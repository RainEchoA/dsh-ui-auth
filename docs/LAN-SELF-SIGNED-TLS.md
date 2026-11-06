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
| **Linux**（Node 24 实测：CentOS 8 / Debian 12） | **读系统 CA 存储**（OpenSSL 编译时的默认证书位置） | 装好系统 CA 后**直接可用，无需任何环境变量**；可用 §2.3 的 `system` 字段验证 |
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

### 2.2 注入 CA：按平台执行

把 CA 交给 Node 有两种路径——**系统级**（Linux 推荐，浏览器与 Node 一并生效）和
**进程级**（macOS 必需，或不想动系统存储时）。下面按你的平台选一条。

#### 路径 A：装进系统信任存储（Linux 推荐）

```bash
CA=/path/to/ca-cert.pem

# Debian / Ubuntu
sudo cp "$CA" /usr/local/share/ca-certificates/dsh-local-ca.crt
sudo update-ca-certificates

# RHEL / CentOS / Rocky / Alma
sudo cp "$CA" /etc/pki/ca-trust/source/anchors/dsh-local-ca.crt
sudo update-ca-trust extract
```

完成后**无需任何环境变量**，Node 会直接读取（验证见 §2.3）。

#### 路径 B：进程级注入（macOS 必需；Linux 可选）

```bash
CA=/path/to/ca-cert.pem
export NODE_EXTRA_CA_CERTS="$CA"
```

⚠️ 只在**进程启动时**读取——已运行的实例不会生效，必须重启。

#### 把它固化进服务（避免每次手动 export）

```ini
# systemd（Linux）：/etc/systemd/system/dsh-web.service.d/ca.conf
[Service]
Environment=NODE_EXTRA_CA_CERTS=/etc/pki/ca-trust/source/anchors/dsh-local-ca.crt
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart dsh-web
```

macOS 用 launchd 时，在 plist 的 `EnvironmentVariables` 字典里加同名键。

#### 一次性验证

```bash
# 不带 -k：这一步才真正检验信任是否生效
node -e "require('node:https').get('https://<地址>:<端口>/auth/login', r => {
  console.log('✅', r.statusCode); process.exit()
}).on('error', e => { console.log('❌', e.code); process.exit(1) })"
```

看到 `✅ 200` 即成功；`❌ SELF_SIGNED_CERT_IN_CHAIN` 说明 Node 仍未信任（→ §2.3 诊断）。

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
| `system: 0` | Node 没读系统存储。**macOS 上这是正常的**（读不了钥匙串）；**Linux 上装了系统 CA 后仍为 0，说明证书没被 OpenSSL 看到**（路径或命令用错了发行版，见 §2.1） |
| `system` > 0 | Node **在读**系统存储。此时装了 CA 就该生效；若仍失败，问题在证书本身（SAN / CA 链 / 过期） |

**真实输出对照**（两个平台各一份，可直接比对自己的数字）：

| 环境 | 输出 | 判读 |
|---|---|---|
| macOS / Node 24 | `{ openssl: '3.5.5', bundled: 144, system: 0 }` | 不读钥匙串 → 必须用 §2.4 的方案 |
| **Debian 12 / Node 24** | `{ openssl: '3.0.16', bundled: 150, system: 422 }` | **在读系统存储**（422 个 CA）→ 装进系统即可，无需环境变量 |
| CentOS 8 / Node 24 | `system` 为正值（`update-ca-trust extract` 之后） | 同上 |

> `bundled` 的数字随 Node 版本变化（144 / 150 只是不同构建的差异），**不是判据**。
> 真正要看的是 `system` 是否为 0。

> ⚠️ **不要用 `process.config.variables.node_use_openssl_ca` 判断。**
> 那是 Node **编译期**的变量，且**在现代 Node 中已不存在**（Node 24 实测为 `undefined`，
> `process.config.variables` 里只剩 `node_use_openssl`）。用它判断会得到一个永远是
> `undefined` 的假阴性。用上面的 `tls.getCACertificates('system')` 才是运行时事实。

**另一条更直接的判据**：Node 自己在证书校验失败时会提示

```
If the root CA is installed locally, try running Node.js with --use-system-ca flag
```

如果这条提示出现，说明 Node **没有**把该 CA 视为可信——这是最可靠的信号。

### 2.4 其他注入方式（代码内 / 不推荐）

§2.2 覆盖了绝大多数场景（系统存储 + `NODE_EXTRA_CA_CERTS`）。剩下三种方式供特殊需要：

| 方式 | 适用 | 注意 |
|---|---|---|
| **代码里显式传 `ca`** | 自己写的脚本/测试 | 只有 `node:https` / `node:tls` 支持；**全局 `fetch` 不支持** |
| `NODE_OPTIONS=--use-system-ca` | 想用系统 CA 又不想装 | Linux 有效；**macOS 读不到钥匙串** |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | ❌ 仅一次性排查 | **关闭校验**，不是信任 CA |

#### 代码里显式传 `ca`

```js
import { get } from 'node:https'
import { readFileSync } from 'node:fs'

get('https://<地址>:<端口>/auth/login', { ca: readFileSync('/path/to/ca-cert.pem') }, res => {
  console.log(res.statusCode)
})
```

⚠️ **全局 `fetch` 不能用这个办法**：Node 内置的 `fetch`（undici）不接受 `ca` 选项，
也没有可直接 `import` 的 `undici` 模块（`import('undici')` 会报 `ERR_MODULE_NOT_FOUND`）。
依赖 `fetch` 的脚本（如仓库里的 `test/live-*.mjs`）**只能用 §2.2 的方案**，或改用 `node:https`。

#### 关于 `NODE_TLS_REJECT_UNAUTHORIZED=0`

很多排障帖会建议它。它**关闭**所有 TLS 校验（包括 DSH 访问外部 API 的连接），
不是「信任这个 CA」——用它定位完必须立刻撤掉，绝不要写进长期配置或 service 单元。

### 2.5 跨平台证书路径与环境变量速查

写脚本时最常需要的两件事：**CA 应该放哪里**、**用哪个环境变量**。下面按平台列全。

#### 系统 CA 路径（供脚本判断/写入）

| 平台 | 放置目录 | 生效命令 | OpenSSL bundle 路径 |
|---|---|---|---|
| **macOS** | 钥匙串（无目录） | `security add-trusted-cert` | — |
| **Debian / Ubuntu** | `/usr/local/share/ca-certificates/` | `update-ca-certificates` | `/etc/ssl/certs/ca-certificates.crt` |
| **RHEL / CentOS / Rocky / Alma** | `/etc/pki/ca-trust/source/anchors/` | `update-ca-trust extract` | `/etc/pki/tls/certs/ca-bundle.crt` |
| **Alpine** | `/usr/local/share/ca-certificates/` | `update-ca-certificates` | `/etc/ssl/certs/ca-certificates.crt` |
| **Arch** | `/etc/ca-certificates/trust-source/anchors/` | `trust extract-compat` | `/etc/ssl/certs/ca-certificates.crt` |

> 检测发行版的脚本片段：
>
> ```bash
> . /etc/os-release
> case "$ID $ID_LIKE" in
>   *debian*|*ubuntu*) ANCHOR=/usr/local/share/ca-certificates/; CMD="update-ca-certificates" ;;
>   *rhel*|*centos*|*fedora*|*rocky*|*alma*) ANCHOR=/etc/pki/ca-trust/source/anchors/; CMD="update-ca-trust extract" ;;
>   *alpine*) ANCHOR=/usr/local/share/ca-certificates/; CMD="update-ca-certificates" ;;
>   *arch*) ANCHOR=/etc/ca-certificates/trust-source/anchors/; CMD="trust extract-compat" ;;
>   *) echo "未知发行版，请手动确认 CA 路径"; exit 1 ;;
> esac
> ```

#### 环境变量：哪些对 Node 有效

| 变量 | 对 Node 有效 | 作用 |
|---|---|---|
| **`NODE_EXTRA_CA_CERTS`** | ✅ **有效** | **追加**一个 PEM 到 Node 的 CA 列表。macOS 上唯一可靠的进程级手段 |
| `NODE_OPTIONS=--use-system-ca` | ✅ 被接受 | 改用系统 CA；Linux 上读系统存储，**macOS 上读不到钥匙串** |
| `SSL_CERT_FILE` | ❌ **无效** | OpenSSL 标准变量，`curl` 读，**Node 不读** |
| `SSL_CERT_DIR` | ❌ **无效** | 同上 |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | ⚠️ 有害 | **关闭校验**，不是信任 CA；见 §2.4 警告 |

> **`SSL_CERT_FILE` / `SSL_CERT_DIR` 的误判陷阱**（值得单独记一笔）：
> 设了它们以后 `curl` 能通、`node` 仍失败，容易误以为「Node 配置没生效」；
> 更糟的是反向误判——若环境里**已有** `NODE_EXTRA_CA_CERTS`，`SSL_CERT_FILE` 的
> 「测试通过」其实是前者在起作用。判断时务必先 `env -u NODE_EXTRA_CA_CERTS` 隔离。

#### 一段可直接用的注入脚本

```bash
#!/usr/bin/env bash
# inject-ca.sh <ca-cert.pem> —— 按平台把 CA 注入系统信任存储
set -euo pipefail
if [ $# -lt 1 ]; then echo "用法: $0 <ca-cert.pem>" >&2; exit 2; fi
CA="$1"
[ -f "$CA" ] || { echo "找不到证书: $CA" >&2; exit 1; }

if [ "$(uname -s)" = "Darwin" ]; then
  sudo security add-trusted-cert -d -r trustRoot -p ssl \
    -k /Library/Keychains/System.keychain "$CA"
  echo "✅ macOS：CA 已加入系统钥匙串"
  echo "ℹ️  Node 仍需 NODE_EXTRA_CA_CERTS=$CA"   # 见 §2.1
else
  . /etc/os-release
  case "$ID $ID_LIKE" in
    *debian*|*ubuntu*|*alpine*)
      sudo cp "$CA" /usr/local/share/ca-certificates/dsh-local-ca.crt
      sudo update-ca-certificates ;;
    *rhel*|*centos*|*fedora*|*rocky*|*alma*)
      sudo cp "$CA" /etc/pki/ca-trust/source/anchors/dsh-local-ca.crt
      sudo update-ca-trust extract ;;
    *arch*)
      sudo cp "$CA" /etc/ca-certificates/trust-source/anchors/dsh-local-ca.crt
      sudo trust extract-compat ;;
    *) echo "未知发行版 $ID，请手动确认 CA 路径" >&2; exit 1 ;;
  esac
  echo "✅ Linux：CA 已注入系统信任存储（Node 会直接读取，无需环境变量）"
fi
```

### 2.6 各场景该用哪种

| 场景 | macOS | Linux（Debian 系） | Linux（RHEL 系） |
|---|---|---|---|
| 让 **DSH 进程**信任自签证书 | `export NODE_EXTRA_CA_CERTS=...`（或写进 launchd 环境） | `update-ca-certificates`，或 `NODE_EXTRA_CA_CERTS`（见 §2.5） | `update-ca-trust extract`，或 `NODE_EXTRA_CA_CERTS`（见 §2.5） |
| 跑 `test/live-*.mjs` 等仓库脚本 | 同上（`tls-mux-scheme.run.mjs` 已用 launcher 注入） | 同上，装系统 CA 后直接可用 | 同左 |
| 只是浏览器访问面板 | 动浏览器信任链（§1），不需要动 Node | 同 macOS | 同 macOS |
| 不想动系统存储（容器 / 无 root） | — | `NODE_EXTRA_CA_CERTS`（§2.5） | 同左 |
| 需要**跨平台统一**的做法 | `NODE_EXTRA_CA_CERTS` 三处都有效 | 同左 | 同左 |

> **建议**：如果目标机器不确定，或者要用一份配置覆盖多种环境，用 `NODE_EXTRA_CA_CERTS`——
> 它在 macOS 和 Linux 上行为一致。Linux 上额外装系统 CA 的好处是 DSH 之外的工具也一并信任。

### 2.7 常见误区

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

## 附录：证据（本文结论的实测依据）

本文的每个平台结论都来自实机测试，不是推断。列出测量方法与环境，便于读者复现或质疑。

### E1. 测量方法

所有「Node 是否信任某 CA」的结论，都用同一段代码判定——**发起真实 TLS 连接**，
而不是读配置文件或看证书是否存在：

```bash
# 不带 -k：失败即表示 Node 不信任
node -e "require('node:https').get('https://<地址>:<端口>/auth/login', r => {
  console.log('✅', r.statusCode); process.exit()
}).on('error', e => { console.log('❌', e.code); process.exit(1) })"
```

CA 列表的判定用 Node 官方运行时 API：

```bash
node -e "const tls=require('node:tls'); console.log({
  openssl: process.versions.openssl,
  bundled: tls.getCACertificates('bundled').length,
  system:  tls.getCACertificates('system').length,
})"
```

> 特意**没有**用 `process.config.variables.node_use_openssl_ca`：它是编译期变量，
> Node 24 上已不存在（实测 `undefined`），用它只会得到假阴性。

### E2. 平台实测结果

| # | 环境 | 测量 | 结果 | 支撑的结论 |
|---|---|---|---|---|
| 1 | **macOS** / Node 24.14.1 / OpenSSL 3.5.5 | `tls.getCACertificates` | `{ bundled: 144, system: 0 }` | macOS 上 Node 不读钥匙串（§2.1） |
| 2 | 同上，CA 已在钥匙串受信任 | 真实 https 请求 | `SELF_SIGNED_CERT_IN_CHAIN` | 系统信任 ≠ Node 信任（§2.1、§2.2） |
| 3 | 同上，加 `--use-system-ca` | 真实 https 请求 | 仍是 `SELF_SIGNED_CERT_IN_CHAIN` | 该开关在 macOS 上解决不了（§2.4） |
| 4 | 同上，`NODE_EXTRA_CA_CERTS` | 真实 https 请求 | `200` | 该变量有效（§2.2 路径 B） |
| 5 | 同上，`SSL_CERT_FILE` | 真实 https 请求 | `SELF_SIGNED_CERT_IN_CHAIN` | 该变量对 Node 无效（§2.5） |
| 6 | 同上，`SSL_CERT_DIR` | 真实 https 请求 | `SELF_SIGNED_CERT_IN_CHAIN` | 同上 |
| 7 | **Debian 12** / Node 24 | `tls.getCACertificates` | `{ openssl: '3.0.16', bundled: 150, system: 422 }` | Linux 上 Node **读**系统存储（§2.1） |
| 8 | **CentOS 8** / Node 24 | `update-ca-trust extract` 后真实 https 请求 | 无需任何环境变量即成功 | 同上（§2.1、§2.2 路径 A） |

**要点**：第 1 行与第 7 行是同一段代码在两个平台上的输出——`system: 0` vs `system: 422` 的对比，
就是「macOS 不读系统 CA、Linux 读」最直接的证据。

### E3. 测试中发现的坑（已写进正文）

| 坑 | 怎么被发现的 |
|---|---|
| `SSL_CERT_FILE` 看似有效 | 首次测试返回 200，但当时环境里**已有** `NODE_EXTRA_CA_CERTS`；用 `env -u NODE_EXTRA_CA_CERTS` 隔离后才发现它无效（§2.5） |
| `node_use_openssl_ca` 在现代 Node 不存在 | 实测返回 `undefined`，同一对象里只剩 `node_use_openssl` |
| `curl 200` + `node 失败` 不一定是配置问题 | macOS 上 Node 与浏览器各有信任链（E2 行 2、4 的对比） |
| `curl` 返回 `000` 不是证书问题 | 实测 DSH 绑定局域网 IP 时不监听 `localhost`，用错地址得到 `000`（连不上），与信任失败表现相同（§1） |

### E4. 本文未覆盖的部分

诚实标注边界——以下结论**没有**在本文中实测验证过，请以官方文档为准：

| 事项 | 说明 |
|---|---|
| Windows 的 Node 信任行为 | 未测试。据 Node 文档 Windows 会读系统证书存储，但本文未验证 |
| Alpine / Arch 的 CA 路径 | 摘自各发行版通用做法，**未实测**（§2.5 表格中标注） |
| `--use-system-ca` 在 Linux 上的效果 | 标志被接受且不报错，但本文未单独验证 Linux 上的实际行为差异 |
| 各发行版对自定义 CA 的具体处理差异 | 如 Debian 的 `ca-certificates.crt` 合并时机等细节未深入 |

## 相关文档

- [运维手册](OPERATIONS.md) —— 环境变量（含 `DSH_AUTH_RP_ID`）、备份恢复、升级回滚
- [安全说明与已知边界](SECURITY.md) —— 信任边界与残余风险
- [README](../README.md) —— 安装、首次登录、通行密钥对访问地址的要求
