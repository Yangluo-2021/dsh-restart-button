'use strict'
// 对比 npm CLI 与直调 regFetch 发出的 POST /-/v1/login 请求差异
const http = require('http')
const path = require('path')

const NPM_LIB = 'C:/Users/99687/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/npm/node_modules/npm-registry-fetch'
const regFetch = require(NPM_LIB)

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    console.log('=== 收到请求 ===')
    console.log(req.method, req.url)
    console.log('--- headers ---')
    for (const [k, v] of Object.entries(req.headers)) {
      console.log(`${k}: ${v}`)
    }
    console.log('--- body ---')
    console.log(body || '(empty)')
    console.log('==================')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ loginUrl: 'http://x/login', doneUrl: 'http://x/done' }))
  })
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/`
  console.log('mock server on', base)

  // 用与 npm CLI 相同的参数
  await regFetch('/-/v1/login', {
    method: 'POST',
    body: {},
    registry: base,
    npmCommand: 'login',
    userAgent: 'npm/10.9.7 node/v22.22.2 win32 x64 workspaces/false',
  }).then(r => r.json()).catch(e => console.log('err:', e.message))

  server.close()
  process.exit(0)
})
