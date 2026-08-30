# 天翼量子 AI 云电脑与 AI 云手机列表接口

## 1. 文档范围

本文记录 `https://pc.ctyun.cn/#/desktop-list` 页面下列位置的列表加载行为：

- “AI云电脑”标签。
- “AI云手机”标签。
- 标签右侧的刷新按钮。

接口存在性、请求方法、请求头、线上加密报文、解密后的请求与响应字段、状态码和页面动作均来自 2026-08-29 的实际 Edge 浏览器抓包。分类、排序、补拉和回退规则来自同版本线上 JS bundle：

- `https://deskcdn.ctyun.cn/pccdnstatic/js/main.1bcf98.js`
- `https://deskcdn.ctyun.cn/pccdnstatic/js/9987.1bcf98.chunk.js`

本次分析涉及的原始前端资源已归档到 [2026-08-29 bundle 快照](./bundle-snapshots/2026-08-29/README.md)。

本次账号同时存在 1 台 Windows AI 云电脑和 1 台 Android AI 云手机。设备名称、设备 ID、租户和用户标识等敏感值均未写入本文。

## 2. 核心结论

AI 云电脑和 AI 云手机没有两个独立的主列表接口。页面统一调用：

```http
POST https://desk.ctyun.cn:8810/api/desktop/client/pageDesktop
```

该请求一次返回 AI 云电脑和 AI 云手机，页面再按 `cloudMobileType` 在前端分类：

| 页面标签 | 前端分类条件 | 本次样本 |
| --- | --- | --- |
| AI云手机 | `cloudMobileType === "2002"` | Android、`vmType=2`、`prodType="1300"` |
| AI云电脑 | `cloudMobileType !== "2002"` | Windows、`vmType=0`、`prodType="1005"` |

页面动作与网络行为：

| 页面动作 | 是否重新请求 `pageDesktop` | 实际行为 |
| --- | --- | --- |
| 首次进入列表页 | 是 | 拉取全部支持类型并显示默认标签 |
| 点击“AI云电脑” | 否 | 从已加载数组筛选 `cloudMobileType !== "2002"` |
| 点击“AI云手机” | 否 | 从已加载数组筛选 `cloudMobileType === "2002"` |
| 点击刷新按钮 | 是 | 使用相同参数重新请求完整列表 |

点击标签会为当前选中设备触发 `getLinkInfo`、`feature`、`getDesktopExtraInfo` 等详情请求，但这些不是列表接口，不纳入本文。

## 3. 公共协议

该接口是登录态接口，使用与账号登录文档相同的 AES-CBC 报文和认证签名机制，详见 [账号登录与退出登录接口](./ctyun-account-auth-api.md#3-公共协议)。

本次实际请求的主要请求头：

| 请求头 | 本次值或来源 |
| --- | --- |
| `Accept` | `application/json, text/plain, */*` |
| `Content-Type` | `application/json` |
| `CTG-APPMODEL` | `2` |
| `CTG-DEVICECODE` | `localStorage.web_device_code`，生成规则见账号认证文档 3.1.1 |
| `CTG-DEVICETYPE` | `60` |
| `CTG-NEGO-EKEYID` | AES 密钥协商所得 `eid` |
| `CTG-REQDATA-ETYPE` | `2`，AES-CBC |
| `CTG-REQUESTID` | `String(Date.now() + ++requestCounter)` |
| `CTG-SIGNATURESTR` | 账号认证文档 3.1 的七字段拼接 MD5 大写十六进制签名 |
| `CTG-SOFTWARECODE` | `web_client` |
| `CTG-TENANTID` | 登录响应所得租户 ID |
| `CTG-TIMESTAMP` | `String(Date.now() - offsetTime)` |
| `CTG-USERID` | 登录响应所得用户 ID |
| `CTG-VERSION` | `204000100` |

逻辑请求体会整体加密为：

```json
{
  "data": "<AES-CBC-Base64(JSON.stringify(逻辑请求体))>"
}
```

响应线上格式为：

```json
{
  "edata": "<AES-CBC-Base64(逻辑响应 JSON)>"
}
```

HTTP 200 只表示传输成功；解密后仍需检查 `code === 0`。

## 4. 主列表接口

### 4.1 基本信息

```http
POST /api/desktop/client/pageDesktop HTTP/1.1
Host: desk.ctyun.cn:8810
Content-Type: application/json
```

无 URL 查询参数。

本次初始加载和点击刷新均得到：

```text
HTTP 200
业务 code = 0
```

### 4.2 逻辑请求体

本次实际解密结果：

```json
{
  "getCnt": 20,
  "desktopTypes": ["1", "2001", "2002"],
  "sortType": "createTimeV1"
}
```

字段说明：

| 字段 | 类型 | 必填 | 本次值/含义 |
| --- | --- | --- | --- |
| `getCnt` | number | 是 | 首批获取数量，本次固定为 `20` |
| `desktopTypes` | string[] | 是 | 请求的设备类型集合，本次为 `1`、`2001`、`2002` |
| `sortType` | string | 是 | 排序规则，本次为 `createTimeV1` |
| `desktopStateFilter` | string[] | 否 | 页面选择状态筛选后附加；本次未选择筛选，因此请求中不存在 |

bundle 中可确认的设备类型常量：

| 值 | bundle 名称 | 本次用途 |
| --- | --- | --- |
| `"1"` | 本调用处未提供枚举名称 | 本次 `sortList` 中对应 Windows AI 云电脑 |
| `"2001"` | `X86` | 请求集合包含，本次响应没有该类型设备 |
| `"2002"` | `ARM` | 本次 `sortList` 中对应 Android AI 云手机；也是页面手机分类条件 |
| `"2003"` | `HW` | bundle 中存在，但本页面请求未包含 |

### 4.3 逻辑响应外层

```ts
interface PageDesktopResponse {
  code: number;
  data: {
    desktopList: NormalDesktop[];
    desktopPoolList: unknown[];
    preemptionDesktopList: unknown[];
    sortList: SortItem[];
    timestamp: number;
  };
  msg?: string;
}
```

外层字段说明：

| 字段 | 本次类型 | 本次结果/含义 |
| --- | --- | --- |
| `code` | number | `0` |
| `data.desktopList` | array | 普通设备列表；本次包含 1 台云电脑和 1 台云手机 |
| `data.desktopPoolList` | array | 桌面池列表；本次为空，元素结构未由本次抓包验证 |
| `data.preemptionDesktopList` | array | 抢占式桌面列表；本次为空，元素结构未由本次抓包验证 |
| `data.sortList` | array | 跨设备类型的显示顺序和索引 |
| `data.timestamp` | number | 服务端列表时间戳 |

### 4.4 `sortList` 字段

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `objId` | string | 关联 `desktopList`、`desktopPoolList` 或 `preemptionDesktopList` 中的对象 ID |
| `objType` | number | 对象类别：`0` 普通设备、`1` 桌面池、`2` 抢占式桌面 |
| `objValue` | string | 排序相关值；本次具体语义未由页面主流程直接使用 |
| `desktopTypes` | string[] | 设备类型；本次分别观察到 `["1"]` 和 `["2002"]` |

客户端严格按 `sortList` 顺序从对应数组中查找 `objId`，再生成页面最终列表。

## 5. 普通设备字段字典

以下字段全部来自本次 `data.desktopList` 的实际解密结果。类型写为 `null` 的字段表示本次两个样本均为空，不能据此推断服务端非空时的最终类型。

### 5.1 标识与归属

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `objId` | string | 页面和后续接口使用的主对象 ID |
| `objName` | string | 页面显示名称 |
| `objType` | number | 对象类型；两个样本均为 `0`，即普通设备 |
| `desktopId` | string | 桌面内部 ID |
| `desktopCode` | string | 页面展示的设备编码 |
| `desktopName` | string | 服务端桌面名称；客户端在 `objName` 为空时用作回退 |
| `nickName` | string | 昵称 |
| `foreignDesktopId` | string | 外部/底层桌面 ID；客户端派生为 `uuid` |
| `prodInstId` | string | 产品实例 ID |
| `tenantId` | number | 租户 ID |
| `tenantCode` | string | 租户编码 |
| `tanentCode` | string | 服务端同时返回的历史拼写字段 |
| `tanentName` | string | 服务端历史拼写的租户名称字段 |
| `userDesktopGroupId` | null | 用户桌面组 ID；本次为空 |
| `regionId` | number | 区域 ID |
| `resPoolId` | null | 资源池 ID；本次为空 |

### 5.2 产品与设备分类

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `cloudMobileType` | string/null | 页面主分类字段；`"2002"` 为 AI 云手机，其他值或空值归入 AI 云电脑 |
| `vmType` | number | VM 类型；本次云电脑为 `0`，云手机为 `2` |
| `prodType` | string | 产品类型；本次云电脑为 `"1005"`，云手机为 `"1300"` |
| `prodSubType` | null | 产品子类型；本次为空 |
| `prodGroupType` | number | 产品组类型；两个样本均为 `10` |
| `prodGroupName` | string | 产品组名称 |
| `desktopBusiTagTypes` | null | 桌面业务标签类型；本次为空 |
| `desktopMirrorTagSet` | string[] | 镜像/业务标签集合 |
| `haProdType` | number | 高可用产品类型码 |
| `payType` | string | 付费类型 |
| `userMode` | number | 用户模式；客户端据此判断是否为并发模式 |
| `defaultDesktop` | boolean | 是否默认桌面 |

### 5.3 操作系统与规格

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `osName` | string | 操作系统名称；本次为 Windows 或 Android |
| `osType` | string | 操作系统类型；本次为 Windows 或 Android |
| `osBit` | string | 操作系统位数 |
| `imageId` | number | 镜像 ID |
| `imageName` | string | 镜像名称 |
| `imageCategoryId` | number | 镜像分类 ID |
| `cpuCore` | null | CPU 核数；本次主列表响应为空 |
| `memoryGB` | null | 内存 GB；本次主列表响应为空 |
| `rootDiskGB` | null | 系统盘 GB；本次主列表响应为空 |
| `dataDiskGB` | null | 数据盘 GB；本次主列表响应为空 |
| `flavorName` | null | 规格名称；本次主列表响应为空 |
| `gpuType` | boolean | 是否为 GPU 设备；客户端派生为 `isGPU` |
| `gpuVirtualMethod` | null | GPU 虚拟化方式；本次为空 |
| `upperResolution` | null | 分辨率上限；本次为空 |
| `usePrivateImageFile` | boolean | 是否使用私有镜像文件 |

### 5.4 运行状态

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `status` | string | 服务端通用状态；两个样本均为 `OK` |
| `instStatus` | number | 实例状态码 |
| `useStatus` | string | 页面运行状态码；本次 `25` 显示“运行中”，`45` 显示“已关机” |
| `useStatusText` | string | 服务端状态文案 |
| `useStatusColor` | string | 状态显示颜色 |
| `useStatusShowActions` | null | 当前状态可显示操作集合；本次为空 |
| `needLineUp` | boolean | 连接前是否需要排队/等待 |
| `forbiddenConnect` | boolean | 是否禁止连接；客户端派生为 `isForbidden` |
| `projectionScreenState` | null | 投屏状态；本次为空 |
| `summary` | null | 状态摘要；本次为空 |

### 5.5 连接信息与能力

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `backupurl` | string[] | 备用 API 地址列表；客户端过滤掉纯 IP 后保存为设备备用域名 |
| `connectUrl` | array | 可轮询的连接地址；本次为空数组 |
| `connectApiUrl` | object | 连接、状态查询路径集合，见下表 |
| `connectMaster` | number | 是否/如何使用主连接节点的数值标志 |
| `connectType` | number | 连接类型码 |
| `ctrlTypes` | array | 支持的控制类型；本次为空数组 |
| `operationAuditSupported` | boolean | 是否支持操作审计 |

`connectApiUrl`：

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `appendData` | null | 附加连接数据；本次为空 |
| `connectPath` | string | 建立连接的 API 路径 |
| `statePath` | string | 状态查询 API 路径 |
| `statusPath` | string | 运行状态 API 路径 |

### 5.6 时间、到期与许可

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `createDate` | number | 创建时间 |
| `lastOnlineTime` | number | 最近在线时间 |
| `expireDate` | null | 设备到期时间；本次为空 |
| `nowDate` | null | 服务端当前时间字段；本次为空 |
| `allowConnStartTime` | null | 允许连接开始时间；本次为空 |
| `allowConnEndTime` | null | 允许连接结束时间；本次为空 |
| `licenseId` | number | 许可 ID |
| `licenseExpireDate` | number | 许可到期时间 |
| `licenseNoticeInterval` | number | 许可到期提醒间隔 |
| `bandExpireDate` | null | 带宽到期时间；本次为空 |
| `bandNoticeInterval` | number | 带宽到期提醒间隔 |
| `noticeInterval` | number | 通用提醒间隔 |
| `useTimeVO` | null | 使用时长数据；本次为空 |

### 5.7 策略与订单数据

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `modifyComputerAllas` | null | 顶层别名修改能力/值；本次为空 |
| `strategy` | object | 设备控制策略，见下表 |
| `orderProductData` | object | 订购和时长信息，见下表 |

`strategy`：

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `checkBeforeConnect` | null | 连接前检查策略；本次为空 |
| `modifyComputerAllas` | string | 是否/如何允许修改设备别名；客户端会保留该值 |
| `rebootMsg` | null | 重启提示；本次为空 |
| `rebootStrategy` | null | 重启策略；本次为空 |
| `reconnectMsg` | null | 重连提示；本次为空 |
| `reserveTime` | null | 预约时间；本次为空 |
| `shutdownStrategy` | null | 关机策略；本次为空 |
| `shutoffMsg` | null | 关机提示；本次为空 |

`orderProductData`：

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `activeDate` | null | 产品激活时间；本次为空 |
| `busiChannelType` | null | 业务渠道类型；本次为空 |
| `keepTime` | null | 保持/有效时长；本次为空 |
| `manageData` | null | 管理数据；本次为空 |
| `nextAcctTime` | null | 下次计费时间；本次为空 |
| `timeLimitTotal` | null | 总可用时长；本次为空 |
| `timeLimitUsed` | null | 已使用时长；本次为空 |

### 5.8 桌面池与抢占式对象的最小契约

本次账号没有非空 `desktopPoolList` 或 `preemptionDesktopList`，因此不能给出其全部服务端字段字典；以下是同版本运行时代码实际读取并生成的最小可渲染契约。

桌面池原始对象至少需要：

```ts
interface DesktopPoolItem {
  objId: string;
  objType: 1;
  objName?: string;
  poolId: string | number;
  poolName?: string;
  matchMode: number;
  expireDate?: number | null;
  noticeInterval?: number | null;
  bandExpireDate?: number | null;
  bandNoticeInterval?: number | null;
  backupurl?: string[];
  [other: string]: unknown;
}
```

客户端保留除 `poolId`、`poolName`、`matchMode` 外的其他原始字段，并覆盖/增加：

| 字段 | 生成规则 |
| --- | --- |
| `id` | `` `${objType}-${objId}` `` |
| `desktopId` | 空字符串 |
| `defaultDesktop` | `false` |
| `uuid` | `` `pool-${poolId}` `` |
| `desktopCode` | `poolId` |
| `isPool` | `true` |
| `isForbidden` | `false` |
| `mode` | `matchMode` |
| `desktopState` / `bandState` / `isExpired` | 使用普通设备相同的到期计算函数 |

抢占式对象最少读取 `objId`、`objType=2`，其他原始字段全部透传，再覆盖/增加：

| 字段 | 生成规则 |
| --- | --- |
| `id` | `` `${objType}-${objId}` `` |
| `desktopId` | 空字符串 |
| `defaultDesktop` | `false` |
| `uuid` / `desktopCode` | `` `preemption-${objId}` `` |
| `isPool` / `isExpired` / `isForbidden` | `false` |
| `isPreemption` | `true` |
| `desktopState` / `bandState` | 固定正常状态枚举 |
| `mode` | 固定私有模式枚举 |

页面可以用上述归一化字段完成排序、key、基础名称/状态展示；未实测的产品规格字段必须保持可选和 null-safe，不应为其编造默认业务值。

## 6. 页面分类与样本验证

本次同一响应中两类普通设备的非敏感分类字段如下：

| 页面类型 | `desktopTypes` | `cloudMobileType` | `osType` | `vmType` | `prodType` | `useStatus` | 页面状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AI云电脑 | `["1"]` | null | `Windows` | `0` | `"1005"` | `"25"` | 运行中 |
| AI云手机 | `["2002"]` | `"2002"` | `Android` | `2` | `"1300"` | `"45"` | 已关机 |

页面代码的实际分类条件只有 `cloudMobileType === "2002"`，不是按 `osType`、`prodType` 或 `vmType` 分类。后面三个字段只能作为交叉验证信号。

## 7. 客户端组装规则

### 7.1 排序与对象类型

客户端遍历 `sortList`，按 `objType` 选择数据源：

| `objType` | bundle 名称 | 数据源 |
| --- | --- | --- |
| `0` | `NORMAL` | `desktopList` |
| `1` | `POOL` | `desktopPoolList` |
| `2` | `Preemption` | `preemptionDesktopList` |

普通设备按 `objId` 匹配；如果 `objId` 为空则回退使用 `desktopId`。

### 7.2 客户端派生字段

以下字段是前端在收到响应后生成的，不是 `pageDesktop` 原始响应字段：

| 派生字段 | 生成方式 |
| --- | --- |
| `id` | `objId` |
| `uuid` | `foreignDesktopId` |
| `isGPU` | `Boolean(gpuType)` |
| `isConcurrent` | `userMode` 是否等于并发模式枚举 |
| `isForbidden` | `forbiddenConnect === true` |
| `desktopState` | 根据设备到期时间计算 |
| `bandState` | 根据带宽到期时间计算 |
| `isExpired` | `desktopState` 是否为到期状态 |

### 7.3 超过首批数量时的补拉

本次只有 2 台设备，未触发补拉。以下完整算法来自同版本线上运行时代码：

1. 仅当 `sortList.length > getCnt` 时进入补拉。
2. 遍历原始 `sortList`，只选择 `objType=0` 且尚未出现在 `desktopList` 的普通设备项。
3. 保留完整 `SortItem`，按每批 30 项调用补拉接口。
4. 每个成功批次返回的 `desktopList`、`desktopPoolList` 和 `preemptionDesktopList` 分别追加到主响应同名数组。
5. 所有批次结束后，仍严格按最初的 `sortList` 重新组装最终列表，不能按批次返回顺序直接拼接 UI。

```http
POST /api/desktop/client/listDesktopByIds
```

逻辑请求体：

```json
{
  "objIds": [
    {
      "objId": "<id>",
      "objType": 0,
      "objValue": "<value>",
      "desktopTypes": ["<type>"]
    }
  ]
}
```

运行时代码按与主列表相同的集合名称消费响应：

```ts
interface ListDesktopByIdsResponse {
  code: number;
  data: {
    desktopList: NormalDesktop[];
    desktopPoolList: unknown[];
    preemptionDesktopList: unknown[];
    sortList: SortItem[];
  };
}
```

其中补拉响应自身的 `sortList` 不替换初始 `sortList`。如果某一个 30 项批次失败，当前客户端只记录错误并继续其他批次；最终组装时，仍缺失的 `objId` 会被跳过，因此页面可得到“部分列表成功”，而不是整次请求失败。

该接口没有在本次账号的实际抓包中触发；端点、请求、集合合并和失败语义均为同版本运行时代码证据，元素字段沿用主列表模型。

### 7.4 主接口失败回退

同版本运行时代码显示，如果 `pageDesktop` 请求抛出异常或被 API 层拒绝，客户端会回退调用旧接口：

```http
GET /api/desktop/client/list
```

该 GET 不发送逻辑请求体。客户端按与主响应相同的四个集合消费其 `data`：

```ts
interface LegacyListResponse {
  code: number;
  data: {
    desktopList: NormalDesktop[];
    desktopPoolList: unknown[];
    preemptionDesktopList: unknown[];
    sortList: SortItem[];
  };
}
```

回退成功后继续执行 7.1 的 `sortList` 组装规则；若回退结果同样需要补足普通设备，则继续执行 7.3 的 30 项分批补拉。`pageDesktop` 的失败结果不会与 `/list` 合并。

本次 `pageDesktop` 成功，没有触发该回退接口。端点、响应消费和控制流为同版本运行时代码证据，不能视为本次账号的实际响应样本。

## 8. 实现注意事项

1. AI 云电脑和 AI 云手机应共用一次 `pageDesktop` 请求，不要为两个标签各请求一次。
2. 手机分类必须复现页面规则：`cloudMobileType === "2002"`。
3. 刷新按钮重新拉取全部设备，而不是只刷新当前标签。
4. 响应最终顺序以 `sortList` 为准，不能直接使用 `desktopList` 的数组顺序。
5. `getCnt=20` 不是总设备数上限；设备较多时还存在 `listDesktopByIds` 补拉。
6. 补拉批次失败不会使已取得的设备失效；调用方必须允许缺项并按原 `sortList` 跳过未解析对象。
7. 主接口失败时再调用 `/list`，不要同时请求两个列表接口；该回退与连接信息接口的竞速逻辑不同。
8. `status="OK"` 不是开关机状态；页面运行状态应使用 `useStatus`/`useStatusText`。
9. `objId`、`desktopId`、`desktopCode`、`foreignDesktopId`、`prodInstId`、租户字段和备用连接地址均应按敏感数据处理，不得写入公开日志。
10. 本文只记录列表及其前端分类行为，不包含设备详情、连接、开机、关机、重启或快捷应用接口。
