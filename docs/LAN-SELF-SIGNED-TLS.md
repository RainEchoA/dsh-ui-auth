# 局域网自签证书部署

> **面向：**不想暴露公网、但确实要用 TLS 直连在局域网内提供 HTTPS 面板的部署者，
> 以及**在这台目标节点上运行的编码 agent**（Claude Code、Codex 等）。
>
> 建议把本文直接交给运行在**目标节点本机**、**有 shell 权限**的 agent 执行（见 §0.1 的前提与
> §0.4 的流程）：探查与验证是确定性操作，人工照抄容易漏掉「换证后要重新信任」「域名没进 SAN」
> 这类细节；同时 §0.3 划出了**只能由人决定**的安全边界。

DSH 支持用 `--tls-cert` / `--tls-key` 直接以 HTTPS 监听（即 README 安全说明里的「TLS 直连」形态）。

**本文面向「不想暴露公网，但确实要 TLS 直连」的场景**：没有公网域名、也不打算为面板开一个
公网入口，但局域网内的设备需要用 HTTPS 访问。这条路自签一套本地 CA + 叶子证书即可，
代价是下面列出的这些限制（主要是**每台设备都要手动信任 CA**）。

> 但在动手之前，先花一分钟看下面的判断表——**你可能有更好的选择**。

### 先确认：你到底需不需要自签？

「不想暴露公网」**不等于**「拿不到公网信任的证书」。先看这张表，可能不必读完全文：

| 你的条件 | 能用公网信任的证书吗 | 推荐做法 |
|---|---|---|
| **有域名**（哪怕是便宜的二级域名） | ✅ **能** | **反代 + DNS-01 验证**，见下方 §A。无需开放任何入站端口 |
| 只有内网 IP，无域名 | ❌ 不能 | 自签证书（本文），或改用 §B 的私有 CA |
| 有域名但**不想让它出现在公网 DNS** | ❌ 不能 | §B 私有 CA，或自签 |

> **关键**：能否拿到公网信任证书，取决于**你有没有域名**，而不是「有没有暴露公网」。
> 反代完全可以只听内网——它不需要公网入口。

#### §A. 有域名时：反代 + DNS-01（不必读本文其余部分）

这是**纯收益**方案：浏览器天然信任、证书自动续期、通行密钥可用真实域名。

```caddyfile
# Caddy 示例：只监听内网，用 DNS-01 验证，无需开放 80/443 入站
dsh.example.com {
    reverse_proxy 127.0.0.1:3443
}
```

```bash
# Caddy 需装 DNS 插件（以 Cloudflare 为例）；nginx 可用 acme.sh 的 dns 模式
xcaddy build --with github.com/caddy-dns/cloudflare
```

然后用**内网 DNS 或 `/etc/hosts`** 把 `dsh.example.com` 解析到内网 IP 即可：

```
# /etc/hosts 或内网 DNS
192.168.1.20  dsh.example.com
```

> ⚠️ **通行密钥（WebAuthn）要求真实可解析的域名**。若用 `/etc/hosts`，每台设备都要配一次；
> 设备数量多时建议自建内网 DNS。

#### §B. 没有域名时：两种选择

| 方案 | 设备需信任 CA | 自动化 | 说明 |
|---|---|---|---|
| **自签证书**（本文） | ✅ 每台手动导入 | 手动续期 | 最简单，无额外组件 |
| 私有 ACME CA（如 [step-ca](https://smallstep.com/docs/step-ca/)） | ✅ 每台导入**一次**根 CA | 自动续期/签发 | 设备多、实例多时更省事；本质仍是私有信任链 |

两者在**安全模型上没有区别**——都需要你的设备信任你自己的 CA。私有 ACME CA 只是把
「导入 CA」和「续期」这两个动作自动化了。

> **为什么内网 IP 拿不到公网证书**：Let's Encrypt 自 2025 年起确实签发 IP 地址证书，但
> （[官方说明](https://letsencrypt.org/2025/07/01/issuing-our-first-ip-address-certificate/)）：
> 只支持**公网 IP**，私网地址（`192.168.x`、`10.x`、`172.16-31.x`）无法验证归属；
> 且必须是 **`shortlived` profile（约 6 天有效期）**，只能走 `http-01` / `tls-alpn-01`
> 验证——**不能用 DNS-01**，意味着 CA 必须能从公网连到你的机器。这与「不暴露公网」直接矛盾。

---

这条路可行，但有若干**本插件无法绕过**的限制——它们来自浏览器、macOS 与 WebAuthn 规范。
本文把踩过的坑按「会真的拦住你」的顺序列出来。

---

## 0. 用外部 agent 执行本文（推荐）

本文的步骤**适合交给外部 agent 执行**：探查、签发、验证都是确定性操作，人工照抄容易漏掉
「换证后要重新信任」「域名没进 SAN」这类细节。把这一页交给 agent，让它按下面的流程推进。

### 0.1 前提：agent 跑在**要部署 DSH 的那台节点上**

本文的「外部 agent」指的是在**目标节点本机**运行的编码 agent（Claude Code、Codex 等），
它拥有该机器的 shell 权限，能直接执行 `lsof`、`security`、`openssl`、`curl`、`systemctl` 等命令。

**不是**这样用的：

| ❌ 错误用法 | 为什么不行 |
|---|---|
| agent 在**你的笔记本**上，让你去操作服务器 | 它看不到目标机的证书、监听地址、钥匙串、hosts，只能凭猜测写命令 |
| agent 在一个**没有 shell 的聊天窗口**里 | §0.4 的探查与验证全部无法执行，会退化成「照着文档念」 |
| agent 在**容器/沙箱**里，看不到宿主机 | `security`、钥匙串、`/etc/hosts` 都是宿主机的，沙箱内看不到 |

**如果 agent 不在目标节点**：它只能用 **SSH 远程执行**，此时它必须能真正连上目标机并跑命令；
否则本文对它无意义——直接人工操作更快。

### 0.2 给 agent 的指令

把下面这段发给**运行在目标节点上**的 agent：

```
你运行在要部署 DSH 的这台机器上，可以直接执行本机命令。

读 https://github.com/0QwQ0/dsh-ui-auth/blob/main/docs/LAN-SELF-SIGNED-TLS.md
（或本地仓库的 docs/LAN-SELF-SIGNED-TLS.md），按其中「先确认」的判断表和 §0 的流程
为我配置局域网 HTTPS。

要求：
1. 每一步执行前先说明你要做什么、为什么；
2. 遇到需要我决策或授权的点（见 §0.3 安全边界）先停下来问我，不要自行决定；
3. 先探查（§0.4 第一步）再动手，不要假设地址、端口、证书路径；
4. 完成后按 §0.4 第三步验证，并把「只能由人完成」的剩余事项列给我。
```

### 0.3 必须由人决定，agent 不得自行处置

这些一旦做错会影响安全或他人设备，**agent 必须先征得同意**：

| 事项 | 为什么不能自动做 |
|---|---|
| `sudo` 类操作（写系统钥匙串、改 `/etc/hosts`） | 需要管理员授权；agent 不应擅自提权 |
| **是否信任某个 CA** | 信任一个 CA 等于信任它能签发的**任意**证书，是安全决策，不是配置细节 |
| 选择域名 | 取决于你的内网 DNS / hosts 现状，agent 无法替你决定用哪个名字 |
| 在其他设备上导入 CA | 涉及他人设备，需逐台人工确认（尤其 iOS 的「完全信任」开关） |
| 改用反向代理方案 | 属于架构变更，应回到使用者决策（但见下方说明） |
| 选择自签 vs 私有 ACME CA（§B） | 影响信任模型与运维复杂度，由使用者权衡 |

> **agent 可以先做的判断**：如果使用者**已有域名**，应主动提示「用 §A 的反代 + DNS-01
> 可以拿到公网信任证书，无需本文其余步骤」——这比默默配置自签证书更有价值，
> 但**最终选哪种仍由使用者决定**。

### 0.4 agent 的执行流程

**第一步：先探查，不要立刻改动**

> 先用 `uname -s` 确认平台——以下命令分 macOS / Linux 两套，用错平台会得到误导性的空结果。

```bash
# 1) DSH 当前监听方式（是否已用 --tls-cert）—— 两平台通用
ps aux | grep -i "[d]sh .*--port" | head -3
lsof -nP -iTCP:<端口> -sTCP:LISTEN 2>/dev/null | head -3

# 2) 是否已有证书，SAN 覆盖了哪些名字 —— 两平台通用
ls -l ~/.dsh/certs 2>/dev/null || ls -l ./certs 2>/dev/null
openssl x509 -in <证书路径> -noout -text 2>/dev/null | grep -A2 "Subject Alternative Name"

# 3) 本机局域网 IP 与主机名
#    macOS:
ipconfig getifaddr en0 2>/dev/null; scutil --get LocalHostName 2>/dev/null
#    Linux:
hostname -I 2>/dev/null; hostnamectl --static 2>/dev/null || hostname

# 4) CA 是否已被**系统**信任（注意：存在 ≠ 被信任；且 Node 另有规则，见 §2）
#    macOS:
security find-certificate -a -c "<CA的CN>" 2>/dev/null | head -3
#    Linux — 先确认发行版系别，再看对应目录：
#      Debian/Ubuntu:  /usr/local/share/ca-certificates/
#      RHEL/CentOS:    /etc/pki/ca-trust/source/anchors/
ls /usr/local/share/ca-certificates/*.crt /etc/pki/ca-trust/source/anchors/*.pem 2>/dev/null | head -3
#    确认 CA 是否真的进了 OpenSSL 读取的 bundle（RHEL 系看 ca-bundle.crt）：
openssl crl2pkcs7 -nocrl -certfile /etc/pki/tls/certs/ca-bundle.crt 2>/dev/null | grep -c "BEGIN CERTIFICATE"

# 4b) Node 自己认为它信任什么 —— 比看文件更直接的运行时事实（详见 §2.3）
node -e "const t=require('node:tls'); console.log({openssl:process.versions.openssl,
  bundled:t.getCACertificates('bundled').length, system:t.getCACertificates('system').length})"

# 5) 域名是否已能解析到本机 —— 两平台通用
getent hosts <候选域名> 2>/dev/null || dscacheutil -q host -a name <候选域名> 2>/dev/null | head -3
```

> **侦察要点**：`security find-certificate` 能找到证书，**不代表它被信任**。实测遇到过证书已导入、
> 但信任设置未生效的情况（`security verify-cert` 报 `CSSMERR_TP_NOT_TRUSTED`）。
> 真正的判据是 §0.4 第三步的 `curl`（不带 `-k`），不要只看证书是否存在。

把探查结果**汇报给使用者**，再按 §0.3 征求决策。

**第二步：按本文章节执行，每步验证**

| 章节 | 何时需要 |
|---|---|
| §1 信任 CA | 本机首次部署，或浏览器证书报 `ERR_CERT_AUTHORITY_INVALID` |
| §2 **Node 信任证书** | `curl` 通了但 Node 脚本/DSH 报 `SELF_SIGNED_CERT_IN_CHAIN` —— macOS 常见（不读钥匙串）；Linux 装了系统 CA 一般不会遇到 |
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

## 2. Node.js 与系统证书的信任差异 —— macOS 与 Linux **行为不同**

**这是最容易卡住、也最容易写错的一条。** 浏览器信任了证书，不等于**跑在 Node.js 里的程序**也信任——
而 DSH 本身就是 Node 程序，插件测试脚本也用 Node 的 `fetch`/`https`。

**但两个平台的结论不一样**：macOS 上 Node **不读**系统信任，需要额外配置；Linux 上 Node
**读**系统 CA 存储，装好系统 CA 就够。**下面 §2.1 的对照表是本节最重要的内容。**

### 2.1 差异从哪来

**macOS 和 Linux 的行为不一样**——这是本节最容易被忽略、也最容易踩坑的地方：

| 平台 | Node.js 的信任来源 | 结果 |
|---|---|---|
| **macOS** | 使用 **Node 自带的一组根证书**，**不读系统钥匙串** | 即使 `security add-trusted-cert` 信任了 CA，Node 仍报 `SELF_SIGNED_CERT_IN_CHAIN` |
| **Linux**（Node 24 实测） | **读系统 CA 存储**（OpenSSL 编译时的默认证书位置） | 装好系统 CA 后**直接可用，无需任何环境变量** |
| 浏览器 | macOS 读钥匙串；Linux 读 NSS/IPA 库 | 与 Node 各有自己的规则 |

> ⚠️ **上一版的本文把 Linux 也写成了「不读系统 CA」，那是错的。**
> 实测：Node 24 + CentOS 8，把 CA 装进系统信任存储后，Node 默认即可信任，不需要
> `NODE_EXTRA_CA_CERTS`。

**Linux 发行版的 CA 路径与命令并不统一**（这是 §1 之外最容易漏的一层差异）：

| 发行版 | 放入目录 | 生效命令 | OpenSSL 读取的文件 |
|---|---|---|---|
| **Debian / Ubuntu** | `/usr/local/share/ca-certificates/` | `sudo update-ca-certificates` | `/etc/ssl/certs/ca-certificates.crt` |
| **RHEL / CentOS / Rocky / Alma** | `/etc/pki/ca-trust/source/anchors/` | `sudo update-ca-trust extract` | `/etc/pki/tls/certs/ca-bundle.crt` |

> 把 Debian 的 `update-ca-certificates` 用在 CentOS 上会直接报命令不存在——
> 这跟证书本身无关，只是用错了发行版的工具。

**关键结论：**

- **macOS**：系统信任与 Node 信任是**两件事**，必须额外给 Node 传 CA（§2.4）；
- **Linux**：只要装进系统 CA 存储（用对发行版的命令），**浏览器和 Node 一并生效**，最省事；
- 两边都不要假设对方的行为——先按 §0.4 的探查确认。

### 2.2 实测对照

**macOS**（CA 已在钥匙串受信任，Node 仍失败）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<地址>:<端口>/auth/login   # → 200（浏览器信任链 OK）
env -u NODE_EXTRA_CA_CERTS node -e "..."                                    # → SELF_SIGNED_CERT_IN_CHAIN
node --use-system-ca -e "..."                                              # → 仍然失败
```

> 实测：在 macOS 上 `--use-system-ca`（Node 提供的「改用系统 CA」开关）**也解决不了**——
> 它不会让 Node 读取钥匙串中**用户手动信任**的 CA。macOS 只能用 §2.4 的方案。

**Linux**（装进系统 CA 存储，Node 直接可用）：

```bash
# Debian / Ubuntu
sudo cp ca.crt /usr/local/share/ca-certificates/dsh-local-ca.crt
sudo update-ca-certificates

# RHEL / CentOS / Rocky / Alma（CentOS 8 实测）
sudo cp ca.crt /etc/pki/ca-trust/source/anchors/dsh-local-ca.crt
sudo update-ca-trust extract

# 两种情况都不需要 NODE_EXTRA_CA_CERTS
node -e "require('node:https').get('https://<地址>:<端口>/auth/login', r => console.log(r.statusCode))"  # → 200
```

> 实测环境：**Node 24 + CentOS 8**，`update-ca-trust extract` 之后 Node 默认即信任。

# Node 仍失败
node -e "require('node:https').get('https://<地址>:<端口>/auth/login',r=>{console.log(r.statusCode);process.exit()}).on('error',e=>{console.log(e.code);process.exit()})"
# → SELF_SIGNED_CERT_IN_CHAIN
```

### 2.3 诊断：Node 到底信任哪些 CA

排查证书问题时，先让 Node 自己说清楚「它现在信任什么」，比猜快得多。

```bash
node -e "const tls=require('node:tls'); console.log({
  openssl: process.versions.openssl,
  bundled: tls.getCACertificates('bundled').length,
  system:  tls.getCACertificates('system').length,
})"
```

各字段含义：

| 字段 | 含义 |
|---|---|
| `openssl` | Node 链接的 OpenSSL 版本 |
| `bundled` | **Node 自带**的根证书数量（通常 100+） |
| `system` | **从系统读取**的根证书数量；`0` 表示没走系统存储 |

对照判断：

| 现象 | 说明 |
|---|---|
| `system: 0` | Node 没启用系统 CA。macOS 上正常（读不了钥匙串）；**Linux 上装了系统 CA 后仍为 0，说明系统证书没被 OpenSSL 看到**（路径/命令用错了发行版，见 §2.1） |
| `system` > 0 | Node 在读系统存储；此时装了 CA 就该生效 |

> ⚠️ **不要用 `process.config.variables.node_use_openssl_ca` 判断。**
> 那是 Node **编译期**的变量，且**在现代 Node 中已不存在**（Node 24 实测为 `undefined`，
> `process.config.variables` 里只剩 `node_use_openssl`）。用它判断会得到一个永远是
> `undefined` 的假阴性。用上面的 `tls.getCACertificates('system')` 才是运行时事实。

**另一条更直接的判据**：Node 自己在证书校验失败时会提示

```
If the root CA is installed locally, try running Node.js with --use-system-ca flag
```

如果这条提示出现，说明 Node **没有**把该 CA 视为可信——这是最可靠的信号。

### 2.4 解法

按「影响范围」从大到小排列，任选其一：

> **Linux 用户注意**：如果 CA 已经装进系统信任存储（Debian 系 `update-ca-certificates` /
> RHEL 系 `update-ca-trust extract`），**通常不需要本节任何方案**——Node 会直接读取。
> 先用下面的 `node -e` 验证一下，能通过就跳过。
> `NODE_EXTRA_CA_CERTS` 主要是给 **macOS** 用的，以及用于跨平台统一。

**方案 A：`NODE_EXTRA_CA_CERTS`（最通用，macOS 必备）**

```bash
export NODE_EXTRA_CA_CERTS=/path/to/ca-cert.pem
```

- **跨平台**：macOS / Linux 行为一致（Linux 上属于锦上添花）；
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

### 2.5 各场景该用哪种

| 场景 | macOS | Linux（Debian 系） | Linux（RHEL 系） |
|---|---|---|---|
| 让 **DSH 进程**信任自签证书 | `export NODE_EXTRA_CA_CERTS=...`（或写进 launchd 环境） | `update-ca-certificates`，无需环境变量 | `update-ca-trust extract`，无需环境变量 |
| 跑 `test/live-*.mjs` 等仓库脚本 | 同上（`tls-mux-scheme.run.mjs` 已用 launcher 注入） | 同上，装系统 CA 后直接可用 | 同左 |
| 只是浏览器访问面板 | 动浏览器信任链（§1），不需要动 Node | 同 macOS | 同 macOS |
| 需要**跨平台统一**的做法 | `NODE_EXTRA_CA_CERTS` 三处都有效 | 同左 | 同左 |

> **建议**：如果目标机器不确定，或者要用一份配置覆盖多种环境，用 `NODE_EXTRA_CA_CERTS`——
> 它在 macOS 和 Linux 上行为一致。Linux 上额外装系统 CA 的好处是 DSH 之外的工具也一并信任。

### 2.6 常见误区

| 做法 | 为什么不够 |
|---|---|
| 只做了 `security add-trusted-cert`（macOS） | 只修好浏览器；**Node 仍不信任**——macOS 上必须额外处理（§2.4） |
| 以为 Linux 上也一样要设 `NODE_EXTRA_CA_CERTS` | Linux 会读系统 CA，装好后本就可用；多设一个变量不会错，但别以为系统 CA 白装了 |
| 在 CentOS 上跑 `update-ca-certificates` | 那是 Debian 系的命令，RHEL 系要用 `update-ca-trust extract` |
| 只把文件放进 `anchors/` 却没执行更新命令 | RHEL 系需要 `update-ca-trust extract` 才会合并进 `ca-bundle.crt` |
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
| 浏览器正常，但 **Node 脚本报 `SELF_SIGNED_CERT_IN_CHAIN`** | **浏览器与 Node 是两套信任链**。macOS 上 Node 不读钥匙串，必须额外配（§2.4）；Linux 装好系统 CA 通常就够 |
| 设了 `NODE_EXTRA_CA_CERTS` 却没效果 | 该变量只在**进程启动时**读取，必须重启进程（见 §2.4） |
| `find-certificate` 能找到 CA，但浏览器仍报警 | 证书「存在」≠「被信任」，信任设置未生效（见 §1 的 `curl` 判据） |
| `curl` 返回 `000` / 退出码 7 | **连不上**，不是证书问题——多半是地址/端口不对或实例未监听该地址 |
| 浏览器正常，但其他设备报证书错误 | 只在当前机器信任了 CA（见 §1） |
| 能登录，但一直「重新连接中」 | TLS 直连 + 插件版本 ≤ 0.7.1（见 §7） |
| 登录页提示「不接受 IP 地址作为通行密钥域」 | 用 IP 访问，通行密钥需要域名（见 §4） |
| 换了证书后所有设备都报错 | 用了 `--regen` 换了 CA（见 §3） |
| 两个端口上的通行密钥互相串 | RP ID 忽略端口（见 §5） |
| 反代配好了，但证书申请失败 | 内网 IP 无法申请公网证书；DNS-01 需要域名（见文首 §A / §B） |
| 反代后浏览器报「证书名称不匹配」 | 访问用的域名不在证书 SAN 内，或反代未把 Host 正确转发 |

---

## 相关文档

- [运维手册](OPERATIONS.md) —— 环境变量（含 `DSH_AUTH_RP_ID`）、备份恢复、升级回滚
- [安全说明与已知边界](SECURITY.md) —— 信任边界与残余风险
- [README](../README.md) —— 安装、首次登录、通行密钥对访问地址的要求
