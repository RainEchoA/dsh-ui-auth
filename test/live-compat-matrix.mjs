/**
 * 多版本兼容矩阵运行器（可复现）。
 *
 * 对每个 DSH 版本：装一个**一次性** CLI + profile（把本仓库作为插件加入）→ 启动到独立端口 →
 * 跑 `test/live-020-check.mjs`（同一套 38 项断言）→ 记录通过/失败数 → 停实例、清理。
 *
 * 用法：
 *   node test/live-compat-matrix.mjs                            # 最新 rc + 区间下限（默认）
 *   node test/live-compat-matrix.mjs 0.1.7-rc.2 0.1.6-alpha.2   # 考古：显式指定版本
 *   MATRIX_OFFLINE=1 node test/live-compat-matrix.mjs           # 跳过网络探测，只跑固定下限
 *
 * 守护范围：**只守护新版本 DSH**。默认跑两个端点，合起来才真正佐证 package.json 里
 * `>=0.2.0-rc.2 <0.3.0` 这个声明：
 *   - **最新 rc**：运行时从 npm 动态解析（默认取 `latest` dist-tag），上游发新版第二天就能发现不兼容；
 *   - **区间下限**：写死在 MIN_VERSION，防止"只测最新版能用"却悄悄丢了下限兼容。
 * 探测失败（离线/限流）时退回 MIN_VERSION 并明确告警，不会静默跳过守护。
 *
 * 历史版本的实测记录保留在兼容性文档里供考古，但不再是 CI 的守护对象。
 *
 * 判读：历史版本里"宿主不存在的端点"会返回 404，那属于**能力收窄**而不是回归；
 * 结果写回 docs/DSH-0.2.0-COMPATIBILITY.md 的矩阵表。守护范围内应为全绿。
 *
 * 退出码（CI 依赖它，否则矩阵失败也会假绿）：
 *   0  每个版本都跑到并给出了结论（能力收窄 37/38 仍算 0——见 docs 的判读口径）
 *   1  至少一个版本**未能评估**：安装失败、启动超时、或检查脚本没产出结果行
 *      这类才是"回归/环境坏了"，必须让流水线红。
 * 设 `MATRIX_STRICT=1` 时改为：任何版本只要有失败断言就退出 1（用于锁定当前支持线）。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
const DSH_PACKAGE = '@deepseek-ai/dsh'

/**
 * 兼容区间的**下限**，写死。上线时必须与 package.json 的 `dsh.compatibility.dsh` 一致：
 * 它是我们对外承诺的最低 DSH 版本，必须始终有实测覆盖，不能只测最新版。
 */
const MIN_VERSION = '0.2.0-rc.2'

/** 从 npm 取最新 rc：优先 `latest` dist-tag，没有就退回 semver 排序里最大的 rc/alpha 之外版本。 */
function latestRcVersion() {
  const tags = sh('npm', ['view', DSH_PACKAGE, 'dist-tags', '--json'], { timeout: 30_000 })
  if (tags.status === 0) {
    try {
      const parsed = JSON.parse(tags.stdout)
      for (const key of ['latest', 'next']) {
        const value = parsed?.[key]
        if (typeof value === 'string' && value.length > 0) return value
      }
    } catch { /* 落到下面的 all-versions 分支 */ }
  }
  // 退路：列全部版本，按 semver 取最大（预发布也算在内）。
  const all = sh('npm', ['view', DSH_PACKAGE, 'versions', '--json'], { timeout: 30_000 })
  if (all.status !== 0) return undefined
  try {
    const list = JSON.parse(all.stdout)
    if (!Array.isArray(list) || list.length === 0) return undefined
    const parse = v => v.split(/[-+]/)[0].split('.').map(Number)
    return [...list].sort((x, y) => {
      const [a1, b1, c1] = parse(x); const [a2, b2, c2] = parse(y)
      return (a2 - a1) || (b2 - b1) || (c2 - c1)
    })[0]
  } catch { return undefined }
}

/** 默认版本集合：最新 rc + 区间下限（去重后保序）。 */
function defaultVersions() {
  if (process.env.MATRIX_OFFLINE === '1') {
    console.log(`MATRIX_OFFLINE=1：跳过最新 rc 探测，只跑区间下限 ${MIN_VERSION}`)
    return [MIN_VERSION]
  }
  const latest = latestRcVersion()
  if (latest === undefined) {
    console.log(`⚠️  无法从 npm 解析最新 DSH 版本（离线或限流），只跑区间下限 ${MIN_VERSION}`)
    return [MIN_VERSION]
  }
  console.log(`最新 DSH 版本（npm）：${latest}；区间下限：${MIN_VERSION}`)
  return [...new Set([latest, MIN_VERSION])]
}

const BASE_PORT = Number(process.env.MATRIX_PORT ?? 3210)
const isWindows = process.platform === 'win32'

const sh = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: 'utf8', shell: isWindows, ...options })

// 注意：必须在 `sh` 之后求值——defaultVersions() 会调用它探测 npm，
// 放在前面会撞上 const 的暂时性死区。
const versions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultVersions()

const waitForPort = async (port, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/auth/login`, { redirect: 'manual' })
      if (response.status > 0) return true
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  return false
}

/**
 * Wait for the one-time bootstrap file the plugin writes on first start.
 *
 * Listening is not the same as ready: the server accepts requests before the plugin's own
 * startup has written that file (the plugin logs its URL first, then creates the admin
 * account). Waiting only on the port raced here and made the checker die with ENOENT on
 * slower machines — CI failed for that reason while a fast local run never hit it.
 */
const waitForFile = async (file, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

const stopTree = (pid) => {
  if (isWindows) sh('taskkill', ['/PID', String(pid), '/T', '/F'])
  else { try { process.kill(-pid, 'SIGKILL') } catch { /* ignore */ } }
}

const results = []
for (const [index, version] of versions.entries()) {
  const port = BASE_PORT + index
  const root = path.join(os.tmpdir(), `dsh-matrix-${version.replace(/[^\w.-]/g, '_')}`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'work'), { recursive: true })
  const cliBin = path.join(root, 'cli', 'node_modules', '.bin', isWindows ? 'dsh.cmd' : 'dsh')
  const env = { ...process.env, DSH_HOME: path.join(root, 'home'), PUPPETEER_SKIP_DOWNLOAD: 'true' }
  console.log(`\n===== ${version}（端口 ${port}）`)

  const install = sh('npm', ['install', '--prefix', path.join(root, 'cli'), `@deepseek-ai/dsh@${version}`], { env })
  if (install.status !== 0) {
    console.log(`  安装失败：${(install.stderr ?? '').split('\n').slice(-3).join(' / ')}`)
    results.push({ version, installed: false })
    continue
  }
  // 装上插件是这个矩阵的全部意义：失败必须立刻停下并报出来。原来这里不检查返回值，
  // 插件装失败也会一路跑到"起实例 → 跑检查"，最后只看到一堆莫名其妙的断言失败。
  const added = sh(cliBin, ['plugin', '--profile', 'web', 'add', REPO], { env, cwd: path.join(root, 'work') })
  if (added.status !== 0) {
    console.log('  插件安装失败：')
    for (const line of `${added.stderr ?? added.stdout ?? ''}`.trim().split('\n').slice(-15)) console.log('    ' + line)
    results.push({ version, installed: true, booted: false })
    continue
  }

  // 把宿主自己的输出收进日志，而不是 `stdio: 'ignore'`：插件"没写 bootstrap 文件"
  // 这类失败，原因只存在于宿主/插件的日志里（写入报错、初始化异常、宿主插件未加载）。
  const serverLog = fs.openSync(path.join(root, 'server.log'), 'w')
  const server = spawn(cliBin, ['web', '--port', String(port), '--no-open'], {
    cwd: path.join(root, 'work'), env, detached: !isWindows, stdio: ['ignore', serverLog, serverLog], shell: isWindows,
  })
  try {
    if (!(await waitForPort(port, 150_000))) {
      console.log('  启动超时')
      results.push({ version, installed: true, booted: false })
      continue
    }
    const bootstrap = path.join(root, 'work', 'dsh-ui-auth-bootstrap.txt')
    // 端口通了不等于插件就绪：插件先监听、后写 bootstrap 文件，这里必须等文件出现，
    // 否则检查脚本会以 ENOENT 崩掉（慢机器/CI 上必现，快机器上偶发）。
    if (!(await waitForFile(bootstrap, 60_000))) {
      console.log('  插件未在 60s 内写出 dsh-ui-auth-bootstrap.txt（实例可能初始化失败）')
      const logPath = path.join(root, 'server.log')
      const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-20) : ['（无日志）']
      console.log('  宿主日志尾部：')
      for (const line of tail) console.log('    ' + line)
      results.push({ version, installed: true, booted: true, pass: 0, fail: -1 })
      continue
    }
    const check = sh('node', [path.join(REPO, 'test', 'live-020-check.mjs')], {
      env: { ...env, DSH020_URL: `http://127.0.0.1:${port}`, DSH020_BOOTSTRAP: bootstrap },
      cwd: REPO,
    })
    const output = `${check.stdout ?? ''}`
    const summary = /结果:\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(output)
    const failures = output.split('\n').filter(line => line.startsWith('FAIL')).map(line => line.trim())
    const pass = summary === null ? 0 : Number(summary[1])
    const fail = summary === null ? -1 : Number(summary[2])
    console.log(`  结果：${pass} 通过 / ${fail} 失败`)
    for (const line of failures) console.log('    ' + line)
    // 没拿到结果行 = 检查脚本自己崩了（或没跑到汇总）。它的异常堆栈在 stderr，
    // 只读 stdout 会让原因彻底消失——这里必须把 stderr 与退出码打出来，否则无法排障。
    if (summary === null) {
      console.log(`  检查脚本异常退出（exit ${check.status}），stderr：`)
      for (const line of `${check.stderr ?? ''}`.trim().split('\n').slice(-15)) console.log('    ' + line)
    }
    results.push({ version, installed: true, booted: true, pass, fail, failures })
  } finally {
    stopTree(server.pid)
    try { fs.closeSync(serverLog) } catch { /* 已被关闭 */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const markdown = [
  '| DSH 版本 | 结论 | 通过/总数 | 失败项 |',
  '|---|---|---|---|',
  ...results.map(entry => {
    if (entry.booted !== true) return `| \`${entry.version}\` | ❌ | 未能启动 | |`
    // fail < 0：没拿到结果行（实例初始化失败 / 检查脚本崩溃）。此时没有失败项可列，
    // 必须单独成档——否则会掉进下面的 "能力收窄" 分支并读一个不存在的 failures 数组。
    if (entry.fail < 0) return `| \`${entry.version}\` | ❌ | 未能评估 | |`
    const verdict = entry.fail === 0 ? '✅ compatible' : '⚠️ 能力收窄'
    return `| \`${entry.version}\` | ${verdict} | ${entry.pass}/${entry.pass + entry.fail} | ${(entry.failures ?? []).slice(0, 3).join('；')} |`
  }),
].join('\n')
// GitHub Actions 的 job summary（本地运行时该变量不存在，跳过）
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 兼容矩阵\n\n${markdown}\n`, 'utf8')
}

fs.writeFileSync(path.join(REPO, 'matrix-result.json'), JSON.stringify(results, null, 2), 'utf8')
console.log('\n结果已写入 matrix-result.json（未跟踪，供人工回填文档）')

// 退出码判定：只有"未能评估"（没装/没起/没结果）才算硬失败。
// 能力收窄（如 37/38，失败项是宿主不存在的端点）按 docs 口径仍属 compatible，不算失败；
// 需要把收窄也当失败时用 MATRIX_STRICT=1。
const unevaluated = results.filter(entry => entry.booted !== true || entry.fail < 0)
const narrowed = results.filter(entry => entry.booted === true && entry.fail > 0)
if (unevaluated.length > 0) {
  console.log(`\n❌ ${unevaluated.length} 个版本未能评估：${unevaluated.map(entry => entry.version).join(', ')}`)
  process.exit(1)
}
if (process.env.MATRIX_STRICT === '1' && narrowed.length > 0) {
  console.log(`\n❌ MATRIX_STRICT=1：${narrowed.length} 个版本存在失败断言：${narrowed.map(entry => entry.version).join(', ')}`)
  process.exit(1)
}
console.log(`\n✅ 全部 ${results.length} 个版本均已评估${narrowed.length > 0 ? `（其中 ${narrowed.length} 个能力收窄，见上表）` : ''}`)
