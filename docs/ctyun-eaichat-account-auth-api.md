# 天翼云智助手账号登录与退出登录接口

## 1. 文档范围

本文记录 `https://eaichat.ctyun.cn/chat/#/setting` 对应平台的以下流程：

1. SSO 配置获取。
2. IAM 账号密码登录。
3. IAM 票据交换为云智助手平台会话。
4. 云智助手平台退出。
5. IAM 单点登录态退出并返回云智助手登录页。

不包含扫码登录、天翼云账号登录、微信登录、手机号登录、客户端免密登录和验证码登录。

接口存在性、HTTP 方法、URL、实际请求字段、实际响应字段、状态码和重定向均来自 2026-08-29 的内置浏览器实际抓包。字段生成规则和客户端处理分支来自同版本线上 JS bundle：

- IAM：`https://desk.ctyun.cn/cloudB/dy/iam/js/index.101a7d44.js`
- IAM 登录组件：`https://desk.ctyun.cn/cloudB/dy/iam/js/chunk-2f59c1ce_73b9ccbd.js`
- 云智助手：`https://eaichat.ctyun.cn/chat/js/app.37bbce61.js`

本次分析涉及的原始前端资源已归档到 [2026-08-29 bundle 快照](./bundle-snapshots/2026-08-29/README.md)。

本次实测账号登录、票据授权、平台退出和 IAM 单点退出均成功。账号、密码、密码摘要、IAM 票据、会话密钥、客户端密钥、用户标识和租户标识均未写入本文。

## 2. 接口总览

| 顺序 | 方法 | Origin | 路径 | 用途 | 本次结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `GET` | `https://gwyilian.ctyun.cn` | `/server/eaiSysInfo` | 获取网关及 SSO 公钥配置 | HTTP 200 |
| 2 | `POST` | `https://desk.ctyun.cn` | `/cloudB/dy/iam/api/auth/iam/login` | IAM 账号密码认证 | HTTP 200，`code=0` |
| 3 | `POST` | `https://eaichat.ctyun.cn` | `/sso/login/v2/iam/ticketAuthorize` | IAM 票据换取云智助手会话 | HTTP 200，`resultCode=0` |
| 4 | `POST` | `https://eaichat.ctyun.cn` | `/sso/login/v2/iam/logout` | 注销云智助手平台会话 | HTTP 200，`resultCode=0` |
| 5 | `GET` | `https://desk.ctyun.cn` | `/cloudB/dy/iam/api/auth/iam/cas/logout` | 注销 IAM SSO 登录态 | HTTP 302 跳回云智助手 |

完整时序：

```text
GET eaiSysInfo
  -> POST IAM /iam/login
  -> IAM 响应 returnUrl，URL 片段中携带 ticket
  -> 浏览器进入 eaichat /chat/
  -> POST ticketAuthorize
  -> 得到 sessionKey，建立云智助手签名会话
  -> 正常使用平台
  -> POST /iam/logout
  -> GET IAM /iam/cas/logout?service=...
  -> HTTP 302 回到 eaichat /chat/#/login
```

## 3. 获取 SSO 配置

### 3.1 请求

```http
GET https://gwyilian.ctyun.cn/server/eaiSysInfo HTTP/1.1
```

无查询参数、无请求体。本次浏览器因跨域请求先发送了 CORS `OPTIONS` 预检，业务 `GET` 返回 HTTP 200。

### 3.2 响应

本次实际响应字段：

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `success` | boolean | 请求处理结果标志 |
| `resultCode` | string | 结果码 |
| `resultMsg` | string | 结果文案 |
| `data` | string | 加密后的平台网关配置 |
| `extendObj` | null | 本次为空 |
| `serverConfigVersion` | null | 本次为空 |

```json
{
  "success": true,
  "resultCode": "<result-code>",
  "resultMsg": "<result-message>",
  "data": "<encrypted-config>",
  "extendObj": null,
  "serverConfigVersion": null
}
```

示例中的布尔值仅表达 JSON 类型，不代表本文公开实际业务值。

bundle 显示，Web 客户端使用以下规则解开 `data`：

| 项目 | 规则 |
| --- | --- |
| 算法 | AES-ECB |
| Padding | PKCS#7 |
| Key | UTF-8 字符串 `chinatelecom@cnn` |
| 明文 | JSON 字符串 |

解密后的配置中，登录流程会读取：

| 字段 | 用途 |
| --- | --- |
| `eai` | 云智助手 API 网关地址 |
| `sso.ssopk` | 用于加密客户端随机密钥的 RSA 公钥 |
| `sso.ssopkid` | 公钥标识，提交为 `clientKeyId` |

解密后完整配置不是本次登录接口文档的字段范围，且没有作为独立明文响应抓包，因此不扩展其他字段。

## 4. IAM 账号密码登录

### 4.1 请求

```http
POST https://desk.ctyun.cn/cloudB/dy/iam/api/auth/iam/login HTTP/1.1
Accept: application/json, text/plain, */*
Content-Type: application/json
```

无 URL 查询参数。

本次实际请求体包含 4 个字段：

| 字段 | 类型 | 必填 | 生成规则或含义 |
| --- | --- | --- | --- |
| `userAccount` | string | 是 | 用户输入的手机号、邮箱或账号名；页面提交前去除首尾空白 |
| `password` | string | 是 | `SHA256(去除首尾空白后的原始密码)`，64 位小写十六进制字符串 |
| `deviceCode` | string | 是 | IAM Web 设备标识，本次长度为 36 |
| `deviceName` | string | 是 | IAM Web 设备名称，实际固定为 `iam:web` |

脱敏请求示例：

```json
{
  "userAccount": "<account>",
  "password": "<64-char-sha256-hex>",
  "deviceCode": "iam:<32-char-random-id>",
  "deviceName": "iam:web"
}
```

bundle 中的 `deviceCode` 规则：

1. 首次访问时生成 `iam:` 加 32 位随机标识。
2. 保存到浏览器本地键 `iam_devicecode`。
3. 后续登录复用同一值。

密码摘要使用 CryptoJS SHA-256 默认十六进制输出。密码明文没有出现在实际网络请求中。

bundle 还支持以下可选字段，但本次成功抓包没有出现：

| 字段 | 类型 | 触发条件 |
| --- | --- | --- |
| `captchaCode` | string | 服务端返回 `code=51040` 要求图形验证码后 |
| `captchaCodeKey` | string | 与图形验证码配套的响应头标识 |

图形验证码契约来自同版本 IAM 登录组件运行时代码：

```http
GET /cloudB/dy/iam/api/auth/iam/captcha?width=100&height=40&userInfo=<url-encoded-identifier> HTTP/1.1
Host: desk.ctyun.cn
```

| 项目 | 规则 |
| --- | --- |
| `width` / `height` | 登录组件为 `100` / `40` |
| `userInfo` | 组件传入的 IAM `deviceCode`；未传时组件自行生成一次 identifier |
| 图片数据 | 响应 body 的 `data.data`，Base64 JPEG，页面拼成 `data:image/jpeg;base64,...` |
| 验证码 key | 响应头 `CTG-CAPTCHA-KEY` 或小写等价头，提交为 `captchaCodeKey` |

服务端返回 `code=51040` 后，刷新验证码并重新提交 4.1 的同一 `/iam/login`，在原四字段上附加 `captchaCode`、`captchaCodeKey`。

### 4.2 成功响应

本次实际响应为 HTTP 200、`code=0`。字段结构如下：

```ts
interface IamLoginResponse {
  code: number;
  data: IamLoginData;
  msg?: string;
}
```

`data` 中实际出现的全部字段：

| 字段 | 本次类型 | 含义/客户端用途 |
| --- | --- | --- |
| `changePwd` | number | 密码变更相关状态；本次页面未直接读取 |
| `commonLoginReqHeader` | null | 公共登录请求头数据；本次为空 |
| `email` | string | 账号邮箱 |
| `firstLogin` | number | 首次登录状态标志 |
| `intlType` | null | 国际化/环境类型；本次为空 |
| `loginNotify` | null | 登录通知；本次为空 |
| `loginType` | null | 登录类型；本次为空 |
| `menuModule` | string[] | IAM 菜单模块列表 |
| `mobilePhone` | string | 账号手机号 |
| `needDesensitize` | boolean | 是否需要对用户信息脱敏 |
| `needSmsValidate` | boolean | 是否需要短信二次认证 |
| `needUpdatePassword` | boolean | 是否需要更新密码 |
| `orgId` | number | 组织 ID |
| `ownerLevel` | number | 账号/组织层级 |
| `phyResPoolId` | number | 物理资源池 ID |
| `publicCloud` | boolean | 是否为公有云账号标志 |
| `qs` | null | 本次为空，具体业务语义未由抓包证实 |
| `regionIdList` | null | 区域 ID 列表；本次为空 |
| `relaStatus` | null | 关联状态；本次为空 |
| `returnUrl` | string | 登录成功后的跳转地址，携带一次性 IAM 票据 |
| `sysType` | null | 系统类型；本次为空 |
| `tenantCode` | string | 租户编码 |
| `tenantId` | number | 租户 ID |
| `token` | string | IAM 登录令牌，必须按敏感数据处理 |
| `userAccount` | string | 标准化后的用户账号 |
| `userId` | number | 用户 ID |
| `userName` | string | 用户名称 |
| `userType` | number | 用户类型码 |

脱敏结构示例：

```json
{
  "code": 0,
  "data": {
    "changePwd": 0,
    "commonLoginReqHeader": null,
    "email": "<redacted>",
    "firstLogin": 0,
    "intlType": null,
    "loginNotify": null,
    "loginType": null,
    "menuModule": ["<module>"],
    "mobilePhone": "<redacted>",
    "needDesensitize": false,
    "needSmsValidate": false,
    "needUpdatePassword": false,
    "orgId": 0,
    "ownerLevel": 0,
    "phyResPoolId": 0,
    "publicCloud": true,
    "qs": null,
    "regionIdList": null,
    "relaStatus": null,
    "returnUrl": "https://eaichat.ctyun.cn/chat/#/...?...",
    "sysType": null,
    "tenantCode": "<redacted>",
    "tenantId": 0,
    "token": "<redacted>",
    "userAccount": "<redacted>",
    "userId": 0,
    "userName": "<redacted>",
    "userType": 0
  }
}
```

示例中的具体布尔值和数值只用于表达类型，不代表本次账号真实值。

### 4.3 跳转行为

本次 `returnUrl` 的非敏感结构为：

```text
Origin: https://eaichat.ctyun.cn
Path:   /chat/
Hash query: ticket=<one-time-iam-ticket>
```

URL `#` 后的内容不会随 HTTP 文档请求发送给服务端。云智助手前端加载后读取 `ticket`，再调用下一节的 `ticketAuthorize`。

如果 `needSmsValidate == 1`，bundle 会进入短信二次认证页面，并保留 `mobilePhone` 及第一次登录的完整逻辑请求。本次未进入该分支；以下控制流和字段来自同版本 IAM 登录组件运行时代码：

1. 短信页面通过上面的 `GET /iam/captcha` 获取图形验证码，并把响应头 `CTG-CAPTCHA-KEY` 保存为 `captchaValidateKey`。
2. 请求短信端点：

```http
POST /cloudB/dy/iam/api/auth/iam/send HTTP/1.1
Host: desk.ctyun.cn
Content-Type: application/json
CTG-DEVICECODE: <same-mobilePhone>
```

逻辑请求体：

```json
{
  "type": 1,
  "mobilePhone": "<mobile-from-login-response>",
  "captchaCode": "<user-input-image-code>",
  "captchaValidateKey": "<CTG-CAPTCHA-KEY-response-header>"
}
```

3. 短信发送响应头 `CTG-SMS-KEY`（大小写不敏感）保存为 `smsCodeKey`。页面启动 60 秒重发倒计时。
4. 用户输入短信码后，再次调用同一个 `POST /cloudB/dy/iam/api/auth/iam/login`。
5. 第二次请求保留原 `userAccount`、SHA-256 `password`、`deviceCode`、`deviceName`，并附加 `smsCode`、`smsCodeKey`。
6. 第二次登录成功后，继续使用新的 `returnUrl` 进入 5 节的 ticket 授权流程。

第二次登录的逻辑请求体：

```json
{
  "userAccount": "<same-account>",
  "password": "<same-64-char-sha256-hex>",
  "deviceCode": "<same-iam-device-code>",
  "deviceName": "iam:web",
  "smsCode": "<user-input-code>",
  "smsCodeKey": "<CTG-SMS-KEY-response-header>"
}
```

验证码和短信端点、请求字段、响应头及续登字段均来自同版本运行时代码，本次账号未触发对应网络事务。成功响应仍回到 4.2 的 `IamLoginResponse`，并按新的 `needSmsValidate`/`returnUrl` 继续判断；错误按外层 `code`、`msg` 展示。

`needUpdatePassword` 在响应中存在，但本次云智助手 IAM 集成未观察到可验证的改密端点和完整响应。该值为真时不能继续 ticket 授权，应交回 IAM 官方页面处理；本文不把该未验证分支声明为可独立实现。

## 5. IAM 票据换取云智助手会话

### 5.1 请求

```http
POST https://eaichat.ctyun.cn/sso/login/v2/iam/ticketAuthorize HTTP/1.1
Accept: application/json, text/plain, */*
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
```

无 URL 查询参数。

本次实际请求字段：

| 字段 | 类型 | 必填 | 本次值/来源 |
| --- | --- | --- | --- |
| `loginType` | string | 是 | 固定为 `iamTicket` |
| `clientId` | string | 是 | 固定为 `eaiapp` |
| `iamTicket` | string | 是 | IAM `returnUrl` 中的一次性 `ticket`；本次长度为 282 |
| `redirectUri` | string | 是 | 本次为 `https://eaichat.ctyun.cn:443/chat/#/aichat` |
| `clientKey` | string | 是 | 加密后的本地客户端随机密钥；本次为 256 位十六进制字符串 |
| `clientKeyId` | string | 是 | SSO 公钥标识；本次为 15 位字符串 |

```text
loginType=iamTicket
&clientId=eaiapp
&iamTicket=<redacted>
&redirectUri=https%3A%2F%2Feaichat.ctyun.cn%3A443%2Fchat%2F%23%2Faichat
&clientKey=<256-char-rsa-cipher-hex>
&clientKeyId=<sso-public-key-id>
```

`clientKey` 的 bundle 生成规则：

1. 读取 `localStorage.clientKey`；不存在时生成 16 个字符并保存，后续登录复用到退出清理。
2. 每个字符通过 `Math.random()` 从 ASCII `32..126` 的 95 个可打印字符中选择。该规则是兼容现有客户端所需，并非密码学安全随机源。
3. 从 `eaiSysInfo` 解密配置读取 `sso.ssopk`，补成标准 PEM `PUBLIC KEY` 文本后解析。
4. 将本地 `clientKey` 作为 UTF-8/字节字符串，使用 RSAES-PKCS1-v1_5 加密。
5. 将 RSA 密文字节编码为小写十六进制字符串，提交为 `clientKey`。
6. 将 `sso.ssopkid` 提交为 `clientKeyId`。

兼容伪代码：

```ts
const alphabet = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
const localClientKey = existingClientKey ?? randomCharsWithMathRandom(alphabet, 16);
const pem = wrapAsPublicKeyPem(ssopk);
const encryptedBytes = rsaPkcs1v15Encrypt(pem, utf8Bytes(localClientKey));
const clientKey = lowerHex(encryptedBytes);
const clientKeyId = ssopkid;
```

### 5.2 成功响应

本次实际响应：

```json
{
  "success": true,
  "resultMsg": "操作成功！",
  "resultCode": 0,
  "data": {
    "sessionKey": "<redacted>"
  }
}
```

字段说明：

| 字段 | 类型 | 本次结果/含义 |
| --- | --- | --- |
| `success` | boolean | 本次为 `true` |
| `resultMsg` | string | 本次为 `操作成功！` |
| `resultCode` | number | 本次为 `0` |
| `data.sessionKey` | string | 加密的平台会话密钥；本次长度为 65，必须按敏感数据处理 |

bundle 显示，客户端会按以下字节规则建立签名密钥：

1. 将原始 `sessionKey` 保存为本地键 `skcache`。
2. 对响应中的 `sessionKey` 做标准 Base64 解码，得到 AES 密文字节。
3. 取本地 16 字符 `clientKey` 的 UTF-8 字节作为 128-bit AES key。
4. 使用 AES-ECB 解密；Forge 默认 PKCS#7 padding，无 IV。
5. 把去除 padding 后的明文字节解释为 UTF-8 字符串，保存为仅驻留内存的运行时签名密钥 `sk`。
6. 后续平台 API 使用该密钥生成 `Web-Signature`、`Web-Random` 和 `Web-Timestamp`。

因此，IAM 登录成功只产生一次性票据；`ticketAuthorize` 成功才代表云智助手平台会话建立完成。

### 5.3 会话恢复、Cookie 与客户端环境

云智助手 axios 实例统一设置 `withCredentials: true`。平台 API 不在本文暴露可复制的 Cookie 值；浏览器会随同源/允许跨域请求自动携带会话 Cookie，前端不能只复制 `Web-Signature` 而忽略 Cookie 会话。

页面重载时的恢复流程：

1. 同时读取 `skcache` 和 `clientKey`。
2. 按 5.2 的 Base64 + AES-ECB + UTF-8 规则恢复内存签名密钥。
3. 使用标准平台 Cookie、环境头和 Web 签名发起无参数请求：

```http
GET /ai/portal/v1/prompt/appassistant/modeltype HTTP/1.1
Host: eaichat.ctyun.cn
```

4. 只有响应外层 `resultCode === 0` 才调用登录成功处理并进入应用。
5. 非零结果或请求异常不会恢复登录状态；当前函数本身不删除 `skcache`，因此外部实现可选择保留后重试或清理后重新登录，但不能仅因本地存在缓存就认定会话有效。

该探测端点正常业务响应的 `data.modelTypes` 用于模型类型列表；会话恢复只依赖外层 `resultCode`，不要求列表非空。

Web 客户端还持久化请求环境标识：

| 项目 | 规则 |
| --- | --- |
| `xuid` | `localStorage.lxuid`；不存在时生成 `pubweb_` + UUID v4，后续复用 |
| `env` | 移动端或 URL 存在 `from` 时为 `pubH5`，其他 Web 页面为 `pubWeb` |
| `x-eai-version` | `202060305` |
| `x-user-agent` | `navigator.userAgent` |
| `x-eai-source` | 浏览器固定 `web-eai` |
| `x-eai-tenant-id` | 当前用户配置中的 `currentTenantIdStr`，初始化规则见下文 |
| `x-eai-env-code` | 私有网关状态提供；公有环境为空字符串 |

Electron 客户端通过桌面 IPC 获取 `xuid`、环境和私网代码；Web 实现不要调用该分支。

#### 5.3.1 用户与租户初始化

IAM 登录响应中的 `tenantId` 只属于 IAM 身份响应，云智助手不会直接把它复制到后续 SSE。ticket 授权或缓存恢复成功后，平台重新查询自己的用户、配置和租户数据：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/ai/portal/v1/user/queryUserInfo` | 初始化云智助手用户资料；可选 `?syncIam=true` 分支不用于本次普通启动 |
| `GET` | `/ai/portal/v1/user/queryUserConfig` | 读取 `currentTenantIdStr` 等用户配置 |
| `GET` | `/ai/portal/v2/user/queryUserTenantInfo` | 获取当前账号可用租户列表，无查询参数 |

租户列表按以下响应路径消费：

```ts
interface UserTenantResponse {
  resultCode: number;
  data: {
    data: TenantItem[];
  };
}

interface TenantItem {
  tenantId: number;
  tenantIdStr: string;
  // 其他展示字段不参与本文请求签名和 SSE。
}
```

当前租户选择优先级：

1. URL 查询参数 `iamTenantId`。
2. `queryUserConfig` 返回的 `currentTenantIdStr`。
3. `localStorage.currentTenant.tenantIdStr`。
4. `localStorage.currentTenant.tenantId`。
5. 租户列表第一项。

客户端以宽松相等比较在列表中匹配 `tenantIdStr`，匹配不到时回退第一项；选中对象整体保存到 `localStorage.currentTenant`，同时把其 `tenantIdStr` 更新到用户配置。

后续字段映射必须区分字符串和数值：

| 使用位置 | 来源 |
| --- | --- |
| `x-eai-tenant-id` | `userConfig.currentTenantIdStr` |
| 对话请求体 `tenantId` | `currentTenant.tenantId` |
| MCP 工具请求体 `tenant_id` | `currentTenant.tenantId` |

租户列表为空时 `currentTenant=null`，对话请求体省略/序列化为无值的 `tenantId`，而不是回退使用 IAM 登录响应的同名字段。

## 6. 退出云智助手平台会话

### 6.1 请求

```http
POST https://eaichat.ctyun.cn/sso/login/v2/iam/logout HTTP/1.1
Accept: application/json, text/plain, */*
```

本次实际请求：

- 无查询参数。
- 无请求体。
- 浏览器实际请求未设置 `Content-Type`。

### 6.2 成功响应

本次实际响应为 HTTP 200：

```json
{
  "success": true,
  "resultMsg": "操作成功！",
  "resultCode": 0,
  "data": null
}
```

字段说明：

| 字段 | 类型 | 本次值 |
| --- | --- | --- |
| `success` | boolean | `true` |
| `resultMsg` | string | `操作成功！` |
| `resultCode` | number | `0` |
| `data` | null | `null` |

bundle 显示，`resultCode === 0` 后客户端会清理：

| 本地键/状态 | 用途 |
| --- | --- |
| `skcache` | 加密的平台会话密钥 |
| `clientKey` | 本地 16 字符随机密钥 |
| `ssopk` | SSO 公钥配置缓存 |
| 运行时签名密钥 | 后续平台 API 的 Web 签名密钥 |

随后客户端开始 IAM 单点退出。

## 7. IAM 单点退出

### 7.1 请求

本次实际浏览器导航：

```http
GET /cloudB/dy/iam/api/auth/iam/cas/logout?service=<encoded-service-url> HTTP/1.1
Host: desk.ctyun.cn
```

唯一查询参数：

| 参数 | 类型 | 必填 | 本次解码值 |
| --- | --- | --- | --- |
| `service` | string | 是 | `https://eaichat.ctyun.cn:443/chat/#/login` |

完整脱敏请求：

```text
https://desk.ctyun.cn/cloudB/dy/iam/api/auth/iam/cas/logout
  ?service=https%3A%2F%2Feaichat.ctyun.cn%3A443%2Fchat%2F%23%2Flogin
```

### 7.2 重定向

抓包确认该请求返回 HTTP 302，并重定向到：

```text
https://eaichat.ctyun.cn/chat/
```

云智助手 SPA 最终进入：

```text
https://eaichat.ctyun.cn/chat/#/login
```

因此，完整退出不能只调用平台 `/sso/login/v2/iam/logout`；Web 流程还会导航到 IAM CAS logout，以清理 IAM SSO 登录态。

## 8. 成功判定与错误处理

| 接口 | HTTP 成功 | 业务成功判定 |
| --- | --- | --- |
| IAM `/iam/login` | HTTP 200 | `code === 0` |
| `/ticketAuthorize` | HTTP 200 | `resultCode === 0` |
| 平台 `/iam/logout` | HTTP 200 | `resultCode === 0` |
| IAM CAS logout | HTTP 302 | 重定向到 `service` 对应站点 |

本次没有主动制造密码错误、验证码错误、票据失效或退出失败。以下仅来自 bundle 分支，不是本次错误响应样本：

| 场景 | bundle 行为 |
| --- | --- |
| IAM 返回 `code=51040` | 显示图形验证码输入，并在下一次登录附加 `captchaCode`、`captchaCodeKey` |
| IAM 返回 `needSmsValidate == 1` | 转入短信二次认证流程 |
| `ticketAuthorize.resultCode !== 0` | 提示“登录验证失败” |
| `logout.resultCode !== 0` | 显示服务端 `resultMsg` 或“退出失败” |

## 9. 实现注意事项

1. 密码字段是 SHA-256 十六进制摘要，不是明文，也不是 Base64。
2. IAM `returnUrl` 中的 `ticket` 是一次性敏感凭据，不应缓存、复用或写入日志。
3. `ticketAuthorize` 不能省略；它负责将 IAM 身份转换为云智助手自己的签名会话。
4. `clientKey` 在线上请求中是 RSA 密文；本地原始 16 字符密钥不得上传明文。
5. `sessionKey` 需要使用同一次登录生成的本地 `clientKey` 解密。
6. HTTP 200 不等于业务成功，必须继续检查 `code` 或 `resultCode`。
7. 完整退出顺序是平台 logout 成功后再访问 IAM CAS logout。
8. 账号、密码摘要、IAM ticket、token、sessionKey、clientKey、用户 ID、租户 ID 和设备 ID 均应按敏感数据处理。
9. 本文只记录账号密码登录，不包含页面同时存在的扫码及其他第三方登录方式。
