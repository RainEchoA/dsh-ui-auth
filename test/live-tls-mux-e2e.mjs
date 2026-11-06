/**
 * 端到端：TLS 直连部署下 mux 通道必须真正打通。
 *
 * 与 `test/tls-mux-scheme.test.mjs` 的区别：
 *   - 那个是**单元级**：进程内起一个 TLS 宿主 mux，驱动 `proxyMuxUpgrade` 断言回连 scheme；
 *   - 这个是**端到端**：起一个真实的 DSH 实例并以 `--tls-cert/--tls-key` 监听（README 安全说明
 *     承认的「TLS 直连」形态），经本插件的 mux 透明代理走完整 WS 升级，断言拿到会话列表。
 *
 * 为什么需要它：scheme 回连错了时，服务端**零日志**（上游 `error` 只触发静默 shutdown），
 * 现场只表现为「登录正常、左下角无限重新连接中、会话列表为空」。只查代码或只测进程内
 * 单元都会漏掉这条断链——必须有真实实例把它跑通。
 *
 * 用法：
 *   DSH_E2E_CLI=<dsh 可执行文件> \
 *   DSH_E2E_PORT=3210 \
 *   DSH_E2E_TLS_CERT=<证书> DSH_E2E_TLS_KEY=<私钥> \
 *   node test/live-tls-mux-e2e.mjs
 *
 * 或经 launcher 运行（注入 NODE_EXTRA_CA_CERTS 信任测试证书）：
 *   node test/live-tls-mux-e2e.run.mjs <dsh 可执行文件>
 *
 * 退出码：0 = 通道打通；1 = 通道不通或断言失败（CI 依赖）。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '..')

const CLI = process.env.DSH_E2E_CLI
const PORT = Number(process.env.DSH_E2E_PORT ?? 3302)
const TLS_CERT = process.env.DSH_E2E_TLS_CERT ?? join(here, 'tls-mux-scheme-cert.pem')
const TLS_KEY = process.env.DSH_E2E_TLS_KEY ?? join(here, 'tls-mux-scheme-key.pem')

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

if (CLI === undefined || CLI === '') {
  console.log('SKIP 未提供 DSH_E2E_CLI，跳过端到端 TLS 用例（本地请显式传入 dsh 路径）')
  process.exit(0)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tls-e2e-'))
const work = path.join(root, 'work')
fs.mkdirSync(work, { recursive: true })
const env = { ...process.env, DSH_HOME: path.join(root, 'home') }
const base = `https://127.0.0.1:${PORT}`

let server
const stop = () => {
  if (server === undefined) return
  try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch { /* 已退出 */ } }
  server = undefined
}

const waitFor = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await predicate()) return true } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`等待超时：${label}`)
}

try {
  // 1. 用一次性 profile 装上本插件（与兼容矩阵同一套做法）
  const profile = spawnSync(CLI, ['plugin', '--profile', 'web', 'add', REPO], { encoding: 'utf8', env, cwd: work })
  check('插件安装到一次性 profile', profile.status === 0, profile.stderr?.split('\n').slice(-2).join(' / ') ?? '')

  // 2. 以 TLS 直连方式启动真实 DSH
  const serverLog = fs.openSync(path.join(root, 'server.log'), 'w')
  server = spawn(CLI, [
    'web', '--port', String(PORT), '--no-open',
    '--tls-cert', TLS_CERT, '--tls-key', TLS_KEY,
    '--trusted-host', `127.0.0.1:${PORT}`,
  ], { cwd: work, env, detached: true, stdio: ['ignore', serverLog, serverLog] })

  // 端口通了 ≠ 插件就绪：插件先监听后写 bootstrap 文件，必须等文件
  const bootstrap = path.join(work, 'dsh-ui-auth-bootstrap.txt')
  await waitFor(() => fs.existsSync(bootstrap) && fs.statSync(bootstrap).size > 0, 120_000, 'dsh-ui-auth-bootstrap.txt')

  const password = (/密码:\s*(\S+)/.exec(fs.readFileSync(bootstrap, 'utf8')) ?? [])[1]
  check('从 bootstrap 取到管理员口令', typeof password === 'string' && password.length > 0)

  // 3. HTTPS 登录门可用（TLS 直连的第一层证据）
  const rootResp = await fetch(base + '/', { redirect: 'manual' })
  check('未认证 GET / → 302 登录页（HTTPS 可达）', rootResp.status === 302,
    `status=${rootResp.status} location=${rootResp.headers.get('location')}`)
  const loginPage = await fetch(base + '/auth/login')
  check('GET /auth/login → 200', loginPage.status === 200, `status=${loginPage.status}`)

  // 4. 登录拿会话 cookie
  const loginResp = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  })
  const cookies = loginResp.headers.getSetCookie?.() ?? []
  const cookie = (cookies[0] ?? loginResp.headers.get('set-cookie') ?? '').split(';')[0]
  check('登录成功并拿到会话 cookie', loginResp.status === 200 && cookie.includes('='),
    `status=${loginResp.status}`)

  // 5. 核心断言：经本插件代理的 mux 通道必须真正打通。
  //    这就是修复前断掉的那条链路——写死 ws:// 时 TLS 宿主会拒掉握手。
  // 判据选择：「入站 wss 握手成功」不足以证明修复生效——那是浏览器到网关这一段，
  // 回连 scheme 写错时它照样成功，真正断掉的是**网关到宿主**那一段。
  // 与单元用例一致，改用「发一帧 open，看是否有**任何**回帧或明确的上游失败信号」。
  //
  // 注意 mux 是被动通道：宿主不会主动推送，客户端必须先发帧。
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${PORT}/api/remote.mux`, {
      headers: { cookie, origin: base },
      rejectUnauthorized: true,
    })
    const frames = []
    let settled = false
    const finish = (ok, why) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.terminate() } catch { /* ignore */ }
      resolve({ ok, why, frames })
    }
    const timer = setTimeout(() => finish(frames.length > 0, `30s 内收到 ${frames.length} 帧`), 30_000)
    ws.on('open', () => {
      // 触发一次真实往返：open 一个只读端点，宿主应回帧。
      try {
        ws.send(JSON.stringify({
          type: 'open', streamId: 'e2e-probe', endpoint: 'session/list',
          payload: { type: 'client-request', rpcId: 'e2e-probe', method: 'session/list', payload: { args: {} } },
        }))
      } catch (error) { finish(false, `发送探测帧失败：${error.message}`) }
    })
    ws.on('message', data => { frames.push(String(data).slice(0, 120)); finish(true, `收到第 ${frames.length} 帧`) })
    ws.on('close', (code) => finish(frames.length > 0, `连接被关闭（code=${code}，${frames.length} 帧）`))
    ws.on('error', error => finish(false, `连接错误：${error.message}`))
    ws.on('unexpected-response', (_req, res) => { res.resume(); finish(false, `升级被拒：HTTP ${res.statusCode}`) })
  })

  check('mux 通道经本插件代理后真正承载数据', outcome.ok === true,
    outcome.ok ? outcome.why : `${outcome.why} —— 回连 scheme 可能仍写死为 ws://`)
} catch (error) {
  fail += 1
  console.log(`FAIL 端到端 TLS 用例异常：${error instanceof Error ? error.message : String(error)}`)
  const logPath = path.join(root, 'server.log')
  if (fs.existsSync(logPath)) {
    console.log('  宿主日志尾部：')
    for (const line of fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-15)) console.log('    ' + line)
  }
} finally {
  stop()
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail === 0 ? 0 : 1)
