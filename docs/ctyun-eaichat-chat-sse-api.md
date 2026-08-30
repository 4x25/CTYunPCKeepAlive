# 天翼云智助手 AI 对话 SSE 接口

## 1. 文档范围

本文记录 `https://eaichat.ctyun.cn/chat/#/aichat` 页面中，在中央输入框输入文字并按 Enter 发送后触发的 AI 对话接口。

本次测试消息：

```text
SSE接口测试，请只回复 SSE_OK。
```

页面实际返回：

```text
SSE_OK
```

接口存在性、HTTP 方法、URL、请求头、请求体、响应头、网络分块、SSE 事件字段和结束方式均来自 2026-08-29 的内置浏览器实际事务。字段生成规则、SSE 解析和错误处理分支来自同版本线上 bundle：

- `https://eaichat.ctyun.cn/chat/js/app.37bbce61.js`
- `https://eaichat.ctyun.cn/chat/js/chunk-vendors.a4560e99.js`

本次分析涉及的原始前端资源已归档到 [2026-08-29 bundle 快照](./bundle-snapshots/2026-08-29/README.md)。

本次先执行了一次正常发送，确认实际端点和页面回复；随后对同一消息执行一次“重新生成”，从同一端点完整记录请求体和响应流。重新生成会额外携带 `conversation_id` 和 `message_id`，本文会明确标注这些差异。

账号、租户 ID、用户设备 ID、会话签名密钥、请求签名、消息 ID、会话 ID 和校验 ID 均已脱敏。

## 2. 接口总览

```http
POST https://eaichat.ctyun.cn:443/ai/portal/wenc/v3/openai/chat/completions
Content-Type: application/json
```

本次实际结果：

| 项目 | 实际值 |
| --- | --- |
| 请求实现 | `fetch` |
| HTTP 状态 | `200` |
| `Response.ok` | `true` |
| 响应类型 | `text/event-stream` |
| 是否重定向 | 否 |
| 凭据模式 | `credentials: "include"` |
| 取消机制 | `AbortController` |
| 网络分块数 | 5 |
| SSE 事件数 | 7 |
| 响应正文总字节数 | 2048 |
| 首次发送耗时 | 约 3554 ms |
| 重新生成耗时 | 约 3497 ms |
| 最终输出 | `SSE_OK` |

## 3. 会话认证与请求签名

该接口依赖云智助手登录后建立的签名会话，登录过程见 [天翼云智助手账号登录与退出登录接口](./ctyun-eaichat-account-auth-api.md)。

### 3.1 实际应用请求头

以下是本次 `fetch` 初始化参数中实际出现的全部应用层请求头。浏览器自动增加的 `Origin`、`Sec-Fetch-*`、`User-Agent` 等传输层请求头不在此表中。

| 请求头 | 本次值/格式 | 含义 |
| --- | --- | --- |
| `Content-Type` | `application/json` | JSON 请求体 |
| `x-client-trace-id` | 36 位 UUID | 客户端链路追踪 ID |
| `YL-Main-Version` | `202060305` | Web 主版本 |
| `YL-Product-Id` | `5` | 产品 ID |
| `Web-Signature` | 64 位十六进制字符串 | 请求签名，敏感 |
| `Web-Random` | 8 位字符串 | 签名随机数 |
| `Web-Timestamp` | 十进制毫秒时间戳 | 签名时间戳 |
| `x-eai-xuid` | string，本次长度 43 | Web 设备/访问标识，敏感 |
| `x-eai-env` | `pubWeb` | Web 环境 |
| `x-eai-version` | `202060305` | 云智助手版本 |
| `x-user-agent` | string | 浏览器 User-Agent 副本 |
| `x-eai-source` | `web-eai` | 请求来源 |
| `x-eai-tenant-id` | string，本次长度 6 | 当前租户 ID，敏感 |
| `x-eai-env-code` | string | 私有环境代码；本次请求头存在 |
| `x-eai-mode` | `eai` | 当前场景模式 |

动态头来源：

| 请求头 | 生成规则 |
| --- | --- |
| `x-client-trace-id` | 每次请求新建 UUID v4 |
| `x-eai-xuid` | `localStorage.lxuid`；不存在时生成 `pubweb_` + UUID v4 并复用 |
| `x-eai-env` | 移动端或当前 URL 含 `from` 时为 `pubH5`，其他 Web 页面为 `pubWeb` |
| `x-eai-tenant-id` | 当前租户配置/currentTenant |
| `x-eai-env-code` | 私有网关运行状态；公有环境为空字符串 |
| `Web-*` | 使用账号认证文档 5.2 恢复出的内存签名密钥，按 3.2 逐请求生成 |

### 3.2 `Web-Signature` 生成规则

bundle 中的签名步骤：

1. 删除 URL 参数中值为 `null` 或 `undefined` 的字段。
2. 参数名使用 JavaScript `localeCompare` 排序。
3. 每项按 JavaScript 字符串强制转换为 `key=value`，再用 `&` 连接；该步骤不做 URL 编码。本接口本次没有 URL 参数，因此该部分为空。
4. 请求体存在时先生成参与摘要的精确字符串：字符串保持不变，`URLSearchParams` 使用 `.toString()`，其他对象使用 `JSON.stringify(body)`。
5. 对该字符串计算 MD5 小写十六进制摘要 `bodyMd5`。没有请求体时不加入该组件。
6. 生成 8 位字母数字随机串 `random`：`crypto.getRandomValues` 产生随机字节，每字节对 62 取模后映射到大小写字母和数字。
7. 生成 `Date.now()` 毫秒字符串 `timestamp`。
8. 按“存在才加入”的规则连接查询串、`bodyMd5`、会话签名密钥、时间戳、随机数，并计算 SHA-256 小写十六进制摘要。

通用公式：

```text
query = sortedNonNullParams.map(([k,v]) => `${k}=${String(v)}`).join("&")
bodyMd5 = bodyExists ? lowercaseHex(MD5(exactBodyString)) : absent

signatureSource = [query, bodyMd5, sessionSigningKey, timestamp, random]
  .filter(componentIsPresent)
  .join("&")

Web-Signature = lowercaseHex(SHA256(signatureSource))
```

本接口无 URL 参数时：

```text
bodyMd5 = MD5(JSON.stringify(requestBody))

signatureSource = bodyMd5
  + "&" + sessionSigningKey
  + "&" + timestamp
  + "&" + random

Web-Signature = lowercaseHex(SHA256(signatureSource))
```

`sessionSigningKey` 是登录时对 `ticketAuthorize` 返回的 `sessionKey` 解密后得到的运行时密钥，不得记录或持久化到普通日志。

`Web-Random` 使用 `crypto.getRandomValues()` 生成，字符集为大小写字母和数字。

签名必须基于最终传给 `fetch` 的同一份 body 字符串。对象签名后再调整字段顺序、增删空数组或重新序列化，都会导致服务端验签失败。

## 4. 请求体

### 4.1 本次完整抓包

以下请求体来自“重新生成”事务：

```json
{
  "key_model": "TEXT_DEEPSEEK_V4",
  "messages": [
    {
      "role": "user",
      "content": "SSE接口测试，请只回复 SSE_OK。",
      "verify_id": "<redacted>",
      "ref": {
        "type": "file",
        "file": []
      }
    }
  ],
  "stream": true,
  "client_retry": true,
  "web_search": false,
  "tenantId": 0,
  "enable_thinking": false,
  "message_id": 0,
  "conversation_id": "<redacted-uuid>",
  "tools": [],
  "action": {}
}
```

示例中的 `tenantId` 和 `message_id` 只表达 number 类型，不是本次真实值。

### 4.2 顶层字段

| 字段 | 类型 | 新发送 | 重新生成实测 | 含义 |
| --- | --- | --- | --- | --- |
| `key_model` | string | 是 | `TEXT_DEEPSEEK_V4` | 请求使用的模型键 |
| `messages` | array | 是 | 1 个元素 | 本次发送给模型的消息 |
| `stream` | boolean | 是 | `true` | 开启流式响应 |
| `client_retry` | boolean | 是 | `true` | 允许客户端/服务端重试标志 |
| `web_search` | boolean | 是 | `false` | 是否启用联网搜索 |
| `agentId` | string/number | 否 | 未出现 | 智能体 ID；使用智能体时附加 |
| `tenantId` | number | 视登录态 | 出现 | 当前租户 ID |
| `enable_thinking` | boolean | 是 | `false` | 是否开启深度思考 |
| `message_id` | number | 否 | 出现 | 重新生成时关联原用户消息 |
| `conversation_id` | string | 否 | 36 位字符串 | 已有会话或重新生成时使用 |
| `tools` | array | 否 | 空数组 | 可调用工具定义 |
| `action` | object | 否 | 空对象 | 文档、思维导图、PPT 等动作参数 |

消息和会话 ID 的完整规则：

| 场景 | `verify_id` | `conversation_id` | `message_id` | `messages` 内容 |
| --- | --- | --- | --- | --- |
| 全新会话首条消息 | 新建 UUID v4；同时作为本地用户消息的 `messageId` 和 `verifyId` | 省略 | 省略 | 仅当前用户消息 |
| 已有会话普通追问 | 当前用户消息新建 UUID v4 | 当前会话 ID | 仅调用方提供且 `!isNaN(value)` 时加入 | 仍仅当前用户消息，不重传全部历史 |
| 重新生成 | 复用最后一条用户消息原 `verifyId` | 当前会话 ID | 按下述历史校准得到的服务端用户消息 ID | 复用该用户消息的文本和引用 |

服务器通过 `conversation_id` 关联已有历史；正常追问不需要把历史消息重新放入 `messages[]`。收到任一 SSE 事件的 `conversation_id` 后，客户端立即用它更新当前会话状态。

重新生成的历史校准算法来自同版本运行时代码：

1. 从本地消息列表移除最后一条 assistant 消息。
2. 找到最后一条 user 消息，复用它的 `verifyId`、文本和 `ref`。
3. 调用历史接口：

```http
GET /ai/portal/v2/openai/chat/history?conversation_id=<url-encoded-id>&count=2 HTTP/1.1
Host: eaichat.ctyun.cn
```

4. 该 GET 使用 3 节的 Cookie、环境头和 Web 签名；查询参数由 axios `params` 标准序列化。
5. 响应 body 必须包含数组 `content`，否则当前客户端直接判定重新生成失败：

```ts
interface RegenerateHistoryResponse {
  content: RegenerateHistoryItem[];
  // 分页加载时可能还有其他字段；重新生成不消费。
}

interface RegenerateHistoryItem {
  verifyId: string;
  messageId: number;
  messageRole?: string;
  messageContent?: string;
}
```

6. 客户端只读取 `content[0]`。如果其 `verifyId` 与本地用户消息相同，用返回的数值 `messageId` 覆盖本地 ID；不匹配时保留本地 `messageId`，后续仅当它为数值时才进入请求。
7. 使用同一 `verify_id`，并附加当前 `conversation_id` 和可用的数值 `message_id`，再次调用 `/chat/completions`。

历史路由也可以从 URL/query 初始化当前 `conversation_id`。任何来源的 `message_id` 都只在可转换为有效 number 时加入请求。

### 4.3 `messages[]` 字段

| 字段 | 类型 | 本次值/含义 |
| --- | --- | --- |
| `role` | string | `user` |
| `content` | string | 用户输入文本 |
| `verify_id` | string | 消息校验 ID，敏感 |
| `ref` | object | 文件、图片、URL、绘图等引用信息 |

本次引用结构：

```json
{
  "type": "file",
  "file": []
}
```

bundle 还支持图片内容直接放入 `ref.image`，以及 `file_url`、`draw` 等引用类型。本次没有附件或图片。

新用户消息的 `verify_id` 不是服务端预分配值，而是客户端 UUID v4。自动模型重试和重新生成必须保持该值不变，避免同一逻辑消息被当作两条独立用户输入。

## 5. SSE 响应协议

### 5.1 响应头

本次实际响应：

```http
HTTP 200
Content-Type: text/event-stream
```

实际可见响应头名称：

```text
access-control-allow-credentials
access-control-allow-origin
access-control-expose-headers
content-type
date
server
strict-transport-security
x-ct-request-id
x-envoy-upstream-service-time
x-request-id
```

本次浏览器没有暴露 `Cache-Control`、`Connection` 或 `Transfer-Encoding` 响应头，调用方不应依赖这些头判断流是否结束。

### 5.2 SSE 帧格式

本次 7 个事件全部只有 `data` 字段：

```text
data: <JSON>

```

本次没有观察到：

- `event:`
- `id:`
- `retry:`
- `data: [DONE]`

每个 `data` 值都是一个独立 JSON 对象。

bundle 的 SSE 解析器支持标准字段 `data`、`event`、`id`、`retry`，并支持一个事件中出现多行 `data:`，多行内容使用换行符连接。

## 6. SSE 事件字段

### 6.1 顶层字段

下表是本次 7 个事件实际出现字段的并集：

| 字段 | 本次类型 | 是否每帧都有 | 含义 |
| --- | --- | --- | --- |
| `object` | string | 是 | 本次固定为 `chat.completion.chunk` |
| `status` | string | 是 | 本次固定为 `generating` |
| `model` | string | 是 | 实际模型标识 |
| `created` | number | 是 | 服务端生成时间 |
| `conversation_id` | string | 是 | 会话 ID，敏感 |
| `choices` | array | 是 | 增量输出数组 |
| `id` | string | 否 | 流/响应 ID；前两帧出现 |
| `message_id` | number | 否 | 消息 ID；内容帧出现 |
| `code` | number | 否 | 第二帧出现 |
| `audit_result` | string | 否 | 内容审查结果；本次为 `pass` |

### 6.2 `choices[0]`

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `index` | number | 选项索引，本次为单选项流 |
| `delta` | object | 当前增量数据 |
| `finish_reason` | string | 结束原因；最后一帧为 `stop` |

### 6.3 `choices[0].delta`

本次实际字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `role` | string | 消息角色 |
| `type` | string | 增量内容类型 |
| `content` | string | 文本增量；部分控制帧为空字符串或不存在 |

bundle 支持但本次未观察到的可选字段：

| 字段 | 用途 |
| --- | --- |
| `reasoning_content` | 深度思考增量 |
| `waiting` | 排队人数，配合 `status=queueing` |
| `tool_calls` | 工具调用请求 |
| `image_url` | 图片输出地址 |
| `meta_data.metadata_list` | 元数据列表 |
| `meta_data.citation_links` | 引用来源列表 |

## 7. 本次事件序列

网络层共收到 5 个字节块：

```text
297, 616, 290, 292, 553
```

SSE 解析后得到 7 个事件：

| 事件 | `status` | 主要增量 | 其他实际字段 |
| --- | --- | --- | --- |
| 1 | `generating` | `content=""` | `id`、`message_id`；模型为带 `-ctyun-pt-api` 后缀的实际部署名 |
| 2 | `generating` | `content=""` | `code`、`id`、`message_id`；模型字段使用较短别名 |
| 3 | `generating` | `content="SS"` | `message_id` |
| 4 | `generating` | `content="E"` | `message_id` |
| 5 | `generating` | `content="_OK"` | `message_id` |
| 6 | `generating` | 无文本增量 | `audit_result="pass"` |
| 7 | `generating` | 无文本增量 | `finish_reason="stop"` |

将事件 3、4、5 的 `delta.content` 顺序拼接：

```text
SS + E + _OK = SSE_OK
```

网络分块边界和 SSE 事件边界并不一致：5 个网络块解析出了 7 个事件。因此实现时必须维护缓冲区，以空行分隔完整 SSE 帧，不能把每次 `ReadableStream.read()` 当作一个事件。

## 8. 结束与关闭行为

本次服务端没有发送 `[DONE]`。实际结束过程是：

1. 最后一帧出现 `choices[0].finish_reason = "stop"`。
2. 响应 `ReadableStream` 随后返回 `done=true`。
3. 客户端等待约 200 ms。
4. 调用 `onclose`，保存最终消息与历史记录。

因此推荐同时处理：

- `finish_reason` 用于识别模型完成原因。
- `ReadableStream` 关闭用于确认传输真正结束。

不要只等待 `[DONE]`，否则本次协议会一直处于未完成状态。

## 9. 客户端状态与错误处理

bundle 中的状态分支：

| 状态/条件 | 客户端行为 |
| --- | --- |
| `status="queueing"` | 读取 `choices[0].delta.waiting` 并显示排队提示 |
| `status="generating"` | 处理文本、思考、图片、工具调用、卡片和引用增量 |
| `status="fail"` 且事件没有模型元数据 | 标记当前模型不可用并执行同产业模型回退 |
| HTTP 401 | 清理会话状态并重定向登录 |
| 其他非 2xx | 转成统一服务异常，不继续解析 SSE |
| 用户主动停止 | 调用 `AbortController.abort()`，保留已收到的部分输出并标记停止 |
| 流读取异常 | 调用 `onError`，保留已收到内容或显示服务异常 |

普通对话超时由前端定时器控制，bundle 默认约 90 秒；新智能体模式约 150 秒。超时后客户端主动中止请求。

请求体固定带 `client_retry=true`。客户端模型回退算法：

1. 将当前模型加入本次不可用集合。
2. 调用：

```http
GET /ai/portal/v2/openai/chat/queryModels?type=all HTTP/1.1
Host: eaichat.ctyun.cn
```

3. 响应必须满足 `resultCode === 0` 且 `data` 为数组。回退至少消费：

```ts
interface QueryModelsResponse {
  resultCode: number;
  data: Array<{
    keyModel: string;
    status: string;
    type: string;
  }>;
}
```

4. 在候选中选择第一个 `status === "avaiable"`、`type === 当前 industry.curIndustry` 且 `keyModel` 未在排除集合中的模型。注意服务端/客户端枚举实际拼写是 `avaiable`。
5. 使用最后一条用户消息重新发送，复用原 `verify_id`，保留当前 `conversation_id` 和其他请求选项。
6. 当前实现约 420 秒后会再次调用同一 `queryModels?type=all`，若原模型恢复为 `avaiable` 则回滚。

若没有符合条件的候选，客户端结束自动重试并显示服务异常。外部实现必须设置重试模型排除集合，避免两个不可用模型之间无限循环。

`industry.curIndustry` 不需要额外接口。初始化时客户端用同一个 `queryModels?type=all` 响应按 `item.type` 分组，并把当前选中 `key_model` 所在项的 `type` 保存为 `curIndustry`。等价实现：

```ts
const current = models.find(item => item.keyModel === activeKeyModel);
const currentIndustry = current?.type;

const fallback = models.find(item =>
  item.type === currentIndustry &&
  item.status === "avaiable" &&
  !excludedKeyModels.has(item.keyModel)
);
```

初始 `activeKeyModel` 优先取路由 `keyModel`，否则取平台保存的行业默认模型；用户切换模型时同步更新。若当前 key 不在查询结果中，不能跨行业盲选，直接结束自动回退。

## 10. 自定义 `tools` 兼容性实测

### 10.1 测试方法

在同一登录会话和同一 `/v3/openai/chat/completions` 端点中，向实际请求体注入一个没有任何外部实现的 OpenAI 风格函数工具：

```json
{
  "type": "function",
  "function": {
    "name": "get_test_value",
    "description": "返回固定测试值，仅用于验证自定义工具调用",
    "parameters": {
      "type": "object",
      "properties": {
        "input": {
          "type": "string",
          "description": "固定填写 ping"
        }
      },
      "required": ["input"],
      "additionalProperties": false
    }
  }
}
```

同时强制指定：

```json
{
  "tool_choice": {
    "type": "function",
    "function": {
      "name": "get_test_value"
    }
  }
}
```

测试提示词：

```text
请调用 get_test_value 工具，参数 input 固定为 ping，不要直接回答。
```

为防止页面尝试执行未知工具，测试程序只读取网关的原始 SSE，随后向页面返回本地占位回答 `CUSTOM_TOOL_TEST_CAPTURED`。页面显示的占位回答不是网关原始内容。

### 10.2 实际结果

| 项目 | 实际值 |
| --- | --- |
| 模型键 | `TEXT_DEEPSEEK_V4` |
| HTTP 状态 | `200` |
| 响应类型 | `text/event-stream` |
| 网络分块数 | 1 |
| SSE 事件数 | 2 |
| 响应总字节数 | 581 |
| 请求中 `tools` | 1 个自定义函数 |
| 请求中 `tool_choice` | 强制 `get_test_value` |
| 响应中 `delta.tool_calls` | 0 个 |
| 最终 `finish_reason` | `stop` |

事件序列：

| 事件 | `delta` 字段 | 结果 |
| --- | --- | --- |
| 1 | `content`、`role`、`type` | 返回 23 字符普通文本，没有 `tool_calls` |
| 2 | `role`、`type` | `finish_reason="stop"`，没有 `tool_calls` |

### 10.3 结论

本次可以确认：

1. 网关没有因 `tools` 或 `tool_choice` 字段返回 HTTP/参数校验错误。
2. 当前 `TEXT_DEEPSEEK_V4` 模型与该路由组合没有遵守强制 `tool_choice`。
3. 响应没有产生 OpenAI 风格的 `choices[0].delta.tool_calls`。
4. 因此，当前组合不能视为支持可用的任意自定义函数工具调用。

bundle 本身包含 `delta.tool_calls` 处理逻辑，并能处理平台内置或 MCP 工具。这只能证明客户端和平台协议预留了工具调用能力，不能证明任意用户自定义 `tools` 会被当前模型执行。

更严格的兼容性表述是：

```text
请求字段可被接受，但当前模型未执行自定义工具，强制 tool_choice 未生效。
```

该结果是模型和路由相关的，不能外推到其他 `key_model`。

### 10.4 平台工具调用续跑协议

以下流程来自同版本运行时代码，适用于服务端实际返回 `delta.tool_calls` 的平台内置或 MCP 工具；本次自定义工具测试没有触发它。

`choices[0].delta.tool_calls` 的运行时代码消费 schema：

```ts
interface PlatformToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: unknown;
  };
  call_type?: "server" | string;
  tool_id?: string | number;
  display_name?: string;
  tool_code?: string;
}
```

当前解析器没有按 OpenAI `index` 合并碎片，也不会拼接分段的 `function.arguments`。它假定每个 SSE 事件中的 `delta.tool_calls` 已是可直接执行的完整数组；对于非即时本地工具，当前事件的数组会成为流关闭后待执行列表。因此服务端若把一个工具调用拆成多个增量，当前 Web 客户端本身也无法正确还原，外部实现无需猜测额外聚合规则。

当前 SSE 流关闭后：

1. 按数组顺序逐个执行工具。本地工具通过桌面 IPC；`call_type === "server"` 的远程/MCP 工具通过平台工具接口。
2. 把工具执行结果和状态写入最后一条 assistant 消息的 metadata。
3. 为每个调用创建一条 `role="tool"` 的 continuation 消息。
4. 复用原请求的模型、搜索、思考、agent/action 等上下文和当前 `conversation_id`。
5. 从 continuation 请求中删除 `tools` 声明，避免再次把定义重复提交。
6. 再次调用同一个 `/ai/portal/wenc/v3/openai/chat/completions` SSE 接口，让模型读取工具结果并继续回答。

Web 与 Electron 能力边界：

| `call_type` / 工具来源 | 浏览器 Web | Electron 客户端 |
| --- | --- | --- |
| `call_type === "server"` | 支持，使用下述 `/mcp/tool/call` | 支持 |
| 非 `server` 的本地 MCP/文件工具 | 不支持，依赖 `window.ipcRenderer.mcp(...)` | 由桌面 IPC 执行 |

本文是 Web 前端接口文档，因此可独立实现范围是远程/server 工具续跑。浏览器在构造 `tools` 时应只暴露可由服务端执行的定义；如果响应仍返回非 `server` 工具，应标记为客户端能力不支持并终止该工具续跑，不能伪造 IPC 结果。Electron IPC 方法、文件访问和本地应用启动属于桌面客户端协议，不属于本 Web API 文档。

续跑消息 schema：

```json
{
  "role": "tool",
  "tool_call_id": "<original-tool-call-id>",
  "content": "<summary_content-or-content>",
  "text": "<display-text>",
  "task_status": "<processing|success|fail|other-runtime-status>"
}
```

`content` 优先使用工具结果的 `summary_content`，不存在时使用 `content`；`text` 用于页面展示，不能代替传给模型的 `content`。

远程服务端工具调用：

```http
POST /ai/portal/v1/mcp/tool/call
Content-Type: application/json
```

逻辑请求体：

```json
{
  "tool_call_id": "<original-tool-call-id>",
  "tool_id": "<platform-tool-id>",
  "name": "<tool-name>",
  "arguments": "<JSON.stringify(original-arguments)>",
  "conversation_id": "<current-conversation-id>",
  "tenant_id": 0
}
```

`tenant_id` 取账号认证文档 5.3.1 选中的 `currentTenant.tenantId`，示例中的 `0` 只表达 number 类型。

该接口自身也返回 SSE。每个 `data:` JSON 按以下结构消费：

```ts
interface RemoteToolSseEvent {
  data?: {
    text?: string;
    content?: string;
    display_name?: string;
    summary_content?: string;
    task_status?: string; // 缺失时按 processing
  };
}
```

只有 `data.content` 为真值的事件会更新工具状态；`content`、`summary_content`、`text` 和 `display_name` 均以最新非空值覆盖同 ID 工具。`summary_content` 正是 continuation `content` 的优先来源。

远程工具的完成/失败语义是传输级的：

- SSE 正常关闭时，客户端把该工具本地状态更新为 `close` 并 resolve，然后继续下一个工具。
- SSE `onerror` 时状态更新为 `error`、Promise reject，当前 continuation 不应继续发送。
- 当前代码不要求最后一帧出现 `task_status=success` 才继续；业务状态仅作为 metadata 和 continuation 字段传回模型。

所有工具执行 Promise 完成后才组装 `role=tool` continuation，不能在远程工具仍为 `processing` 时提前续跑模型。

## 11. 相关但非 SSE 的请求

本次发送完成后还观察到以下独立请求，它们不属于流式回答接口：

| 接口 | 用途 |
| --- | --- |
| `POST /ai/portal/wenc/v1/itstat/reportBusiEvent?code=eai_user_chat...` | 上报对话行为统计 |
| `GET /ai/portal/v2/openai/chat/history?...` | 读取会话历史；重新生成使用 `conversation_id`、`count=2` |

不能用这两个请求的成功状态代替 SSE 对话成功状态。

## 12. 实现注意事项

1. 使用 `fetch` 和 `ReadableStream`，不要使用只支持 GET 的原生 `EventSource`。
2. 请求体必须设置 `stream=true`。
3. 请求需要登录态 Cookie 和 Web 签名请求头。
4. `Web-Signature` 必须覆盖本次请求体的精确 JSON 字符串；字段、空对象或空数组变化都会改变 MD5 和最终签名。
5. SSE 事件边界可能跨多个网络分块，也可能一个网络分块包含多个事件。
6. 每个 `data:` 值独立执行 JSON 解析，再按 `delta.content` 顺序拼接。
7. 不要假设存在 `[DONE]`；本次以 `finish_reason="stop"` 加流关闭结束。
8. `conversation_id`、`message_id`、`verify_id`、租户 ID、Web 签名和设备标识均应按敏感数据处理。
9. 全新发送和重新生成共用同一接口，但重新生成通常增加 `conversation_id` 和 `message_id`。
