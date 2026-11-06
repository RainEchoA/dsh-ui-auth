# 局域网自签证书部署

> **面向：**不想暴露公网、但确实要用 TLS 直连在局域网内提供 HTTPS 面板的部署者，
> 以及**替他们执行配置的外部 agent**。
>
> 建议把本文直接交给外部 agent 执行（见 §0）：探查与验证是确定性操作，人工照抄容易漏掉
> 「换证后要重新信任」「域名没进 SAN」这类细节；同时 §0.2 划出了**只能由人决定**的安全边界。

DSH 支持用 `--tls-cert` / `--tls-key` 直接以 HTTPS 监听（即 README 安全说明里的「TLS 直连」形态）。

**本文面向「不想暴露公网，但确实要 TLS 直连」的场景**：没有公网域名、也不打算为面板开一个
公网入口，但局域网内的设备需要用 HTTPS 访问。这条路自签一套本地 CA + 叶子证书即可，
是本场景下唯一不依赖外部服务的选择——代价就是下面列出的这些限制。

> 如果能用反向代理（Caddy / nginx 等）终结 TLS，请优先选那条路：证书自动续期、只需在一处配置，
> 且通行密钥用真实域名，天然规避本文大部分限制。「不想暴露公网」不等于「不能用反代」——
> 反代同样可以只听内网。

这条路可行，但有若干**本插件无法绕过**的限制——它们来自浏览器、macOS 与 WebAuthn 规范。
本文把踩过的坑按「会真的拦住你」的顺序列出来。

---

## 0. 用外部 agent 执行本文（推荐）

本文的步骤**适合交给外部 agent 执行**：探查、签发、验证都是确定性操作，人工照抄容易漏掉
「换证后要重新信任」「域名没进 SAN」这类细节。把这一页交给 agent，让它按下面的流程推进。

### 0.1 给 agent 的指令

```
读 https://github.com/<owner>/dsh-ui-auth/blob/main/docs/LAN-SELF-SIGNED-TLS.md
（或本地仓库的 docs/LAN-SELF-SIGNED-TLS.md），按其中 §0 的流程为我配置局域网 HTTPS。
每一步执行前先说明你要做什么、为什么；遇到需要我决策或授权的点（见 §0.2）先停下来问我。
```

### 0.2 必须由人决定，agent 不得自行处置

这些一旦做错会影响安全或他人设备，**agent 必须先征得同意**：

| 事项 | 为什么不能自动做 |
|---|---|
| `sudo` 类操作（写系统钥匙串、改 `/etc/hosts`） | 需要管理员授权；agent 不应擅自提权 |
| **是否信任某个 CA** | 信任一个 CA 等于信任它能签发的**任意**证书，是安全决策，不是配置细节 |
| 选择域名 | 取决于你的内网 DNS / hosts 现状，agent 无法替你决定用哪个名字 |
| 在其他设备上导入 CA | 涉及他人设备，需逐台人工确认（尤其 iOS 的「完全信任」开关） |
| 改用反向代理方案 | 属于架构变更，应回到使用者决策 |

### 0.3 agent 的执行流程

**第一步：先探查，不要立刻改动**

```bash
# 1) DSH 当前监听方式（是否已用 --tls-cert）
ps aux | grep -i "[d]sh .*--port" | head -3

# 2) 是否已有证书，SAN 覆盖了哪些名字
ls -l ~/.dsh/certs 2>/dev/null || ls -l ./certs 2>/dev/null
openssl x509 -in <证书路径> -noout -text 2>/dev/null | grep -A2 "Subject Alternative Name"

# 3) 本机局域网 IP 与主机名
ipconfig getifaddr en0 2>/dev/null; scutil --get LocalHostName 2>/dev/null

# 4) CA 是否已被本机信任（注意：证书「在钥匙串里」≠「被信任」）
#    下面这条会列出所有钥匙串中同名的证书——有输出只说明证书存在，不说明信任已生效
security find-certificate -a -c "<CA的CN>" 2>/dev/null | head -3

# 5) 域名是否已能解析到本机
dscacheutil -q host -a name <候选域名> 2>/dev/null | head -3
```

> **侦察要点**：`security find-certificate` 能找到证书，**不代表它被信任**。实测遇到过证书已导入、
> 但信任设置未生效的情况（`security verify-cert` 报 `CSSMERR_TP_NOT_TRUSTED`）。
> 真正的判据是 §0.3 第三步的 `curl`（不带 `-k`），不要只看证书是否存在。

把探查结果**汇报给使用者**，再按 §0.2 征求决策。

**第二步：按本文章节执行，每步验证**

| 章节 | 何时需要 |
|---|---|
| §1 信任 CA | 本机首次部署，或浏览器证书报 `ERR_CERT_AUTHORITY_INVALID` |
| §2 **Node 信任证书** | `curl` 通了但 Node 脚本/DSH 报 `SELF_SIGNED_CERT_IN_CHAIN` —— 浏览器与 Node 是两套信任 |
| §3 `--renew` vs `--regen` | 仅换叶子证书 → `--renew`；避免无谓地让所有设备重新信任 |
| §4 域名与 SAN | 要用通行密钥，且当前用 IP 访问 |
| §5 RP ID 与端口 | 多个实例共用同一域名 |
| §6 localhost | 只是本机自用——**这种情况下根本不需要自签证书** |

**第三步：验证（必须做，不能只看命令退出码）**

> 先用 `lsof -nP -iTCP:<端口> -sTCP:LISTEN` 确认 DSH **实际监听地址**。
> 绑定到具体局域网 IP 的实例不监听 `localhost`，地址用错会得到 `000`（连不上），
> 与「信任没配好」是两回事——先排除前者，再判断后者。

```bash
# TLS 是否真的能握手（-k 绕过信任，验证的是服务端证书本身可用）
curl -sk -o /dev/null -w "status=%{http_code}\n" https://<监听地址>:<端口>/auth/login

# 证书链与 SAN 是否符合预期
openssl s_client -connect <监听地址>:<端口> -servername <域名> </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName

# 不带 -k 再试一次：这一步才验证「本机是否真的信任了该 CA」
curl -s -o /dev/null -w "trusted=%{http_code}\n" https://<域名>:<端口>/auth/login
```

前两条返回 200 说明服务端本身没问题；最后一条**返回 `000` 或非 0 退出码就说明信任没配好**，
此时不要继续下一步，回到 §1 排查。

**第四步：交给使用者做人工确认**

agent 完成后应明确告知使用者这些**只能由人完成**的剩余事项：

- 用浏览器实际打开一次，确认无证书警告；
- 若要通行密钥，在 `https://<域名>:<端口>` 下试绑一次（用 IP 访问时按钮会不可用，见 §4）；
- 其他设备按 §1 各自导入 CA。

> **注意**：本文的 `dsh.example.com`、`192.168.1.20` 都是**占位值**，agent 必须替换成
> 探查到的真实值，不得直接照抄。

---

## 1. 自签 CA 必须被显式信任，且**每台设备**都要信任

浏览器不会因为证书是服务端自己签的就放行。macOS 上需要把 **CA 证书**（不是叶子证书）
加入受信任根：

```bash
# 系统级：所有用户、所有浏览器生效；需要管理员授权
sudo security add-trusted-cert -d -r trustRoot -p ssl \
  -k /Library/Keychains/System.keychain <你的CA证书.pem>

# 或仅当前用户（重启浏览器后生效）
security add-trusted-cert -r trustRoot -p ssl \
  -k ~/Library/Keychains/login.keychain-db <你的CA证书.pem>
```

验证是否**真正生效**（证书存在不等于被信任）：

```bash
# ① 证书是否已导入（所有钥匙串）；有输出 ≠ 已信任
security find-certificate -a -c "<你的CA的CN>" 2>/dev/null | head -3

# ② 信任是否生效——这才是判据。对正在运行的面板做一次不带 -k 的请求：
curl -s -o /dev/null -w "trusted=%{http_code}\n" https://<实际监听地址>:<端口>/auth/login
#   返回 200 = 信任生效；返回 000 / curl 退出码非 0 = 信任未生效
```

> ⚠️ **先确认 DSH 实际监听在哪个地址**。用 `lsof -nP -iTCP:<端口> -sTCP:LISTEN` 查。
> DSH 绑定到具体局域网 IP 时**不监听** `localhost`/`127.0.0.1`，用错地址会得到 `000`，
> 那是连不上，不是信任问题——两者要分清。

> 实测踩过：CA 已 `add-trusted-cert` 导入、`security find-certificate` 也能找到，但
> `security verify-cert` 仍报 `CSSMERR_TP_NOT_TRUSTED`，浏览器照旧报警。
> 所以 **别用「证书是否在钥匙串里」判断信任**，用 ② `curl` 实测。

**限制**：这只影响**当前这台机器**。

- 手机、平板访问同一地址时仍会报证书错误，需要在各自设备上重复导入；
- iOS 还要额外在「设置 → 通用 → 关于本机 → 证书信任设置」里手动开启该 CA 的**完全信任**；
- Android 对用户级 CA 的态度因版本/厂商而异，部分应用不信任用户 CA。

内网长期使用，建议用内部 CA 统一签发，并把 CA 一次性下发到各设备。

## 2. Node.js 不信任系统证书 —— macOS 与 Linux 的差异与解法

**这是最容易卡住的一步。** 浏览器信任了证书，不等于**跑在 Node.js 里的程序**也信任——
而 DSH 本身就是 Node 程序，插件测试脚本（`test/live-*.mjs`）也用 Node 的 `fetch`/`https`。

### 2.1 差异从哪来

| 平台 | Node.js 的信任来源 | 结果 |
|---|---|---|
| **macOS** | 使用 **Node 自带的一组根证书**，**不读系统钥匙串** | 即使你 `security add-trusted-cert` 信任了 CA，Node 仍报 `self-signed certificate in certificate chain` |
| **Linux** | 同样使用 Node 自带根证书，**不读** `/etc/ssl/certs` | 即使 `update-ca-certificates` 装好了 CA，Node 仍不信任 |
| 浏览器（Chrome / Safari） | macOS 读钥匙串；Linux 多数读 NSS/IPA 库 | 与 Node **不是同一套规则** |

**关键结论：在 Node.js 里，「系统信任」和「Node 信任」是两件事。** 这条在 macOS 和 Linux 上
**都成立**——两者都不自动继承系统 CA（Windows 上 Node 会读系统证书存储，是唯一例外）。

实测复现（macOS，CA 已在钥匙串受信任）：

```bash
# 浏览器/curl 能通
curl -s -o /dev/null -w "%{http_code}\n" https://<地址>:<端口>/auth/login   # → 200

# Node 仍失败
node -e "require('node:https').get('https://<地址>:<端口>/auth/login',r=>{console.log(r.statusCode);process.exit()}).on('error',e=>{console.log(e.code);process.exit()})"
# → SELF_SIGNED_CERT_IN_CHAIN
```

### 2.2 解法

按「影响范围」从大到小排列，任选其一：

**方案 A：`NODE_EXTRA_CA_CERTS`（推荐，最通用）**

```bash
export NODE_EXTRA_CA_CERTS=/path/to/ca-cert.pem
```

- **跨平台**：macOS / Linux 行为一致；
- **只影响 Node**：不改变浏览器与系统信任；
- ⚠️ **只在进程启动时读取**：已经跑起来的进程不会生效，必须重启。

```bash
# 验证是否生效
NODE_EXTRA_CA_CERTS=/path/to/ca-cert.pem node -e "
require('node:https').get('https://<地址>:<端口>/auth/login', r => { console.log('✅', r.statusCode); process.exit() })
  .on('error', e => { console.log('❌', e.code); process.exit(1) })"
```

**方案 B：代码里显式传 `ca`（适合脚本/测试）**

只有 **`node:https` / `node:tls`** 支持直接传 `ca`：

```js
import { get } from 'node:https'
import { readFileSync } from 'node:fs'
get('https://<地址>:<端口>/auth/login', { ca: readFileSync('/path/to/ca-cert.pem') }, res => { ... })
```

⚠️ **全局 `fetch` 不支持 `ca` 选项**：Node 内置的 `fetch`（undici）不接受 `ca` 参数，
也不提供可以直接 `import` 的 `undici` 模块（`import('undici')` 会报 `ERR_MODULE_NOT_FOUND`）。
所以依赖 `fetch` 的脚本（如仓库里的 `test/live-*.mjs`）**只能用方案 A**，
或改用 `node:https` 重写。

**方案 C：禁用校验（❌ 不推荐，仅限一次性排查）**

```bash
# 仅用于确认「是不是证书问题」，不要写进任何长期配置
NODE_TLS_REJECT_UNAUTHORIZED=0 node ...
```

> 为什么单独点名：很多排障帖会建议这个开关。它会让**所有** TLS 校验失效（包括 DSH 访问
> 外部 API 的连接），把证书问题变成静默的安全洞。用它定位完就必须撤掉。

### 2.3 各场景该用哪种

| 场景 | 建议 |
|---|---|
| 让 **DSH 进程**信任自签证书 | 启动前 `export NODE_EXTRA_CA_CERTS=...`，或写进 systemd/launchd 的 service 环境 |
| 跑 `test/live-*.mjs` 等仓库脚本 | 同上；`test/tls-mux-scheme.run.mjs` 已经这么做了（用 launcher 注入） |
| 只是浏览器访问面板 | 不需要动 Node —— 浏览器走自己的信任链（§1） |
| Linux 上想让系统级也信任（非 Node 程序） | `sudo cp ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`（注意：**对 Node 仍无效**，Node 还需要方案 A） |

### 2.4 常见误区

| 做法 | 为什么不够 |
|---|---|
| 只做了 `security add-trusted-cert`（macOS） | 只修好浏览器；Node 仍不信任 |
| 只做了 `update-ca-certificates`（Linux） | 同上，Node 不读该目录 |
| 用 `curl -k` 验证通过 | `-k` 是**跳过**校验，不能证明任何信任关系成立 |
| 设了 `NODE_EXTRA_CA_CERTS` 但没重启进程 | 该变量只在启动时读取 |

## 3. 换 CA 就要全量重新信任

文档里的签发脚本提供两个相近但差别很大的参数：

| 参数 | 做什么 | 对已信任设备的影响 |
|---|---|---|
| `--renew` | 只重签**叶子证书**，复用原 CA | ✅ 无影响，浏览器信任照旧 |
| `--regen` | **全部重签**，生成新 CA | ❌ 旧 CA 的信任记录作废，所有设备都要重新导入 |

正在排查证书错误时尤其容易选错：症状看起来一样（浏览器报证书无效），但 `--regen`
会让问题扩散到所有设备。

## 4. IP 地址不能做通行密钥的 RP ID —— 与证书是否受信任无关

这是 **WebAuthn 规范**的限制，自签证书再受信任也救不了：

| 访问地址 | 通行密钥 | 原因 |
|---|---|---|
| `https://localhost:3443` | ✅ 可用 | `localhost` 是规范特例，可作 RP ID |
| `https://dsh.example.com:3443` | ✅ 可用 | 真实域名（需在证书 SAN 内 + 本机能解析） |
| `https://192.168.1.20:3443` | ❌ **不可用** | 浏览器拒绝 IP 字面量作为 RP ID |

插件会在登录页明确提示：

> 浏览器不接受 IP 地址作为通行密钥域（RP ID）：请改用域名并通过 HTTPS 访问

因此**局域网访问且要用通行密钥，必须给机器一个域名**，两步：

1. 签发时把域名加入 SAN：`--domain dsh.example.com`
2. 让该域名解析到本机 IP（`/etc/hosts`，或内网 DNS）

```bash
# 查看当前证书的 SAN 覆盖了哪些名字
openssl x509 -in certs/server-chain.pem -noout -text | grep -A2 "Subject Alternative Name"
```

只用 IP 访问时，**密码 + TOTP 仍完全正常**，只是通行密钥不可用。

## 5. RP ID 忽略端口：同域名不同端口共享通行密钥

通行密钥的 RP ID **不包含端口**。`https://dsh.example.com:3443` 与
`https://dsh.example.com:8443` 被视为**同一个 relying party**，在其一绑定的通行密钥
在另一处也会被列出。

多实例共用一个域名/证书时请留意。需要固定时用 `DSH_AUTH_RP_ID` 显式指定
（见 [运维手册](OPERATIONS.md) 的环境变量表；值必须是访问域名的后缀）。

## 6. `http://localhost` 本身就是安全上下文

如果只是**本机自用**，最省事的做法是走明文 `http://localhost:3080`——
loopback 源（`localhost` / `127.0.0.1` / `::1`）在浏览器里属于可信源，**无需任何证书**
就能使用通行密钥。

反之，`https://localhost:PORT` 配自签证书时，Chrome 等浏览器可能仍要求证书受信任才允许
WebAuthn 调用——等于为了本机使用，额外引入了一整套证书麻烦。

**建议**：本机用 `http://localhost`；自签证书留给「需要局域网其他设备访问」的场景。

## 7. TLS 直连下 mux 通道的状态

| 插件版本 | TLS 直连（`--tls-cert`） | 说明 |
|---|---|---|
| **0.7.1 及更早** | ❌ 不可用 | 网关回连宿主写死 `ws://`，握手阶段即被断开。服务端**零日志**，表现为登录正常但左下角无限「重新连接中」、会话列表为空 |
| **`main`（未发布）** | ✅ 可用 | 回连 scheme 按入站 socket 加密状态推导（`wss`/`ws`），并有真实实例的端到端回归 |

排查提示：这个症状**只影响会话列表/mux 连接**，登录页与 `/auth/*` 不受影响。
如果「能登录但看不到会话」，先确认是不是这条；同一部署切回明文 HTTP 监听即恢复。

## 8. 常见排查清单

| 症状 | 最可能原因 |
|---|---|
| 浏览器报 `NET::ERR_CERT_AUTHORITY_INVALID` | CA 未导入受信任根，或导入的是叶子证书而非 CA |
| 浏览器正常，但 **Node 脚本报 `SELF_SIGNED_CERT_IN_CHAIN`** | **浏览器与 Node 是两套信任链**：macOS 与 Linux 上 Node 都不读系统 CA（见 §2） |
| 设了 `NODE_EXTRA_CA_CERTS` 却没效果 | 该变量只在**进程启动时**读取，必须重启进程（见 §2.2） |
| `find-certificate` 能找到 CA，但浏览器仍报警 | 证书「存在」≠「被信任」，信任设置未生效（见 §1 的 `curl` 判据） |
| `curl` 返回 `000` / 退出码 7 | **连不上**，不是证书问题——多半是地址/端口不对或实例未监听该地址 |
| 浏览器正常，但其他设备报证书错误 | 只在当前机器信任了 CA（见 §1） |
| 能登录，但一直「重新连接中」 | TLS 直连 + 插件版本 ≤ 0.7.1（见 §7） |
| 登录页提示「不接受 IP 地址作为通行密钥域」 | 用 IP 访问，通行密钥需要域名（见 §4） |
| 换了证书后所有设备都报错 | 用了 `--regen` 换了 CA（见 §3） |
| 两个端口上的通行密钥互相串 | RP ID 忽略端口（见 §5） |

---

## 相关文档

- [运维手册](OPERATIONS.md) —— 环境变量（含 `DSH_AUTH_RP_ID`）、备份恢复、升级回滚
- [安全说明与已知边界](SECURITY.md) —— 信任边界与残余风险
- [README](../README.md) —— 安装、首次登录、通行密钥对访问地址的要求
