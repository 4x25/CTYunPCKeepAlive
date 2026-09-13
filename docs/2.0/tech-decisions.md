# CTYunPCKeepAlive 2.0 技术选型决策记录

> 状态：待确认（2026-09-12 起草）
> 所有标注「实测」的结论均在本机 `deno 2.9.6 (aarch64-apple-darwin)` 上跑过验证脚本，非文档推断。

## 0. 决策总览

| # | 决策 | 结论 | 置信度 |
| --- | --- | --- | --- |
| 1 | 运行时 | Deno 2.9+ | 高 |
| 2 | 桌面壳 | `deno desktop`（`webview` 后端） | 中（experimental，需隔离） |
| 3 | HTTP 服务 | Hono 4.13（JSR `@hono/hono`） | 高 |
| 4 | 前端渲染 | `hono/jsx` SSR 外壳 + `hono/jsx/dom` 客户端 + SSE JSON | 高 |
| 5 | 样式 | Tailwind CSS 4.3 + daisyUI 5.5 | 高 |
| 6 | 密码学 | **全部走 `node:crypto`**，不用 Web Crypto | 高（实测） |
| 7 | WebSocket | **内置 `WebSocket`**（`protocols` 传数组 + `headers`），零 npm 依赖 | 高（实测） |
| 8 | 配置存储 | **JSON 文件**，不用 `localStorage` | 高（已确认） |
| 9 | Cookie | 自实现 per-account CookieJar | 高 |
| 10 | 无头模式 | `deno compile` 产出同源 CLI | 高（实测） |

---

## 1. 运行时：Deno 2.9+

采纳用户提议。除了「与浏览器 API 同源」之外，真正的收益是三条：

1. **`fetch` 可以自由设置 `Origin` / `Referer` / `User-Agent`**。浏览器禁止改这三个头，油猴脚本只能寄生在 `pc.ctyun.cn` 页面里才能让请求「看起来对」。搬到后端后，我们可以精确复刻官方 Web 客户端的请求指纹，同时彻底摆脱对页面宿主的依赖。
2. **`node:crypto` 补齐了 Web Crypto 的所有缺口**（见 §6）。1.x 需要 JSEncrypt / forge 这类 shim，2.0 可以全部删掉。
3. **多账号真隔离**。1.x 一个浏览器 profile 只能承载一个会话，需求稿要求的「10 账号并发」在浏览器端根本不可能实现。后端每账号一套独立的 `deviceCode` / `eid`/`evalue` / `secretKey` / cookie jar，这才是 2.0 真正的价值主张。

固定版本：CI 与本地都锁 Deno 2.9.x，不要跟随 `deno upgrade` 漂移（`deno desktop` 还在 experimental）。

---

## 2. 桌面壳：`deno desktop`

### 实测结论

`deno desktop` 在 Deno 2.9（2026-06-25）引入，本机 2.9.6 可用。实测结果：

```
支持 target（6 个）：
  x86_64-unknown-linux-gnu   aarch64-unknown-linux-gnu
  x86_64-pc-windows-msvc     aarch64-pc-windows-msvc
  x86_64-apple-darwin        aarch64-apple-darwin
```

- **macOS 主机交叉编译出 Windows `.msi` 成功**，产物 **30.5 MB**（自动下载 `laufey webview backend v0.7.0`，无需任何 Windows 工具链）。作为对比，Electron 安装包通常 80–150 MB。
- macOS `.app` 产物 65 MB（未压缩，含 V8），构建时自动 ad-hoc 签名。
- `--compress` 只存在于 `deno desktop`，**`deno compile` 没有这个 flag**（用户如果按 blog 推断会踩坑）。

### 需求稿覆盖度

需求稿 §9 的托盘与通知要求，`deno desktop` 原生 API 几乎一一对应：

| 需求稿要求 | Deno API | 备注 |
| --- | --- | --- |
| 托盘两种图标状态（正常 / 异常角标） | `tray.setIcon(pngBytes)` / `setIconDark` | 传字节不是路径 |
| 托盘菜单仅「显示主窗口 / 退出」 | `tray.setMenu([...])` + `menuclick` | 完全够用 |
| 关闭窗口隐藏、进程与托盘常驻 | `win.addEventListener("close", e => { e.preventDefault(); win.hide(); })` | 文档未直接给例子，但 `preventDefault` + `hide()` 是标准组合 |
| Windows 原生 toast 通知 | **Web `Notification` API** | ⚠️ 仅在 `deno desktop` 产物中存在 |
| 一次性说明提示 + 「不再提醒」 | 自己用 HTML 弹层做 | `confirm()` 也会渲染成原生对话框 |
| 检查更新 | `Deno.autoUpdate()`（manifest + bsdiff + 失败回滚） | 比 1.x 手工查 GitHub Release 强，列为 P1 |
| —— 额外白送 | `Deno.dock.setVisible(false)` | macOS 可做纯菜单栏应用 |

**`Notification` 的关键限制（实测文档确认）**：只在 `deno desktop` 编译产物里有定义，`deno run` / `deno compile` 下是 `undefined`。这正好与「无头模式舍弃通知」的预期一致，但代码里必须做特性检测，不能假设存在。另外 `icon` 只认 `data:` URL，`https:` / `file:` 会静默不显示图标。

### 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `deno desktop` 是 experimental，API 可能变 | **所有 `Deno.BrowserWindow` / `Deno.Tray` / `Deno.dock` / `Notification` 调用只允许出现在 `src/shell/desktop.ts` 一个文件里**，core 层通过 `ShellAdapter` 接口访问。真出问题时换成「启动后打开系统浏览器」的降级壳，只丢托盘，不丢功能 |
| Windows 缺 WebView2 Runtime | Win10 1803+ / Win11 默认带 Evergreen Runtime；老 LTSC 需要单独装。README 写明，或另出一个 `--backend cef` 变体包（体积 +数十 MB） |
| 未签名安装包触发 SmartScreen / Gatekeeper | 已知问题，README 说明。真要解决需要买证书，不在 v2.0 范围 |
| 各平台 WebView 渲染差异 | 默认 `webview` 后端跟随系统引擎。UI 用 daisyUI 标准组件，不做 CSS 黑魔法即可 |

**结论：采纳，但必须做壳隔离。** 这是整个方案里唯一一个「上游可能变」的依赖，不能让它渗透进业务代码。

---

## 3 / 4. 服务端与前端渲染

### Hono —— 采纳

实测 Hono 4.13.7（JSR `@hono/hono`）在 Deno 下一切正常，`streamSSE` 输出格式正确，且**能通过 `deno compile` 打进单文件二进制并正常运行**。

### 前端渲染：SSR 外壳 + 客户端增量更新（已确认）

方案是「hono/jsx SSR + SSE 推状态 + 几个 HTTP 触发接口」。这里要避开一个坑：**SSE 不能推 HTML 片段并整体替换**。需求稿里这些交互都要求保持局部状态：

- 倒计时每秒更新 mm:ss，且明确要求「只触碰相关文本节点」（§11）
- 日志自动滚动，用户上滚后自动关闭并显示「回到底部」（§5）
- 日志三级筛选叠加（等级 + 模块 + 关键字）、别名双击内联重命名（§2）
- `desktopCode` 点击复制后「已复制」保持 2 秒（§3）
- 手动按钮 5 种瞬时状态（空闲 / 执行中 / ✓成功 2s / 重试 / 排队中）

每秒全量替换 DOM 会打断滚动位置、输入焦点和这些瞬时状态。

**建议方案：**

```
服务端  hono/jsx        →  SSR 首屏外壳（静态结构 + 骨架屏）
        SSE /api/stream →  推 JSON 状态快照（带 version），不推 HTML
        POST /api/*     →  命令接口（保活、开关、增删账号…）

客户端  hono/jsx/dom    →  React 风格组件 + hooks，按 key 增量更新 DOM
        deno bundle     →  打成单个 client.js
```

**实测：`hono/jsx/dom` + hooks + EventSource + 倒计时组件，`deno bundle --minify` 后仅 15.2 KB**（含整个类 React 运行时）。同一套 JSX 语法服务端客户端通用，组件可共享。

**倒计时不走网络**：服务端只推 `nextKeepAliveAt` 绝对时间戳，客户端本地 `setInterval` 算 mm:ss。这样既满足「每秒更新」又满足「只更新文本节点」，且 SSE 只在状态真变化时才推。

已确认采用此方案（而非手写 vanilla 渲染），理由是交互后续会变复杂，手写渲染顶不住。
SSE 载荷格式细节见 [architecture.md §3.4](./architecture.md)。

### 样式：Tailwind CSS 4 + daisyUI 5

实测**全程不需要 Node**：

```bash
deno run -A npm:@tailwindcss/cli@4 -i src/ui/app.css -o assets/app.css --minify
```

产出正确（Tailwind 4.3.3 + daisyUI 5.5.23，含 `.btn-primary` / `.card` / `.badge-warning` 等类）。唯一要求是 `deno.json` 里设 `"nodeModulesDir": "auto"`，因为 Tailwind CLI 走 Node 的文件系统解析而非 Deno specifier。

CSS 在构建期产出，用 `deno desktop --include-as-is assets/` 嵌进二进制。

---

## 5. 密码学：全部走 `node:crypto`

**这是本次调研最重要的发现。** 六份接口文档要求的原语里，有三个 **Web Crypto 根本不支持**：

| 需求 | 出处 | Web Crypto | `node:crypto` |
| --- | --- | --- | --- |
| MD5 | `CTG-SIGNATURESTR`、`Web-Signature` 的 `bodyMd5` | ❌ 不支持 | ✅ |
| AES-ECB | `eaiSysInfo` 配置解密（key `chinatelecom@cnn`）、`sessionKey` 解密 | ❌ 不支持 | ✅ |
| RSAES-PKCS#1 v1.5 **加解密** | `negotiationEncKey` 的 `encKey` 解密、`clientKey` 加密 | ❌ 只有签名版 | ✅ |
| AES-CBC 零 IV / PKCS#7 | 全部登录态报文 | ✅ | ✅ |
| SHA-256 hex | 密码哈希、`Web-Signature` | ✅ | ✅ |
| RSA-OAEP / SHA-1 | Clink Ticket | ✅（但 seed 不可控） | ✅ |
| 解析 162 字节 DER 公钥 | Clink ServerLink | 需手工拆 DER | ✅ 直接 `createPublicKey` |

**本机实测输出：**

```
MD5: 900150983cd24fb0d6963f7d28e17f72
AES-CBC zeroIV: y3DdwloqIEW0wTCEQYqauw== -> {}
AES-ECB: OILrL3o6RkEmqM2CDFh2ug== -> hello
RSA PKCS1v15 decrypt: intermediate-aes-key
1024-bit SPKI DER len: 162          ← 与 ServerLink 文档的 162 字节完全吻合
Clink ticket cipher len: 128        ← OAEP/SHA-1 加密单个 NUL 字节
ticket plaintext bytes: [ 0 ]
```

162 字节这条尤其关键：接口文档写的「162 bytes DER RSA public key」就是**标准 SPKI DER**，可以直接
`crypto.createPublicKey({ key: der, format: "der", type: "spki" })` 解析，不需要手写 ASN.1 解析器。

**因此 1.x 依赖的 JSEncrypt / node-forge 兼容层可以全部删除。** 关于 OAEP seed：文档要求「20 字节随机 seed，来自 `crypto.getRandomValues`」，`node:crypto` 内部本就用 CSPRNG 生成 seed，行为等价，无需干预。

---

## 6. WebSocket：内置 `WebSocket`，`npm:ws` 作为退路

Deno 的 `WebSocket` 有一个**非标准的 options 对象**（`WebSocketOptions`），支持自定义握手头。
官方文档明确标注 `headers: HeadersInit` 为 non-standard 扩展。

### 关键陷阱：`protocols` 必须传数组

```ts
// ❌ 报错：'protocols' of 'WebSocketInit' can not be converted to sequence
new WebSocket(url, { protocols: "binary", headers });

// ❌ 静默失联：没有 protocols 字段，服务端子协议协商失败
new WebSocket(url, { headers });
new WebSocket(url, { protocol: "binary", headers });   // 字段名是 protocols，不是 protocol

// ✅ 唯一正确写法
new WebSocket(url, { protocols: ["binary"], headers });
```

即使只有一个子协议也必须用数组。前两种错法一个抛异常、一个只在服务端表现为
`Protocol 'binary' not in the request's protocol list`，都不容易一眼看出。

### 实测结果

```
new WebSocket(url, { protocols: ["binary"], headers: { Origin, "User-Agent" } })

  protocol                = "binary"                    ✅
  msgType                 = ArrayBuffer                 ✅
  sec-websocket-protocol  = "binary"                    ✅
  origin                  = "https://pc.ctyun.cn"       ✅
  user-agent              = "Deno/2.9.6, Mozilla/5.0 (Windows NT 10.0; Win64; …)"   ⚠️
```

**注意 `User-Agent` 是追加而不是覆盖**，实际发出的是 `Deno/2.9.6, <自定义值>`。`Origin` 是干净的完整覆盖。
`deno compile` 产物中行为完全一致。

### 结论

用内置 `WebSocket`，**零 npm 依赖**。附带白送 `client: Deno.HttpClient` 选项，
将来要走代理或自定义 TLS 直接可用。

### `npm:ws` 是待定退路，不是计划中的依赖

**M1 实连后二选一，没有中间态：**

| 结局 | 处置 |
| --- | --- |
| 内置 WS 建链成功 | **删除 `npm:ws` 退路**，本小节连同这张表一并从文档移除 |
| 因 UA 前缀被拒 | 切 `npm:ws@8.x`（`Origin` 与 `User-Agent` 均为完整覆盖，无 `Deno/` 前缀），并确认 `bufferutil` / `utf-8-validate` 两个 optional 原生 addon 没被拉进 `deno compile` 产物 |

风险面只剩 `User-Agent` 一项——`Origin` 内置版已实测为干净覆盖。

已核对过的、**不构成**切换理由的场景：

- 自定义 TLS / 走代理 → 内置版有 `client: Deno.HttpClient`
- permessage-deflate → Clink 握手没协商 extension（抓包文档 §5：「本次响应没有返回 WebSocket extension 头」）
- WS 层 ping/pong 保活 → Clink 用应用层 `ACK_SYNC(type=1)`，与 WS 控制帧无关

### `core/ctyun/ws.ts` 窄接口无论如何都保留

即使最终不切库，也保留 `connect(url, {protocols, headers}) → 收发二进制` 这层封装。
理由不是「方便换实现」，而是**可测试性**：Clink 通道状态机要单测的东西
（跨帧重组、15 秒超时、`auth_code` 各分支、重试不复用 `session_id`）都必须靠注入假 transport，
不可能每条用例都连真服务器。成本约 20 行。

> **M1 待验证**：`deskmsgz.ctyun.cn:9011` 代理层是否校验 `Origin` 与 `User-Agent`。
> 跨 frame 重组缓冲区无论用哪个库都要自己写（Clink 文档 §7.1）。

---

## 7. 配置存储：JSON 文件（已确认）

不用 `localStorage`。理由来自需求稿本身：

需求稿 §10 明确写了：

- 明文密码就在配置文件里，README 必须警告用户**分享配置前先删掉 `password` 字段**
- 删除账号要「立即生效并整文件重写」

`localStorage` 在编译产物里落在平台 app-data 目录下的不透明存储中（Deno 2.9 起 `deno compile` 会持久化到 `--app-name` 对应目录）。用户**无法查看、无法编辑、无法删掉密码字段再分享**——直接违背需求稿的处置方案。

**方案：**

```
<appdata>/CTYunPCKeepAlive/
├── config.json          # 原子写（临时文件 + rename）
└── logs/
    └── 2026-09-12.jsonl # 每日一文件，保留 7 天 / 单文件 5 MB 上限
```

平台路径：`%APPDATA%`（Windows）/ `~/Library/Application Support`（macOS）/ `$XDG_CONFIG_HOME`（Linux）。

### 不做文件权限收紧

**已确认砍掉。** 不调 `icacls`，也不做 `Deno.chmod`——按系统默认权限落盘即可。

（需求稿 §10 曾把「`%APPDATA%` 当前用户独占 ACL」列为「真正的防线」。该表述一并作废。）

连带影响：README 的措辞**不能声称文件权限提供了任何保护**。明文密码就是明文密码，
能读到这个文件的人就能拿到账号——如实写这一句即可，不要再提权限防护。

### 单实例：不做锁文件

已确认不引入锁文件机制，由分发形态保证单实例即可。

需要知道的边界：保活会踢掉自己的会话（需求稿 §7 明确承认），所以**如果**同时跑起两个进程，
两个实例会互踢 Clink 会话，表现为「保活一直失败」。这属于误用而非缺陷，不做防护。
`deno compile` 的无头产物在服务器上更容易被重复启动，README 里提一句即可。

---

## 8. Cookie：自实现 per-account CookieJar

Deno 的 `fetch` **没有 cookie jar**（符合规范，cookie 是浏览器职责）。而需求稿 §10 要求：

- 云电脑链（`desk.ctyun.cn:8810`）**不带 cookie**，只靠 `CTG-*` 头 + 加密 body
- `desk.ctyun.cn`（IAM）与 `eaichat.ctyun.cn` **必须共用一个 cookie jar**，否则 `ticketAuthorize` 看不到 IAM 会话

所以必须自己写一个约 100 行的 `CookieJar`（`Set-Cookie` 解析 + domain/path 匹配 + expires）。**每账号一个实例**，只挂在 EAI 客户端上。

这反而比浏览器更好：浏览器里 10 个账号共用一个 cookie jar，根本没法并行。

---

## 9. 无头 / CLI 模式

实测 `deno compile` 能打包完整栈（Hono + JSX + SSE + npm:ws + node:crypto），产物 65 MB，运行正常。

设计：`src/core/` 与壳完全解耦，两个入口共用同一个 core。

| | GUI | 无头 |
| --- | --- | --- |
| 构建 | `deno desktop` | `deno compile` |
| 托盘 / 通知 | ✅ | ❌（`Notification` undefined，降级为日志 + 控制台） |
| 界面 | 内嵌 WebView | 控制台打印 `http://127.0.0.1:<port>`，用户自己开浏览器 |

**安全要求**：默认只绑 `127.0.0.1`。需求稿的「重新登录」对话框会回显明文密码，`--host 0.0.0.0` 必须强制要求 `--token`，否则拒绝启动。

顺手白送的 CLI 子命令（几乎零成本，对服务器用户价值很高）：
`keepalive --account <alias>`、`status --json`、`config export/import`、`logs --tail`。

---

## 10. 对需求稿的增删建议

### 建议砍掉 / 降级

| 项 | 处置 | 理由 |
| --- | --- | --- |
| **文件权限收紧（`icacls` / `chmod`）** | **已确认砍掉** | 见 §7。README 措辞相应不得声称权限提供保护 |
| 积分明细 `getPointDetailList` | 不做 | P0 不需要，纯只读展示，价值低 |
| 「检查 GitHub Release 更新」 | 换成 `Deno.autoUpdate()`（已确认接入，M6） | 官方 API 带 bsdiff 增量 + 启动失败回滚，比手工查强。具体实现方案到 M6 再定 |
| 桌面池 / 抢占式桌面 | 保持 null-safe 透传，不做专门逻辑 | 接口文档明说样本为空、结构未验证 |
| `status=1` 待领取自动领取 | 不做 | 上游没有可用的领取端点，不能编造 |

### 建议新增

| 项 | 理由 |
| --- | --- |
| 日志落盘用 JSONL | 筛选/导出都更容易；导出 `.log` 时再转纯文本 |
| `GET /api/health` | 无头用户接监控 |
| 配置导入 / 导出 | 多机迁移；导出时可选剔除 `password` |

### 需求稿 §12「明确不做」作废（已确认）

原文把「无头 / 服务器模式」和「macOS / Linux」列为 v1 不做。2.0 架构下这两项**基本是免费的**：

- 无头模式：core 与壳本就解耦，`deno compile` 一条命令的事
- macOS / Linux：协议层与宿主 OS 无关——我们**自己填** `osType: 15 (WINDOWS)` 和 Windows 风格 UA（接口文档 4.3 明确说 `osType` 是「客户端 UA 映射」而非远端桌面属性），所以在 macOS 上跑也是以 Windows Web 客户端身份连接。`deno desktop --all-targets` 一次出全平台产物

保持「优先保障 Windows」的定位不变，另外两平台标注为 best-effort、不进验收门槛即可。

---

## 11. 风险清单

| # | 风险 | 等级 | 缓解 | 验证时机 |
| --- | --- | --- | --- | --- |
| R1 | Clink 代理校验 `Origin` / UA | 中 | 内置 WS 可带 `Origin`（干净覆盖）；UA 带 `Deno/2.9.6, ` 前缀，若被校验则切 `npm:ws` | **M1 首要验证点** |
| R2 | 自生成 `CTG-*` 头被服务端拒 | 高 | 接口文档已标注为待验证项 | **M0 登录即可证伪** |
| R3 | `deno desktop` API 变更 | 中 | 壳隔离 + 锁 Deno 2.9.x | 持续 |
| R4 | Windows 缺 WebView2 Runtime | 中 | README 说明 / 备选 `cef` 后端包 | M5 |
| R5 | 未签名包触发 SmartScreen | 中 | README 说明，不在 v2.0 解决 | M6 |
| R6 | `npm:ws` 原生 addon 混入构建 | 低 | 默认零 npm 依赖，不用 `npm:ws`；仅当 R1 迫使切换时才需锁 8.x 并验证产物 | 仅在切换时 |
| R7 | 长连接 1 小时任务的流量成本 | 低 | 最低画质 + 行内悬浮警告（需求稿已要求） | M4 |

---

## 附：本次实测环境

```
deno 2.9.6 (stable, release, aarch64-apple-darwin)
v8 15.0.245.2-rusty / typescript 6.0.3

@hono/hono   4.13.7 (JSR)
tailwindcss  4.3.3  (npm)
daisyui      5.5.23 (npm)
ws           8.21.3 (npm)
```

实测覆盖：`node:crypto` 全部原语 · 内置 WebSocket 与 `npm:ws` 的子协议/二进制/自定义头对比 ·
Hono JSX + SSE · `deno compile` 打包 npm 依赖 · `deno bundle` 客户端产物 · Tailwind/daisyUI 构建 ·
`deno desktop` 本机构建与 macOS→Windows 交叉构建。

### 勘误

初版曾记「内置 `WebSocket` 不支持自定义头，必须用 `npm:ws`」。该结论错误：Deno 的
`WebSocketOptions` 支持 `headers`，只是 `protocols` 必须传数组，传字符串会抛
`can not be converted to sequence`。已按实测更正为内置优先（§6）。
