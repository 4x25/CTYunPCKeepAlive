# 天翼量子 AI 云电脑积分中心查询接口

## 1. 文档范围

本文记录 `https://pc.ctyun.cn/` 内置浏览器中“积分中心”嵌入页的只读查询接口，覆盖：

1. 当前用户摘要。
2. 通用积分与云智手机通用积分余额。
3. 积分明细及分页信息。
4. 平台任务、任务进度和完成状态。
5. “积分规则”的实际数据来源。

不包含兑换奖励的商品目录、兑换限制、下单、领取或兑换接口，也不包含页面行为埋点接口。

实现目标限定为运行在官方 PC 宿主、可调用 `window.jsBridge` 的嵌入页。脱离宿主的独立浏览器页面不是本次抓包场景，也不属于本文可独立实现范围；其另一套 `CTG-SIGNATURE` 仅用于说明不要混用。

接口存在性、HTTP 方法、URL、请求头、请求参数、响应字段和页面状态映射来自 2026-08-29 至 2026-08-30 的实际内置浏览器抓包与可见页面语义；其中 2026-08-30 00:00 后补抓了新日周期的 `getTaskList`。未观察到的枚举值和非空结构不作猜测。

本次账号的手机号、积分余额、积分明细总数、用户 ID、租户 ID、任务实例 ID、明细 ID 和其他业务标识均未写入本文。

## 2. 页面与接口覆盖

积分中心嵌入页：

```text
https://desk.ctyun.cn/selforder/points.html?deviceType=60
```

业务接口统一 Origin：

```text
https://desk.ctyun.cn
```

| 页面区域/动作 | 接口 | 方法 | 本次结果 |
| --- | --- | --- | --- |
| 打开积分中心 | `/selforder/api/auth/client/getUserInfo` | GET | HTTP 200，`code=0` |
| 打开积分中心 | `/selforder/api/marketing/userPoints/getUserPoints` | GET | HTTP 200，`code=0` |
| 打开积分中心 | `/selforder/api/marketing/userPoints/getTaskList` | GET | HTTP 200，`code=0` |
| 点击“积分明细” | `/selforder/api/marketing/userPoints/getPointDetailList` | GET | HTTP 200，`code=0` |
| 点击“积分规则” | 无业务接口 | - | 仅加载静态 SVG 规则图片 |

核心结论：

- 通用积分余额由 `getUserPoints` 返回。
- 平台任务定义、进度和完成状态由同一个 `getTaskList` 返回，没有独立的“任务完成状态”接口。
- 积分明细由 `getPointDetailList` 分页返回，首屏请求 `pageNum=1&pageSize=10`。
- “积分规则”不是接口数据，而是静态图片资源。

## 3. 公共协议

### 3.1 响应格式

这些积分中心接口直接返回普通 JSON，没有账号登录接口中的 AES `edata` 包装：

```ts
interface ApiEnvelope<T> {
  code: number;
  data: T;
  msg?: string;
}
```

本次四个查询接口均为：

```text
HTTP 200
code = 0
```

HTTP 200 仅表示传输成功，调用方仍应检查 `code === 0`。本次成功响应未观察到 `msg`。

### 3.2 公共请求头

四个查询接口实际携带同一组认证和客户端上下文请求头：

| 请求头 | 本次值/来源 | 说明 |
| --- | --- | --- |
| `Accept` | `application/json, text/plain, */*` | 响应类型 |
| `CTG-APPCHANNEL` | `1` | 应用渠道 |
| `CTG-APPMODEL` | `2` | 应用模式 |
| `CTG-AUTHENTICATE` | `1` | 当前账号已完成实名认证；该值表示实名状态，不是登录 token |
| `CTG-DEVICE-MANU` | bridge 返回值 | PC 宿主页识别的设备厂商信息 |
| `CTG-DEVICE-MODEL` | bridge 返回值 | PC 宿主页识别的设备型号信息 |
| `CTG-DEVICECODE` | bridge 返回值 | 当前 Web 设备标识 |
| `CTG-DEVICETYPE` | `60` | Web 客户端设备类型 |
| `CTG-REQUESTID` | bridge 返回值 | PC 宿主页生成的请求 ID |
| `CTG-SIGNATURESTR` | bridge 返回值 | 32 位大写十六进制签名 |
| `CTG-SOFTWARECODE` | `web_client` | 软件代码 |
| `CTG-TENANTID` | bridge 返回值 | 登录态租户 ID |
| `CTG-TIMESTAMP` | bridge 返回值 | 服务端时间校正后的毫秒时间戳 |
| `CTG-USERID` | bridge 返回值 | 登录态用户 ID |
| `CTG-VERSION` | `204000100` | 客户端版本码 |
| `From` | `App-web` | 调用来源 |
| `x-lang` | `zh-CN` | 语言 |

上述认证值应由已登录的官方客户端会话生成。不要记录或输出 `CTG-SIGNATURESTR`、用户/租户 ID、设备标识等实际值。

#### 3.2.1 嵌入页认证头来源

当前积分中心运行在 PC 页面弹出的嵌入页中。积分前端不自行重算 `CTG-SIGNATURESTR`，而是调用：

```js
window.jsBridge.getPublicParams()
```

该调用不是同步返回值，而是 callback RPC。积分 bundle 的 Promise 包装契约：

```ts
window.jsBridge.getPublicParams({
  success: resolve,
  fail: reject,
  complete: resolve,
});
```

| 情况 | 当前前端处理 |
| --- | --- |
| `window.jsBridge.getPublicParams` 不存在 | Promise reject，消息为“调用失败，无getPublicParams方法” |
| `success(res)` | resolve `res` |
| `fail(err)` | reject `err` |
| `complete(res)` | 也会尝试 resolve；Promise 已 settle 时无二次影响 |
| 普通 PC WebView | 取 `res.data` 作为请求头对象 |
| UA 含 `bgzs` | 直接取 `res` 作为请求头对象 |

随后对头对象执行 `Object.keys(data)`，把每一个键值原样写入 axios `config.headers`。`CTG-REQUESTID`、`CTG-TIMESTAMP`、用户/租户 ID、设备信息和签名实际由已登录的 PC 宿主页生成，生成规则见 [账号登录与退出登录接口](./ctyun-account-auth-api.md#3-公共协议)。积分页面只额外设置 `Cache-Control: no-cache`、`Pragma: no-cache`、`Content-Type: application/json`、`From: App-web` 和 `x-lang` 等基础头。

bridge 调用异常会被请求拦截器捕获并退化为空 config，正常嵌入请求因而不能依赖无 bridge 继续工作。独立前端若不在官方 PC 宿主中，必须实现同名 callback bridge 或选择下述独立 Web 签名分支；本文四个实际抓包均属于官方 bridge 模式。

同一积分 bundle 还包含“独立 Web 打开”分支，该分支生成另一套 SHA-256 `CTG-SIGNATURE`。本次实际弹窗走的是 bridge 嵌入模式，请勿把独立 Web 的 `CTG-SIGNATURE` 与当前抓包中的 MD5 `CTG-SIGNATURESTR` 混用。

积分代码只读取 bridge 返回的 `CTG-AUTHENTICATE == 1` 判断实名，不从 PC 登录响应的 `realNameStatus` 自行换算。两者的服务端映射关系未由本次抓包验证，嵌入页应把 bridge 值视为事实来源。

## 4. 获取当前用户摘要

### 4.1 请求

```http
GET /selforder/api/auth/client/getUserInfo HTTP/1.1
Host: desk.ctyun.cn
```

无查询参数、无请求体。

### 4.2 响应字段

```ts
interface PointsUserInfo {
  userId: number;
  userAccount: string;
  userName: string;
  desensitizeUserName: string;
  mobilephone: string;
  canBindMobilephone: boolean;
  timestampMillSecond: number;
}
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `userId` | number | 用户 ID |
| `userAccount` | string | 登录账号 |
| `userName` | string | 用户名称 |
| `desensitizeUserName` | string | 脱敏用户名/显示名 |
| `mobilephone` | string | 手机号；页面使用脱敏形式显示 |
| `canBindMobilephone` | boolean | 当前账号是否允许绑定手机号 |
| `timestampMillSecond` | number | 服务端毫秒时间戳 |

该接口用于积分中心顶部用户摘要。它不返回积分余额或任务状态。

## 5. 获取积分余额

### 5.1 请求

```http
GET /selforder/api/marketing/userPoints/getUserPoints HTTP/1.1
Host: desk.ctyun.cn
```

无查询参数、无请求体。

### 5.2 响应字段

`data` 是积分账户数组：

```ts
interface UserPointsItem {
  pointType: number;
  pointTypeName: string;
  points: number;
  pretakePoints: number;
  willOutDate: unknown | null;
  outDateTime: unknown | null;
  exchangeUrl: string | null;
}
```

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `pointType` | number | 积分类型码 |
| `pointTypeName` | string | 积分类型名称 |
| `points` | number | 当前积分余额 |
| `pretakePoints` | number | 预占积分字段；本次两个账户均为 `0` |
| `willOutDate` | null | 待过期积分相关字段；本次为空，非空结构未验证 |
| `outDateTime` | null | 积分过期时间字段；本次为空，非空结构未验证 |
| `exchangeUrl` | null | 页面返回的跳转地址字段；本次为空，不属于本文兑换范围 |

本次实际观察到两个积分类型：

| `pointType` | `pointTypeName` | 页面位置 |
| --- | --- | --- |
| `1` | `通用积分` | “通用积分”余额 |
| `500` | `云智手机通用积分` | “云智手机通用积分”余额 |

数组顺序不能作为类型依据，调用方应按 `pointType` 或 `pointTypeName` 匹配。

页面会先按 `pointType` 对返回项分组，再计算各类型当前余额。带非空 `willOutDate` 的条目属于待过期展示数据，不计入当前总额；当前余额只汇总同组中 `willOutDate` 为空的 `points`。因此不能简单取同一 `pointType` 的第一项，也不能把待过期条目重复相加。

## 6. 获取积分明细

### 6.1 请求

```http
GET /selforder/api/marketing/userPoints/getPointDetailList?pageNum=1&pageSize=10 HTTP/1.1
Host: desk.ctyun.cn
```

查询参数：

| 参数 | 类型 | 必填 | 本次值/含义 |
| --- | --- | --- | --- |
| `pageNum` | number | 是 | 页码，从 `1` 开始；本次抓到首屏 `1` |
| `pageSize` | number | 是 | 每页条数；本次为 `10` |

页面使用无限滚动样式展示明细。本次正常 UI 抓包确认了首屏请求和完整分页响应，没有通过隐藏请求重放后续页。

前端无限滚动算法来自同版本积分运行时代码：

1. 初始化 `pageNum=1`、`pageSize=10`。
2. 每次成功后把响应 `list` 追加到已有明细，不替换前页数据。
3. 以响应 `isLastPage` 设置 `noMore`。
4. 每次成功后无条件执行 `pageNum += 1`；`noMore=true` 时不再触发下一次请求。

失败请求不追加列表，也不应推进页码。

### 6.2 分页响应字段

```ts
interface PointDetailPage {
  pageNum: number;
  pageSize: number;
  size: number;
  startRow: number;
  endRow: number;
  total: number;
  pages: number;
  list: PointDetailItem[];
  prePage: number;
  nextPage: number;
  isFirstPage: boolean;
  isLastPage: boolean;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  navigatePages: number;
  navigatepageNums: number[];
  navigateFirstPage: number;
  navigateLastPage: number;
  firstPage: number;
  lastPage: number;
}
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `pageNum` | number | 当前页码 |
| `pageSize` | number | 请求的每页条数 |
| `size` | number | 当前页实际条数 |
| `startRow` | number | 当前页起始行号 |
| `endRow` | number | 当前页结束行号 |
| `total` | number | 总明细数 |
| `pages` | number | 总页数 |
| `list` | array | 当前页明细数组 |
| `prePage` | number | 上一页页码 |
| `nextPage` | number | 下一页页码 |
| `isFirstPage` | boolean | 是否第一页 |
| `isLastPage` | boolean | 是否最后一页 |
| `hasPreviousPage` | boolean | 是否存在上一页 |
| `hasNextPage` | boolean | 是否存在下一页 |
| `navigatePages` | number | 导航页码数量配置 |
| `navigatepageNums` | number[] | 导航页码数组 |
| `navigateFirstPage` | number | 导航区第一页 |
| `navigateLastPage` | number | 导航区最后一页 |
| `firstPage` | number | 第一页页码 |
| `lastPage` | number | 最后一页页码 |

### 6.3 明细项字段

```ts
interface PointDetailItem {
  logId: number;
  msgType: number;
  foreignType: number;
  foreignId: string;
  tenantId: number;
  userId: number;
  points: string;
  relObjType: number | null;
  relObjId: string | null;
  relUsePoints: string | null;
  remark: string;
  createDate: number;
  updateDate: number;
  pointsList: PointValue[];
}
```

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `logId` | number | 积分明细日志 ID |
| `msgType` | number | 积分变动方向/消息类型码 |
| `foreignType` | number | 外部业务类型码 |
| `foreignId` | string | 外部业务记录 ID |
| `tenantId` | number | 租户 ID |
| `userId` | number | 用户 ID |
| `points` | string | JSON 字符串，按积分类型记录变动绝对值，例如 `{"1":100}` |
| `relObjType` | number/null | 关联对象类型；收入样本为空，支出样本非空 |
| `relObjId` | string/null | 关联对象 ID；收入样本为空，支出样本非空 |
| `relUsePoints` | string/null | 关联业务使用积分字段；收入样本为空，支出样本非空 |
| `remark` | string | 页面“详情说明”文案 |
| `createDate` | number | 13 位毫秒时间戳，页面作为明细时间显示 |
| `updateDate` | number | 13 位毫秒更新时间戳 |
| `pointsList` | array | 已结构化的积分类型和变动值 |

页面的完整符号规则来自同版本运行时代码：`msgType === 1` 显示 `+`，其他所有值显示 `-`。本次可确认的样本：

| `msgType` | `foreignType` | 页面符号 | 已观察场景 |
| --- | --- | --- | --- |
| `1` | `1` | `+` | 登录、使用时长、AI 对话等任务积分收入 |
| `2` | `2` | `-` | 历史积分支出明细 |

`points` 和 `pointsList[].value` 在支出样本中仍是正数绝对值，页面的正负号由交易类型决定，不能仅根据数值正负判断收入或支出。

### 6.4 `pointsList` 字段

```ts
interface PointValue {
  type: number;
  typeDesc: string;
  value: number;
}
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `type` | number | 积分类型码；本次明细为 `1` |
| `typeDesc` | string | 积分类型名称；本次为 `通用积分` |
| `value` | number | 本次变动的积分绝对值 |

## 7. 获取平台任务和完成状态

### 7.1 请求

```http
GET /selforder/api/marketing/userPoints/getTaskList HTTP/1.1
Host: desk.ctyun.cn
```

无查询参数、无请求体。

### 7.2 响应字段

`data` 是当前用户的平台任务实例数组：

```ts
interface PointsTaskItem {
  taskInstId: number | null;
  taskDefId: number;
  taskDefName: string;
  taskGroup: unknown | null;
  taskCalendarType: number;
  eventType: number;
  taskDesc: string;
  taskSort: number;
  tenantId: number | null;
  userId: number;
  points: string;
  totalProgress: number;
  currentProgress: number;
  receiveStartProgress: unknown | null;
  isDisplayProgress: unknown | null;
  receiveProgressUnit: unknown | null;
  sourceObjType: unknown | null;
  sourceObjId: unknown | null;
  status: number;
  remark: unknown | null;
  expireDate: number;
  receiveDate: number | null;
  createDate: number | null;
  updateDate: number;
  pointsList: PointValue[];
  receiveProgressMap: unknown | null;
  canReceive: unknown | null;
  isSatisfiedCondition: unknown | null;
}
```

| 字段 | 本次类型 | 含义 |
| --- | --- | --- |
| `taskInstId` | number/null | 用户任务实例 ID；任务尚未在本周期产生实例时可为 `null` |
| `taskDefId` | number | 任务定义 ID |
| `taskDefName` | string | 任务名称 |
| `taskGroup` | null/unknown | 任务分组；最新样本均为空，非空结构未验证 |
| `taskCalendarType` | number | 任务周期类型码，完整枚举见下表；本次三个每日任务均为 `5` |
| `eventType` | number | 任务事件类型码，见下表 |
| `taskDesc` | string | 任务说明 |
| `taskSort` | number | 页面排序值 |
| `tenantId` | number/null | 租户 ID；未产生任务实例的任务项可为 `null` |
| `userId` | number | 用户 ID |
| `points` | string | 奖励积分 JSON 字符串，例如 `{"1":100}` |
| `totalProgress` | number | 完成目标；单位由任务决定 |
| `currentProgress` | number | 当前进度；单位由任务决定 |
| `receiveStartProgress` | null/unknown | 领取起始进度字段；最新样本为空 |
| `isDisplayProgress` | null/unknown | 是否显示进度字段；最新样本为空 |
| `receiveProgressUnit` | null/unknown | 进度单位字段；最新样本为空 |
| `sourceObjType` | null/unknown | 来源对象类型；最新样本为空 |
| `sourceObjId` | null/unknown | 来源对象 ID；最新样本为空 |
| `status` | number | 任务状态码，完整枚举见下表；最新样本观察到 `0`、`2` |
| `remark` | null/unknown | 备注；最新样本为空 |
| `expireDate` | number | 13 位毫秒到期时间戳 |
| `receiveDate` | number/null | 13 位毫秒获得/领取时间戳；未完成任务可为 `null` |
| `createDate` | number/null | 13 位毫秒创建时间戳；未完成任务可为 `null` |
| `updateDate` | number | 13 位毫秒更新时间戳 |
| `pointsList` | array | 结构化奖励积分列表 |
| `receiveProgressMap` | null/unknown | 领取进度映射；最新样本为空 |
| `canReceive` | null/unknown | 是否可领取字段；最新样本为空 |
| `isSatisfiedCondition` | null/unknown | 是否满足条件字段；最新样本为空 |

任务状态枚举来自当前积分运行时代码，且最新抓包实际观察到 `TODO` 和 `DONE`：

| `status` | 枚举名 | 默认状态文案 | 当前页面呈现 |
| --- | --- | --- | --- |
| `0` | `TODO` | 未完成 | 卡片显示“去完成” |
| `1` | `UNCLAIMED` | 待领取 | 待领取；领取/兑换动作不属于本文 |
| `2` | `DONE` | 已领取 | 当前任务卡渲染为“已获得” |
| `3` | `EXPR` | 已失效 | 已失效 |

任务周期枚举：

| `taskCalendarType` | 含义 |
| --- | --- |
| `0` | 永久任务 |
| `1` | 年度任务 |
| `2` | 月度任务 |
| `3` | 每周任务 |
| `5` | 每日任务 |

`receiveStartProgress`、`isDisplayProgress`、`receiveProgressUnit`、`receiveProgressMap`、`canReceive` 和 `isSatisfiedCondition` 在本次样本均为空，运行时代码也没有给出可验证的统一非空 schema。只读前端应对这些字段做 null-safe 透传，并以 `status`、`currentProgress`、`totalProgress` 为稳定展示依据；不要据字段名猜测领取请求。

### 7.3 本次任务定义与进度

| `eventType` | 任务 | `totalProgress` | 本次完成条件验证 | 奖励 |
| --- | --- | --- | --- | --- |
| `1` | 登录AI云电脑 | `1` | `currentProgress=1` | 100 通用积分 |
| `2` | 使用1小时 | `3600` | `currentProgress=3600`，单位为秒 | 100 通用积分 |
| `3` | 与AI对话1次 | `1` | `currentProgress=1` | 100 通用积分 |

2026-08-29 的上一周期样本中三个任务均同时满足：

```text
currentProgress = totalProgress
status = 2
页面文案 = 已获得
```

因此上一周期抓包可确认 `status=2` 对应当前卡片的“已获得”状态；最新 2026-08-30 样本又确认 `status=0` 的任务卡显示“去完成”。`status=1`、`status=3` 仍只有运行时代码枚举证据，不是本次账号的响应样本。

任务完成状态随 `getTaskList` 一次返回。打开或切换积分中心没有再调用独立状态接口，也没有为三个任务分别发请求。

### 7.4 午夜刷新后的实际任务样本

2026-08-30 00:00（北京时间）后的新一次打开积分中心，重新抓到 `GET /selforder/api/marketing/userPoints/getTaskList`，HTTP 200、`code=0`，返回 3 个当日任务项。敏感的用户、租户、任务实例和时间原值已脱敏；以下是本次响应直接确认的字段组合：

| 任务 | `taskDefId` | `taskSort` | `eventType` | `taskCalendarType` | `totalProgress` | `currentProgress` | `status` | `taskInstId` | `tenantId` | `receiveDate` | `createDate` | 页面状态 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| 登录 AI 云电脑 | 1002 | 1 | 1 | 5 | 1 | 1 | 2 | number | number | number | number | 已获得 |
| 使用 1 小时 | 1003 | 3 | 2 | 5 | 3600 | 3600 | 2 | number | number | number | number | 已获得 |
| 与 AI 对话 1 次 | 1004 | 4 | 3 | 5 | 1 | 0 | 0 | `null` | `null` | `null` | `null` | 去完成 |

三个任务的 `points` 均为 JSON 字符串 `{"1":100}`，`pointsList` 均为：

```json
[
  {
    "type": 1,
    "typeDesc": "通用积分",
    "value": 100
  }
]
```

本次三项的 `taskGroup`、`receiveStartProgress`、`isDisplayProgress`、`receiveProgressUnit`、`sourceObjType`、`sourceObjId`、`remark`、`receiveProgressMap`、`canReceive` 和 `isSatisfiedCondition` 均为 `null`。已完成两项的 `receiveDate` 非空；未开始的对话任务 `receiveDate`、`createDate` 和 `taskInstId` 均为 `null`，但 `updateDate` 仍为 number，说明列表项可以先于任务实例落库而返回。

本次所有每日任务的 `expireDate` 都指向当日结束/下一自然日 00:00（北京时间）。新周期不会复用上一日的任务实例字段：完成任务返回新的数值实例和时间，未开始任务则保留任务定义、目标进度、奖励和状态，实例相关字段为空。

最新响应的全字段可空性闭环：

| 字段组 | 最新实际观察 |
| --- | --- |
| 任务定义字段 | `taskDefId`、`taskDefName`、`taskCalendarType`、`eventType`、`taskDesc`、`taskSort`、`points`、`totalProgress`、`currentProgress`、`status`、`expireDate`、`pointsList` 均非空 |
| 用户归属字段 | `userId` 非空 number；`tenantId` 在已生成任务实例上为 number，在未开始对话任务上为 `null` |
| 实例时间字段 | 已完成任务 `taskInstId`、`receiveDate`、`createDate` 为 number；未开始对话任务三者均为 `null`；三项 `updateDate` 均为 number |
| 预领取/来源扩展字段 | `receiveStartProgress`、`isDisplayProgress`、`receiveProgressUnit`、`sourceObjType`、`sourceObjId`、`receiveProgressMap`、`canReceive`、`isSatisfiedCondition` 均为 `null` |
| 分组/备注字段 | `taskGroup`、`remark` 均为 `null` |

这说明 `getTaskList` 返回的是“任务定义 + 当前周期实例投影”，而不是每一项都保证有已落库的任务实例。实现列表模型时应按上述 nullable 类型定义，不要在 `taskInstId`、`tenantId`、`receiveDate` 或 `createDate` 上强制断言 number。

## 8. 积分规则与非业务请求

### 8.1 积分规则

点击“积分规则”没有产生 XHR/Fetch 业务请求，只加载静态 SVG：

```text
/selforder/static/svg/rule-mobile-Cd7SYMqL.svg
```

因此积分规则没有可文档化的查询接口，规则内容由当前前端静态资源承载。

### 8.2 行为埋点

点击“积分明细”时，页面还会向数据事件接口发送一次行为埋点。该请求携带页面事件和当前用户摘要，但不提供积分余额、明细或任务数据，因此不作为积分业务接口录入。

## 9. 调用与安全注意事项

1. 积分余额应按 `pointType` 匹配，不能依赖数组顺序。
2. 任务完成状态应同时消费 `status`、`currentProgress` 和 `totalProgress`，不要仅根据任务名称推断。
3. `points` 是 JSON 字符串；优先使用已结构化的 `pointsList`，避免手工拼接文案。
4. 明细中的积分值是绝对值；收入/支出符号应结合 `msgType` 等交易类型判断。
5. 明细分页从 `pageNum=1` 开始，首屏 `pageSize=10`；当前页面以 `isLastPage` 设置 `noMore`，并仅在成功后递增页码。
6. HTTP 200 不是业务成功的充分条件，仍需检查 `code === 0`。
7. 手机号、账号、用户 ID、租户 ID、任务实例 ID、明细 ID、外部业务 ID、认证头和实际积分余额均应按敏感数据处理。
8. 本文严格排除兑换奖励相关接口，也不包含任何会领取、兑换或修改积分状态的操作。
