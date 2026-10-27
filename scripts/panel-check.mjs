/**
 * Look at what the Plugins panel actually says about this plugin.
 *
 * The manifest carries a description, but the panel reads `meta` through the
 * host's own resolver, so the only trustworthy answer is the rendered text.
 *
 * Run: node scripts/panel-check.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXE = 'C:\\Users\\YSK\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
const IMAGE = 'DeepSeek Harness.exe'
const DIR = dirname(EXE)
const CDP_PORT = 9335
const SHOTS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'shots')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
      /* not up yet */
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
  const shot = async (name) => {
    const result = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOTS, name), Buffer.from(result.result.data, 'base64'))
  }
  return { evaluate, send, shot, close: () => ws.close() }
}

const CLICK = (texts) => `(() => {
  const wanted = ${JSON.stringify(texts)}
  const nodes = [...document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="menuitem"]')]
  const hit = nodes.find((node) => {
    const label = ((node.innerText || '') + ' ' + (node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('title') || '')).trim()
    return wanted.some((w) => label === w || label.indexOf(w) === 0)
  })
  if (!hit) return { clicked: false, seen: nodes.map((n) => (n.innerText || '').trim()).filter(Boolean).slice(0, 40) }
  hit.click()
  return { clicked: true, text: (hit.innerText || '').trim() }
})()`

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  for (let i = 0; i < 10 && appPids().length > 0; i += 1) {
    spawnSync('taskkill', ['/IM', IMAGE, '/F'], { windowsHide: true })
    await sleep(2000)
  }
  const child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], { detached: true, stdio: 'ignore', cwd: DIR, env: cleanEnv() })
  child.on('error', (error) => console.log(`  spawn error: ${error.message}`))
  child.unref()

  const page = await attach(await openTarget())
  await sleep(4000)
  await page.shot('panel-00-landing.png')
  console.log('landing text:', (await page.evaluate('document.body.innerText')).slice(0, 600).replace(/\n/g, ' | '))

  console.log('clicking sidebar:', JSON.stringify(await page.evaluate(CLICK(['插件', 'Plugins']))))
  await sleep(2500)
  await page.shot('panel-01-open.png')
  const text = await page.evaluate('document.body.innerText')
  console.log('\n--- panel text ---\n' + text.slice(0, 3000))

  // The market tab: a locally installed package may show up there too, and the
  // card's blurb comes from the catalog rather than from the manifest.
  console.log('\nclicking market tab:', JSON.stringify(await page.evaluate(CLICK(['插件市场', 'Market']))))
  await sleep(3000)
  await page.shot('panel-02-market.png')
  const market = await page.evaluate('document.body.innerText')
  console.log('\n--- market text ---\n' + market.slice(0, 2000))

  console.log('\nmarket > installed:', JSON.stringify(await page.evaluate(CLICK(['已安装 (', 'Installed (']))))
  await sleep(3000)
  await page.shot('panel-03-market-installed.png')
  const installedInMarket = await page.evaluate('document.body.innerText')
  console.log('\n--- market installed text ---\n' + installedInMarket.slice(0, 2500))
  page.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
