'use strict'
// 用 mock server 拦截 npm CLI 自己的 POST /-/v1/login，拿到真实请求头
const http = require('http')
const { spawn } = require('child_process')
const fs = require('fs')

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    console.log('=== CLI 真实请求 ===')
    console.log(req.method, req.url)
    for (const [k, v] of Object.entries(req.headers)) {
      console.log(`${k}: ${v}`)
    }
    console.log('body:', body || '(empty)')
    console.log('====================')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ loginUrl: 'http://127.0.0.1/login', doneUrl: 'http://127.0.0.1/done' }))
  })
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/`
  console.log('mock on', base)

  const child = spawn('npm', ['login', '--auth-type=web', '--registry', base], {
    shell: true,
    env: { ...process.env, npm_config_loglevel: 'silly' },
  })
  let out = ''
  child.stdout.on('data', d => { out += d.toString() })
  child.stderr.on('data', d => { out += d.toString() })

  setTimeout(() => {
    child.kill()
    server.close()
    console.log('\n--- CLI 输出尾部 ---')
    console.log(out.split('\n').slice(-12).join('\n'))
    process.exit(0)
  }, 15000)
})
