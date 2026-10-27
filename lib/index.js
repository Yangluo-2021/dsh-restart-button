/**
 * dsh-restart-button — host side.
 *
 * Restarting the desktop app is not "kill and start again". The app is two
 * processes: the Electron shell (main) and the host that serves this plugin —
 * a node-mode child of it. Work that has been accepted but not yet written
 * belongs to the host, so ending it with `taskkill` throws that work away.
 *
 * So the sequence is:
 *
 * 1. A detached helper verifies that main and host really are the pair we think
 *    they are, and that `process.execPath` is the application.
 * 2. The helper freezes the shell first (`NtSuspendProcess`), so the shell never
 *    sees the host leave and never paints a crash dialog.
 * 3. The host disconnects from the shell's IPC channel. That is the shell's own
 *    quit path: sessions flush, plugins dispose, the port is released.
 * 4. The helper ends the frozen shell, waits for the port, and starts the
 *    application again with the arguments it was originally given.
 *
 * Two variables decide whether any of this works, and neither is visible in the
 * code below:
 *
 * - `ELECTRON_RUN_AS_NODE` is set in this process (that is how the app starts
 *   its own backend). Anything started from here inherits it, and the app
 *   started that way runs as a bare node — no window, no port, gone in a
 *   second. `launchEnv()` drops it.
 * - `windowsHide: true` on a spawn becomes `STARTUPINFO.wShowWindow = SW_HIDE`,
 *   and Windows applies that to the first window the new process shows — for an
 *   Electron app, the main window. The helper therefore never passes it.
 *
 * Routes (all `POST` ones require `application/json` and a loopback peer):
 *
 *   GET  /dsh-restart-button/status       what a restart would interrupt, and
 *                                         whether the previous one finished
 *   GET  /dsh-restart-button/capabilities which build is loaded (health probe)
 *   POST /dsh-restart-button/restart      now, or `{ when: 'idle' }` when work ends
 *   POST /dsh-restart-button/cancel       cancel a scheduled restart
 *   POST /dsh-restart-button/resume-ack   forget the post-restart record
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-restart-button'

/** The routes this plugin owns. */
export const ROUTE = '/dsh-restart-button'

/** Reported by `capabilities`, so a host can be asked which build it loaded. */
export const VERSION = '0.6.0'

/** Longest the page may take to answer before a restart is refused as in flight. */
const SCHEDULE_POLL_MS = 1000
/** Three consecutive idle checks before a scheduled restart fires. */
const IDLE_CHECKS_BEFORE_RESTART = 3
/** A record older than this is stale and not offered after start-up. */
const RECORD_MAX_AGE_MS = 10 * 60 * 1000
/** How long the helper gets to verify the process pair before we give up. */
const VERIFY_TIMEOUT_MS = 30000
/** How long the helper gets to report "frozen" after the page is answering. */
const READY_TIMEOUT_MS = 25000
/** Pause inside the helper between "verified" and freezing, so the response lands. */
const START_DELAY_MS = 700
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
/** The detached launcher; it starts PowerShell so the work outlives this process. */
export const LAUNCHER = join(LIB_DIR, 'detach.cjs')
/** The PowerShell half that does the restarting. */
export const HELPER_SCRIPT = join(LIB_DIR, 'restart-desktop.ps1')

const FALLBACK_KEYS = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING', 'NODE_OPTIONS']

/** `~/.dsh`, or wherever the profile lives. */
function dshHome(env = process.env) {
  return typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
}

/** Append-only account of every restart, next to the app's other logs. */
export function logFilePath(env = process.env) {
  return join(dshHome(env), 'logs', 'dsh-restart-button.log')
}

/** Handed from one host to the next: what this restart interrupted. */
export function recordFilePath(env = process.env) {
  return join(dshHome(env), 'dsh-restart-button', 'last-restart.json')
}

export const TRACE = logFilePath()

/** One line into the log. Never throws: a failure to log must not mask the failure being logged. */
export function createLogger(file) {
  return (line) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* nowhere left to report it */
    }
  }
}

/**
 * The environment a relaunched app should get: ours, minus everything that
 * would make it start as something other than the app.
 * @returns a fresh object, safe to hand to `spawn`.
 */
export function launchEnv(env = process.env) {
  const next = { ...env }
  for (const key of FALLBACK_KEYS) delete next[key]
  return next
}

/**
 * Which restart strategy this process supports.
 *
 * The desktop shape is checked by evidence rather than by the platform alone: an
 * Electron Node-mode child has an IPC channel to a parent shell. Running under a
 * bare `dsh web` or a test runner fails this and is refused before anything is
 * spawned — which is the one guard that keeps a stray call from ending every
 * `node.exe` on the machine.
 * @param proc - the process object (replaceable by tests).
 * @returns 'desktop' when a restart can be done here, else 'unsupported'.
 */
export function detectMode(proc = process) {
  if (proc.versions?.electron === undefined) return 'unsupported'
  if (proc.platform !== 'win32') return 'unsupported'
  if (typeof proc.send !== 'function' || proc.connected !== true) return 'unsupported'
  if (!Number.isSafeInteger(proc.ppid) || proc.ppid <= 0) return 'unsupported'
  return 'desktop'
}

/**
 * What restarting now would interrupt: running or queued agent turns and running
 * background jobs, reported per top-level session — a busy sub-agent counts for
 * the session that owns it.
 * @returns `activeTasks` plus the ids of the busy root sessions.
 */
export function analyzeActivity(ctx) {
  const result = { activeTasks: false, busySessions: [] }
  try {
    if (typeof ctx.get !== 'function') return result
    const agents = ctx.get('agents')
    if (agents === undefined || agents === null || typeof agents.list !== 'function') return result
    const jobs = ctx.get('jobs')
    const running = (job) => job.status === 'running' || job.status === 'stopping'
    const busy = (agent) => agent.status === 'running'
      || (agent.inbox?.nextTurn?.length ?? 0) > 0
      || (agent.inbox?.nextStep?.length ?? 0) > 0
      || (typeof jobs?.list === 'function' && (jobs.list(agent.id) ?? []).some(running))
    const owned = (id, owner) => {
      try {
        return typeof agents.isOwnedBy === 'function' && agents.isOwnedBy(id, owner) === true
      } catch {
        return false
      }
    }
    const live = agents.list()
    const roots = typeof agents.roots === 'function' ? agents.roots() : live
    for (const root of roots) {
      const queue = [root]
      const seen = new Set([String(root.id)])
      let found = false
      while (queue.length > 0 && !found) {
        const agent = queue.shift()
        if (busy(agent)) {
          found = true
          break
        }
        for (const child of live) {
          if (seen.has(String(child.id)) || !owned(child.id, agent)) continue
          seen.add(String(child.id))
          queue.push(child)
        }
      }
      if (found) result.busySessions.push(String(root.id))
    }
    result.activeTasks = result.busySessions.length > 0 || live.some(busy)
  } catch {
    /* the services are optional; a host without them simply cannot tell */
  }
  return result
}

function readRecord(file) {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))
    return typeof record === 'object' && record !== null && record.version === 1 ? record : undefined
  } catch {
    return undefined
  }
}

function writeRecord(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2))
  renameSync(tmp, file)
}

function removeRecord(file, id) {
  const record = readRecord(file)
  if (record === undefined) return
  if (id === undefined || record.id === id) rmSync(file, { force: true })
}

/** The part of a record a page needs: what was open, and what got cut off. */
function resumeView(record) {
  const ids = Array.isArray(record.interrupted)
    ? record.interrupted.filter((id) => typeof id === 'string' && SESSION_ID.test(id))
    : []
  return {
    id: String(record.id),
    at: Number(record.at),
    activeSessionId: typeof record.activeSessionId === 'string' && SESSION_ID.test(record.activeSessionId)
      ? record.activeSessionId
      : null,
    interrupted: [...new Set(ids)],
  }
}

/** A node able to run the launcher. `process.execPath` is the app itself here. */
function nodeBin() {
  const override = process.env.DSH_RESTART_BUTTON_NODE
  if (typeof override === 'string' && override !== '') return override
  const bundled = join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
  if (existsSync(bundled)) return bundled
  return /^node(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : 'node.exe'
}

/**
 * Poll a file the helper writes as it goes.
 * @param file - the status file.
 * @param accept - whether a value is the one being waited for.
 * @param timeoutMs - give up after this long (resolves `undefined`).
 * @returns the accepted value, a `failed: …` line, or `undefined`.
 */
function watchStatus(file, accept, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      let value
      try {
        value = readFileSync(file, 'utf8').trim()
      } catch {
        value = undefined
      }
      if (value !== undefined && (value.startsWith('failed') || accept(value))) return resolve(value)
      if (Date.now() >= deadline) return resolve(undefined)
      setTimeout(tick, 120)
    }
    tick()
  })
}

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function loopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Whether the click came from the app itself rather than from some other site.
 *
 * `Origin` is not asked to carry any weight: the desktop serves its page over a
 * custom scheme whose origins have no comparable authority, and comparing them
 * to an HTTP `Host` is what made the first build refuse every click from its own
 * UI. A loopback peer with no proxy headers in front of it, and a browser that
 * has not labelled the request cross-site, is the whole test.
 */
function fromApp(request) {
  const headers = request.headers ?? {}
  if (headers.forwarded !== undefined
    || headers['x-forwarded-for'] !== undefined
    || headers['x-real-ip'] !== undefined) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  return loopback(request.socket?.remoteAddress)
}

/** Read a small JSON body. Anything unparseable becomes `{}`, as a body is optional. */
function readJson(request) {
  return new Promise((resolve) => {
    if (typeof request.on !== 'function') {
      resolve({})
      return
    }
    let data = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      data += chunk
      if (data.length > 8192) finish({})
    })
    request.on('end', () => {
      try {
        const value = data === '' ? {} : JSON.parse(data)
        finish(typeof value === 'object' && value !== null ? value : {})
      } catch {
        finish({})
      }
    })
    request.on('error', () => finish({}))
  })
}

/**
 * The "restart once the work finishes" watcher, on its own so it can be tested
 * without a host, a process, or a clock.
 *
 * It waits for a run of consecutive idle checks rather than one, because the
 * gap between two turns of an agent is idle for a moment and restarting in that
 * gap would cut the work anyway.
 * @param analyze - `() => ({ activeTasks })`, asked once per poll.
 * @param start - called once, after the run of idle checks, and only if armed.
 * @returns `arm` (idempotent per entry), `cancel`, and `peek`.
 */
export function createScheduler({ analyze, start, pollMs = SCHEDULE_POLL_MS, checks = IDLE_CHECKS_BEFORE_RESTART }) {
  let entry
  const cancel = (why) => {
    if (entry === undefined) return false
    clearInterval(entry.timer)
    entry = undefined
    void why
    return true
  }
  const arm = ({ activeSessionId } = {}) => {
    if (entry !== undefined) {
      if (activeSessionId !== undefined) entry.activeSessionId = activeSessionId
      return entry
    }
    const fresh = { since: Date.now(), activeSessionId, idleChecks: 0, timer: undefined }
    fresh.timer = setInterval(() => {
      if (entry !== fresh) return
      fresh.idleChecks = analyze().activeTasks ? 0 : fresh.idleChecks + 1
      if (fresh.idleChecks < checks) return
      clearInterval(fresh.timer)
      entry = undefined
      start({ activeSessionId: fresh.activeSessionId })
    }, pollMs)
    entry = fresh
    return fresh
  }
  return { arm, cancel, peek: () => entry }
}

/**
 * Register the routes.
 * @param ctx - the cordis context; routes go up once `webServer` exists.
 * @param config - `allowRestart: false` makes the endpoint a no-op, and
 *   `confirm` picks when the page asks first: `when-busy` (default) | `always` | `never`.
 */
export function apply(ctx, config = {}) {
  const allowRestart = config.allowRestart !== false
  const confirm = ['when-busy', 'always', 'never'].includes(config.confirm) ? config.confirm : 'when-busy'
  const log = createLogger(logFilePath())
  const recordFile = recordFilePath()
  const bootId = randomUUID()
  const startedAt = Date.now() - Math.round(process.uptime() * 1000)

  /** The restart in flight, if any. */
  let current
  /** The record left by the previous host, offered once. */
  let resume
  let disposed = false

  const mode = () => detectMode()
  const inProgress = () => current !== undefined && current.state !== 'failed'

  // ---- what the previous host left behind
  const previous = readRecord(recordFile)
  if (previous !== undefined) {
    const view = resumeView(previous)
    if (previous.fromPid === process.pid) {
      // Our own record from an earlier activation: nothing to offer.
    } else if (view.interrupted.length === 0 || Date.now() - Number(previous.at) >= RECORD_MAX_AGE_MS) {
      // Nothing was cut off (or it is too old to be news): drop it rather than
      // greet the next session with a notice about zero sessions.
      removeRecord(recordFile, previous.id)
    } else {
      resume = view
      log(`resume record ${resume.id}: interrupted [${resume.interrupted.join(', ')}]`)
    }
  }

  const webPort = () => {
    const port = ctx.get?.('webServer')?.port
    return Number.isSafeInteger(port) && port > 0 ? port : 0
  }

  /**
   * Hand the restart to the helper and wait until it has the shell frozen.
   *
   * Resolves once the helper reported `verified` — by then the page's answer can
   * be written, and `run.ready` settles when the shell is frozen, which is the
   * moment this process may disconnect.
   * @returns `{ ready }`, where `ready` is a promise of the helper's status.
   */
  const beginRestart = async (id) => {
    if (mode() !== 'desktop') throw new Error('restart is only implemented for the Windows desktop app')
    const statusFile = join(tmpdir(), `dsh-restart-button-${id}.status`)
    rmSync(statusFile, { force: true })
    const spec = {
      mainPid: process.ppid,
      hostPid: process.pid,
      exe: process.execPath,
      port: webPort(),
      statusFile,
      logFile: logFilePath(),
      startDelayMs: START_DELAY_MS,
    }
    const launcher = spawn(nodeBin(), [LAUNCHER], {
      detached: true,
      stdio: 'ignore',
      cwd: dirname(process.execPath),
      env: {
        ...launchEnv(),
        DSH_RESTART_LAUNCHER_SPEC: JSON.stringify({
          command: join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
            'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          script: HELPER_SCRIPT,
          spec,
        }),
      },
    })
    launcher.on('error', (error) => log(`launcher could not start: ${error.message}`))
    launcher.unref()
    log(`launcher detached (pid ${String(launcher.pid)}), status ${statusFile}`)

    const verified = await watchStatus(statusFile, (value) => value === 'verified', VERIFY_TIMEOUT_MS)
    if (verified === undefined) throw new Error('the restart helper did not answer in time')
    if (verified.startsWith('failed')) throw new Error(verified.replace(/^failed:\s*/, ''))

    const ready = watchStatus(statusFile, (value) => value.startsWith('ready'), READY_TIMEOUT_MS)
    return { ready }
  }

  /**
   * Start one restart. Writes the record first, so a crash in the middle still
   * tells the next host what was open.
   */
  const startRestart = async ({ reason, activeSessionId, delayMs = 0 }) => {
    if (mode() !== 'desktop') throw new Error(`restart is not supported here (${process.platform}, ${process.versions.electron ? 'electron' : 'node'})`)
    const id = randomUUID()
    current = { id, state: 'pending', reason, startedAt: Date.now() }
    const activity = analyzeActivity(ctx)
    const interrupted = [...new Set([...(resume?.interrupted ?? []), ...activity.busySessions])]
    const record = {
      version: 1,
      id,
      at: Date.now(),
      fromPid: process.pid,
      reason,
      activeSessionId: activeSessionId ?? resume?.activeSessionId ?? null,
      interrupted,
    }
    try {
      writeRecord(recordFile, record)
    } catch (error) {
      log(`could not write the resume record: ${error.message}`)
    }
    log(`restart ${id} requested (${reason}, pid ${process.pid}, ppid ${process.ppid}, version ${VERSION}); interrupting [${interrupted.join(', ')}]`)

    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      const run = await beginRestart(id)
      log(`restart ${id}: helper verified the process pair`)
      run.ready.then((status) => {
        if (status?.startsWith('ready')) {
          current = { ...current, state: 'handoff' }
          log(`restart ${id}: ${status}; disconnecting so the shell quits on its own terms`)
          setTimeout(disconnectHost, 50)
        } else {
          const why = status === undefined ? 'the helper stopped reporting' : status.replace(/^failed:\s*/, '')
          current = { ...current, state: 'failed', error: why }
          log(`restart ${id} failed: ${why}`)
          removeRecord(recordFile, id)
        }
      })
      return { id }
    } catch (error) {
      current = { ...current, state: 'failed', error: error.message }
      log(`restart ${id} failed: ${error.message}`)
      removeRecord(recordFile, id)
      throw error
    }
  }

  // ---- restarting once the running work has finished
  const scheduler = createScheduler({
    analyze: () => analyzeActivity(ctx),
    start: ({ activeSessionId }) => {
      if (disposed || inProgress()) return
      log('running work finished; starting the scheduled restart')
      startRestart({ reason: 'idle', activeSessionId }).catch(() => {})
    },
  })

  const schedule = ({ activeSessionId }) => {
    const entry = scheduler.arm({ activeSessionId })
    log(`restart scheduled for when running work finishes (open ${activeSessionId ?? '-'})`)
    return entry
  }

  const cancelSchedule = (why) => {
    const had = scheduler.cancel(why)
    if (had) log(`scheduled restart cancelled (${why})`)
    return had
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposed = true
      cancelSchedule('plugin unloaded')
    }, 'dsh-restart-button: lifecycle')
  }

  /** Everything a page needs to decide what a click would cost. */
  const status = () => {
    const activity = analyzeActivity(ctx)
    const memory = process.memoryUsage()
    return {
      ok: true,
      version: VERSION,
      bootId,
      pid: process.pid,
      platform: process.platform,
      mode: mode(),
      supported: mode() === 'desktop',
      allowRestart,
      confirm,
      activeTasks: activity.activeTasks,
      busySessions: activity.busySessions,
      runtime: {
        startedAt,
        uptimeSec: Math.round(process.uptime()),
        rssBytes: memory.rss,
      },
      restart: current ?? null,
      scheduled: scheduler.peek() === undefined
        ? null
        : { since: scheduler.peek().since, activeSessionId: scheduler.peek().activeSessionId ?? null },
      resume: resume ?? null,
      logFile: logFilePath(),
    }
  }

  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.webServer

    webServer.register({
      kind: 'exact',
      path: `${ROUTE}/status`,
      handler: (request, response) => {
        if (request.method !== 'GET') {
          json(response, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!fromApp(request)) {
          json(response, 403, { ok: false, error: 'refused: only the app itself may read this' })
          return
        }
        json(response, 200, status())
      },
    })

    webServer.register({
      kind: 'exact',
      path: `${ROUTE}/capabilities`,
      handler: (request, response) => {
        if (request.method !== 'GET') {
          json(response, 405, { ok: false, error: 'method not allowed' })
          return
        }
        json(response, 200, {
          ok: true,
          canRestart: allowRestart && mode() === 'desktop',
          mode: mode(),
          version: VERSION,
          trace: TRACE,
          inherited: FALLBACK_KEYS.filter((key) => process.env[key] !== undefined),
        })
      },
    })

    webServer.register({
      kind: 'exact',
      path: `${ROUTE}/restart`,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          json(response, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!fromApp(request)) {
          log(`refused a click from ${String(request.socket?.remoteAddress)}`)
          json(response, 403, { ok: false, error: 'refused: only the app itself may ask for this' })
          return
        }
        if (!allowRestart) {
          json(response, 403, { ok: false, error: 'restart is switched off (allowRestart: false)' })
          return
        }
        if (mode() !== 'desktop') {
          json(response, 501, { ok: false, error: 'restart is only implemented inside the Windows desktop app' })
          return
        }
        if (inProgress()) {
          json(response, 409, { ok: false, error: 'a restart is already in progress', restart: current })
          return
        }
        const body = await readJson(request)
        const activeSessionId = typeof body.activeSessionId === 'string' && SESSION_ID.test(body.activeSessionId)
          ? body.activeSessionId
          : undefined
        if (body.when === 'idle' && analyzeActivity(ctx).activeTasks) {
          const entry = schedule({ activeSessionId })
          json(response, 202, { ok: true, scheduled: true, since: entry.since, bootId, logFile: logFilePath() })
          return
        }
        cancelSchedule('superseded by an immediate restart')
        try {
          const { id } = await startRestart({ reason: body.when === 'idle' ? 'idle' : 'button', activeSessionId })
          json(response, 202, { ok: true, id, bootId, logFile: logFilePath() })
        } catch (error) {
          json(response, 500, { ok: false, error: error.message, logFile: logFilePath() })
        }
      },
    })

    webServer.register({
      kind: 'exact',
      path: `${ROUTE}/cancel`,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          json(response, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!fromApp(request)) {
          json(response, 403, { ok: false, error: 'refused: only the app itself may ask for this' })
          return
        }
        json(response, 200, { ok: true, cancelled: cancelSchedule('cancelled from the page') })
      },
    })

    webServer.register({
      kind: 'exact',
      path: `${ROUTE}/resume-ack`,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          json(response, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!fromApp(request)) {
          json(response, 403, { ok: false, error: 'refused: only the app itself may ask for this' })
          return
        }
        const body = await readJson(request)
        if (resume !== undefined && (body.id === undefined || body.id === resume.id)) {
          const handled = resume.id
          resume = undefined
          removeRecord(recordFile, handled)
          log(`resume record ${handled} acknowledged`)
        }
        json(response, 200, { ok: true })
      },
    })

    log(`routes mounted (version ${VERSION}, mode ${mode()}, allowRestart ${String(allowRestart)}, confirm ${confirm})`)
  })
}

/**
 * Let go of the shell.
 *
 * Disconnecting is how the desktop host asks its own shell to quit: the shell
 * runs its normal shutdown, which flushes sessions and disposes plugins before
 * the helper ends what is left. Not `process.exit()`, and not a kill.
 */
function disconnectHost() {
  try {
    if (process.connected) process.disconnect()
  } catch {
    /* already gone; the helper ends the shell regardless */
  }
}
