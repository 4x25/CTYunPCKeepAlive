# CTYunPCKeepAlive 2.0 架构设计

> 配套文档：[技术选型决策](./tech-decisions.md) · [里程碑与进度](./milestones.md)
> 接口事实来源：`docs/*.md` 六份抓包文档。**任何字段语义以那六份为准，本文不复述。**

## 1. 分层原则

```
┌─────────────────────────────────────────────────────────┐
│  shell/          桌面壳（唯一允许出现 Deno.BrowserWindow  │
│                  / Deno.Tray / Notification 的地方）      │
├─────────────────────────────────────────────────────────┤
│  server/         Hono HTTP + SSE + JSX SSR + 客户端 bundle│
├─────────────────────────────────────────────────────────┤
│  core/           ★ 全部业务逻辑。不 import 任何 UI/壳 API  │
│                  可被 CLI、GUI、测试直接复用              │
├─────────────────────────────────────────────────────────┤
│  core/ctyun/     协议层。一份文档一个模块，不掺业务决策    │
└─────────────────────────────────────────────────────────┘
```

三条硬约束：

1. **`core/` 不得 import `shell/` 或 `server/`**。lint 规则强制。
2. **`core/ctyun/` 只做协议翻译**，不做重试、不做调度、不写日志决策——那是上层的事。这样协议层可以按接口文档逐条对照审查。
3. **壳能力全部走 `ShellAdapter` 接口**。无头模式注入一个 no-op 实现，桌面模式注入真实现。`deno desktop` 哪天改 API，只动一个文件。

```ts
interface ShellAdapter {
  notify(o: { title: string; body: string; tag?: string; onClick?: () => void }): void;
  setTrayState(state: "normal" | "anomaly"): void;
  showWindow(): void;
  readonly kind: "desktop" | "headless";
}
```

---

## 2. 目录结构

```
CTYunPCKeepAlive/
├── deno.json                 # workspace / tasks / imports / compilerOptions
├── deno.lock
├── AGENTS.md                 # 给 AI 协作者的项目约定
├── docs/
│   ├── ctyun-*.md            # ← 已有的六份接口文档，只读，不要改
│   ├── bundle-snapshots/     # ← 已有的前端 bundle 快照
│   └── 2.0/
│       ├── tech-decisions.md
│       ├── architecture.md   # 本文
│       └── milestones.md     # ★ 跨会话进度追踪
├── assets/
│   ├── tray-normal.png       # 22×22 模板图标
│   ├── tray-anomaly.png
│   ├── icon.ico / icon.icns
│   └── app.css               # 构建产物（Tailwind + daisyUI）
└── src/
    ├── main.ts               # 统一入口：解析 argv → desktop | headless | oneshot
    │
    ├── shell/
    │   ├── adapter.ts        # ShellAdapter 接口 + headless 实现
    │   └── desktop.ts        # ★ 唯一使用 deno desktop API 的文件
    │
    ├── server/
    │   ├── app.tsx           # Hono 实例、路由挂载
    │   ├── api.ts            # POST 命令接口
    │   ├── stream.ts         # GET /api/stream（SSE 状态推送）
    │   ├── ssr.tsx           # hono/jsx 首屏外壳
    │   └── ui/               # 组件（服务端 SSR + 客户端 hydrate 共用）
    │       ├── client.tsx    # hono/jsx/dom 入口 → deno bundle
    │       ├── AccountTabs.tsx  KeepAliveTab.tsx
    │       ├── PointsTab.tsx    LogTab.tsx
    │       └── app.css       # @import "tailwindcss"; @plugin "daisyui";
    │
    └── core/
        ├── ctyun/            # ── 协议层，一文档一模块 ──
        │   ├── envelope.ts   # CTG 头构造 / AES-CBC data·edata / MD5 签名 / 时间校正
        │   ├── nego.ts       # getServData → negotiationEncKey（eid/evalue）
        │   ├── auth.ts       # genChallengeData → login 条件状态机 → logout
        │   ├── desktops.ts   # pageDesktop / listDesktopByIds / GET list 回退 / sortList 组装
        │   ├── connect.ts    # queryConnectData ⟷ connect 竞速 + connectUrl 轮询规则
        │   ├── points.ts     # getUserPoints / getTaskList
        │   ├── clink/
        │   │   ├── frame.ts      # ClinkHeader / ClientLink / ServerLink / mini header / LE 编解码
        │   │   ├── reassembler.ts# 跨 WS frame 字节流重组
        │   │   ├── ticket.ts     # 162B SPKI → RSA-OAEP/SHA-1 → 132B Ticket
        │   │   ├── channel.ts    # 单通道状态机 CONNECTING→…→READY
        │   │   └── session.ts    # MAIN+DISPLAY+INPUTS 编排、0x0e 就绪掩码、ACK_SYNC
        │   ├── eai/
        │   │   ├── sysinfo.ts    # eaiSysInfo + AES-ECB(chinatelecom@cnn) 解密
        │   │   ├── iam.ts        # IAM login → ticket → ticketAuthorize → sk
        │   │   ├── sign.ts       # Web-Signature / Web-Random / Web-Timestamp
        │   │   └── chat.ts       # /chat/completions SSE + 模型回退
        │   ├── cookiejar.ts  # per-account，只挂 EAI 链
        │   ├── ws.ts         # WS 窄接口，唯一 new WebSocket 的地方（退路：npm:ws）
        │   └── http.ts       # fetch 封装：UA/Origin/Referer、超时、重试钩子
        │
        ├── account.ts        # 账号 actor：4 态状态机、凭据生命周期、静默重登
        ├── keepalive.ts      # 四步保活管线（编排 connect + clink/session）
        ├── tasks.ts          # 积分任务 1002 / 1004 / 1003
        ├── scheduler.ts      # 全局时间轮 + 优先级队列 + 并发/节流
        ├── errors.ts         # 11 类失败分类 + 重试策略表
        ├── store.ts          # config.json 原子读写（临时文件 + rename）+ appdata 路径解析
        ├── logger.ts         # 环形缓冲 + 每日文件 + 脱敏 + 03:00 清理
        ├── state.ts          # 状态快照（SSE 的唯一数据源）
        └── bus.ts            # 事件总线 core → server
```

---

## 3. 关键子系统

### 3.1 账号 actor

每个账号一个独立对象，持有：

| 持久化 | 仅内存 |
| --- | --- |
| `password`（明文，需求稿决策） | `eid` / `evalue` / 临时 RSA 私钥 |
| `userId` `deviceCode` | `secretKey` / `authData` / `authExpiredAt` / `offsetTime` |
| `eaiDeviceCode` `eaiClientKey` `eaiXuid` | Clink 证书 / key / CA / token / `session_id` |
| `keepAlive{intervalMinutes,autoInstances[]}` | IAM ticket（一次性，禁止缓存） |
| `points{windowStart,windowEnd,autoTasks[]}` | `sk` / `Web-Signature` 每请求生成 |

四态状态机（需求稿 §2）：`正常` / `登录中` / `登录失败` / `需人工处理`。**只有主站 `/api/auth/client/login` 能改账号状态**；EAI 侧受阻只挂起任务 1004，不改账号状态点。

凭据生命周期：`authExpiredAt = now + 2h`，每 30 分钟刷新本地时间戳（**不是预防性登录请求**）。`40010` / 本地过期 / 启动检查失败 → 静默重登（`getServData → negotiationEncKey → genChallengeData → login`），上限 3 次/小时。

### 3.2 调度器

**一个全局时间轮 + 一个优先级队列**，不是每个任务一个 `setTimeout`。

```
优先级：手动 > 登录/重认证 > 自动保活 > 积分任务     （同级 FIFO）

并发：全局 2 · 单账号 1（严格串行）
节流：账号内请求间隔 1.5–3s 随机 · 跨账号 ≥800ms · 单账号 10 次/分
队列：容量 50，超限丢最低优先级并记 WARN（绝不静默丢弃）
超时：单动作 2 分钟 · 保活单轮 45 秒硬上限
```

**睡眠/唤醒检测**：时间轮每次 tick 比对墙钟漂移，超阈值则重算全部日程，每对象至多补跑一次。Deno 没有电源事件 API，这是唯一可行路径。

**会话锁**：每台云电脑一把锁，由周期保活 / 手动保活 / 1 小时任务竞争。**抢不到就跳过本轮，不排队等**——凭据 60 秒就过期，等待没有意义。

### 3.3 保活管线（四步原子）

```
① 连接信息   queryConnectData 立即 ‖ connect 延迟 10ms，先成功者胜
             普通请求失败 → 立即整轮失败（缓存成功也不救）        10s 超时
② MAIN       WS → proxy JSON → 0x01 → REDQ+ClientLink(conn=0)
             → ServerLink(error=0) → 132B Ticket → auth_code=0
             → MAIN_INIT(103) 取 session_id                      15s 超时
③ DISPLAY    用 session_id 建链 → DISPLAY_SETTING(108) → DISPLAY_INIT(101)
   INPUTS     用 session_id 建链                                 各 15s 超时
④ 判定       就绪掩码 == 0x0e → 成功 → 关闭三通道（1 小时任务除外）
                                                          整轮 45s 硬上限
```

**绝对不能复用**：重试一律从 ① 重新开始，`session_id` / token / 证书全部作废。

`auth_code=7`（PERMISSION_DENIED）= 会话冲突，**不重试、不通知**，当作正常跳过。
`auth_code=8/9` = 协议类错误，不重试，完整帧号只进日志。

### 3.4 状态推送

```
core/bus.ts ──(状态变更)──> server/stream.ts ──SSE──> 客户端 store ──> hono/jsx/dom 重渲染
```

SSE 推的是 **JSON 状态快照**，不是 HTML。事件类型：

| event | 载荷 | 触发时机 |
| --- | --- | --- |
| `snapshot` | 全量状态 + `rev` | 客户端连上时 |
| `patch` | 变更部分 + `rev` | 状态变更 |
| `log` | 单条日志 | 新日志产生 |

**载荷约定**

- 每条 `snapshot` / `patch` 带单调递增的 `rev`。客户端发现 `rev` 不连续（漏帧、重连）就丢弃增量、
  重新拉一次全量，避免状态静默错位。
- `patch` 按顶层键做浅合并；数组（设备列表、任务列表）整体替换并要求元素带稳定 key
  （设备用 `objId`、任务用 `taskDefId`），由 `hono/jsx/dom` 按 key 做增量 DOM 更新。
- 日志走独立 `log` 事件而非塞进 `patch`，这样高频日志不会连带触发整表重渲染。
  筛选在客户端做——服务端不感知每个客户端的筛选条件，避免多窗口时状态分叉。

**倒计时不占 SSE 带宽**：只推 `nextKeepAliveAt` 绝对时间戳，客户端本地算 mm:ss。

### 3.5 日志与脱敏

- 内存环形缓冲 2000 条 → UI
- 每日文件 `logs/YYYY-MM-DD.jsonl`，保留 7 天 / 单文件 5 MB，03:00 清理（错过则下次启动补做并记录结果）
- 导出时 JSONL → `.log` 纯文本

**脱敏在 logger 入口统一做，不靠调用方自觉**：手机号中间四位、凭据留首 6 末 4、密码永不打印。接口文档各节列出的「不得入日志字段」维护成一张常量表，logger 按 key 名自动打码。

日志只用 `objName` 或工具自生成短索引指代桌面，**绝不打印 `objId` / `desktopId` / `desktopCode`**。

---

## 4. HTTP 接口契约（草案）

```
GET  /                       SSR 首屏
GET  /assets/*               静态资源（CSS / client.js / 图标）
GET  /api/stream             SSE 状态流

POST /api/accounts           新增账号 {account,password,alias}
POST /api/accounts/:id/relogin      凭据订正（回显密码的唯一入口）
POST /api/accounts/:id/rename       别名内联重命名
DEL  /api/accounts/:id

POST /api/keepalive/run      手动保活 {accountId, objId}
POST /api/keepalive/auto     单机开关 {accountId, objId, enabled}
POST /api/keepalive/interval {accountId, minutes}        1–59
POST /api/desktops/refresh   {accountId}                 10s 节流

POST /api/points/run         手动执行 {accountId, taskDefId}
POST /api/points/auto        {accountId, taskDefId, enabled}
POST /api/points/window      {accountId, start, end}

GET  /api/logs/export        .log 下载
POST /api/logs/clear
GET  /api/health             无头模式监控用
```

所有 POST 幂等或带去重：相同 `account+object+action` 在队列中重复入队直接丢弃（按钮同时置灰）。

---

## 5. 构建与产物

```jsonc
// deno.json tasks
{
  "css":     "deno run -A npm:@tailwindcss/cli@4 -i src/server/ui/app.css -o assets/app.css --minify",
  "client":  "deno bundle --minify --platform browser -c client.deno.json -o assets/client.js src/server/ui/client.tsx",
  "build":   "deno task css && deno task client",
  "dev":     "deno task build && deno desktop --hmr src/main.ts",
  "pack:win":  "deno task build && deno desktop --target x86_64-pc-windows-msvc --icon assets/icon.ico --compress -o dist/CTYunPCKeepAlive.msi src/main.ts",
  "pack:all":  "deno task build && deno desktop --all-targets --compress -o dist/CTYunPCKeepAlive src/main.ts",
  "pack:cli":  "deno task build && deno compile -A --include assets --output dist/ctyun-keepalive src/main.ts"
}
```

产物参考体积（实测同类空项目）：Windows `.msi` ≈ 30 MB，macOS `.app` ≈ 65 MB（未压缩）。

CI：单个 Linux runner 用 `--all-targets` 出全平台包（Windows `.msi` 与 Linux `.deb`/`.rpm` 打包器是纯 Rust 实现，不需要目标平台工具链）。

---

## 6. 测试策略

| 层 | 方式 |
| --- | --- |
| `core/ctyun/` 编解码 | 纯单测。Clink 帧用接口文档里的字节长度做断言（MAIN client REDQ=42B、Ticket=132B、MAIN_INIT payload=32B…） |
| 加密原语 | 对拍固定向量；`negotiationEncKey` 用自生成密钥对走完整往返 |
| 调度器 | 注入可控时钟，断言间隔/抖动/并发上限/睡眠唤醒补跑 |
| 协议集成 | 本地 mock 服务器复刻 6 份文档的报文，含失败分支 |
| 真实联调 | 只在 M0/M1/M4 的门禁点上跑，用真账号，人工核对 |

**接口文档明确标注「未实测」的分支（桌面池、`status=1/3`、`willOutDate` 非空）一律只写降级路径，不编造默认值。**
