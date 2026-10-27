/**
 * Offline smoke test: load both halves of the plugin with stand-ins for what
 * the host provides, and assert they register what the host expects.
 *
 * It must never reach the restart itself. The last POST below is a loopback
 * click, which is exactly what the real button sends — and it is answered 501,
 * because a plain node process is not the desktop app and `detectMode()` says
 * so. That check is the one that matters: the first build of this plugin had no
 * such guard, and a test run handed `taskkill /IM node.exe /F` to a detached
 * helper. The trace comparison at the end is the second opinion.
 *
 * Run: node scripts/smoke.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let failures = 0

/** Windows paths are not URLs; `import()` insists on one. */
function fileUrl(path) {
  const drive = /^([A-Za-z]):/.exec(path)
  const rest = drive === null ? path : path.slice(2)
  const unix = rest.replace(/\\/g, '/').replace(/^\//, '')
  return drive === null ? `file://${unix}` : `file:///${drive[1].toLowerCase()}:/${unix}`
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ---------------------------------------------------------------- host side

console.log('\nhost side (lib/index.js)')

const module_ = await import(fileUrl(join(root, 'lib/index.js')))
const {
  name: hostName,
  apply: hostApply,
  ROUTE,
  VERSION,
  TRACE,
  detectMode,
  launchEnv,
  analyzeActivity,
  createScheduler,
} = module_

/** The log as it stood before this run — proof, at the end, that nothing ran. */
const traceBefore = existsSync(TRACE) ? readFileSync(TRACE, 'utf8') : ''

function fakeResponse() {
  const written = { status: 0, headers: {}, body: '' }
  return {
    written,
    writeHead(status, headers) {
      written.status = status
      written.headers = headers
    },
    end(body) {
      written.body = body ?? ''
    },
  }
}

/** A request that can never be trusted: off-loopback, so the fence refuses first. */
function fakeRequest(overrides) {
  return {
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '203.0.113.7' },
    ...overrides,
  }
}

/** A real click: loopback peer, JSON body, same-origin browser. */
function clickRequest(overrides) {
  const payload = overrides?.body ?? ''
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
    // Enough of a stream for the body reader: data then end, nothing else.
    on(event, callback) {
      if (event === 'data' && payload !== '') setTimeout(() => callback(payload), 0)
      if (event === 'end') setTimeout(() => callback(), 0)
    },
    ...overrides,
  }
}

/** A context with no agents/jobs services: the shape a bare host has. */
function hostContext(routes) {
  return {
    get: () => undefined,
    inject(deps, callback) {
      if (deps.includes('webServer')) {
        callback({
          webServer: {
            register(route) {
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          },
        })
      }
    },
  }
}

check('exports a name matching cordis.patch.yml', hostName === 'dsh-restart-button', hostName)
check('exports a route prefix', typeof ROUTE === 'string' && ROUTE.startsWith('/'), ROUTE)
check('reports a version', typeof VERSION === 'string' && VERSION.length > 0, VERSION)

{
  const env = launchEnv({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', PATH: '/usr/bin' })
  check('launchEnv drops ELECTRON_RUN_AS_NODE', env.ELECTRON_RUN_AS_NODE === undefined)
  check('launchEnv drops NODE_OPTIONS', env.NODE_OPTIONS === undefined)
  check('launchEnv keeps everything else', env.PATH === '/usr/bin', env.PATH)
}

check('a plain node process is not the app', detectMode(process) === 'unsupported', detectMode(process))
check('a context without agents reports no work', analyzeActivity({ get: () => undefined }).activeTasks === false)

// ---- what counts as "work is running"
{
  const agent = (id, status) => ({ id, status, inbox: { nextTurn: [], nextStep: [] } })
  const busyHost = {
    get: (service) => {
      if (service === 'agents') {
        const list = [agent('running-one', 'running'), agent('idle-one', 'idle')]
        return { list: () => list, roots: () => list, isOwnedBy: () => false }
      }
      return undefined
    },
  }
  const busy = analyzeActivity(busyHost)
  check('a running turn counts as work', busy.activeTasks === true, String(busy.activeTasks))
  check('the busy session is named', busy.busySessions.includes('running-one'), JSON.stringify(busy.busySessions))
  check('an idle session is not named', !busy.busySessions.includes('idle-one'), JSON.stringify(busy.busySessions))

  const jobsHost = {
    get: (service) => {
      if (service === 'agents') {
        const list = [agent('idle-one', 'idle')]
        return { list: () => list, roots: () => list, isOwnedBy: () => false }
      }
      if (service === 'jobs') return { list: () => [{ status: 'running' }] }
      return undefined
    },
  }
  check('a running background job counts as work', analyzeActivity(jobsHost).activeTasks === true)

  const queuedHost = {
    get: (service) => {
      if (service === 'agents') {
        const queued = { id: 'queued', status: 'idle', inbox: { nextTurn: ['x'], nextStep: [] } }
        return { list: () => [queued], roots: () => [queued], isOwnedBy: () => false }
      }
      return undefined
    },
  }
  check('a queued turn counts as work', analyzeActivity(queuedHost).activeTasks === true)
}

// ---- "restart when the work finishes"
{
  let busy = true
  const fired = []
  const scheduler = createScheduler({
    analyze: () => ({ activeTasks: busy }),
    start: (entry) => fired.push(entry),
    pollMs: 10,
    checks: 3,
  })
  scheduler.arm({ activeSessionId: 'a' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  check('a busy host does not restart itself', fired.length === 0, `fired ${fired.length}`)
  busy = false
  await new Promise((resolve) => setTimeout(resolve, 120))
  check('it restarts once the work is done', fired.length === 1, `fired ${fired.length}`)
  check('it remembers the session that was open', fired[0]?.activeSessionId === 'a', JSON.stringify(fired[0]))
  check('the watcher is cleared once it fires', scheduler.peek() === undefined)
}

{
  const fired = []
  const scheduler = createScheduler({
    analyze: () => ({ activeTasks: false }),
    start: () => fired.push(1),
    pollMs: 10,
    checks: 3,
  })
  scheduler.arm({})
  const cancelled = scheduler.cancel('test')
  await new Promise((resolve) => setTimeout(resolve, 120))
  check('cancelling stops it', cancelled === true && fired.length === 0, `cancelled ${String(cancelled)} fired ${fired.length}`)
  check('cancelling twice is harmless', scheduler.cancel('test') === false)
}

const routes = new Map()
hostApply(hostContext(routes), {})

for (const path of ['status', 'capabilities', 'restart', 'cancel', 'resume-ack']) {
  check(`registered /${path}`, routes.has(`${ROUTE}/${path}`), [...routes.keys()].join(','))
}

const status = routes.get(`${ROUTE}/status`)
const capabilities = routes.get(`${ROUTE}/capabilities`)
const restart = routes.get(`${ROUTE}/restart`)
const cancel = routes.get(`${ROUTE}/cancel`)
const resumeAck = routes.get(`${ROUTE}/resume-ack`)

{
  const response = fakeResponse()
  await status.handler({ method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, response)
  const body = JSON.parse(response.written.body)
  check('GET status answers 200 on loopback', response.written.status === 200, String(response.written.status))
  check('status reports this build', body.version === VERSION, body.version)
  check('status says restart is unsupported here', body.supported === false, String(body.supported))
  check('status defaults to asking only when busy', body.confirm === 'when-busy', body.confirm)
  check('status reports no running work', body.activeTasks === false, String(body.activeTasks))
}

{
  const response = fakeResponse()
  await status.handler(fakeRequest({ method: 'GET' }), response)
  check('status is refused off-loopback', response.written.status === 403, String(response.written.status))
}

{
  const response = fakeResponse()
  await capabilities.handler({ method: 'GET', headers: {} }, response)
  const body = JSON.parse(response.written.body)
  check('GET capabilities answers 200', response.written.status === 200, String(response.written.status))
  check('capabilities says where the log goes', typeof body.trace === 'string' && body.trace.length > 0, body.trace)
  check('capabilities refuses to claim a restart here', body.canRestart === false, String(body.canRestart))
}

{
  const response = fakeResponse()
  await capabilities.handler(fakeRequest({ method: 'DELETE' }), response)
  check('capabilities refuses other methods', response.written.status === 405, String(response.written.status))
}

{
  const response = fakeResponse()
  await restart.handler(fakeRequest({ method: 'GET' }), response)
  check('restart refuses GET', response.written.status === 405, String(response.written.status))
}

{
  const response = fakeResponse()
  await restart.handler(fakeRequest({
    method: 'POST',
    headers: { host: '127.0.0.1:3080', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  }), response)
  check('restart refuses a cross-site click', response.written.status === 403, String(response.written.status))
}

{
  const response = fakeResponse()
  await restart.handler(fakeRequest({
    method: 'POST',
    headers: { forwarded: 'for=203.0.113.9' },
  }), response)
  check('restart refuses a proxied click', response.written.status === 403, String(response.written.status))
}

{
  // The guard that keeps a test run from ending every node.exe on the machine.
  const response = fakeResponse()
  await restart.handler(clickRequest(), response)
  check('a loopback click is refused outside the desktop app', response.written.status === 501, String(response.written.status))
  check('the refusal says where restart works', String(response.written.body).includes('desktop'), response.written.body)
}

{
  // And the switch, checked before anything else can spawn.
  const swapped = new Map()
  hostApply(hostContext(swapped), { allowRestart: false })
  const response = fakeResponse()
  await swapped.get(`${ROUTE}/restart`).handler(clickRequest(), response)
  check('a switched-off host refuses its own click', response.written.status === 403, String(response.written.status))
  check('the refusal names the allowRestart switch', String(response.written.body).includes('allowRestart'))
}

{
  const response = fakeResponse()
  await cancel.handler(clickRequest(), response)
  const body = JSON.parse(response.written.body)
  check('cancel with nothing scheduled answers ok', response.written.status === 200 && body.cancelled === false, response.written.body)
}

{
  const response = fakeResponse()
  await resumeAck.handler(clickRequest(), response)
  check('resume-ack answers ok with no record', response.written.status === 200, String(response.written.status))
}

// ------------------------------------------------------------- browser side

console.log('\nbrowser side (client/client.js)')

const source = readFileSync(join(root, 'client/client.js'), 'utf8')
let loaded = null
globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
// eslint-disable-next-line no-new-func
new Function(source)()

check('declares itself to the module loader', loaded !== null && loaded.id === 'dsh-restart-button', loaded?.id)

let hooks = 0
const react = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    hooks += 1
    return [initial, () => {}]
  },
  useEffect() {
    hooks += 1
  },
  useRef(initial) {
    return { current: initial ?? null }
  },
}

const client = loaded.factory((specifier) => {
  if (specifier === 'react') return react
  throw new Error(`unexpected import: ${specifier}`)
})

check('exports name', client.name === 'dsh-restart-button', client.name)
check('exports inject', Array.isArray(client.inject) && client.inject.includes('slots'), String(client.inject))
check('exports apply', typeof client.apply === 'function')

const registered = []
const slots = {
  inject(name, callback) {
    if (name === 'shell.overlay') registered.push(callback())
  },
  register(entry, component) {
    return { entry, component }
  },
}

client.apply({ slots })

check('registers into shell.overlay', registered.length === 1, `count ${registered.length}`)
check('entry names the slot', registered[0]?.entry?.name === 'shell.overlay', registered[0]?.entry?.name)
check('entry carries an id', typeof registered[0]?.entry?.id === 'string')
check('entry carries a component', typeof registered[0]?.component === 'function')

// The component must render without touching anything but React's hooks: no DOM
// during construction, no fetch at module scope, no state the frame cannot
// rebuild after a reload.
try {
  const tree = registered[0].component({})
  check('component renders a tree', tree !== null && typeof tree === 'object')
  check('component used state hooks', hooks > 0, `hooks ${hooks}`)
  check('the button is drawn immediately', JSON.stringify(tree).includes('button'))
} catch (error) {
  check('component renders a tree', false, error instanceof Error ? error.message : String(error))
}

// ------------------------------------------------------------------- guard

console.log('\nguard')

{
  const after = existsSync(TRACE) ? readFileSync(TRACE, 'utf8') : ''
  const added = after.slice(traceBefore.length)
  check('no launcher was started during this run', !added.includes('launcher detached'), added.trim().split('\n').slice(-2).join(' | '))
  check('nothing was asked to freeze', !added.includes('NtSuspendProcess'), added.trim().split('\n').slice(-2).join(' | '))
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
