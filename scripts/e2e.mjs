/**
 * End-to-end check of the restart, driven entirely from outside the app.
 *
 * It starts the app, waits for this build to answer, presses the button over
 * HTTP — the same JSON POST the page sends — and then watches three things that
 * are each a way the previous builds failed:
 *
 *   1. the old processes really leave,
 *   2. the app comes back on a new port with a window (not a hidden one: a
 *      process with a zero MainWindowHandle is an app nobody can see),
 *   3. the log shows it went through the graceful path — `ready suspended` and
 *      `host exited on its own` — rather than being killed outright.
 *
 * Run: node scripts/e2e.mjs [--hold]
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const EXE = 'C:\\Users\\YSK\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
const IMAGE = 'DeepSeek Harness.exe'
const DIR = 'C:\\Users\\YSK\\AppData\\Local\\Programs\\DeepSeek Harness'
const WANT = '0.6.0'
const LOG = join(homedir(), '.dsh', 'logs', 'dsh-restart-button.log')

const started = Date.now()
const stamp = () => `[${((Date.now() - started) / 1000).toFixed(1)}s]`
const say = (line) => console.log(`${stamp()} ${line}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pids() {
  const listing = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const found = []
  for (const line of String(listing.stdout || '').split(/\r?\n/)) {
    if (line.charAt(0) !== '"') continue
    const pid = Number(line.split('","')[1])
    if (pid > 0) found.push(pid)
  }
  return found
}

/** How many of the app's windows are actually on screen. */
function visibleWindows() {
  const script = `@(Get-Process -Name '${IMAGE.replace(/\.exe$/, '')}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count`
  // No `windowsHide` here and nowhere else: hiding this PowerShell would not
  // hide the app, but keeping the launch plain is the habit that avoids it.
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  const value = Number(String(run.stdout || '').trim())
  return Number.isFinite(value) ? value : -1
}

function listeningPorts(pidList) {
  const netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
  const ports = []
  for (const line of String(netstat.stdout || '').split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const cells = line.trim().split(/\s+/)
    const pid = Number(cells[cells.length - 1])
    if (!pidList.includes(pid)) continue
    const port = Number(cells[1].split(':').pop())
    if (port > 0) ports.push(port)
  }
  return ports
}

async function capabilities(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/dsh-restart-button/capabilities`, {
      signal: AbortSignal.timeout(2000),
    })
    return await response.json()
  } catch {
    return null
  }
}

async function status(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/dsh-restart-button/status`, {
      signal: AbortSignal.timeout(2000),
    })
    return await response.json()
  } catch {
    return null
  }
}

/** Wait for a host answering with the build under test. */
async function awaitHost(limitMs) {
  const deadline = Date.now() + limitMs
  let last = ''
  while (Date.now() < deadline) {
    const alive = pids()
    for (const port of listeningPorts(alive)) {
      const body = await capabilities(port)
      if (body?.ok) {
        last = `v${body.version} port ${port} mode ${body.mode}`
        if (body.version === WANT) return { port, pids: alive, body }
      }
    }
    await sleep(1000)
  }
  say(`no host answered as ${WANT} (last seen: ${last || 'nothing'})`)
  return null
}

function logTail(marker) {
  try {
    const lines = readFileSync(LOG, 'utf8').split('\n').filter((line) => line.includes(marker))
    return lines
  } catch {
    return []
  }
}

async function main() {
  const stale = pids()
  if (stale.length > 0) {
    say(`clearing ${stale.length} leftover process(es)`)
    spawnSync('taskkill', ['/IM', IMAGE, '/F'], { windowsHide: true })
    await sleep(3000)
  }

  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING', 'NODE_OPTIONS']) {
    delete env[key]
  }

  const logMark = existsSync(LOG) ? readFileSync(LOG, 'utf8').length : 0

  say('starting the app with a cleaned environment')
  const app = spawn(EXE, [], { detached: true, stdio: 'ignore', cwd: DIR, env })
  app.on('error', (error) => say(`spawn error: ${error.message}`))
  app.unref()

  const before = await awaitHost(120000)
  if (before === null) {
    say('FAIL — the app never came up, so the restart cannot be tested')
    process.exit(1)
  }
  say(`app is up: ${before.pids.length} processes, port ${before.port}, build ${before.body.version}`)

  const beforeStatus = await status(before.port)
  say(`status before: supported=${String(beforeStatus?.supported)} mode=${String(beforeStatus?.mode)} activeTasks=${String(beforeStatus?.activeTasks)}`)

  say('pressing the button: POST /dsh-restart-button/restart')
  let answer = null
  try {
    const response = await fetch(`http://127.0.0.1:${before.port}/dsh-restart-button/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ when: 'now' }),
      signal: AbortSignal.timeout(20000),
    })
    answer = { status: response.status, body: await response.json() }
    say(`host answered ${answer.status} ${JSON.stringify(answer.body)}`)
  } catch (error) {
    say(`FAIL — the host never answered the click: ${error.message}`)
    process.exit(1)
  }

  say('waiting for the old processes to leave')
  const goneBy = Date.now() + 30000
  while (pids().some((pid) => before.pids.includes(pid))) {
    if (Date.now() > goneBy) {
      say('FAIL — the app never exited')
      process.exit(1)
    }
    await sleep(400)
  }
  say('old processes are gone')

  say('waiting for the app to come back')
  const after = await awaitHost(120000)
  if (after === null) {
    say('FAIL — the app was closed but never reopened')
    process.exit(1)
  }
  const fresh = after.pids.filter((pid) => !before.pids.includes(pid))
  say(`app is back: ${after.pids.length} processes (${fresh.length} new), port ${after.port}, build ${after.body.version}`)

  await sleep(1500)
  const windows = visibleWindows()
  say(`windows on screen: ${windows}`)

  const afterStatus = await status(after.port)
  say(`status after: resume=${afterStatus?.resume === null || afterStatus?.resume === undefined ? 'none' : `${afterStatus.resume.interrupted.length} interrupted`}`)

  // The helper keeps working after the app is up: three seconds to see whether
  // the new process stays, four more before it calls the restart done. Reading
  // the log before that is how a healthy restart gets reported as a failed one.
  const doneBy = Date.now() + 30000
  while (Date.now() < doneBy && !logTail('restart complete').length) await sleep(500)

  const fresh_log = existsSync(LOG) ? readFileSync(LOG, 'utf8').slice(logMark) : ''
  const suspended = fresh_log.includes('ready suspended') || fresh_log.includes('ready unsuspended')
  const graceful = fresh_log.includes('host exited on its own')
  const startedAgain = fresh_log.includes('restart complete')
  say(`log: frozen=${String(suspended)} gracefulHostExit=${String(graceful)} completed=${String(startedAgain)}`)

  const checks = [
    ['host accepted the click', answer?.status === 202],
    ['the old processes left', true],
    ['new processes are running', fresh.length > 0],
    ['a new port is serving', after.port !== before.port],
    ['a window is on screen', windows > 0],
    ['the shell was frozen first', suspended],
    ['the host quit on its own', graceful],
    ['the helper finished', startedAgain],
  ]

  console.log('')
  for (const [label, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  const passed = checks.every(([, ok]) => ok)

  console.log('\n--- log tail ---')
  console.log(fresh_log.trim().split('\n').slice(-16).join('\n') || '(nothing new)')

  console.log(passed ? '\nPASS — the button restarted the app gracefully\n' : '\nFAILED — see the log above\n')
  if (process.argv.includes('--hold')) {
    say('holding the app open for 120s so it can be inspected from outside')
    await sleep(120000)
  }
  process.exit(passed ? 0 : 1)
}

main().catch((error) => {
  say(`crashed: ${error && error.stack ? error.stack : error}`)
  process.exit(1)
})
