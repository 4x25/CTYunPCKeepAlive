# 天翼量子 AI 云电脑 Clink WebSocket 握手协议

## 1. 文档范围

本文记录天翼量子 AI 云电脑 Web 客户端建立远程连接时以下三个 Clink 通道的握手过程：

- `MAIN`：主控制通道，channel type `1`。
- `DISPLAY`：显示通道，channel type `2`。
- `INPUTS`：输入通道，channel type `3`。

本文覆盖：

1. 获取云电脑连接信息的 HTTP 接口。
2. WebSocket HTTP Upgrade。
3. Clink 代理层 JSON 建链。
4. `REDQ` 链路协商、RSA ticket 认证和通道进入 `READY`。
5. 三个目标通道在认证后的必要初始化消息。
6. 连接成功判定和失败条件。

不包含视频帧、图像解码、音频流、键鼠业务事件、剪贴板、文件传输、摄像头、WebRTC 或其他 Clink 通道的业务协议。

接口存在性、HTTP 方法、WebSocket URL、Upgrade 头、帧方向、长度、消息编号和样本字段来自 2026-08-29 的实际内置浏览器抓包。结构体布局、状态机和消息名称来自同版本线上 bundle 快照：

- `docs/bundle-snapshots/2026-08-29/pc-cloud-desktop/main.1bcf98.js`

实际证书、私钥、token、账号、桌面 ID、session ID、内网地址和 WebSocket 节点均已脱敏，未写入本文。

## 2. 抓包方法说明

当前 Chromium 和官方代码默认优先使用 WebTransport，因此第一次正常连接没有产生 WebSocket 帧。为验证用户指定的 WebSocket 路径，本次在连接前临时将当前页面运行时的 `WebTransport` 设为不可用，触发官方代码内置的 WebSocket fallback：

```text
WebTransport unavailable
  -> official transport selector
  -> new WebSocket(url, "binary")
```

连接成功后恢复原运行时设置。服务端、远程云电脑和项目文件均未因此改变。

本文只适用于 WebSocket framing。WebTransport 会在每次发送的数据前增加其自己的 5 字节类型/长度封装，不属于本文范围。

## 3. 建链总览

```text
POST queryConnectData  ─┐
                        ├─ first successful response -> connectionInfo
POST connect (10ms后)  ─┘
          |
          v
open wss://<proxy>/clinkProxy/<desktop-id>/MAIN
          |
          +-- HTTP 101, subprotocol=binary
          +-- proxy JSON connect request
          +-- proxy success byte 0x01
          +-- REDQ header + MAIN link message
          +-- server REDQ link response + RSA public key
          +-- encrypted ticket
          +-- auth_code=0
          +-- MAIN_INIT
          +-- CLIENT_LOGIN_INFO
          +-- CLIENT_LOGIN_INFO_RES
          +-- ATTACH_CHANNELS
          +-- MAIN_CHANNELS_LIST
                    |
                    +--> open .../DISPLAY
                    |      common REDQ/ticket auth
                    |      DISPLAY_SETTING
                    |      DISPLAY_INIT
                    |
                    +--> open .../INPUTS
                           common REDQ/ticket auth
                           INPUTS_INIT

MAIN + DISPLAY + INPUTS all reach READY
          -> global Clink CONNECTED
```

## 4. 获取连接信息

### 4.1 实际调用策略

普通云电脑连接时，当前客户端会并行竞争两个接口：

| 启动时机 | 接口 | 用途 |
| --- | --- | --- |
| 立即 | `POST /api/desktop/client/queryConnectData` | 读取可缓存的连接信息 |
| 约 10 ms 后 | `POST /api/desktop/client/connect` | 正常建立连接并获取连接信息 |

第一个成功响应被客户端采用。客户端为缓存接口响应增加本地 `fromCache=true` 标记，该字段不是服务端原始响应字段。

本次两个接口均为 HTTP 200、解密后 `code=0`，响应结构相同。

竞速的精确失败语义来自同版本运行时代码：

1. `queryConnectData` 立即启动；普通连接请求在约 10 ms 后启动。
2. 两个请求互不取消。任一请求先成功，外层 Promise 即采用其结果；另一个请求仍可能继续完成。
3. 缓存请求失败会被吞掉，普通请求仍可继续成功。
4. 普通请求失败会立即拒绝外层 Promise；即使缓存请求稍后成功，也不会恢复这次连接。

普通请求的目标选择规则：

| 条件 | 请求方式 |
| --- | --- |
| 设备提供非空 `connectUrl` | 按下述 `apiPollRequest` 规则使用前两个地址 |
| 否则 `connectMaster === 1` | 调用 `/api/desktop/client/connectMaster` |
| 其他情况 | 调用 `/api/desktop/client/connect`；`backupurl[0]` 存在时作为可选备用 API base |

因此，外部实现若要复现当前页面行为，不能把两个请求简单改成“等待全部完成后择优”，也不能把缓存成功设计为普通请求失败后的兜底恢复。

`connectUrl` 精确轮询规则：

1. 空数组立即抛出“请求地址未定义”。
2. 首次请求设置 `baseURL=connectUrl[0]`，并关闭直连 host 改写。
3. 第一次失败后，仅在存在 `connectUrl[1]` 且错误属于网络/传输错误，或业务错误码为 `BACKUP` 时，重试第二个地址。
4. 第二次设置 `baseURL=connectUrl[1]`、超时 `30 秒`；其结果直接返回或抛出。
5. 第三个及后续数组元素当前不会使用，也没有循环回第一项或过期刷新逻辑。

没有 `connectUrl` 时，普通连接先请求默认 API host；若设备提供 `backupurl[0]`，在首次错误满足同一“网络错误或 `BACKUP` 业务码”条件时，以该 URL、30 秒超时再请求一次。缓存接口不显式传设备 `backupurl[0]`，只允许请求层已有的全局 backup host 参与回退。

### 4.2 请求协议

统一 Origin：

```text
https://desk.ctyun.cn:8810
```

两个接口均使用：

```http
Content-Type: application/x-www-form-urlencoded
```

线上请求体：

```text
eParams=<AES-CBC encrypted logical request JSON>
```

线上响应体：

```json
{
  "edata": "<AES-CBC encrypted logical response JSON>"
}
```

AES 和认证请求头规则见 [账号登录与退出登录接口](./ctyun-account-auth-api.md#3-公共协议)。

### 4.3 逻辑请求字段

| 字段 | 类型 | 当前 Web 客户端来源/值 |
| --- | --- | --- |
| `objId` | string | 当前选中列表对象的 `objId` |
| `objType` | string/number | 当前选中列表对象的 `objType` |
| `osType` | number | 客户端 UA 映射的 OS 枚举，不是远端桌面的 `osType`；映射见下表 |
| `deviceId` | number | `env.getDeviceType()`，Web 固定 `60` |
| `deviceCode` | string | 公共 Web 设备代码，生成规则见账号认证文档 3.1.1 |
| `deviceName` | string | 账号认证文档 3.1.1 的缓存浏览器/设备名称 |
| `sysVersion` | string | UA 第一组圆括号内子串，无法匹配时为 `"0"` |
| `appVersion` | string | 固定 `"4.0.1"` |
| `hostName` | string | 当前代码再次调用 `env.getDeviceName()`，因此与 `deviceName` 完全相同，不是 URL hostname |
| `vdCommand` | string | 固定空字符串 `""` |
| `ipAddress` | string | 固定空字符串 `""` |
| `macAddress` | string | 固定空字符串 `""` |
| `hardwareFeatureCode` | string | 与 `deviceCode` 完全相同 |
| `specifiedCertCategory` | string/number | 固定 `1` |

`osType` 枚举：

| UA 条件 | 值 |
| --- | --- |
| 包含 `Macintosh` | `30` (`MACOS`) |
| 包含 `Windows` | `15` (`WINDOWS`) |
| 包含 `Android` | `20` (`ANDROID`) |
| 包含 `iPhone` 或 `iPad` | `25` (`IOS`) |
| 包含 `Linux` 且包含 `x86` | `11` (`LINUX_X86`) |
| 其他 Linux | `10` (`LINUX`) |
| 都不匹配 | `15` (`WINDOWS`) |

逻辑请求示例：

```json
{
  "objId": "<selected-obj-id>",
  "objType": 0,
  "osType": 15,
  "deviceId": 60,
  "deviceCode": "<web-device-code>",
  "deviceName": "<client-device-name>",
  "sysVersion": "<client-system-version>",
  "appVersion": "4.0.1",
  "hostName": "<client-host-name>",
  "vdCommand": "",
  "ipAddress": "",
  "macAddress": "",
  "hardwareFeatureCode": "<same-as-deviceCode>",
  "specifiedCertCategory": 1
}
```

### 4.4 逻辑响应外层

```ts
interface ConnectResponse {
  code: number;
  data: {
    goingRetry: boolean;
    desktopInfo: DesktopConnectionInfo;
    shadowDesktopInfo: object;
    desktopAnywhereInfo: object;
    desktopId: string;
    pollingKey: unknown | null;
    authInfo: unknown | null;
  };
}
```

与握手直接相关的 `desktopInfo` 字段：

| 字段 | 本次类型 | Clink 配置用途 |
| --- | --- | --- |
| `desktopId` | number | WebSocket 路径和 MAIN 登录信息中的桌面 ID |
| `clinkLvsInHost` | string | Clink 代理候选节点 |
| `clinkLvsInHostBak` | string | 内网代理备用节点 |
| `clinkLvsOutHost` | string | 外网代理候选节点 |
| `clinkLvsOutHostBak` | string | 外网代理备用节点 |
| `internalIp` | string | 代理连接的目标 Clink 主机 |
| `internalPort` | string | 代理连接的目标 Clink 端口 |
| `clientCert` | string | TLS 客户端证书，敏感 |
| `clientKey` | string | TLS 客户端私钥，敏感 |
| `caCert` | string | CA 证书 |
| `token` | string | MAIN 登录 ticket/session 字符串，敏感 |
| `desktopCertCategory` | number | 传给代理的 OQS/证书类别选项 |
| `tenantMemberAccount` | string | MAIN 登录用户账号，敏感 |
| `osType` | string | 远端系统类型 |
| `osName` | string | 远端系统名称 |
| `showStrategy` | string | DISPLAY 初始质量参数来源 |
| `clientStrategy` | object | 连接后的客户端策略，不属于基础握手 |

当前 WebSocket URI 构造不读取四个 `clinkLvs*` 字段。它只使用页面 `server` 查询参数或固定默认 `wss://deskmsgz.ctyun.cn:9011/clinkProxy`；四个字段是响应中的候选元数据，但本版本 Web 建链没有额外选择算法。不要根据字段名自行替换 `getWSHost()` 结果。

客户端据此构造的核心 Clink 配置：

```ts
interface ClinkConfig {
  uri: `wss://${string}/clinkProxy/${string}`;
  servername: string;
  host: string;
  port: string | number;
  cert: string;
  ca: string;
  key: string;
  ssl: true;
  desktopId: string;
  token: string;
  deviceType: number;
  deviceCode: string;
  userAccount: string;
  oqs: number;
}
```

配置字段的精确映射：

| 配置字段 | 来源/规则 |
| --- | --- |
| WebSocket base | 页面 URL 查询参数 `server` 非空时使用该值；否则使用 `wss://deskmsgz.ctyun.cn:9011/clinkProxy` |
| `uri` | 去掉 base 末尾 `/` 后拼接 `/<desktopInfo.desktopId>`；各通道再拼接大写通道名 |
| `servername` | `formatIPv6(desktopInfo.internalIp) + ":" + desktopInfo.internalPort` |
| `host` / `port` | `desktopInfo.internalIp` / `desktopInfo.internalPort` |
| `cert` / `ca` / `key` | `clientCert` / `caCert` / `clientKey` |
| `token` | `desktopInfo.token` |
| `deviceType` | 固定 `99`，枚举名 `REMOTE`；MAIN 登录时转成字符串 `"99"` |
| `deviceCode` | 账号认证文档 3.1.1 的 `web_device_code` |
| `userAccount` | 当前已认证资料中的 `userAccount` |
| `oqs` | `desktopInfo.desktopCertCategory` |

`formatIPv6` 只负责把 IPv6 地址变成可安全拼接端口的形式；IPv4/域名保持原样。URL 查询参数 `server` 是调试/部署覆盖入口，生产页面通常使用默认代理地址。

## 5. WebSocket HTTP Upgrade

三个目标通道分别建立独立 WebSocket：

```text
wss://<clink-proxy>/clinkProxy/<desktop-id>/MAIN
wss://<clink-proxy>/clinkProxy/<desktop-id>/DISPLAY
wss://<clink-proxy>/clinkProxy/<desktop-id>/INPUTS
```

实际 channel path 使用大写名称。

客户端构造方式：

```js
new WebSocket(url, "binary")
websocket.binaryType = "arraybuffer"
```

实际 Upgrade 请求包含：

| 请求头 | 说明 |
| --- | --- |
| `Connection: Upgrade` | WebSocket Upgrade |
| `Upgrade: websocket` | 协议升级 |
| `Sec-WebSocket-Version: 13` | WebSocket 版本 |
| `Sec-WebSocket-Key` | 浏览器随机值 |
| `Sec-WebSocket-Protocol: binary` | Clink 使用的子协议 |
| `Sec-WebSocket-Extensions` | 浏览器提议的扩展 |
| `Origin` | `https://pc.ctyun.cn` 页面来源 |

三个通道实际响应均为：

```http
HTTP/1.1 101 Switching Protocols
Connection: upgrade
Upgrade: websocket
Sec-WebSocket-Protocol: binary
```

本次响应没有返回 WebSocket extension 头。

## 6. 代理层建链

WebSocket 打开后，三个通道的第一条消息都是文本 JSON：

```json
{
  "type": 1,
  "ssl": 1,
  "host": "<internal-clink-host>",
  "port": "<internal-clink-port>",
  "ca": "<ca-cert>",
  "cert": "<client-cert>",
  "key": "<client-private-key>",
  "servername": "<tls-server-name>",
  "oqs": 0
}
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `type` | number | Clink channel type：MAIN `1`、DISPLAY `2`、INPUTS `3` |
| `ssl` | number | 是否让代理使用 TLS；本次为 `1` |
| `host` | string | 代理需要连接的目标 Clink 主机 |
| `port` | string/number | 目标 Clink 端口 |
| `ca` | string | CA 证书 |
| `cert` | string | TLS 客户端证书 |
| `key` | string | TLS 客户端私钥 |
| `servername` | string | TLS SNI/服务端名称 |
| `oqs` | number | OQS/证书类别选项；本次为 `0` |

证书、私钥和内部地址不得写入日志。

代理连接成功后返回一个二进制字节：

```text
01
```

官方客户端只接受首字节 `0x01`。其他值会进入 `proxy server error` 分支，不继续发送 `REDQ`。

## 7. Clink 公共二进制握手

除代理 JSON 外，后续 WebSocket 消息均为 binary frame。整数均为 little-endian。

### 7.1 重要 framing 规则

Clink 将 WebSocket 当作连续字节流：

- 一个 Clink 结构可能跨多个 WebSocket frame。
- 一个 WebSocket frame 也可能包含多个 Clink 结构或消息。
- 不能假设“一帧等于一条 Clink 消息”。

实际样本中，INPUTS 的服务端 `REDQ` 响应被拆为 `194 + 4 + 4` 字节三个 frame；MAIN 的一个 4096 字节 frame 中包含多个消息的开头和数据。

### 7.2 状态机

```text
CONNECTING
  -> WebSocket open
OPEN
  -> proxy JSON
  -> proxy byte 0x01
START
  -> send REDQ header + ClientLink
  -> receive REDQ header
LINK
  -> receive ServerLink
  -> send Ticket
TICKET
  -> receive AuthReply
READY
  -> use 6-byte mini message header
```

bundle 中定义了 15 秒连接超时常量，但当前 Web 实现创建的定时回调为空。复现方不能依赖该定时器主动终止连接，应自行实现有效超时。

### 7.3 `ClinkHeader`

固定 16 字节：

| Offset | 长度 | 类型 | 字段 | 本次值 |
| --- | --- | --- | --- | --- |
| 0 | 4 | ASCII | `magic` | `REDQ` |
| 4 | 4 | uint32 LE | `major_version` | `2` |
| 8 | 4 | uint32 LE | `minor_version` | `2` |
| 12 | 4 | uint32 LE | `size` | 后续 link payload 字节数 |

### 7.4 `ClientLink`

紧跟在客户端 `ClinkHeader` 后：

| 顺序 | 类型 | 字段 |
| --- | --- | --- |
| 1 | uint32 LE | `connection_id` |
| 2 | uint8 | `channel_type` |
| 3 | uint8 | `channel_id` |
| 4 | uint32 LE | `num_common_caps` |
| 5 | uint32 LE | `num_channel_caps` |
| 6 | uint32 LE | `caps_offset`，相对 ClientLink 起点 |
| 7 | uint32 LE[] | common capability words |
| 8 | uint32 LE[] | channel capability words |

本次 `caps_offset` 均为 `18`。

MAIN 使用 `connection_id=0`。DISPLAY 和 INPUTS 使用 MAIN_INIT 返回的 `session_id`，channel id 均为 `0`。

### 7.5 `ServerLink`

服务端 `ClinkHeader` 后的 payload：

| 顺序 | 长度/类型 | 字段 |
| --- | --- | --- |
| 1 | uint32 LE | `error` |
| 2 | 162 bytes | DER RSA public key |
| 3 | uint32 LE | `num_common_caps` |
| 4 | uint32 LE | `num_channel_caps` |
| 5 | uint32 LE | `caps_offset`，相对 ServerLink 起点 |
| 6 | uint32 LE[] | common capability words |
| 7 | uint32 LE[] | channel capability words |

本次三个通道 `error=0`，`caps_offset=178`。

### 7.6 Ticket 与认证响应

客户端使用 ServerLink 中的 RSA 公钥生成 ticket：

```ts
interface Ticket {
  auth_mechanism: uint32LE; // 1 = AUTH_SPICE
  encrypted_data: byte[128];
}
```

Ticket 总长固定 `132` 字节。`encrypted_data` 长度来自 `CLINK_TICKET_KEY_PAIR_LENGTH=1024` bit。

同版本运行时代码给出的 ticket 字节级算法：

1. 把 ServerLink 中 162 字节 DER 公钥解析为 1024-bit RSA 公钥。
2. 待加密明文严格为一个 NUL 字节，即 `String.fromCharCode(0)` 的单字节结果，不是 token、密码或空字符串。
3. 使用 RSAES-OAEP，Hash 为 SHA-1，MGF1 也使用 SHA-1，label 为空。
4. OAEP seed 长度为 20 字节，随机源为 `crypto.getRandomValues`。
5. RSA 运算结果按无符号大端整数补齐为 128 字节，原样写入 `encrypted_data`。
6. Ticket 前 4 字节写 `auth_mechanism=1` 的 uint32 little-endian，随后紧跟 128 字节 RSA 密文。

这里的 RSA-OAEP/SHA-1 与登录密钥协商中的 RSAES-PKCS1-v1_5 是两套不同协议，不能复用同一解密/填充配置。

服务端认证响应：

```ts
interface AuthReply {
  auth_code: uint32LE;
}
```

本次三个通道均返回 `auth_code=0`。

链路错误码：

| 值 | 名称 |
| --- | --- |
| `0` | `OK` |
| `1` | `ERROR` |
| `2` | `INVALID_MAGIC` |
| `3` | `INVALID_DATA` |
| `4` | `VERSION_MISMATCH` |
| `5` | `NEED_SECURED` |
| `6` | `NEED_UNSECURED` |
| `7` | `PERMISSION_DENIED` |
| `8` | `BAD_CONNECTION_ID` |
| `9` | `CHANNEL_NOT_AVAILABLE` |

### 7.7 READY 后的 mini message

客户端声明 common capability bit `MINI_HEADER`，READY 后消息使用 6 字节头：

| Offset | 长度 | 类型 | 字段 |
| --- | --- | --- | --- |
| 0 | 2 | uint16 LE | `type` |
| 2 | 4 | uint32 LE | `size` |
| 6 | `size` | bytes | `data` |

## 8. 三通道实际公共握手数据

| 通道 | type | Client REDQ 总长 | Server REDQ 总长 | Ticket | auth_code |
| --- | --- | --- | --- | --- | --- |
| MAIN | `1` | 42 bytes | 202 bytes | 132 bytes | `0` |
| DISPLAY | `2` | 42 bytes | 206 bytes | 132 bytes | `0` |
| INPUTS | `3` | 38 bytes | 202 bytes | 132 bytes | `0` |

### 8.1 Common capabilities

客户端三个通道均发送：

```text
word = 0x00000009
bits = [0, 3]
```

| bit | capability |
| --- | --- |
| 0 | `PROTOCOL_AUTH_SELECTION` |
| 3 | `MINI_HEADER` |

服务端三个通道均返回：

```text
word = 0x0000001b
bits = [0, 1, 3, 4]
```

当前 bundle 可命名 bit `0`、`1`、`3`；bit `4` 没有对应名称，保持为未知扩展位。

## 9. MAIN 通道

### 9.1 Link capabilities

客户端 MAIN capability word：

```text
0x00000804, bits [2, 11]
```

| bit | capability |
| --- | --- |
| 2 | `AGENT_CONNECTED_TOKENS` |
| 11 | `LOGIN_INFO_EARLY` |

服务端 MAIN 样本 capability word：

```text
0x00017f09, bits [0, 3, 8, 9, 10, 11, 12, 13, 14, 16]
```

当前 bundle 可命名其中：bit `0` `SEMI_SEAMLESS_MIGRATE`、bit `3` `SEAMLESS_MIGRATE`、bit `11` `LOGIN_INFO_EARLY`。其他服务端扩展位不作猜测。

### 9.2 `CLINK_MSG_MAIN_INIT` (`type=103`)

认证成功后，服务端发送 32 字节 MAIN_INIT payload：

| Offset | 类型 | 字段 |
| --- | --- | --- |
| 0 | uint32 LE | `session_id` |
| 4 | uint32 LE | `display_channels_hint` |
| 8 | uint32 LE | `supported_mouse_modes` |
| 12 | uint32 LE | `current_mouse_mode` |
| 16 | uint32 LE | `agent_connected` |
| 20 | uint32 LE | `agent_tokens` |
| 24 | uint32 LE | `multi_media_time` |
| 28 | uint32 LE | `ram_hint` |

本次可公开样本：

```text
display_channels_hint = 1
supported_mouse_modes = 3
current_mouse_mode = 2 (client mode)
agent_connected = 0
agent_tokens = 10
```

`session_id` 是 DISPLAY 和 INPUTS ClientLink 的 `connection_id`，属于会话敏感值。

### 9.3 客户端身份消息

MAIN_INIT 后客户端发送两条身份消息：

1. `CLINK_MSGC_MAIN_CLIENT2SERVER_CUSTOM` (`type=118`)：UTF-8 JSON，包含用户名/用户 ID 等显示元数据。
2. `CLINK_MSGC_MAIN_CLIENT_LOGIN_INFO` (`type=112`)：连接认证信息。

`sendUserName()` 在每次收到 MAIN_INIT 时都会调用，因此 `type=118` 是当前实现的固定步骤，不是可选的 UI 增强。其 mini message payload 为：

| Offset | 类型 | 字段 |
| --- | --- | --- |
| 0 | uint32 LE | UTF-8 JSON 字节数 |
| 4 | uint32 LE | JSON 相对 payload 起点偏移，固定 `8` |
| 8 | bytes | UTF-8 JSON，不要求末尾 NUL |

JSON schema：

```json
{
  "type": 1,
  "userName": "<resolved-user-name>",
  "userInfo": "<resolved-user-info-or-empty-string>",
  "userId": "<resolved-user-id>"
}
```

字段来源和回退顺序：

| 字段 | 来源 |
| --- | --- |
| `type` | number，固定 `1`，即 `CLIENT2SERVER_CUSTOM_JSON_TYPE_CLIENT_USER_NAME` |
| `userName` | `authData.userName`，否则会话 `user_name`，否则调用方 projection 的 `userName` |
| `userInfo` | 调用方 projection 的 `userInfo`，缺失时为空字符串 |
| `userId` | `authData.userId`，否则会话 `userId`，否则调用方 projection 的 `userId` |

当前代码即使回退后得到空值也仍会发送该消息。调用方应在进入 Clink 前准备认证资料，避免远端收到缺少身份元数据的 JSON。

`CLIENT_LOGIN_INFO` payload：

| Offset | 类型 | 字段/值 |
| --- | --- | --- |
| 0 | uint32 LE | `Number(desktopId)` |
| 4 | uint32 LE | `sessionId.length + 1` |
| 8 | uint32 LE | `sessionIdOffset = 36` |
| 12 | uint32 LE | `deviceType.length + 1` |
| 16 | uint32 LE | `deviceTypeOffset = sessionIdOffset + sessionIdLength` |
| 20 | uint32 LE | `deviceCode.length + 1` |
| 24 | uint32 LE | `deviceCodeOffset = deviceTypeOffset + deviceTypeLength` |
| 28 | uint32 LE | `userAccount.length + 1` |
| 32 | uint32 LE | `userAccountOffset = deviceCodeOffset + deviceCodeLength` |
| 36 | bytes | 按顺序写 `sessionId/token`、`deviceType`、`deviceCode`、`userAccount`，每段后 1 个 NUL |

构造函数入参映射：

```text
sessionId  = config.token
deviceType = config.deviceType ? config.deviceType.toString() : ""  // 当前为 "99"
deviceCode = config.deviceCode || ""
userAccount = config.userAccount || ""
```

该结构没有使用 UTF-8 编码器。当前实现按 JavaScript 字符串 `.length` 计算长度，并对每个字符执行 `setUint8(charCodeAt(i))`，即只写 UTF-16 code unit 的低 8 位；分配的新缓冲区默认全零，所以每段预留的最后 1 字节自然成为 NUL。四个长度都包含 NUL，payload 总长：

```text
36
+ (sessionId.length + 1)
+ (deviceType.length + 1)
+ (deviceCode.length + 1)
+ (userAccount.length + 1)
```

因此，若外部实现允许非 ASCII `userAccount`，必须复现当前低 8 位写法，不能擅自改为 UTF-8，否则长度和后续 offset 都会变化。

`sessionId/token`、device code 和账号不得写入日志。

### 9.4 Early login 与通道挂载

服务端 MAIN capability 包含 `LOGIN_INFO_EARLY`，因此实际顺序为：

```text
CLINK_MSG_MAIN_INIT
  <- CLINK_MSGC_MAIN_CLIENT_LOGIN_INFO
CLINK_MSG_MAIN_CLIENT_LOGIN_INFO_RES (type=136, payload 4 bytes, 本次全零)
  <- CLINK_MSGC_MAIN_ATTACH_CHANNELS (type=104, size=0)
CLINK_MSG_MAIN_CHANNELS_LIST (type=104)
```

若服务端不声明 `LOGIN_INFO_EARLY`，当前客户端会在 MAIN_INIT 后直接发送 `ATTACH_CHANNELS`，不等待 `CLIENT_LOGIN_INFO_RES`。

### 9.5 `CLINK_MSG_MAIN_CHANNELS_LIST` (`type=104`)

payload：

| 字段 | 类型 |
| --- | --- |
| `num_of_channels` | uint32 LE |
| `channels[].type` | uint8 |
| `channels[].id` | uint8 |

本次服务端返回 25 个可用通道条目，其中与本文相关的是：

```text
DISPLAY: type=2, id=0
INPUTS:  type=3, id=0
```

客户端收到列表后，以 MAIN_INIT 的 `session_id` 为 connection ID，分别创建 DISPLAY 和 INPUTS WebSocket。

### 9.6 非阻塞消息

客户端还会延迟发送：

```text
CLINK_MSGC_MAIN_GET_CLINK_VERSION (type=116, size=0)
```

服务端本次返回：

```text
CLINK_MSGC_MAIN_GET_CLINK_VERSION_RES (type=122)
```

版本查询不阻塞 DISPLAY/INPUTS 创建，不作为连接成功条件。

## 10. DISPLAY 通道

### 10.1 Link capabilities

客户端 DISPLAY capability word：

```text
0x08884d11
bits [0, 4, 8, 10, 11, 14, 19, 23, 27]
```

| bit | capability |
| --- | --- |
| 0 | `SIZED_STREAM` |
| 4 | `STREAM_REPORT` |
| 8 | `MULTI_CODEC` |
| 10 | `CODEC_VP8` |
| 11 | `CODEC_H264` |
| 14 | `STREAM_MODE` |
| 19 | `SETTING` |
| 23 | `RESUME_PAUSE` |
| 27 | `CODEC_BBENC` |

服务端样本返回两个 capability word：

```text
[0xe88c9052, 0x00000007]
```

其中可由当前 bundle 命名的能力包括 monitors config、stream report、preferred compression/video codec、FPS adjust、setting、resume/pause、BBENC 和 WebRTC mode。未命名扩展位保持原始 bit，不作推断。

### 10.2 `CLINK_MSGC_DISPLAY_SETTING` (`type=108`)

DISPLAY 在 AuthReply 成功后、标记 READY 前发送：

| Offset | 类型 | 字段 |
| --- | --- | --- |
| 0 | uint8 | `display_mode` |
| 1 | uint8 | `image_fps` |
| 2 | uint8 | `image_type` |
| 3 | uint8 | `stream_fps` |
| 4 | uint8 | `stream_quality` |

本次样本：

```text
display_mode=2
image_fps=15
image_type=4 (32-bit)
stream_fps=25
stream_quality=3 (best)
```

这里只记录初始化参数，不展开后续视频/图像数据。

### 10.3 `CLINK_MSGC_DISPLAY_INIT` (`type=101`)

紧接 DISPLAY_SETTING，payload 固定 14 字节：

| Offset | 类型 | 字段 | 本次值 |
| --- | --- | --- | --- |
| 0 | uint8 | `pixmap_cache_id` | `1` |
| 1 | uint64 LE | `pixmap_cache_size` | `10485760` |
| 9 | uint8 | `glz_dictionary_id` | `0` |
| 10 | uint32 LE | `glz_dictionary_window_size` | `0` |

### 10.4 初始 ACK 窗口

服务端随后发送公共消息：

```text
CLINK_MSG_SET_ACK (type=3)
payload: generation:uint32LE, window:uint32LE
```

本次：

```text
generation=1
window=20
```

客户端回复：

```text
CLINK_MSGC_ACK_SYNC (type=1)
payload: generation:uint32LE
```

显示 surface、mark 和后续绘图消息已经属于显示业务数据，不纳入握手文档。

## 11. INPUTS 通道

### 11.1 Link capabilities

客户端 INPUTS 没有发送 channel capability word：

```text
num_channel_caps=0
```

服务端样本返回：

```text
0x00000005, bits [0, 2]
```

当前 bundle 没有给这两个 INPUTS capability bit 提供名称，因此只保留原始值。

### 11.2 `CLINK_MSG_INPUTS_INIT` (`type=101`)

INPUTS AuthReply 成功后进入 READY。服务端随后发送：

```ts
interface InputsInit {
  keyboard_modifiers: uint16LE;
}
```

本次 `keyboard_modifiers=0`。

抓包中还出现了 INPUTS 业务消息，它们不是建立通道所必需的握手消息，因此不在本文展开。

## 12. 连接成功判定

每个通道在以下条件满足后触发自身 `CONNECTED`：

1. WebSocket 已打开。
2. 代理返回 `0x01`。
3. ServerLink `error=0`。
4. AuthReply `auth_code=0`。
5. DISPLAY 已在 AuthReply 后发送 DISPLAY_SETTING 和 DISPLAY_INIT。

MAIN 维护 bitmask：

```text
MAIN    -> 1 << 1
DISPLAY -> 1 << 2
INPUTS  -> 1 << 3
required mask = 0x0e
```

当三个通道都报告 CONNECTED，MAIN 将全局 Clink 状态切换为 `CONNECTED`。该判定不等待第一帧图像、不等待音频通道，也不要求实际键鼠输入。

### 12.1 通道关闭与重连边界

当前 Clink 核心对非 PORT 通道的断开处理：

1. 任一主业务通道报告 `DISCONNECTED` 时，全局状态先变为 `DISCONNECTED` 并发出状态事件。
2. 随后 `stop()` 关闭 DISPLAY、INPUTS、CURSOR、PLAYBACK、DATA、RECORD 和所有 PORT，关闭 MAIN，自身状态改为 `CONNECTFAILED`，清除 agent connected 标志并再次发出失败状态。
3. PORT 子通道单独断开时只移除对应 port 并关闭摄像头等局部资源，不立即停止整条主连接。

Clink 核心本身不自动重建 WebSocket，也不重新调用连接信息接口。需要重连时，上层必须重新执行第 4 节的连接信息获取和竞速，再创建新的 MAIN/DISPLAY/INPUTS 实例；旧 session ID、ticket、token、证书和通道对象不得复用。

本文只定义“首次建链”和“断开后重新从第 4 节开始”的协议边界，不定义业务层重试次数、退避或用户提示策略。

## 13. 实现注意事项

1. 三个通道必须使用独立 WebSocket，URL 末段分别为 `MAIN`、`DISPLAY`、`INPUTS`。
2. WebSocket 子协议必须为 `binary`，并将 `binaryType` 设置为 `arraybuffer`。
3. 第一条消息是文本代理配置；收到单字节 `0x01` 后才能发送 `REDQ`。
4. MAIN ClientLink 的 connection ID 为 `0`；DISPLAY/INPUTS 必须使用 MAIN_INIT 的 session ID。
5. 所有 Clink 整数均为 little-endian。
6. 必须实现跨 WebSocket frame 的缓冲区，按 `ClinkHeader.size` 和 mini message `size` 重新组包。
7. Ticket 固定为 `4 + 128` 字节，auth mechanism 为 `1`。
8. AuthReply 非零时不得进入 READY；`7` 应明确报告 permission denied。
9. MAIN 的 `LOGIN_INFO_EARLY` 能力决定 ATTACH_CHANNELS 是否等待 LOGIN_INFO_RES。
10. DISPLAY 的 setting/init 是 READY 前初始化；INPUTS_INIT 是 READY 后的服务端初始状态。
11. 证书、私钥、token、内部地址、账号、device code 和 session ID 都是敏感数据，不得写日志。
12. 页面出现“组件异常”或建议重启测试机的提示不属于 Clink 握手，不应据此执行重启。
