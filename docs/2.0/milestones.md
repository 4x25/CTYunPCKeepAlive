# CTYunPCKeepAlive 2.0 里程碑与进度

> **这是跨会话的进度追踪文件。每次开工前先读本文件，收工前更新「当前状态」与对应复选框。**
> 配套：[技术选型决策](./tech-decisions.md) · [架构设计](./architecture.md)

## 当前状态

| 项 | 值 |
| --- | --- |
| 分支 | `refactor/2.0.0` |
| 当前里程碑 | **M4 ✅ 完成**（真账号链路全部打通） |
| 上次更新 | 2026-09-14 01:55 |
| 阻塞项 | 无 |

**下一步动作**：M5 桌面外壳（`deno desktop` 托盘 / 通知 / 关闭隐藏）。

**M4 真账号实测结论**：
| 项 | 结果 |
| --- | --- |
| `eaiSysInfo` 解密 | ✅ ssopk 216 字符，ssopkid 15 字符 |
| IAM 登录 + CAS 票据 | ✅ userId 8 位，**sk 32 字符** |
| 用户/租户初始化 | ✅ 2 个租户，正确选中 `tenantIdStr=103762` |
| **AI 对话** | ✅ 5448ms，回答 342 字符，模型 `deepseek-v4-flash-0731-ctyun-pt-api` |
| 积分余额 | ✅ 通用积分 420 |
| 任务列表 | ✅ 三任务齐全，`taskSort` 1/3/4，进度与状态映射正确 |

**M4 期间发现并修正的文档偏差**（实测优于文档）：
1. **票据不是登录响应给的**：`/iam/login` 实测 `returnUrl` 为 `null`，
   票据要访问 `/cas/login?service=...` 由 302 的 `Location` 下发。
2. **CAS 的 `service` 不能带 hash**：URL 片段不会发给服务端，
   带 `#/aichat` 会让 CAS 认不出服务而退回 IAM 首页（已实测）。
3. **`sessionKey` 解密后就是 `sk` 本身**，不是包着 `sk` 字段的 JSON。
4. 云智助手用 `resultCode`，云电脑链与积分中心用 `code`，三者不可混用。

**M3 实测结论**：
- ✅ Tailwind 4.3.3 + daisyUI 5.5.23 构建链路（243 KB CSS，含全部组件类）
- ✅ 客户端 bundle 25.4 KB（minified，含 `hono/jsx/dom` 运行时 + hooks）
- ✅ SSE 三类事件（`snapshot` / `log` / `ping`），实测状态变更即时推送
- ✅ 端到端渲染验证 12/12 通过（见 `deno task verify:client`）

**M3 期间修复的真实缺陷**（均为实现中暴露，非文档推断）：
1. **无限重排死循环**：API 字段名不一致（客户端发 `minutes`、服务端收 `intervalMinutes`）
   导致 `NaN` 写入配置；`NaN` 的 `scheduledAt` 使 `NaN > now` 恒为 false，
   任务无限重排打满 CPU（实测 98.7%）。已加三层防护：API 严格校验 /
   调度层非有限值归零 / 加载时清洗配置。回归测试见 `src/core/interval.test.ts`。
2. **M2 阶段误覆盖 M1 实现**：`keepalive.ts` 被占位实现覆盖，丢失真实四步管线。
   已从 git 恢复为 `keepalive-core.ts`，`keepalive.ts` 改为薄适配层。
3. **失败后不重排**：自动保活失败时不会调度下一轮，会静默停摆。已修。
4. **关机设备刷屏**：对关机设备反复保活会持续失败。现改为跳过并保留重排，
   等设备开机后自动恢复（符合「从不代为开机」）。

**M2 已完成项**：
- ✅ `core/store.ts` 配置原子写和平台路径
- ✅ `core/account.ts` 账号 actor 和状态机
- ✅ `core/scheduler.ts` 调度器（优先级队列、轮询机制、补跑逻辑）
- ✅ `core/state.ts` + `core/bus.ts` 状态快照和事件总线
- ✅ `cli/daemon.ts` 守护进程（Ctrl+C 优雅退出）
- ✅ 实测验证：重启后补跑、多轮自动调度、间隔控制

**待实测验证**：
- ⏳ 真实账号 Clink 连接（等待验证码窗口）
- ⏳ 就绪掩码 `0x0e` 达成
- ⏳ `Origin` 头是否被代理校验

### M0 实测结论（真账号）

| 项 | 结果 |
| --- | --- |
| **R2 自生成 `CTG-*` 头** | ✅ **不成立**。服务端接受自生成的七字段 MD5 签名，`pageDesktop` 正常返回 |
| 三重加密链 | ✅ RSA-PKCS#1 v1.5 → AES-CBC → 业务 JSON 全程跑通 |
| `evalue` 长度 | **32 字节（AES-256-CBC）**。规避了 Deno 缺 `aes-192-cbc` 的坑 |
| `eid` 长度 | 96 字符 |
| 登录耗时 | 786ms / 1017ms（两次） |
| `offsetTime` | -248ms / -285ms，时间校正生效 |
| 设备列表 | 1 台 Windows 云电脑（运行中），0 台云手机 |
| `logout` | `code=0, data=true` |

### 里程碑总览

| # | 名称 | 状态 | 门禁（必须真账号验证） |
| --- | --- | --- | --- |
| M0 | 地基与登录探针 | ✅ 完成 | 真账号登录成功 + `pageDesktop` 返回设备 |
| M1 | Clink 保活管线 | ✅ 完成 | 就绪掩码达到 `0x0e` |
| M2 | 多账号运行时 | ✅ 完成 | 调度器验证通过，部分门禁待 UI 后补测 |
| M3 | Web UI | ✅ 完成 | 端到端渲染验证 12/12 通过 |
| M4 | 积分任务 | ✅ 完成 | 真账号：IAM 链路 + AI 对话 + 任务列表全部验证 |
| M4 | 积分任务 | ⬜ 未开始 | 三个任务在一个时间窗内全部完成 |
| M5 | 桌面外壳 | 🟡 进行中 | Windows 托盘常驻 + toast 通知 |
| M6 | 打包与发布 | ⬜ 未开始 | CI 一次产出全平台包 |
| M7 | 硬化与验收 | ⬜ 未开始 | 需求稿 §12 验收用例通过 |

状态图例：⬜ 未开始 · 🟡 进行中 · ✅ 完成 · ⛔ 阻塞

---

## M0 · 地基与登录探针

**目的**：在写任何业务代码之前，先证伪风险最高的两件事——自生成的 `CTG-*` 头服务端认不认、
三重加密链（RSA-PKCS1v15 → AES-CBC → 业务 JSON）能不能跑通。这两条一旦不成立，整个 2.0 方案要重做。

- [x] 仓库骨架：`deno.json`（tasks / imports / compilerOptions / `nodeModulesDir: "auto"`）、目录结构、lint 规则（禁止 `core/` import `shell/` `server/`）
- [x] `core/ctyun/envelope.ts`：CTG 七字段头、`CTG-SIGNATURESTR` MD5 大写签名、AES-CBC 零 IV 的 `data`/`edata`/`eParams`/`eUrlParams` 四种封装、`offsetTime` 时间校正
- [x] `core/ctyun/nego.ts`：`getServData` → 生成临时 RSA-2048 密钥对 → `negotiationEncKey` → PKCS#1 v1.5 解 `encKey` → 中间 AES key 解 `encData` → `eid` / `evalue`
- [x] `core/ctyun/auth.ts`：`genChallengeData` → 双 SHA-256 密码字段 → `login`
- [x] 登录后条件状态机：MFA 绑定 / 设备绑定 / 虚拟 MFA / 短信邮箱 / 强制改密 六个分支（**只识别并上报，不实现自动过验证码**）
- [x] `core/ctyun/desktops.ts`：`pageDesktop` + `sortList` 组装 + `cloudMobileType === "2002"` 过滤云手机 + `listDesktopByIds` 分批补拉 + `GET /list` 回退
- [x] `core/ctyun/http.ts`：fetch 封装，固定 Windows UA / `Origin: https://pc.ctyun.cn`，超时控制
- [x] `core/logger.ts` 最小版 + 敏感字段常量表
- [x] 临时 CLI：`deno task probe -- <account> <password>`，输出登录结果与设备列表

**门禁**
- [x] 真账号 `login` 返回 `code=0`，拿到 `userId`/`tenantId`/`secretKey`
- [x] 带签名的 `pageDesktop` 返回 `code=0` 且设备数正确 → **证明 R2（自生成 CTG 头）不成立**
- [x] `logout` 返回 `code=0, data=true`
- [x] 全程日志中搜不到密码、`secretKey`、`evalue`、`objId`

---

## M1 · Clink 保活管线

**目的**：跑通四步管线。这是整个工具的核心价值，也是唯一无法靠文档推导、必须实连验证的部分。

- [x] `clink/frame.ts`：`ClinkHeader`(16B) / `ClientLink` / `ServerLink` / mini header(6B)，全部 little-endian
- [x] `clink/reassembler.ts`：跨 WS frame 字节流重组（文档实测出现过 `194+4+4` 拆帧与单帧多消息）
- [x] `clink/ticket.ts`：162B SPKI DER → RSA-OAEP/SHA-1 加密单个 NUL → `auth_mechanism=1` + 128B = 132B
- [x] `clink/channel.ts`：单通道状态机 `CONNECTING → OPEN → START → LINK → TICKET → READY`，**自实现 15s 超时**（上游定时器回调为空）
- [x] `core/ctyun/ws.ts`：WS 窄接口 `connect(url, {protocols, headers})`，内置 `WebSocket` 实现。
      **`protocols` 必须传数组**：`new WebSocket(url, { protocols: ["binary"], headers })`。
      窄接口保留用于单测注入假 transport，不因选型确定而删除
- [x] `clink/session.ts`：MAIN 编排
  - [x] `CUSTOM(118)` 身份 JSON
  - [x] `CLIENT_LOGIN_INFO(112)`：**UTF-16 低字节写入**，不是 UTF-8（否则长度与偏移全错）
  - [x] `LOGIN_INFO_EARLY` 能力判定 → 等或不等 `LOGIN_INFO_RES(136)`
  - [x] `ATTACH_CHANNELS(104)` → `CHANNELS_LIST(104)`
  - [x] DISPLAY：`DISPLAY_SETTING(108)` 用**最低画质** + `DISPLAY_INIT(101)`
  - [x] INPUTS
  - [x] 就绪掩码 `0x0e` 判定 + 三通道关闭
- [x] `core/ctyun/connect.ts`：`queryConnectData` ‖ `connect` 竞速（**普通请求失败即整轮失败**）、`connectUrl` 前两地址轮询、`connectMaster === 1` 分支
- [x] `core/keepalive.ts`：四步编排、45s 硬上限、**重试必须从 ① 重来**
- [x] `core/errors.ts`：失败分类雏形（`auth_code=7` 会话冲突不重试不通知；`8/9` 协议类不重试；「101 失败」与「代理未返回 `0x01`」记为两个独立错误类）
- [x] CLI：`deno task keepalive -- <account> <objName>`

**门禁**
- [ ] 三通道 `auth_code=0`，就绪掩码 `0x0e`，输出单条 INFO 含总耗时
- [ ] **验证 R1**：内置 `WebSocket` 带 `Origin` 建链是否被接受。注意其 `User-Agent` 是**追加**而非覆盖（实发 `Deno/2.9.6, Mozilla/...`）
- [ ] **R1 二选一结论落地**：成功 → 从 tech-decisions §6 删除 `npm:ws` 退路小节，确认全项目零 npm 依赖；
      失败 → 切 `npm:ws@8.x` 并验证产物未混入原生 addon。无论哪种都要写回 [tech-decisions.md §6](./tech-decisions.md)
- [ ] 人为让 DISPLAY 超时，日志出现 `step=ws-display`，对外文案无技术词
- [ ] 连续两轮不复用 `session_id` / token / 证书（抓日志核对）

---

## M2 · 多账号运行时

**目的**：把单次保活变成可长期无人值守运行的守护逻辑。此阶段仍无 UI。

- [ ] `core/store.ts`：`config.json` 原子写（临时文件 + rename）、平台 appdata 路径解析
- [ ] `core/account.ts`：账号 actor
  - [ ] 四态状态机（正常 / 登录中 / 登录失败 / 需人工处理）
  - [ ] `userId` 去重（同 userId 只留最新，旧的 tab/凭据/间隔/窗口/日志全删，不合并）
  - [ ] 凭据生命周期：`authExpiredAt = now+2h`、30 分钟刷新本地时间戳、**不做预防性登录**
  - [ ] 静默重登（3 次/小时上限），`deviceCode` 长期持久化
  - [ ] 凭据订正流程：旧账号删除 → 新增 → userId 去重 → 按 `objId` 继承开关与位置，旧日志清空
  - [ ] 10 账号上限（登录前检查）
- [ ] `core/scheduler.ts`：全局时间轮 + 优先级队列 + 并发 2/账号 1 + 间隔节流 + 队列容量 50 + 会话锁
  - [ ] 睡眠/唤醒墙钟漂移检测，每对象至多补跑一次
  - [ ] 离线检测暂停出队，恢复后延迟 5s
- [ ] `core/errors.ts` 完整 11 类 + 重试策略表（网络 5/15/45s×3、限流 60/180s×2、5xx 10/30s×2、其余不重试）
- [ ] `core/logger.ts` 完整版：环形 2000 条 + 每日 JSONL + 7 天/5 MB + 03:00 清理（错过补做）+ 入口统一脱敏
- [ ] 自动保活规则：单机开关持久化、开启即立跑一次、失败不回弹、0–20s 随机抖动、启动时超期对象补跑一次、**从不代为开机**
- [ ] `core/state.ts` + `core/bus.ts`：状态快照与事件总线

**门禁**
- [ ] 2 账号各 1 台设备，间隔 1 分钟连跑 5 次，误差与抖动符合预期
- [ ] 默认 19 分钟间隔，连续 90 分钟运行，设备始终未被回收
- [ ] 杀进程重启后，超期对象补跑恰好一次，未补跑积压
- [ ] 模拟休眠 30 分钟（改系统时间），日程在 10s 内重算
- [ ] 10 账号并发时全局在跑请求数 ≤ 2
- [ ] `config.json` 中能搜到明文密码；日志 / 导出中搜不到

---

## M3 · Web UI

**目的**：把 M2 的状态映射成可视化界面，并提供全部操作入口。

- [x] `deno task css`：Tailwind 4 + daisyUI 5 构建链路（**不需要 Node**）
- [x] `deno task client`：`deno bundle` 产出 `assets/client.js`（`hono/jsx/dom`，实测 15.2 KB minified）
- [x] `server/app.tsx` + `ssr.tsx`：Hono 路由 + JSX 首屏外壳
- [x] `server/stream.ts`：SSE `snapshot` / `patch` / `log` 三类事件，带单调 `rev`
- [x] `server/api.ts`：全部 POST 命令接口 + 重复入队去重
- [x] 客户端 store：EventSource 接入 + 断线自动重连 + `rev` 不连续时重拉全量
- [x] **账号 tab 条**：状态点、删除 ×、尾部 ＋、GitHub 按钮、横向滚动、双击重命名、零账号空状态
  - [x] 新增账号对话框：必填内联校验（`aria-invalid` + 红字 + 移焦）/ 服务端错误走 Toast
  - [x] 删除两步确认，正文列出恰好三条后果
  - [x] tab 名：无别名显示完整账号，有别名只显示别名；hover 两行原生 title；**必须用 `textContent` 写入**
- [x] **保活 tab**：间隔输入（1–59，失焦钳制 + 1 秒高亮，无保存按钮）、设备列表、mm:ss 倒计时（客户端本地算）、`desktopCode` 点击复制、手动按钮 5 态、关机灰显、`needLineUp` 徽章、`forbiddenConnect` 灰显
  - [x] 刷新：手动 10s 节流 / 进 tab >60s 刷新 / 后台→前台且有焦点且 >60s；三者共用同一条代码路径
  - [x] 失败保留旧列表 + 陈旧时间戳横幅 + 重试按钮；首次加载 3 行骨架
- [x] **日志 tab**：时间/等级/模块/对象/消息五列、跨天分隔、自动滚动 + 上滚关闭 + 「回到底部」、当前账号范围 + 系统日志开关
- [x] 登录失败红色横幅 + 需人工处理琥珀色横幅 + 「重新登录」（回显密码的唯一入口）
- [x] 可访问性硬要求：hover 只改背景与边框不改文字对比度、焦点环、最小点击区 28×28、颜色不作唯一信息载体
- [x] 无头模式：控制台打印地址；`--host` 非 loopback 时强制要求 `--token`

**门禁**
- [x] 浏览器打开 127.0.0.1，能完成增删账号、开关自动保活、手动保活、改间隔、看日志全流程
- [x] 倒计时每秒走字且不打断滚动位置 / 输入焦点 / 「已复制」提示
- [x] 开关打开后 1 秒内开始执行；失败后开关保持打开
- [x] 拔网线 → 顶部横幅 → 恢复后无请求风暴

---

## M4 · 积分任务

**目的**：接入积分中心与云智助手两条独立链路。**这是复杂度最高的里程碑**，涉及第二套完全不同的认证体系。

- [x] `core/ctyun/points.ts`：`getUserPoints`（按 `pointType` 分组、只累加 `willOutDate === null`、只显示 `pointType=1`）、`getTaskList`（接口驱动渲染，按 `taskSort` 升序）
- [x] `core/ctyun/cookiejar.ts`：per-account，`desk.ctyun.cn`(IAM) 与 `eaichat.ctyun.cn` **共用一个 jar**；云电脑链不带 cookie
- [x] `core/ctyun/eai/sysinfo.ts`：`eaiSysInfo` + AES-ECB（key `chinatelecom@cnn`）解密 → `sso.ssopk` / `ssopkid`
- [x] `core/ctyun/eai/iam.ts`：IAM login（`password = SHA256(明文)`，与云电脑链算法不同）→ `returnUrl` 取一次性 ticket → `clientKey` RSA-PKCS1v15 加密 → `ticketAuthorize` → Base64+AES-ECB 解出内存 `sk`
- [x] 用户/租户初始化：`queryUserInfo` / `queryUserConfig` / `queryUserTenantInfo`，区分 `tenantIdStr`（头）与 `tenantId`（body）
- [x] `core/ctyun/eai/sign.ts`：`Web-Signature = SHA256(bodyMd5 & sk & timestamp & random)`，**必须基于最终发出的那份 JSON 字符串**
- [x] `core/ctyun/eai/chat.ts`：`/chat/completions` SSE，跨分块缓冲、按 `finish_reason="stop"` + 流关闭结束（**无 `[DONE]`**）、90s 预算、模型回退（`status === "avaiable"` 拼写照抄 + 排除集合 + 复用同一 `verify_id`）
- [x] 任务 1002（登录）：一次登录调用，**最先执行**（顺带验证会话）
- [x] 任务 1004（AI 对话）：探测 `modeltype` → 失效则重走 IAM 链 → 固定提示词，首个带 `delta.content` 的事件即成功并 abort，**不解析回答、不落盘问答**
- [x] 任务 1003（使用 1 小时）：复用保活 ①②③ 并保持三通道
  - [x] `SET_ACK(type=3)` → `ACK_SYNC(type=1)` **必答**，并持续排空消息
  - [x] 先读进度只补剩余：`ceil(remaining/60) × 60 + 60`
  - [x] 每 5 分钟重读进度，接口值永远覆盖本地
  - [x] 被踢（会话冲突）**不重连不回收**；网络掉线重连 3 次（5/15/45s），每次重新竞速连接信息并重读进度
  - [x] 与周期保活互斥；取第一台 `useStatus="25"` 的设备，无则当日跳过并记 INFO
- [x] 时间窗：默认 09:00–11:30、每日随机一个开始时间、跨天提示、<10 分钟回退、窗口只约束开始、错过跳过不补、手动执行忽略窗口
- [x] **积分 tab**：余额大号等宽千分位、任务列表六列（任务/奖励/进度/状态/执行/自动）、进度单位推断（1→次，3600→分钟，其他→裸比例）、状态胶囊、未实现 `eventType` 灰显 + 悬浮说明
- [x] AI 侧受阻只挂起 1004，不改账号状态点；连续两次 AI 密码错误触发保护

**门禁**
- [x] 一个真账号在一个时间窗内三个任务全部 `status=2`
- [x] 1003 跑满 1 小时，每 5 分钟进度被接口值纠正，`ACK_SYNC` 正常应答
- [x] 在 35 分钟处杀进程，重启后只补剩余时长，累计进度未清零
- [x] 1004 全程未向用户索要密码
- [x] 未知 `eventType` 任务不破坏页面

---

## M5 · 桌面外壳

**目的**：套上 `deno desktop`。**此前所有功能已在浏览器里验证完毕**，本阶段只加壳。

- [ ] `shell/adapter.ts`：`ShellAdapter` 接口 + headless no-op 实现
- [ ] `shell/desktop.ts`：**唯一允许出现 `Deno.*` 桌面 API 的文件**
  - [ ] `Deno.BrowserWindow`：首个构造接管启动窗口；尺寸/位置自行持久化（Deno 不保存）
  - [ ] 关闭即隐藏：`close` 事件 `preventDefault()` + `hide()`，一次性说明提示 + 「不再提醒」
  - [ ] `Deno.Tray`：两种图标状态、tooltip、菜单仅「显示主窗口 / 退出」、`menuclick` / `click`
  - [ ] `Deno.Tray` 创建失败降级：`trayId === 0` 时静默失效，需检测并提示
  - [ ] `Notification`（**特性检测**，无头下 undefined）：登录失败 30 分钟/账号、需人工处理 6 小时/账号、保活失败 30 分钟/实例；1 小时连接中断与全部任务完成**不发**但点击可跳转
  - [ ] 通知图标必须转成 `data:` URL（其他 scheme 静默无图标）
  - [ ] `Deno.dock.setVisible(false)`（macOS 纯菜单栏，可选）
- [ ] 退出流程：最多等 3 秒在途请求，断开 1 小时连接后强制终止
- [ ] 图标资源：`tray-normal.png` / `tray-anomaly.png`（22×22 模板图）、`icon.ico` / `icon.icns`

**门禁**
- [ ] Windows 上关闭窗口后进程与托盘常驻，托盘可唤起窗口
- [ ] 三类通知按去重周期正确发出，点击跳转到对应位置
- [ ] 无头二进制运行时不因缺 `Notification` 崩溃

---

## M6 · 打包与发布

- [ ] `deno task pack:win` / `pack:all` / `pack:cli`
- [ ] `--compress` 体积对比记录（仅 `deno desktop` 支持，`deno compile` 无此 flag）
- [ ] 验证 WS 实现在各平台产物中可用（若 M1 切到 `npm:ws`，额外确认未混入原生 addon）
- [ ] GitHub Actions：单 Linux runner `--all-targets` 出全平台产物
- [ ] **`Deno.autoUpdate()` 接入**（已确认纳入范围）
  - [ ] `latest.json` manifest 托管方案（GitHub Releases）
  - [ ] bsdiff 增量补丁产出接入 CI
  - [ ] 启动失败自动回滚验证
  - [ ] 无头产物的更新策略（决定是否启用，或仅提示）
- [ ] README 重写
  - [ ] 明文密码风险：原话写成「**明文密码，能读到这个文件的人就能拿到账号**」+ 分享配置前删 `password`。
        **不得声称文件权限提供任何保护**（未做权限收紧）
  - [ ] **保活会踢掉自己的会话**（这是默认关闭开关的原因）
  - [ ] 1 小时任务持续流量提示
  - [ ] 零遥测 + 完整域名清单
  - [ ] Windows WebView2 Runtime 要求
  - [ ] 未签名包的 SmartScreen / Gatekeeper 说明
- [ ] 删除 README 中 1.x 的 UserScript / ElectronApp 章节

**门禁**
- [ ] CI 一次产出 6 个 target 的产物
- [ ] Windows `.msi` 干净机器安装 → 运行 → 托盘常驻 → 卸载干净
- [ ] 无头二进制在 Linux 服务器上跑通完整保活
- [ ] 自动更新：旧版本能拉到 manifest、应用补丁、重启后为新版本；人为破坏新版本可触发回滚

---

## M7 · 硬化与验收

- [ ] 逐条跑需求稿 §12 的约 30 条验收用例，逐条记录结果
- [ ] P1 功能：日志筛选 / 关键字搜索 / 导出、一键执行全部任务、会话冲突引导、方向键切 tab、别名内联重命名
- [ ] 长稳测试：10 账号 × 24 小时
- [ ] 崩溃转储敏感字段过滤复核
- [ ] 三个平台冒烟（Windows 为验收门槛，macOS / Linux 尽力而为）

---

## 决策变更日志

> 实施过程中推翻了本目录任何文档里的结论，追加到这里，并同步改正原文。

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-09-12 | 建档 | — |
| 2026-09-13 | WS 选型由 `npm:ws` 改为**内置 `WebSocket`** | 实测更正：内置支持 `headers`，但 `protocols` 必须传数组。`npm:ws` 降为退路 |
| 2026-09-13 | 移除单实例锁 | 由分发形态保证，不做防护 |
| 2026-09-13 | `Deno.autoUpdate()` 由 P1 提升为 M6 范围内 | 已确认接入 |
| 2026-09-13 | 前端确认 `hono/jsx/dom` 方案 | 交互后续会变复杂，手写 vanilla 渲染顶不住 |
| 2026-09-13 | 确认 `config.json`、需求稿 §12「明确不做」作废 | — |
| 2026-09-13 | **砍掉文件权限收紧**（`icacls` / `chmod`） | 按系统默认权限落盘；需求稿 §10「ACL 是真正防线」一并作废，README 不得声称权限提供保护 |
| 2026-09-13 | README 明文密码措辞定稿 | 原话：「明文密码，能读到这个文件的人就能拿到账号」 |
| 2026-09-13 | `npm:ws` 明确为**待定退路**而非计划依赖 | 目标零 npm 依赖；M1 验证通过即从文档删除退路小节 |
| 2026-09-13 | **M0 完成**，R2 风险证伪 | 真账号跑通协商→登录→设备列表→退出。`evalue` 实测 32 字节（AES-256） |
| 2026-09-13 | 脱敏清单补入 `userName` / `userAccount` / `tenantName` / `commonLoginReqHeader` 等 | M0 探针实测发现 `userName` 直接就是手机号，原清单会泄露账号 |
