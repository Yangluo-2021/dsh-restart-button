/**
 * Visual check of the overlay button, driven through the app's own renderer.
 *
 * The end-to-end test proves a restart works; this one proves the thing the
 * user actually looks at exists where it is supposed to be — on the landing
 * page, before any conversation is open, clear of the window controls — and
 * that its confirmation card opens and closes without restarting anything.
 *
 * It never presses "restart now". The click it makes lands on the trigger with
 * a confirmation policy of `always`, so the only thing that can happen is a
 * dialog; the dialog is then dismissed and the host's status is compared before
 * and after to prove nothing was handed off.
 *
 * Run: node scripts/ui-check.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXE = 'C:\\Users\\YSK\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
const IMAGE = 'DeepSeek Harness.exe'
const DIR = dirname(EXE)
const CDP_PORT = 9333
const SHOTS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'shots')
const LOG = join(homedir(), '.dsh', 'logs', 'dsh-restart-button.log')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

function cleanEnv() {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING']) delete env[key]
  return env
}

function appPids() {
  const run = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  return String(run.stdout || '').split(/\r?\n/).filter((line) => line.startsWith('"'))
    .map((line) => Number(line.split('","')[1])).filter((pid) => pid > 0)
}

/** Every loopback port the app is listening on, except the debugger's own. */
function listeningPorts(pids = appPids()) {
  const run = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
  const set = new Set(pids)
  const ports = []
  for (const line of String(run.stdout || '').split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const cells = line.trim().split(/\s+/)
    if (!set.has(Number(cells[cells.length - 1]))) continue
    const local = cells[1] || ''
    if (!local.startsWith('127.0.0.1:')) continue
    const port = Number(local.split(':').pop())
    if (port > 0 && port !== CDP_PORT) ports.push(port)
  }
  return ports
}

/**
 * The host's own port.
 *
 * The app listens on several: the shell's debugger, the host's web server, and
 * whatever else it opened. Asking each one for this plugin's capabilities is the
 * only answer that cannot be wrong.
 */
async function hostPort() {
  for (const port of listeningPorts()) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/dsh-restart-button/capabilities`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return port
    } catch {
      /* not the host */
    }
  }
  return 0
}

async function openTarget() {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      if (response.ok) {
        const list = await response.json()
        const page = list.find((target) => target.type === 'page')
        if (page) return page.webSocketDebuggerUrl
      }
    } catch {
      /* not listening yet */
    }
    await sleep(1000)
  }
  throw new Error('no debuggable page appeared')
}

async function attach(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const send = (method, params = {}) => {
    const mine = ++id
    return new Promise((resolve) => {
      pending.set(mine, resolve)
      ws.send(JSON.stringify({ id: mine, method, params }))
    })
  }
  await send('Runtime.enable')
  await send('Page.enable')
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    const details = result.result?.exceptionDetails
    if (details !== undefined) throw new Error(details.text)
    return result.result?.result?.value
  }
  return { evaluate, send, close: () => ws.close() }
}

/**
 * Where the button is, as the browser sees it.
 *
 * `rightGap` is the distance from the button's right edge to the right edge of
 * the frame: that is the number that says whether it clears the window's own
 * minimise/maximise/close group.
 */
const PROBE = `(() => {
  const buttons = [...document.querySelectorAll('button')]
  const label = (node) => node.getAttribute('aria-label') || node.getAttribute('title') || ''
  const trigger = buttons.find((node) => /重启|restart/i.test(label(node)))
  if (!trigger) return { found: false, buttons: buttons.length, labels: buttons.map(label).slice(0, 6) }
  const rect = trigger.getBoundingClientRect()
  const surface = trigger.parentElement
  const style = surface ? getComputedStyle(surface) : null
  return {
    found: true,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    rightGap: Math.round(window.innerWidth - rect.right),
    topGap: Math.round(rect.top),
    position: style ? style.position : '',
    zIndex: style ? style.zIndex : '',
    label: label(trigger),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    bodyText: (document.body.innerText || '').trim().length,
  }
})()`

const DIALOG = `(() => {
  const card = document.querySelector('[role="dialog"]')
  return card ? { open: true, text: (card.innerText || '').replace(/\\s+/g, ' ').trim(), buttons: [...card.querySelectorAll('button')].map((b) => (b.innerText || '').trim()) } : { open: false }
})()`

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const logMark = existsSync(LOG) ? readFileSync(LOG, 'utf8').length : 0

  for (let i = 0; i < 10 && appPids().length > 0; i += 1) {
    spawnSync('taskkill', ['/IM', IMAGE, '/F'], { windowsHide: true })
    await sleep(2000)
  }

  console.log('launching the app with the debugging port open')
  const child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], { detached: true, stdio: 'ignore', cwd: DIR, env: cleanEnv() })
  child.on('error', (error) => console.log(`  spawn error: ${error.message}`))
  child.unref()

  const page = await attach(await openTarget())

  // The plugin's client half is a module the page loads; give it a moment to
  // mount into shell.overlay before looking for the button.
  let probe = null
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    probe = await page.evaluate(PROBE)
    if (probe?.found === true) break
    await sleep(1000)
  }

  console.log('\nbutton')
  check('the button is on the page', probe?.found === true, probe?.found ? undefined : `buttons: ${JSON.stringify(probe?.labels)}`)
  if (probe?.found === true) {
    check('it sits at the top of the frame', probe.rect.y <= 12, `y=${probe.rect.y}`)
    check('it clears the window controls', probe.rightGap >= 120, `rightGap=${probe.rightGap}px`)
    check('it is inside the viewport', probe.rect.x >= 0 && probe.rect.w >= 24, `x=${probe.rect.x} w=${probe.rect.w}`)
    check('it floats above the layout', probe.position === 'fixed' && Number(probe.zIndex) > 1000, `${probe.position} z=${probe.zIndex}`)
    check('it is visible before any conversation is opened', probe.bodyText < 400, `landing page text length ${probe.bodyText}`)
    console.log(`       label: ${probe.label}`)
    console.log(`       rect: ${JSON.stringify(probe.rect)} in ${JSON.stringify(probe.viewport)}`)
  }

  const port = await hostPort()
  const statusUrl = `http://127.0.0.1:${port}/dsh-restart-button/status`
  let before = null
  try {
    before = await (await fetch(statusUrl, { signal: AbortSignal.timeout(3000) })).json()
  } catch (error) {
    check('the page-side host answers /status', false, error.message)
  }
  check('the page-side host answers /status', before?.ok === true, `port ${port}`)
  check('confirm policy reached the host', before?.confirm === 'always', String(before?.confirm))

  // Press the trigger. With `confirm: always` the only possible outcome is the
  // dialog, which is then dismissed — nothing is handed off either way.
  console.log('\nconfirmation card')
  await page.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')]
    const trigger = buttons.find((node) => /重启|restart/i.test(node.getAttribute('aria-label') || node.getAttribute('title') || ''))
    if (trigger) trigger.click()
    return true
  })()`)

  let dialog = { open: false }
  for (let i = 0; i < 20 && dialog.open !== true; i += 1) {
    await sleep(250)
    dialog = await page.evaluate(DIALOG)
  }
  check('clicking it opens a confirmation card', dialog.open === true, JSON.stringify(dialog))
  if (dialog.open === true) {
    console.log(`       text: ${dialog.text}`)
    check('the card offers a way out', dialog.buttons.some((text) => /取消|cancel/i.test(text)), JSON.stringify(dialog.buttons))
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    if (shot.result?.data) writeFileSync(join(SHOTS, 'confirm-open.png'), Buffer.from(shot.result.data, 'base64'))
  }

  await page.evaluate(`(() => {
    const card = document.querySelector('[role="dialog"]')
    if (!card) return false
    const cancel = [...card.querySelectorAll('button')].find((b) => /取消|cancel/i.test((b.innerText || '').trim()))
    if (cancel) cancel.click()
    return true
  })()`)
  await sleep(600)
  const closed = await page.evaluate(DIALOG)
  check('cancelling closes it again', closed.open === false, JSON.stringify(closed))

  await sleep(1000)
  let after = null
  try {
    after = await (await fetch(statusUrl, { signal: AbortSignal.timeout(3000) })).json()
  } catch (error) {
    check('the host is still the same one', false, error.message)
  }
  check('no restart was handed off by the dialog', after?.restart === null || after?.restart === undefined, JSON.stringify(after?.restart))
  const logNow = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
  check('nothing was launched or frozen', !logNow.slice(logMark).includes('launcher detached') && !logNow.slice(logMark).includes('NtSuspendProcess'))

  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    const file = join(SHOTS, 'button.png')
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    console.log(`\nscreenshot: ${file}`)
  }

  page.close()
  console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.log(`crashed: ${error && error.stack ? error.stack : error}`)
  process.exit(1)
})
