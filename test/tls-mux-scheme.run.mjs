// tls-mux-scheme 测试的启动器：TLS 回连需要信任测试 CA，而 NODE_EXTRA_CA_CERTS
// 只在进程启动时读取，无法在被测进程内设置——因此由本 launcher 带环境变量拉起真正
// 的测试进程，退出码原样传递。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const result = spawnSync(
  process.execPath,
  ['--test', join(here, 'tls-mux-scheme.test.mjs')],
  {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(here, 'tls-mux-scheme-cert.pem') },
    stdio: 'inherit',
  },
)
if (result.error) throw result.error
process.exit(result.status === null ? 1 : result.status)
