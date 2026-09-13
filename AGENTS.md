# AGENTS.md

天翼云电脑保活工具。当前在 `refactor/2.0.0` 分支做 2.0 重构：**去 Electron、去油猴，全部保活逻辑搬到 Deno 后端**。

## 开工前必读

| 文件 | 作用 |
| --- | --- |
| [`docs/2.0/milestones.md`](docs/2.0/milestones.md) | **进度追踪。每次开工先读、收工必更。** |
| [`docs/2.0/tech-decisions.md`](docs/2.0/tech-decisions.md) | 技术选型与实测证据 |
| [`docs/2.0/architecture.md`](docs/2.0/architecture.md) | 分层、目录、接口契约 |
| `docs/ctyun-*.md` | 六份接口抓包文档。**只读，不要改** |

## 技术栈

Deno 2.9.x（锁版本）· `deno desktop`（桌面）/ `deno compile`（无头）· Hono 4.13（JSR `@hono/hono`）·
`hono/jsx` SSR + `hono/jsx/dom` 客户端 · Tailwind CSS 4 + daisyUI 5 · SSE 推 JSON 状态

## 硬性约定

1. **`src/core/` 不得 import `src/shell/` 或 `src/server/`。** core 必须能被 CLI、GUI、测试直接复用。
2. **`Deno.BrowserWindow` / `Deno.Tray` / `Deno.dock` / `Notification` 只允许出现在 `src/shell/desktop.ts`。**
   `deno desktop` 还是 experimental，必须可替换。
3. **加解密一律用 `node:crypto`，不要用 Web Crypto。** Web Crypto 没有 MD5、AES-ECB、RSAES-PKCS#1 v1.5 加解密，
   这三样接口文档都要求。
4. **WebSocket 用内置 `WebSocket`**，`protocols` **必须传数组**：
   `new WebSocket(url, { protocols: ["binary"], headers })`。传字符串会抛
   `'protocols' … can not be converted to sequence`。`headers` 是 Deno 的非标准扩展。
   注意 `User-Agent` 是**追加**不是覆盖（实发 `Deno/2.9.6, <自定义>`），`Origin` 是干净覆盖。
   目标是**零 npm 依赖**；`npm:ws` 只是 M1 实连若因 UA 被拒时的退路，验证通过即删。
5. **`src/core/ctyun/` 只做协议翻译**，不掺重试、调度、日志决策。
6. **敏感字段在 logger 入口统一脱敏**，不靠调用方自觉。日志中用 `objName` 或短索引指代桌面，
   绝不打印 `objId` / `desktopId` / `desktopCode` / `secretKey` / `evalue` / 密码及其派生值。
7. **接口文档标注「未实测 / 样本为空」的结构，只写降级路径，不编造默认值。**
   （桌面池、抢占式桌面、`status=1/3`、`willOutDate` 非空等）
8. **`HTTP 200` 不等于成功**，必须继续检查 `code === 0` 或 `resultCode === 0`。
9. 别改 `CLAUDE.md`，改这个文件。

## 已知易错点

- `deno compile` **没有** `--compress`，那是 `deno desktop` 的 flag。
- Deno 的 `node:crypto` **没有 `aes-192-cbc`**（`aes-192-ecb` 却有）。实测 `evalue` 是 32 字节
  走 AES-256，暂未踩到；真遇到 24 字节 key 需基于 ECB 手工实现 CBC 链接。
- 登录响应的 `userName` **实测就是手机号**，`userAccount`、`tenantName`、`commonLoginReqHeader`
  同样敏感。往 logger 加新字段前先想清楚它会不会进 `REDACTED_KEYS`。
- `Notification` 只在 `deno desktop` 产物中存在，`deno run` / `deno compile` 下是 `undefined`，必须特性检测。
  通知图标只认 `data:` URL。
- Tailwind CLI 走 Node 文件系统解析，`deno.json` 必须设 `"nodeModulesDir": "auto"`。
- `CLIENT_LOGIN_INFO(112)` 按 **UTF-16 低字节**写入，不是 UTF-8。写错则长度与全部偏移作废。
- 云电脑链密码是 `SHA256(明文 + challengeCode)`；IAM 链是 `SHA256(明文)`。**两套算法不可混用。**
- 云电脑链不带 cookie；IAM 与 eaichat **必须共用一个 cookie jar**。
- Clink Ticket 用 RSA-OAEP/SHA-1；`negotiationEncKey` 用 RSAES-PKCS#1 v1.5。**两套填充不可复用。**

## 语言

面向用户的界面文案、日志、文档一律简体中文。代码标识符与技术术语保持英文原形。
