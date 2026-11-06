// mux 透明代理回连协议选型（TLS 直连部署回归）：
// DSH 以 --tls-cert/--tls-key 直接监听时，宿主端口只有 TLS；代理回连写死 ws:// 会在
// 握手阶段被断开 → 上游永远连不上 → 前端无限「重新连接中」、会话列表为空。
// 本用例起真实（TLS 或明文）宿主 mux，驱动 proxyMuxUpgrade 的完整 WS 握手，
// 断言回连 scheme 与宿主监听协议一致。
// 由 test/tls-mux-scheme.run.mjs 启动（注入 NODE_EXTRA_CA_CERTS 信任下面的测试证书）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { createModernGateway } from '../lib/modern-gateway.js'

const here = dirname(fileURLToPath(import.meta.url))
const CERT = readFileSync(join(here, 'tls-mux-scheme-cert.pem'), 'utf8')
const KEY = readFileSync(join(here, 'tls-mux-scheme-key.pem'), 'utf8')

const auth = {
  ready: Promise.resolve(),
  user: () => undefined,
  principal: () => undefined,
  loginKey: () => 'login:alice',
  session: () => 'alice',
  workspace: () => 'alice',
  sessionExists: async () => true,
  claimSession: async () => {},
  claimWorkspace: async () => {},
}
const gateway = createModernGateway({ get: () => undefined, effect() {} }, auth)

/**
 * 驱动真实 ws 握手的假客户端 socket（与 security-suite 同一模式，补齐 ws 用到的钩子）。
 * 必须是真实 Duplex 流：ws 的关闭处理读取流的内部状态，且网关依赖 client 的 'close'
 * 事件做 shutdown 级联（断开代理上游），否则存活的连接会拖住测试进程无法退出。
 */
function fakeSocket(extra = {}) {
  const socket = new PassThrough()
  socket.written = []
  socket.setKeepAlive = () => {}
  socket.setTimeout = () => {}
  socket.setNoDelay = () => {}
  socket.on('data', chunk => { socket.written.push(Buffer.from(chunk)) })
  return Object.assign(socket, extra)
}

function upgradeReq(host, socket) {
  return {
    method: 'GET', url: '/api/remote.mux', socket,
    headers: {
      host, upgrade: 'websocket', connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
    },
  }
}

async function driveMuxProxy({ tls, server }) {
  const wss = new WebSocketServer({ noServer: true })
  let upstreamConnected = 0
  // noServer 模式下 'connection' 事件不会自动发射，升级完成的回调即代表上游已连通
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, () => { upstreamConnected += 1 }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const client = fakeSocket(tls ? { encrypted: true } : {})
  try {
    gateway.proxyMuxUpgrade(
      upgradeReq(`127.0.0.1:${address.port}`, client),
      client, Buffer.alloc(0),
      { host: `127.0.0.1:${address.port}`, cookie: undefined, who: { username: 'alice', role: 'user' } },
    )
    // 客户端握手应已完成（101 已写入假 socket），与上游是否连上无关
    assert.ok(client.written.some(chunk => chunk.toString('latin1').includes('101 Switching Protocols')))
    const deadline = Date.now() + 2000
    while (upstreamConnected === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  } finally {
    client.destroy() // 触发网关 shutdown 级联断开代理上游，避免存活连接拖住测试进程
    wss.close(); server.close()
    await Promise.race([once(server, 'close'), new Promise(resolve => setTimeout(resolve, 500))])
  }
  return upstreamConnected
}

test('mux 代理回连直连 TLS 宿主时必须用 wss://（否则握手阶段即被断开）', async () => {
  const connected = await driveMuxProxy({ tls: true, server: createServer({ cert: CERT, key: KEY }) })
  assert.equal(connected, 1)
})

test('明文 HTTP 宿主仍回连 ws://（无回归）', async () => {
  const connected = await driveMuxProxy({ tls: false, server: createHttpServer() })
  assert.equal(connected, 1)
})
