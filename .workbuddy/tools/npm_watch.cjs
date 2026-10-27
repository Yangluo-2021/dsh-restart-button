'use strict'
// npm web 登录常驻监听：session 过期自动续期，token 拿到就落盘
const path = require('path')
const fs = require('fs')

const NPM_LIB = 'C:/Users/99687/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/npm/node_modules/npm-registry-fetch'
const regFetch = require(NPM_LIB)

const REGISTRY = 'https://registry.npmjs.org'
const DIR = 'C:/Users/99687/Desktop/DSH插件发布/.workbuddy'
const URL_FILE = path.join(DIR, 'npm_login_url.txt')
const TOKEN_FILE = path.join(DIR, 'npm_token.txt')

const COMMON = {
  registry: REGISTRY,
  npmCommand: 'login',
  authType: 'web',
  userAgent: 'npm/10.9.7 node/v22.22.2 win32 x64 workspaces/false',
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 计划任务下 stdout 不可见，自己写日志
const LOG_FILE = path.join(DIR, 'npm_watch.log')
function log (msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n'
  try { fs.appendFileSync(LOG_FILE, line, 'utf8') } catch {}
  console.log(msg)
}

async function createSession () {
  const res = await regFetch('/-/v1/login', { ...COMMON, method: 'POST', body: {} })
  const c = await res.json()
  if (!c.loginUrl || !c.doneUrl) throw new Error('bad response: ' + JSON.stringify(c))
  return c
}

async function checkDone (doneUrl) {
  const res = await regFetch(doneUrl, { ...COMMON, cache: false })
  if (res.status === 200) {
    const c = await res.json()
    return { token: c.token || null }
  }
  if (res.status === 202) {
    return { pending: true, retry: Number(res.headers.get('retry-after') || 3) * 1000 }
  }
  return { expired: true, status: res.status }
}

function writeUrl (u) {
  fs.writeFileSync(URL_FILE, u, 'utf8')
  log('[url] ' + u)
}

async function main () {
  try { fs.unlinkSync(TOKEN_FILE) } catch {}
  let s = await createSession()
  writeUrl(s.loginUrl)
  log('[start] session 已创建，开始轮询（过期自动续期）')

  for (;;) {
    const r = await checkDone(s.doneUrl)
    if (r.token) {
      fs.writeFileSync(TOKEN_FILE, r.token, 'utf8')
      log('[ok] 授权成功，token 长度=' + r.token.length)
      log('TOKEN=' + r.token)
      return
    }
    if (r.expired) {
      log('[expired] session 失效 (' + r.status + ')，续期…')
      s = await createSession()
      writeUrl(s.loginUrl)
      continue
    }
    await sleep(r.retry || 3000)
  }
}

main().catch(e => { log('FATAL ' + e.message); process.exit(1) })
