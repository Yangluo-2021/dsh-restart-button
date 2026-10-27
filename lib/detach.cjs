/**
 * dsh-restart-button — detached launcher.
 *
 * Windows PowerShell exits immediately when it is started with DETACHED_PROCESS
 * (Node's `detached: true`), because its console host has no console to attach
 * to. A non-detached child, however, is placed in the parent's kill-on-close job
 * object and would die together with the host it is supposed to outlive.
 *
 * So this process is the one that detaches (the runtime here is the bundled
 * node, not the app), and it starts PowerShell as an ordinary child with a
 * hidden console. PowerShell is allowed to be non-detached because this process
 * outlives the host, and this process's own lifetime is tied to PowerShell's.
 *
 * `windowsHide` is correct here and only here: it hides the PowerShell console.
 * The app is started later by `Start-Process`, which builds its own STARTUPINFO,
 * so the flag cannot reach the app's window.
 *
 * Spec arrives as JSON in `DSH_RESTART_LAUNCHER_SPEC`:
 *   { command, script, spec }
 * and every variable of this process's own wiring is removed before the child
 * starts, so nothing leaks into the relaunched application.
 */

const { spawn } = require('node:child_process')
const { appendFileSync, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')

const raw = process.env.DSH_RESTART_LAUNCHER_SPEC
delete process.env.DSH_RESTART_LAUNCHER_SPEC
delete process.env.DSH_RESTART_SCRIPT
delete process.env.DSH_RESTART_SPEC
delete process.env.ELECTRON_RUN_AS_NODE
delete process.env.ELECTRON_NO_ATTACH_CONSOLE
delete process.env.NODE_OPTIONS

let parsed
try {
  parsed = JSON.parse(raw ?? '{}')
} catch {
  parsed = {}
}

const spec = typeof parsed.spec === 'object' && parsed.spec !== null ? parsed.spec : {}
const logFile = typeof spec.logFile === 'string' ? spec.logFile : null

function note(line) {
  if (logFile === null) return
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    appendFileSync(logFile, `${new Date().toISOString()} launcher ${line}\n`)
  } catch {}
}

function fail(reason) {
  note(reason)
  try {
    if (typeof spec.statusFile === 'string') {
      const { writeFileSync, renameSync } = require('node:fs')
      const tmp = `${spec.statusFile}.${process.pid}.tmp`
      writeFileSync(tmp, `failed: ${reason}`)
      renameSync(tmp, spec.statusFile)
    }
  } catch {}
  process.exit(2)
}

if (typeof parsed.command !== 'string' || typeof parsed.script !== 'string') fail('invalid launcher spec')

// The script is compiled from its file rather than run by path: -EncodedCommand
// is not subject to the execution policy, and the file itself never has to be
// marked as runnable.
const bootstrap = "$ErrorActionPreference='Stop'; & ([ScriptBlock]::Create([IO.File]::ReadAllText($env:DSH_RESTART_SCRIPT, [Text.Encoding]::UTF8)))"
const encoded = Buffer.from(bootstrap, 'utf16le').toString('base64')

const child = spawn(parsed.command, [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', encoded,
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: {
    ...process.env,
    DSH_RESTART_SCRIPT: parsed.script,
    DSH_RESTART_SPEC: JSON.stringify(spec),
  },
})

child.once('error', (error) => fail(`could not start powershell: ${error.message}`))

const relay = (stream, tag) => {
  if (stream === null) return
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text !== '') note(`[${tag}] ${text}`)
  })
}
relay(child.stdout, 'out')
relay(child.stderr, 'err')

child.once('exit', (code, signal) => {
  note(`powershell exited (code ${String(code)}, signal ${String(signal)})`)
  process.exit(code ?? 0)
})
