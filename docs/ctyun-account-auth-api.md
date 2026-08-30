# 天翼量子 AI 云电脑账号登录与退出登录接口

## 1. 文档范围

本文记录 `https://pc.ctyun.cn/` Web 客户端的以下流程：

1. 认证报文加密能力发现与临时密钥协商。
2. 账号密码登录，不包含扫码登录、验证码登录和企业账号登录。
3. 登录态退出。

接口存在性、HTTP 方法、URL、请求头、线上请求体、线上响应体、状态码和成功响应字段均来自 2026-08-29 的实际浏览器抓包。字段生成规则、加密算法和客户端分支来自同版本线上 JS bundle：

- `https://deskcdn.ctyun.cn/pccdnstatic/js/main.1bcf98.js`
- `https://deskcdn.ctyun.cn/pccdnstatic/js/9131.1bcf98.chunk.js`

本次分析涉及的原始前端资源已归档到 [2026-08-29 bundle 快照](./bundle-snapshots/2026-08-29/README.md)。

本次实测结果：账号登录成功，随后退出登录成功。账号、密码、设备标识、用户标识、签名密钥、会话密钥和其他敏感值均已脱敏，未写入本文。

## 2. 接口总览

| 顺序 | 方法 | 路径 | 用途 | 本次结果 |
| --- | --- | --- | --- | --- |
| 1 | `GET` | `/api/cdserv/client/getServData` | 发现服务端支持的报文加密类型 | HTTP 200，`code=0` |
| 2 | `POST` | `/api/auth/client/negotiationEncKey` | 协商本页会话使用的 AES 密钥和密钥 ID | HTTP 200，`code=0` |
| 3 | `POST` | `/api/auth/client/genChallengeData` | 获取密码哈希使用的挑战值 | HTTP 200，`code=0` |
| 4 | `POST` | `/api/auth/client/login` | 提交账号密码登录 | HTTP 200，`code=0` |
| 5 | `POST` | `/api/auth/client/logout` | 注销服务端登录态 | HTTP 200，`code=0`、`data=true` |

统一 API Origin：

```text
https://desk.ctyun.cn:8810
```

账号登录的核心时序：

```text
getServData
  -> negotiationEncKey
  -> genChallengeData
  -> 计算两个 SHA-256 密码字段
  -> login
  -> 保存响应中的用户、租户和签名数据
  -> logout
```

## 3. 公共协议

### 3.1 公共请求头

下表是三个认证业务接口 `genChallengeData`、`login`、`logout` 实际出现的协议头。`Origin`、`Referer`、`User-Agent` 等浏览器标准头不再展开。

| 请求头 | 登录前接口 | 退出接口 | 本次固定值或生成规则 |
| --- | --- | --- | --- |
| `Accept` | 是 | 是 | `application/json, text/plain, */*` |
| `CTG-APPMODEL` | 是 | 是 | `2` |
| `CTG-DEVICECODE` | 是 | 是 | `localStorage.web_device_code`，不存在时生成，规则见 3.1.1 |
| `CTG-DEVICETYPE` | 是 | 是 | `60` |
| `CTG-REQUESTID` | 是 | 是 | `String(Date.now() + ++requestCounter)`；计数器键为 `_requestId` |
| `CTG-SOFTWARECODE` | 是 | 是 | `web_client` |
| `CTG-TIMESTAMP` | 是 | 是 | `String(Date.now() - offsetTime)`；登录前 `offsetTime=0` |
| `CTG-VERSION` | 是 | 是 | 本次为 `204000100` |
| `CTG-REQDATA-ETYPE` | 是 | 是 | `2`，表示 AES-CBC |
| `CTG-NEGO-EKEYID` | 是 | 是 | 密钥协商所得 `eid` |
| `CTG-USERID` | 否 | 是 | 登录响应所得 `userId` |
| `CTG-TENANTID` | 否 | 是 | 登录响应所得 `tenantId` |
| `CTG-SIGNATURESTR` | 否 | 是 | 登录响应所得 `secretKey` 参与计算，见下文 |
| `CTG-APPCHANNEL` | 否 | 条件 | 登录响应提供应用渠道时原样携带 |

这不是退出接口的特例。所有通过该请求层发送的普通登录态 PC API 均使用同一签名规则：

```text
CTG-SIGNATURESTR = UPPERCASE(MD5(
  deviceType + requestId + tenantId + timestamp + userId + version + secretKey
))
```

所有字段直接拼接，不插入分隔符。

时间校正规则：登录成功时客户端记录 `loginAt = Date.now()`，并令：

```text
offsetTime = loginAt - loginResponse.timestamp
CTG-TIMESTAMP = Date.now() - offsetTime
```

签名不包含 URL、查询字符串或请求体。计算签名时使用的 `requestId`、`timestamp` 必须与最终发出的同名请求头完全一致。

#### 3.1.1 Web 设备上下文

以下生成规则来自同版本运行时代码。前端复现时应在调用认证接口前一次性构造并复用：

| 字段 | 生成/持久化规则 |
| --- | --- |
| `deviceCode` | 读取 `localStorage.web_device_code`；不存在时保存 `"web_" + 32 字符随机 ID` |
| 云手机专用设备代码 | 读取 `localStorage.web_phone_device_code`；不存在时使用 `web_phone_` 前缀生成。本文 PC 登录主链不使用该值 |
| `deviceName` | 浏览器/设备识别助手的缓存结果，同一页面生命周期内复用 |
| `deviceModel` | `navigator.userAgent` 第一组圆括号内的子串 |
| `sysVersion` | 与当前实现的 `deviceModel` 相同，取 UA 第一组圆括号内子串 |
| `appVersion` | `4.0.1` |
| `clientVersion` / `CTG-VERSION` | `204000100` |
| `deviceType` / `CTG-DEVICETYPE` | `60` |
| `CTG-APPMODEL` | `2` |

不要在每次请求时重新生成 `deviceCode`，否则登录、设备绑定和登录后接口会被服务端视为不同客户端。

### 3.2 AES 报文格式

本次三个业务接口均使用以下规则：

| 项目 | 规则 |
| --- | --- |
| 算法 | AES-CBC |
| Padding | PKCS#7 |
| IV | 16 个零字节 |
| 明文编码 | UTF-8 |
| 密文编码 | Base64 |
| AES key | 密钥协商后得到的 `evalue` |
| 密钥标识 | 密钥协商后得到的 `eid`，放入 `CTG-NEGO-EKEYID` |

JSON 请求在线上会转换为：

```json
{
  "data": "<AES-CBC-Base64(JSON.stringify(逻辑请求体))>"
}
```

`application/x-www-form-urlencoded` 请求在线上会转换为：

```text
eParams=<URL-encoded AES-CBC-Base64(JSON.stringify(逻辑请求体))>
```

需要加密查询参数的 GET 请求会先以 `URLSearchParams` 规则生成查询字符串，再加密为唯一参数：

```text
eUrlParams=<URL-encoded AES-CBC-Base64(URLSearchParams.toString())>
```

加密响应在线上统一表现为：

```json
{
  "edata": "<AES-CBC-Base64(逻辑响应 JSON)>"
}
```

响应头同时出现：

```text
ctg-rspdata-etype: 2
```

解密后的业务响应遵循：

```ts
interface ApiEnvelope<T> {
  code: number;
  data?: T;
  msg?: string;
}
```

客户端以 `code === 0` 判断成功；非零时使用 `msg` 构造业务异常。三个成功响应均未出现 `msg`。

## 4. 加密前置

### 4.1 获取服务配置

```http
GET /api/cdserv/client/getServData HTTP/1.1
Host: desk.ctyun.cn:8810
```

无查询参数、无请求体。

本文只列出认证加密所需的响应子集；该接口还返回其他服务配置，不属于本文范围。

```json
{
  "code": 0,
  "data": {
    "globalSwitches": {
      "bodyMsgEType": ["2", "3"]
    },
    "serverNodeId": "<server-node-id>"
  }
}
```

本次服务端同时声明支持类型 `2`、`3`，Web 客户端实际选择 `2`。

### 4.2 协商临时报文密钥

```http
POST /api/auth/client/negotiationEncKey HTTP/1.1
Host: desk.ctyun.cn:8810
Content-Type: application/json
```

该请求发生在通用 AES 加密建立之前，因此请求和响应本身不是 `data/edata` 包装。

请求体：

| 字段 | 类型 | 必填 | 本次值/含义 |
| --- | --- | --- | --- |
| `etype` | string | 是 | `"2"`，请求 AES-CBC |
| `certType` | string | 是 | `"2"` |
| `certData` | string | 是 | 浏览器临时生成的 RSA 公钥，SPKI DER 后 Base64 |

```json
{
  "etype": "2",
  "certType": "2",
  "certData": "<base64-rsa-public-key>"
}
```

临时 RSA 密钥对的 Web Crypto 生成参数由 bundle 确认：

| 项目 | 值 |
| --- | --- |
| 算法 | RSA-OAEP |
| 模数长度 | 2048 bit |
| 公共指数 | 65537 |
| Hash | SHA-512 |

需要注意：客户端没有使用 `SubtleCrypto.decrypt()` 解开响应中的 `encKey`，而是把导出的私钥交给 bundle 内的 JSEncrypt 兼容实现；该实现按 PKCS#1 v1.5 块格式解密。复现时应以服务端实际 `encKey` 密文和这一解密实现为准，不能仅根据生成密钥时的 `RSA-OAEP` 名称调用 OAEP 解密。

公私钥和响应字段的字节编码闭环如下：

| 数据 | 编码/解码规则 |
| --- | --- |
| `certData` | 公钥导出为 SPKI DER 字节，再进行标准 Base64 编码，不含 PEM 头尾 |
| 客户端私钥 | 私钥导出为 PKCS#8 DER 字节，再进行标准 Base64 编码，交给 JSEncrypt 兼容解析器 |
| `encKey` | 先按标准 Base64 解码成 RSA 密文字节，再以 RSAES-PKCS1-v1_5 私钥解密 |
| 中间 AES key | RSA 解密结果解释为 UTF-8 JavaScript 字符串；该字符串的 UTF-8 字节作为 AES key |
| `encData` | 标准 Base64 解码后，使用中间 AES key、零 IV、AES-CBC/PKCS#7 解密 |
| `evalue` | `encData` 明文 JSON 中的字符串；后续再次取其 UTF-8 字节作为业务 AES key |

成功响应：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `code` | number | `0` 表示成功 |
| `data.encKey` | string | 使用临时 RSA 公钥加密的中间密钥 |
| `data.encData` | string | 使用中间密钥 AES-CBC 加密的协商结果 |

```json
{
  "code": 0,
  "data": {
    "encKey": "<rsa-encrypted-key>",
    "encData": "<aes-encrypted-negotiation-data>"
  }
}
```

客户端处理顺序：

1. Base64 解码 `encKey`，用临时 RSA 私钥按 RSAES-PKCS1-v1_5 解密并 UTF-8 解码，得到中间 AES key 字符串。
2. 取该字符串的 UTF-8 字节作为 key，按公共 AES 规则解开 Base64 `encData`。
3. 解密结果为包含 `eid`、`evalue` 的 JSON。
4. 后续请求使用 `eid` 作为 `CTG-NEGO-EKEYID`，取 `evalue` 的 UTF-8 字节加解密业务报文。

## 5. 生成账号登录挑战值

```http
POST /api/auth/client/genChallengeData HTTP/1.1
Host: desk.ctyun.cn:8810
Content-Type: application/json
CTG-REQDATA-ETYPE: 2
CTG-NEGO-EKEYID: <eid>
```

逻辑请求体为空对象：

```json
{}
```

实际线上请求体：

```json
{
  "data": "<encrypted {}>"
}
```

解密后的成功响应：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `code` | number | 本次为 `0` |
| `data.challengeCode` | string | 参与密码哈希的短期挑战值 |
| `data.challengeId` | string | 登录请求引用的挑战 ID |
| `data.effectiveSeconds` | number | 挑战有效期；本次为 `60` 秒 |

```json
{
  "code": 0,
  "data": {
    "challengeCode": "<challenge-code>",
    "challengeId": "<challenge-id>",
    "effectiveSeconds": 60
  }
}
```

## 6. 账号密码登录

### 6.1 请求

```http
POST /api/auth/client/login HTTP/1.1
Host: desk.ctyun.cn:8810
Content-Type: application/x-www-form-urlencoded
CTG-REQDATA-ETYPE: 2
CTG-NEGO-EKEYID: <eid>
```

实际线上请求体只有一个表单字段：

```text
eParams=<encrypted-login-json>
```

本次抓包解密后确认的逻辑请求字段：

| 字段 | 类型 | 必填 | 生成规则或含义 |
| --- | --- | --- | --- |
| `userAccount` | string | 是 | 用户输入账号，前后空白被去除；普通账号流程会去掉 `#admin` 后缀 |
| `password` | string | 是 | `SHA256(原始密码 + challengeCode)`，小写十六进制字符串 |
| `sha256Password` | string | 是 | `SHA256(SHA256(原始密码) + challengeCode)`，小写十六进制字符串 |
| `challengeId` | string | 是 | 上一步响应中的 `challengeId` |
| `deviceCode` | string | 是 | 当前 Web 客户端设备标识 |
| `deviceName` | string | 是 | 3.1.1 所述浏览器/设备识别结果 |
| `deviceType` | string | 是 | 本次为 `"60"` |
| `deviceModel` | string | 是 | 当前设备型号/浏览器侧设备模型 |
| `appVersion` | string | 是 | `"4.0.1"` |
| `sysVersion` | string | 是 | UA 第一组圆括号内子串 |
| `clientVersion` | string | 是 | `"204000100"` |
| `captchaCode` | string | 否 | bundle 支持；服务器要求图形验证码时附加。本次成功抓包未出现 |

密码字段伪代码：

```ts
const passwordHash = sha256Hex(plainPassword);

const payload = {
  userAccount: account.trim(),
  password: sha256Hex(plainPassword + challengeCode),
  sha256Password: sha256Hex(passwordHash + challengeCode),
  challengeId,
  deviceCode,
  deviceName,
  deviceType: "60",
  deviceModel,
  appVersion,
  sysVersion,
  clientVersion,
};
```

本次逻辑请求体中没有 `remember`、原始密码、`mfaPassword`、扫码字段或企业账号字段。

如果挑战接口没有返回有效 `challengeId`，bundle 中存在退化逻辑：`password` 与 `sha256Password` 都改为 `SHA256(原始密码)`。本次抓包没有进入该分支。

### 6.2 成功响应

线上响应为 `{"edata":"..."}`。解密后 `code=0`，`data` 中实际出现以下全部字段：

| 字段 | 本次类型 | 客户端用途/说明 |
| --- | --- | --- |
| `adminUser` | boolean | 是否为管理员账号；客户端写入登录状态 |
| `bondedDevice` | boolean | 当前设备是否已绑定；未绑定时客户端进入设备绑定流程 |
| `commonLoginReqHeader` | string | 公共登录请求头相关数据；本次主流程未继续读取其内容 |
| `ctqEncId` | null | 本次为空；主流程未消费，具体业务语义未由抓包证实 |
| `deviceType` | string | 服务端确认的设备类型 |
| `email` | string | 账号邮箱 |
| `forceBindPhone` | boolean | 强制绑定手机号标志；本次主流程未读取 |
| `forceUpdateInitialPwd` | boolean | 强制修改初始密码标志；本次主流程未读取 |
| `hasPassword` | number | 是否已设置密码的数值标志 |
| `loginNotify` | null | 本次为空；具体结构未观察到 |
| `mfaTicket` | null | 本次为空；MFA 相关票据 |
| `mobilephone` | string | 账号手机号 |
| `needAccessRuleCheck` | null | 本次为空；访问规则检查标志/数据未观察到 |
| `needBindVirtualMfa` | null | 是否需要绑定虚拟 MFA；客户端会参与后续安全校验判断 |
| `needSmsValidate` | boolean | 是否需要继续进行短信/邮箱二次校验 |
| `needUpdatePassword` | boolean | 是否需要强制修改密码 |
| `pid` | null | 本次为空；具体业务语义未由抓包证实 |
| `random` | null | 本次为空；具体业务语义未由抓包证实 |
| `realNameStatus` | number | 实名认证状态码 |
| `recordSn` | boolean | 本次为布尔值；主流程未消费，具体业务语义未由抓包证实 |
| `secretKey` | string | 后续认证请求签名所需密钥，必须按敏感数据处理 |
| `tenantId` | number | 租户 ID；用于后续 `CTG-TENANTID` 和签名 |
| `tenantName` | string | 租户名称 |
| `timestamp` | number | 服务端登录时间基准；用于校正后续 `CTG-TIMESTAMP` |
| `token` | null | 本次为空；未使用此字段维持本次 Web 登录态 |
| `tryout` | null | 本次为空；试用相关数据未观察到 |
| `twoFaValidateType` | null | 二次认证类型；客户端会参与后续安全校验判断 |
| `userAccount` | string | 标准化后的账号 |
| `userEid` | string | 用户企业/扩展标识；后续保存到认证资料 |
| `userId` | number | 用户 ID；用于后续 `CTG-USERID` 和签名 |
| `userName` | string | 用户显示名称 |

脱敏结构示例：

```json
{
  "code": 0,
  "data": {
    "adminUser": false,
    "bondedDevice": true,
    "commonLoginReqHeader": "<redacted>",
    "ctqEncId": null,
    "deviceType": "60",
    "email": "<redacted>",
    "forceBindPhone": false,
    "forceUpdateInitialPwd": false,
    "hasPassword": 1,
    "loginNotify": null,
    "mfaTicket": null,
    "mobilephone": "<redacted>",
    "needAccessRuleCheck": null,
    "needBindVirtualMfa": null,
    "needSmsValidate": false,
    "needUpdatePassword": false,
    "pid": null,
    "random": null,
    "realNameStatus": 0,
    "recordSn": false,
    "secretKey": "<redacted>",
    "tenantId": 0,
    "tenantName": "<redacted>",
    "timestamp": 0,
    "token": null,
    "tryout": null,
    "twoFaValidateType": null,
    "userAccount": "<redacted>",
    "userEid": "<redacted>",
    "userId": 0,
    "userName": "<redacted>"
  }
}
```

示例中的具体布尔值和数值仅用于表达 JSON 类型，不代表本次账号真实值。

登录成功后，客户端至少保存 `userId`、`userEid`、`tenantId`、`secretKey`、`timestamp`，用于构造登录态接口头和签名。

### 6.3 登录成功后的条件认证状态机

本次账号直接进入最终成功分支，所以下列接口没有在本次账号上触发；顺序、字段和端点来自同版本线上运行时代码。实现方不能仅看到 `code=0` 就保存最终登录态，必须按以下顺序处理响应标志：

```text
已提交 mfaCode + mfaKey
  -> 完成 MFA 绑定
否则 bondedDevice === false
  -> 设备绑定
否则 twoFaValidateType === 5
  -> 虚拟 MFA 校验/登录
否则 needSmsValidate === true
  -> twoFaValidateType === 4 ? 邮箱校验 : 短信校验
否则 needUpdatePassword === true
  -> 强制修改密码
否则
  -> 保存 authData，进入登录态
```

二次认证仍调用同一个 `/api/auth/client/login`，并复用原账号、设备字段和登录响应状态。若调用上下文保留了 `originalPassword`，客户端会重新调用 `genChallengeData`，按 6.1 计算新的两个密码字段；若只保留了原摘要，则继续提交原摘要。实现方应优先保留内存中的原始密码直到条件认证完成，但不得持久化或记录它。

账号登录图形验证码接口：

```http
GET /api/auth/client/captcha?height=<h>&width=<w>&userInfo=<account>&mode=<auto|direct|internet>&_t=<millis> HTTP/1.1
```

当前页面使用图片 blob 响应，响应头 `CTG-CAPTCHA-KEY` 可由请求层读取；当前 `/login` 逻辑请求实际只附加用户输入的 `captchaCode`。收到 `51030`、`51031` 或 `51040` 后刷新图片并再次提交同一登录接口。

| 分支 | 前置请求/数据来源 | 再次登录附加字段 | 证据边界 |
| --- | --- | --- | --- |
| 短信二次认证 | 上述 CAPTCHA；`GET /api/auth/client/validateCode/sendLoginSmsCode?mobilePhone=<phone>&captchaCode=<image-code>`；响应头 `CTG-SMS-KEY` 由请求层处理 | `smsCode`；若原对象还带 `captchaCode`，当前代码将其置为空字符串 | 运行时代码；本次未触发 |
| 邮箱二次认证 | CAPTCHA；`GET /api/auth/client/validateCode/sendLoginValidateCode?userAccount=<account>&twoFaType=4&captchaCode=<image-code>`；响应头 `CTG-MAIL-KEY` | `mailCode`、`mailCodeKey=<CTG-MAIL-KEY>`；原 `captchaCode` 置空 | 运行时代码；本次未触发 |
| 已绑定虚拟 MFA | 用户输入 6 位动态码 | `mfaCode` | 运行时代码；本次未触发 |
| 新绑定虚拟 MFA | 绑定流程返回 `secKey` | `mfaCode`、`mfaKey=secKey` | 运行时代码；本次未触发 |

设备绑定使用另一组端点：

| 方法 | 路径 | 用途/关键字段 |
| --- | --- | --- |
| `GET` | `/api/auth/client/validateCode/captcha` | 查询参数 `width=200`、`height=80`、`_t=Date.now()`；响应为图片 blob |
| `GET` | `/api/cdserv/client/device/getSmsCode` | 查询参数 `mobilePhone=<profile.mobilephone>`、`captchaCode=<image-code>`；请求层要求登录态签名 |
| `POST` | `/api/cdserv/client/device/binding` | 表单提交 `verificationCode`、`deviceName`、`deviceCode`、`deviceModel`、`sysVersion`、`appVersion`、`hostName`、`deviceInfo=navigator.platform || "WebBrowser"` |

虚拟 MFA 管理端点及当前登录/绑定字段：

| 方法 | 路径 | 逻辑请求/响应用途 |
| --- | --- | --- |
| `GET` | `/api/auth/client/virtualMfa/getBindStatus` | 无参数；返回 data 布尔值，决定显示已绑定状态还是二维码绑定页 |
| `POST` | `/api/auth/client/virtualMfa/getBindCodeData` | `{userAccount, password}`；登录首绑时 `password=SHA256(originalPassword)`；响应 data 至少含 `userName`、`secKey`、`qrCodeData` |
| `POST` | `/api/auth/client/virtualMfa/bind` | 非登录态管理页提交 `{userAccount, password, mfaCode, mfaKey: secKey}` |
| `POST` | `/api/auth/client/virtualMfa/unbind` | 提交 `{checkTarget, checkSign, mfaCode}` |

首次登录绑定 MFA 时不调用 `/virtualMfa/bind`：页面把 6 位码和 `secKey` 写回原登录上下文为 `mfaCode`、`mfaKey`，再次调用 `/api/auth/client/login`。已有 MFA 登录只附加 `mfaCode`。

上述分支接口成功时均按公共 envelope 的 `code===0` 消费 `data`；失败时展示 `msg` 并停留在当前校验页。只有重新执行状态机后进入最终 `authData` 分支，才算完整登录成功。

强制改密和忘记密码共用 `POST /api/auth/client/resetPassword` 表单接口。改密分支发送旧密码的 SHA-256，以及 `newEncPwd1=MD5(新密码)`、`newEncPwd2=SHA256(新密码)`；忘记密码分支还会带邮箱或手机号和服务端签名数据。该端点的完整非空响应结构未在本次账号上实测，调用方应按 `code===0` 判断并展示服务端 `msg`。

### 6.4 错误处理

本次只抓到成功响应，没有主动制造密码错误或验证码错误。以下错误码来自同版本 bundle 的枚举和账号登录页面分支，不能视为本次服务端错误响应样本：

| code | bundle 名称 | 客户端处理 |
| --- | --- | --- |
| `51010` | `INVALID_PASSWORD` | 密码错误 |
| `51020` | `AUTH_LOCKED` | 账号锁定 |
| `51030` | `INVALID_CAPTCHA` | 图形验证码无效，账号登录页显示验证码输入 |
| `51031` | `EXPIRE_CAPTCHA` | 图形验证码过期，账号登录页刷新验证码 |
| `51040` | `NEED_CAPTCHA` | 服务端要求增加图形验证码 |
| `51085` | `ERROR_CAPTCHA` | 验证码错误；bundle 中主要用于验证码登录分支 |

逻辑错误响应由公共处理器按以下方式消费：

```json
{
  "code": 51010,
  "msg": "<server-message>",
  "data": "<optional>"
}
```

错误响应的 `data` 实际结构未在本次成功抓包中验证。

### 6.5 登录态持久化与失效

| 项目 | 当前 Web 客户端行为 |
| --- | --- |
| 登录资料 | `authData` 保存用户资料、`secretKey`、用户/租户 ID 和服务端 `timestamp` |
| 登录时刻 | 保存 `loginAt=Date.now()`，用于计算 `offsetTime` |
| Web 过期时间 | `authExpiredAt=Date.now()+2 小时` |
| 续期 | 登录态下每 30 分钟刷新本地过期时间 |
| 页面重载 | 读取 `authData`，检查 `authExpiredAt`；有效则恢复请求层认证数据，无效则本地退出 |
| 小程序差异 | 同一代码包含 7 天过期分支；本文 Web 实现使用 2 小时，不应混用 |
| 无权限 | 业务码 `40010`（`NO_PERMISSIONS`）触发本地退出，不再调用服务端 logout |
| 账号解绑 | 业务码 `30060`（`UNBINDING`）触发本地移除账号资料 |

`authData`、`secretKey` 和协商密钥均不得进入普通业务日志。实现方如果不复用官方存储层，也必须保持“过期检查 -> 恢复认证头 -> 时间校正”的同等生命周期。

#### 6.5.1 页面重载后的 AES 与 Cookie 行为

`eid`、`evalue`、临时 RSA 私钥和中间 AES key 都只存在于请求对象内存，不写入 `authData` 或其他持久化键。每次页面/请求服务实例创建时会立即执行：

```text
new RequestService
  -> _negotiationHandler = negotiationEncKey()
  -> getServData
  -> 生成新的临时 RSA 密钥对
  -> negotiationEncKey
  -> 内存保存新的 eid/evalue
```

与此同时，认证服务可同步读取 `authData` 并调用 `setAuthData(...)`。二者没有先后依赖；页面重载后的第一个业务 API 在加密拦截器中调用 `getEncData()`，会等待 `_negotiationHandler` 完成，然后使用新协商的 `eid/evalue` 加密，同时使用恢复的 `secretKey`、用户/租户 ID 和时间偏移签名。

因此恢复顺序的可执行模型是：

1. 创建请求服务并启动新的密钥协商。
2. 读取并验证 `authData`/`authExpiredAt`，恢复签名资料。
3. 业务请求同时依赖两组状态：新协商的报文 AES 上下文 + 持久化恢复的认证签名上下文。
4. 协商失败时当前代码不会持久化回退密钥；需要加密的接口将无法形成有效请求，应回到初始化错误处理而不是复用旧 `evalue`。

普通 PC API 的 axios 实例没有设置 `withCredentials: true`，当前认证主链依赖 CTG 请求头、加密 body 和 `authData`，不依赖可复制的登录 Cookie。只有个别其他功能显式覆盖 `withCredentials`；本文登录、列表、连接信息和 logout 均按默认 credentials 行为。退出时仍清理 `token` Cookie，是为了同步清除可能由其他登录入口留下的浏览器 SSO 状态。

## 7. 退出登录

### 7.1 请求

```http
POST /api/auth/client/logout HTTP/1.1
Host: desk.ctyun.cn:8810
CTG-REQDATA-ETYPE: 2
CTG-NEGO-EKEYID: <eid>
CTG-USERID: <userId>
CTG-TENANTID: <tenantId>
CTG-SIGNATURESTR: <signature>
```

本次实际请求：

- 无查询参数。
- 无请求体。
- 浏览器实际出站请求中未出现 `Content-Type`。
- 使用登录响应中的 `userId`、`tenantId`、`secretKey` 构造认证头和签名。

### 7.2 成功响应

线上响应：

```json
{
  "edata": "<encrypted-response>"
}
```

解密后：

```json
{
  "code": 0,
  "data": true
}
```

本次退出后页面路由变为：

```text
https://pc.ctyun.cn/#/login?logout=false
```

### 7.3 客户端退出行为

bundle 显示，客户端会等待服务端退出请求，但最多约 1 秒。无论服务端请求成功、失败或超时，客户端随后都会：

1. 清空内存中的用户资料和登录数据。
2. 清空请求层的认证数据。
3. 删除本地保存的认证资料。
4. 清除当前域和 `.ctyun.cn` 域的 `token` Cookie。
5. 触发本地退出事件并返回登录页。

因此，实现自动化时应分别记录“服务端退出成功”和“本地登录态已清除”，不能只根据页面跳回登录页判断服务端接口成功。本次抓包两者均成功。

## 8. 实现注意事项

1. `genChallengeData` 的挑战有效期本次只有 60 秒，应紧接着调用 `login`，不要缓存复用。
2. 密码哈希是 SHA-256 的小写十六进制结果，不是 Base64。
3. 登录逻辑请求先编码为表单，再由请求层整体加密为唯一的 `eParams` 字段。
4. `CTG-NEGO-EKEYID` 必须与加密使用的 `evalue` 属于同一次协商。
5. 登录前接口没有 `CTG-USERID`、`CTG-TENANTID`、`CTG-SIGNATURESTR`；退出接口必须携带。
6. HTTP 200 只代表传输成功，业务成功仍需解密后检查 `code === 0`。
7. `secretKey`、`evalue`、密码哈希、设备标识和用户标识均应视为敏感数据，不得写入日志。
8. 本文没有录入扫码登录、验证码登录、企业账号登录及其接口。退出后登录页自动产生的二维码轮询请求也不属于本文范围。
