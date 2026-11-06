// 二进制响应透传回归（旧网关 502 根因）：
// 网关把 `/api/<ns>/<method>` 的响应一律当 JSON 解析后投影（forwardJson）。当宿主对该
// 路径返回 multipart/form-data、图片或 HTML 等**非 JSON** 响应时，`JSON.parse` 抛错 →
// 落到 catch 分支回 502 {"error":"Could not persist or project response"}，
// 浏览器预览（图片 / HTML 附件）因此打不开。
// 本用例驱动真实 lib/modern-gateway.js：非 JSON 响应必须原样透传（状态、Content-Type、
// 字节、长度），JSON 响应仍必须投影，且两者都不应打出 502。
//
// d361169 复审追加的两处缺陷（本文件后半部分覆盖）：
// ① **首字节嗅探绕过投影**：`projectableEnvelope` 曾用 `body[0] !== 0x7b` 提前返回，而 JSON 允许
//    前导空白（空格 / `\t` / `\n` / `\r`），`\n{"type":"server-response",…}` 是个**完全合法**的信封，
//    却被当成"非 JSON"原样放行 —— 于是投影（字段裁剪、内容改写）被一个换行符旁路，属于授权面缺陷。
//    修法：去掉首字节判定，一律交给 `JSON.parse`（它按规范跳过前导空白）。注意断言必须落在 **body**
//    上（字段被删 / 被改写），只看状态码或响应头会被"看起来正常"的透传蒙混过关。
// ② **透传分支误删 content-encoding**：非信封响应虽然字节原样放行，却把 `content-encoding` 一并
//    删掉了。上游已经给出 gzip 字节时，浏览器按"无编码"解释这些字节 → 图片 / 文档解码失败。
//    修法：透传分支保留 `content-encoding`（字节没动，编码就仍然成立）；只有**重新序列化**的投影
//    分支才该清掉编码 / 长度等框架头。两条分支因此必须真正分流，而不是形似。
// 运行：node --test test/binary-passthrough.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createModernGateway } from '../lib/modern-gateway.js'

const ADMIN = { username: 'admin', role: 'admin' }
const auth = {
  ready: Promise.resolve(),
  user: () => undefined,
  principal: () => ADMIN,
  loginKey: () => 'login:alice',
  session: () => 'alice',
  workspace: () => 'alice',
  sessionExists: async () => true,
  claimSession: async () => {},
  claimWorkspace: async () => {},
}

function makeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: 'localhost:3080' }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.destroy = () => {}
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  req[Symbol.asyncIterator] = () => {
    let i = 0
    return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
  }
  return req
}

// 假响应：必须是 EventEmitter。真实 ServerResponse 可发 `close`，`forwardJson` 会 `res.once('close', …)`；
// 旧的纯对象 mock 没有 `once`，该行抛错后 `handleHttp` 的 catch 先回 502，响应结束后 `promise.reject`
// 又没人 await —— 于是**同一个 res 被写两次**（502 错误体 + 上游 body），断言看到的就是拼接串。
function makeRes() {
  const res = new EventEmitter()
  Object.assign(res, {
    headersSent: false, status: 0, headers: {}, setHeaders: {}, chunks: [], destroyed: false, finished: false,
  })
  res.writeHead = (status, headers) => {
    res.status = status
    Object.assign(res.headers, headers || {})
    res.headersSent = true
    return res
  }
  res.setHeader = (key, value) => { res.setHeaders[key.toLowerCase()] = value }
  res.getHeader = key => res.setHeaders[key.toLowerCase()]
  // 真实 ServerResponse 的 getHeaders() 只含 setHeader 写入的头（writeHead 的并入由 Node 负责）；
  // 网关的异常清理路径会读它，这里保持同一契约。
  res.getHeaders = () => ({ ...res.setHeaders })
  res.removeHeader = (key) => { delete res.headers[key.toLowerCase()]; delete res.setHeaders[key.toLowerCase()] }
  res.write = (chunk) => { if (chunk !== undefined) res.chunks.push(Buffer.from(chunk)); return true }
  // 结束/销毁时发 `close`（同真实 ServerResponse），`handleHttp` 返回后由 `call()` 再包一层以接住收敛信号。
  res.end = (chunk) => {
    if (chunk !== undefined) res.chunks.push(Buffer.from(chunk))
    res.finished = true
    res.emit('close')
    return res
  }
  res.destroy = () => { res.destroyed = true; res.emit('close') }
  res.body = () => Buffer.concat(res.chunks)
  return res
}

function makeConnection() {
  return {
    authorizeIndex(_request, response) {
      response.writeHead(200, { 'set-cookie': 'dsh-auth-carrier=carrier; Path=/; HttpOnly' })
      return true
    },
    authenticatedUrl: baseUrl => baseUrl,
    requestRejection: () => undefined,
    createSharedFetchHandler() {
      return { fetch: async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }) }
    },
  }
}

// 线上信封的两条 Remote 入参形态之一：命名字对象 `{ args: {...} }`（admin 形状完备即放行）
const envelope = (method) => JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args: {} } })

/** 等 `res` 收敛：`finished`/`destroyed` 置位，或当轮 `forwardJson` 的 promise 落定。 */
async function waitForSettled(res, done, label) {
  const deadline = Date.now() + 2000
  let settled = false
  done.then(() => { settled = true })
  // 先让出一个宏任务：`handleHttp` 交出控制权时 `forwardJson` 的异步 IIFE 还没写完。
  await new Promise(r => setTimeout(r, 0))
  while (!res.finished && !res.destroyed && !settled && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5))
  }
  if (!res.finished && !res.destroyed) assert.fail(label)
}

/**
 * 给一次调用挂上「写完」信号。真实 ServerResponse 结束时发 `close`；`forwardJson` 用
 * `res.once('close', …)` 收敛并清掉监听，所以在**监听被清掉之后**再发一次 `close`，才说明这一轮写完。
 * 不这样做就会在 `handleHttp` 刚交出控制权、body 还没写出的同一 tick 里读断言（旧忙等的缺陷）。
 */
function settleSignal(res) {
  let resolve
  const done = new Promise(r => { resolve = r })
  const emit = res.emit.bind(res)
  res.emit = (event, ...args) => {
    const queued = event === 'close' && res.listenerCount('close') > 0
    const handled = emit(event, ...args)
    if (queued) resolve()
    return handled
  }
  return done
}

/**
 * 驱动一次 handleHttp；`upstream` 是宿主侧的假实现（直接写 res）。
 *
 * 可选参数（全部有默认值，既有用例的调用方式不变）：
 * - `principal`：本次请求的登录主体。默认是管理员（策略层直接绕过投影），因此要**证明投影真的
 *   跑过并改写了 body**，必须传一个非管理员主体。
 * - `policy`：在发起请求**之前**通过公开 seam `uiAuth.registerPolicy()` 登记的策略规则。
 * - 无论是否使用，返回值里都带上 `api`——网关用 `ctx.provide('uiAuth', publicApi)` 暴露的公开
 *   seam（`registerPolicy` 就在这里），测试可据此驱动下游插件视角的策略扩展。
 */
async function call(upstream, { method = 'session.exportAsImage', body, principal = ADMIN, policy } = {}) {
  let api
  const gateway = createModernGateway({
    get: name => (name === 'connection' ? makeConnection() : undefined),
    provide(name, value) { if (name === 'uiAuth') api = value },
    effect() {},
  }, { ...auth, principal: () => principal })
  if (policy !== undefined) {
    assert.equal(typeof api?.registerPolicy, 'function', 'ctx.provide 未暴露 uiAuth.registerPolicy')
    api.registerPolicy(policy.id, policy.rules)
  }
  const req = makeReq('POST', `/api/${method}`, body === undefined ? envelope(method) : body)
  const res = makeRes()
  const errors = []
  const done = settleSignal(res)
  const originalError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    const handled = await gateway.handleHttp(req, res, (_req, downstream) => { upstream(downstream) })
    assert.equal(handled, true)
    await waitForSettled(res, done, 'forwardJson 未在 2s 内收敛')
  } finally {
    console.error = originalError
  }
  return { res, errors, api }
}

const MULTIPART = Buffer.concat([
  Buffer.from('--XyZ\r\nContent-Disposition: form-data; name="meta"\r\n\r\n{"v":1}\r\n--XyZ\r\n'),
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.from('\r\n--XyZ--\r\n'),
])

test('multipart/form-data 响应必须原样透传，不得 502', async () => {
  const { res, errors } = await call((downstream) => {
    downstream.writeHead(200, { 'content-type': 'multipart/form-data; boundary=XyZ', 'content-length': String(MULTIPART.length) })
    downstream.write(MULTIPART.subarray(0, 16))
    downstream.end(MULTIPART.subarray(16))
  })
  assert.equal(res.status, 200, `expected 200 passthrough, got ${res.status} ${res.body().toString()}`)
  assert.equal(String(res.headers['content-type']), 'multipart/form-data; boundary=XyZ')
  assert.deepEqual(res.body(), MULTIPART)
  assert.equal(res.headers['content-length'], String(MULTIPART.length))
  assert.ok(!errors.some(line => line.includes('projection failed')), errors.join('\n'))
})

test('图片响应（image/png）必须原样透传', async () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  const { res } = await call((downstream) => {
    downstream.writeHead(200, { 'content-type': 'image/png' })
    downstream.end(PNG)
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.deepEqual(res.body(), PNG)
})

test('HTML 预览响应必须原样透传（含 <script> 字节）', async () => {
  const HTML = Buffer.from('<!doctype html><meta charset="utf-8"><p>预览</p><script>1<2</script>')
  const { res } = await call((downstream) => {
    downstream.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    downstream.end(HTML)
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
  assert.deepEqual(res.body(), HTML)
})

test('不以 { 开头的 application/json 响应也不得因解析失败变成 502', async () => {
  const { res } = await call((downstream) => {
    downstream.writeHead(200, { 'content-type': 'application/json' })
    downstream.end('not-json-at-all')
  })
  assert.notEqual(res.status, 502, `502 regression: ${res.body().toString()}`)
  assert.equal(res.status, 200)
  assert.equal(res.body().toString(), 'not-json-at-all')
})

test('JSON RPC 响应仍必须被投影（无回归）', async () => {
  // 管理员在策略层绕过投影，因此这里用普通用户 + 白名单只读端点（llm/listProviders）：
  // JSON 响应必须仍走投影路径（清 framing 头、按重算后的字节写 content-length），绝不能把
  // 原始上游字节直接放行。完整投影矩阵在 security-suite 全量覆盖。
  const RESPONSE = JSON.stringify({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: { items: [] } } })
  const gateway = createModernGateway(
    { get: name => (name === 'connection' ? makeConnection() : undefined), effect() {} },
    { ...auth, principal: () => ({ username: 'alice', role: 'user' }) },
  )
  const req = makeReq('POST', '/api/llm/listProviders', JSON.stringify({
    type: 'client-request', rpcId: 'r1', method: 'llm/listProviders', payload: { args: {} },
  }))
  const res = makeRes()
  const done = settleSignal(res)
  const handled = await gateway.handleHttp(req, res, (_req, downstream) => {
    // 真实宿主一定带 content-length；这里故意写成一个不可能等于重算值的数，
    // 「被当成二进制透传」会把它原样保留，投影路径则会删掉它并重算。
    downstream.writeHead(200, { 'content-type': 'application/json', 'content-length': '0' })
    downstream.end(RESPONSE)
  })
  assert.equal(handled, true)
  await waitForSettled(res, done, 'forwardJson 未在 2s 内收敛')
  const body = res.body().toString()
  assert.equal(res.status, 200, body)
  const parsed = JSON.parse(body)
  assert.equal(parsed.type, 'server-response')
  assert.equal(parsed.result.ok, true)
  assert.ok(Array.isArray(parsed.result.value.items))
  // 投影路径会删掉上游的 framing 头、按重算后的字节写响应：Content-Length 改由 Node 依据
  // res.end(body) 的实际长度生成（真实 ServerResponse 语义），因此这里断言的是"上游那个
  // 不可能等于重算值的 Content-Length 不得存活"，而不是要求网关自己回写一个头。
  assert.notEqual(res.headers['content-length'], '0')
})

test('带 content-encoding 的非 JSON 响应仍按上游字节透传（不误解压）', async () => {
  const { res } = await call((downstream) => {
    downstream.writeHead(200, { 'content-type': 'image/jpeg', 'content-encoding': 'identity' })
    downstream.end(Buffer.from([0xff, 0xd8, 0xff]))
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body(), Buffer.from([0xff, 0xd8, 0xff]))
})

test('上游 4xx/5xx 的非 JSON 错误体也不得被吞成 502', async () => {
  const { res } = await call((downstream) => {
    downstream.writeHead(416, { 'content-type': 'text/plain' })
    downstream.end('range not satisfiable')
  })
  assert.equal(res.status, 416)
  assert.equal(res.body().toString(), 'range not satisfiable')
})

// ---------------------------------------------------------------------------
// 复审缺陷 ①：前导空白不得绕过投影
// ---------------------------------------------------------------------------

const ALICE = { username: 'alice', role: 'user' }

/**
 * 用非管理员主体 + `uiAuth.registerPolicy()` 的 rpc 规则，拿到一个**会改写 body** 的投影：
 * 删掉 `value.secret`、把 `value.visible` 改写成 `'rewritten'`、再加上 `value.projected = true`。
 * 只有真的走了投影分支，这三处变化才会出现在响应 body 里；原样透传则 body 与上游逐字节相同。
 */
function filterPolicy(method = 'llm/listProviders') {
  return {
    id: 'test-projection-filter',
    rules: {
      rpc: {
        matches: endpoint => endpoint === method,
        authorize: () => true,
        project: (_who, value) => {
          const filtered = { ...(value || {}) }
          delete filtered.secret
          return { ...filtered, visible: 'rewritten', projected: true }
        },
      },
    },
  }
}

/** 上游会返回的信封原值：`secret` 必须在投影后被删掉。 */
const VALUE = { items: [], secret: 'TOP_SECRET', visible: 'original' }
const RESPONSE_JSON = JSON.stringify({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: VALUE } })

/** 以非管理员主体 + 过滤策略发一次 `llm/listProviders` 调用，上游回 `body`。 */
async function callProjected(body) {
  return call((downstream) => {
    downstream.writeHead(200, { 'content-type': 'application/json', 'content-length': '0' })
    downstream.end(body)
  }, {
    method: 'llm/listProviders',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'llm/listProviders', payload: { args: {} } }),
    principal: ALICE,
    policy: filterPolicy(),
  })
}

/** 断言"投影真的跑过并改写了 body"，而不只是头部或状态码看起来对。 */
function assertProjected(res, label) {
  const body = res.body().toString()
  assert.equal(res.status, 200, `${label}: ${body}`)
  const parsed = JSON.parse(body)
  assert.equal(parsed.type, 'server-response', label)
  assert.equal(parsed.result.ok, true, label)
  // 字段级证据：上游的 secret 必须已被投影删除。
  assert.equal(parsed.result.value.secret, undefined, `${label}: 投影未删除 secret，body=${body}`)
  // 值级证据：original → rewritten 说明 body 是被重新序列化的，不是原字节放行。
  assert.equal(parsed.result.value.visible, 'rewritten', `${label}: 投影未改写 visible，body=${body}`)
  assert.equal(parsed.result.value.projected, true, `${label}: 投影未生效，body=${body}`)
  assert.ok(Array.isArray(parsed.result.value.items), label)
  // 原值里的秘密串不得以任何形式残留在线上字节里。
  assert.ok(!body.includes('TOP_SECRET'), `${label}: 上游 secret 泄漏到响应：${body}`)
}

test('前导换行（\\n）的 2xx RPC 信封仍必须被投影：body 字段被真实裁剪', async () => {
  const { res } = await callProjected('\n' + RESPONSE_JSON)
  assertProjected(res, 'leading \\n')
})

test('前导 CRLF + 制表符 + 空格（\\r\\n\\t␠）的 2xx RPC 信封仍必须被投影', async () => {
  const { res } = await callProjected('\r\n\t ' + RESPONSE_JSON)
  assertProjected(res, 'leading \\r\\n\\t + space')
})

test('前导空格的 2xx RPC 信封仍必须被投影', async () => {
  const { res } = await callProjected('   ' + RESPONSE_JSON)
  assertProjected(res, 'leading spaces')
})

test('无前导空白是投影路径的对照基线（对照组，若它也失败则说明策略装配有问题）', async () => {
  const { res } = await callProjected(RESPONSE_JSON)
  assertProjected(res, 'no leading whitespace')
})

test('前导 UTF-8 BOM（EF BB BF）**故意**不剥离：JSON.parse 按规范拒绝它，必须逐字节透传', async () => {
  // 这条是**有意为之**的行为声明，不是遗漏：`JSON.parse` 不接受 BOM（Node 也不替调用方剥离），
  // 因此 BOM 开头的 body 不是可投影信封 → 走透传分支，字节与上游完全一致：既不 502、不投影、
  // 也不擅自"修复"编码。要让 BOM 也进入投影，就得先手写一个 BOM 去除器，那等于自己实现一份
  // JSON 词法规则，比透传更容易出错 —— 所以这里锁定"透传"这个决定。
  const BOM = Buffer.from([0xef, 0xbb, 0xbf])
  const body = Buffer.concat([BOM, Buffer.from(RESPONSE_JSON)])
  const { res } = await callProjected(body)
  assert.equal(res.status, 200, res.body().toString())
  assert.notEqual(res.status, 502)
  // 逐字节一致：BOM 还在，secret 也还在（未投影），没有任何重序列化痕迹。
  assert.deepEqual(res.body(), body, 'BOM 前缀的 body 必须逐字节透传')
  assert.deepEqual(res.body().subarray(0, 3), BOM, 'BOM 必须保留')
  const parsed = JSON.parse(res.body().toString('utf8').replace(/^\uFEFF/, ''))
  assert.equal(parsed.result.value.secret, 'TOP_SECRET', 'BOM body 不应被投影（故 secret 仍在）')
  assert.equal(parsed.result.value.projected, undefined, 'BOM body 不应被投影')
})

// ---------------------------------------------------------------------------
// 复审缺陷 ②：透传分支必须保留 content-encoding
// ---------------------------------------------------------------------------

test('上游 gzip 的非 JSON 响应透传：content-encoding 必须保留，字节逐一致且可解压回原载荷', async () => {
  const PAYLOAD = Buffer.from('JPEG-ish payload 图片载荷 —— 必须能在浏览器侧正常解码'.repeat(4))
  const GZ = gzipSync(PAYLOAD)
  // 前提自检：真实 gzip 字节，且与原载荷不同（否则"字节一致"是空断言）。
  assert.notDeepEqual(GZ, PAYLOAD)

  const { res, errors } = await call((downstream) => {
    downstream.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-encoding': 'gzip',
      'content-length': String(GZ.length),
    })
    downstream.end(GZ)
  })

  assert.equal(res.status, 200, `expected 200 passthrough, got ${res.status} ${res.body().toString()}`)
  // (a) 字节逐一致：网关不解压、不改写。
  assert.deepEqual(res.body(), GZ, 'gzip 字节必须原样透传（网关不得解压或重压缩）')
  // (b) 关键回归点：旧实现会把 content-encoding 删掉，浏览器于是把 gzip 字节当原图解析 → 花屏。
  assert.equal(res.headers['content-encoding'], 'gzip', 'content-encoding 必须保留，否则浏览器无法解码')
  // (c) 长度与透传字节一致（上游给的值本来就对，不应被删改）。
  assert.equal(res.headers['content-length'], String(GZ.length))
  assert.equal(Number(res.headers['content-length']), res.body().length)
  // (d) 解压后必须拿回原载荷 —— 证明"字节一致"在语义上也成立。
  assert.deepEqual(gunzipSync(res.body()), PAYLOAD)
  // 不应因为压缩内容不是 JSON 而打出 502 / 投影失败日志。
  assert.ok(!errors.some(line => line.includes('projection failed')), errors.join('\n'))
})

test('上游 gzip 的 content-length 与实际字节不符时按实际透传字节修正（编码仍保留）', async () => {
  const GZ = gzipSync(Buffer.from('hello gzip'))
  const { res } = await call((downstream) => {
    downstream.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip', 'content-length': String(GZ.length + 99) })
    downstream.end(GZ)
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body(), GZ)
  assert.equal(res.headers['content-encoding'], 'gzip', 'content-encoding 不应因长度修正而丢失')
  assert.notEqual(res.headers['content-length'], String(GZ.length + 99), '错误的 content-length 必须被修正')
  assert.deepEqual(gunzipSync(res.body()), Buffer.from('hello gzip'))
})

// ---------------------------------------------------------------------------
// 两条分支必须真正分流：投影分支仍要清掉上游的框架 / 编码头
// ---------------------------------------------------------------------------

test('投影分支仍必须清掉 content-encoding 与 content-length（重序列化后这些头不再描述字节）', async () => {
  // 上游对同一个 JSON 信封谎称 `content-encoding: gzip` + `content-length: 0`。
  // 投影分支会把信封重新序列化成 identity 字节：此时若还留着 content-encoding: gzip，
  // 浏览器会把明文 JSON 当 gzip 解压而报错 —— 所以投影分支必须清掉它。
  // 反过来，这正是"透传分支保留编码 / 投影分支丢弃编码"这一分流的反向锚点。
  const falsified = await call((downstream) => {
    downstream.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '0' })
    downstream.end(RESPONSE_JSON)
  }, {
    method: 'llm/listProviders',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'llm/listProviders', payload: { args: {} } }),
    principal: ALICE,
    policy: filterPolicy('llm/listProviders'),
  })
  // 响应体必须是**合法 JSON**（真正的重序列化字节，不是 gzip 密文）。
  const body = falsified.res.body().toString()
  assert.equal(falsified.res.status, 200, body)
  const parsed = JSON.parse(body) // 若不合法会在此抛错
  assert.equal(parsed.type, 'server-response')
  // 投影确实生效（body 级证据）。
  assert.equal(parsed.result.value.secret, undefined, `投影未删除 secret：${body}`)
  assert.equal(parsed.result.value.projected, true)
  // 分流的另一半：投影分支必须丢弃伪造的编码头与失真的长度头。
  assert.equal(falsified.res.headers['content-encoding'], undefined, '重序列化后不得再声明 content-encoding')
  assert.notEqual(falsified.res.headers['content-length'], '0', '重序列化后上游的 content-length 必须被丢弃')
})
