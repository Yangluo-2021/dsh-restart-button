'use strict'
// 自建 npm web 登录会话管理：完全掌控 session 生命周期
// 用 npm 自带的 npm-registry-fetch，保证与 npm CLI 行为完全一致
const path = require('path')
const fs = require('fs')

const NPM_LIB = path.join(
  process.env.APPDATA ? '' : '',
  'C:/Users/99687/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/npm/node_modules/npm-registry-fetch'
)
const regFetch = require(NPM_LIB)

const REGISTRY = 'https://registry.npmjs.org'
const OUT = 'C:/Users/99687/Desktop/DSH插件发布/.workbuddy/npm_session.json'

// 与 npm CLI 一致的请求头
// 关键：npm-auth-type 缺失会返回 401 "You must be logged in to publish packages"
const COMMON = {
  registry: REGISTRY,
  npmCommand: 'login',
  authType: 'web',
  userAgent: 'npm/10.9.7 node/v22.22.2 win32 x64 workspaces/false',
}

async function createSession () {
  const res = await regFetch('/-/v1/login', {
    ...COMMON,
    method: 'POST',
    body: {},
  })
  const content = await res.json()
  if (!content.loginUrl || !content.doneUrl) {
    throw new Error('bad response: ' + JSON.stringify(content))
  }
  return content
}

async function checkDone (doneUrl) {
  const res = await regFetch(doneUrl, { ...COMMON, cache: false })
  if (res.status === 200) {
    const c = await res.json()
    return c.token || null
  }
  if (res.status === 202) {
    const retry = Number(res.headers.get('retry-after') || 3) * 1000
    return { pending: true, retry }
  }
  return { expired: true, status: res.status }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main () {
  const mode = process.argv[2] || 'session'

  if (mode === 'session') {
    // 只创建 session 并把链接写文件
    const s = await createSession()
    fs.writeFileSync(OUT, JSON.stringify({ loginUrl: s.loginUrl, doneUrl: s.doneUrl, at: Date.now() }, null, 2))
    console.log('LOGIN_URL=' + s.loginUrl)
    console.log('SESSION_ID=' + new URL(s.loginUrl).searchParams.get('next').split('/').pop())
    return
  }

  if (mode === 'watch') {
    // 持续轮询；session 过期则自动换新并重写链接文件
    let s = await createSession()
    fs.writeFileSync(OUT, JSON.stringify({ loginUrl: s.loginUrl, doneUrl: s.doneUrl, at: Date.now() }, null, 2))
    console.log('LOGIN_URL=' + s.loginUrl)
    console.log('[watch] session 已创建，开始轮询')

    let lastUrl = s.loginUrl
    for (;;) {
      const r = await checkDone(s.doneUrl)
      if (r && r.token) {
        fs.writeFileSync(OUT + '.token', r.token, 'utf8')
        console.log('TOKEN=' + r.token)
        console.log('[watch] 授权成功，token 已保存')
        return
      }
      if (r && r.expired) {
        console.log('[watch] session 已过期 (' + r.status + ')，自动续期…')
        s = await createSession()
        fs.writeFileSync(OUT, JSON.stringify({ loginUrl: s.loginUrl, doneUrl: s.doneUrl, at: Date.now() }, null, 2))
        console.log('LOGIN_URL=' + s.loginUrl)
        lastUrl = s.loginUrl
        continue
      }
      await sleep(r && r.retry ? r.retry : 3000)
    }
  }
}

main().catch(e => { console.error('FATAL', e.message); process.exit(1) })
