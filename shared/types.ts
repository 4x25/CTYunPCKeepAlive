/**
 * 前后端共享契约类型（与 docs/api.md §2 / §4 一一对应）。
 *
 * 命名原则：字段名一律照抄 api.md，不自造；所有接口响应的 `data`
 * 都在这份文件里命名导出，前端 api.ts 与后端 routes 共用同一份定义。
 */

/* ── 枚举取值 ─────────────────────────────────────────────── */

/** 账号状态点：正常 / 登录失败 / 需人工处理 / 登录中 */
export type DotTone = 'ok' | 'danger' | 'warn' | 'load'

/** 云电脑运行状态；starting/stopping 为上游电源操作过渡态 */
export type RunState = 'running' | 'starting' | 'stopping' | 'stopped' | 'error'

/** 任务状态（沿用上游语义）：0 未完成、1 待领取、2 已领取、3 已失效 */
export type TaskStatus = 0 | 1 | 2 | 3

/** 警示条语气：登录失败 / 需人工处理 / 纯提示（重试中） */
export type BannerTone = 'danger' | 'warn' | 'idle'

/** 警示条按钮动作：修正凭据 / 重试登录 / 无按钮 */
export type BannerAction = 'relogin' | 'retry' | null

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

/** 日志模块归属 */
export type LogModule = '账号' | '保活' | '积分' | '调度' | '系统'

/* ── 数据模型（api.md §2） ────────────────────────────────── */

/** 账号级警示条（api.md §2.1） */
export interface Banner {
  tone: BannerTone
  act: BannerAction
  text: string
  btn: string | null
}

export interface PointsWindow {
  /** "HH:mm" */
  winStart: string
  /** "HH:mm" */
  winEnd: string
}

export interface PointTypeTotal {
  pointType: number
  pointTypeName: string
  points: number
}

/** 积分概览（api.md §2.3） */
export interface PointsSummary {
  /** 已按 pointType 分组累加、过滤即将过期积分 */
  pointsList: PointTypeTotal[]
  /** 最近一次拉取成功时间 */
  updatedDate: number
}

export interface TaskReward {
  type: number
  typeDesc: string
  value: number
}

/** 积分任务（api.md §2.4） */
export interface PointTask {
  taskDefId: number
  taskDefName: string
  /** 5 每日 3 每周 2 每月 1 每年 0 长期 */
  taskCalendarType: number
  /** 奖励明细，奖励列取 sum(value) */
  pointsList: TaskReward[]
  /** 时长任务单位为秒 */
  currentProgress: number
  /** 布尔任务为 1，时长任务为秒数 */
  totalProgress: number
  status: TaskStatus
  /** false 时进度列显示「—」 */
  isDisplayProgress: boolean | null
  /** 手动执行中 */
  busy: boolean
  /** 自动执行开关（本工具持久化） */
  auto: boolean
}

/** 云智助手 Token 用量概览（Token 中心「我的 Token」卡片） */
export interface TokenSummary {
  /** 已发放/购买的 Token 总量 */
  totalTokens: number
  /** 已消耗 Token */
  usedTokens: number
  /** 即将过期 Token（上游返回，当前页面不展示） */
  expTokens: number
  /** 当前可用 Token */
  remainTokens: number
  /** 最近一次拉取成功时间 */
  updatedDate: number
}

/** 云智助手 Token 任务（与云电脑积分任务分开维护） */
export interface TokenTask {
  taskDefId: number
  taskDefName: string
  /** 5 每日 3 每周 2 每月 1 每年 0 长期 */
  taskCalendarType: number
  /** 奖励明细（type 600 = TOKEN 通用积分） */
  pointsList: TaskReward[]
  currentProgress: number
  totalProgress: number
  status: TaskStatus
  /** false 时进度列显示「—」 */
  isDisplayProgress: boolean | null
  /** 当前是否可签到 / 领取 */
  canReceive: boolean
  /** 任务条件是否已满足 */
  isSatisfiedCondition: boolean
  /** 连续签到进度：key 为 "1".."7"，1 = 当天已签到 */
  receiveProgressMap: Record<string, number>
  /** 签到 / 领取操作在途 */
  busy: boolean
}

/** 云电脑实例（api.md §2.2） */
export interface PcInstance {
  /** 上游 desktopId；前端操作寻址用 */
  desktopId: string
  desktopName: string
  osType: string
  run: RunState
  /** 自动保活开关 */
  auto: boolean
  /** 距下次保活秒数；null = 未安排 */
  left: number | null
  /** 被积分任务占用的剩余秒；非 null 时本轮保活暂停 */
  link: number | null
  /** 最近一次保活时间戳（毫秒）；null = 从未执行 */
  lastAt: number | null
  /** 最近一次保活提示；null = 从未执行 */
  lastMsg: string | null
  /** 上游 expireDate，毫秒时间戳；null = 永不过期 */
  expireDate: number | null
}

/** 账号（api.md §2.1） */
export interface Account {
  /** 登录响应 userId，账号唯一标识（去重只认它） */
  userId: number
  /** 用户填的备注名；未填写时后端自动回填 userName / nickName */
  alias: string
  /** 本次登录使用的完整账号 */
  userAccount: string
  /** 明文密码（本地单用户工具，用于修正凭据弹窗回填） */
  password: string
  dot: DotTone
  /** 保活间隔（分钟，1–59） */
  interval: number
  /** 账号级警示条；null = 无警示 */
  banner: Banner | null
  /** 积分任务自动执行时间窗口 */
  pointsWindow: PointsWindow
  eaichat: {
    /** 云智助手会话是否就绪（无感保活前置条件） */
    ok: boolean
    /** 未就绪原因文案；null = 正常 */
    msg: string | null
  }
  pcs: PcInstance[]
  points: PointsSummary
  tasks: PointTask[]
  /** 云智助手 Token 用量概览 */
  token: TokenSummary
  /** 云智助手 Token 任务 */
  tokenTasks: TokenTask[]
}

/** 日志（api.md §2.5） */
export interface LogEntry {
  /** 进程内全局单调递增序号（新条目更大；进程重启后归零，纪元由 /state 的 bootId 标识） */
  seq: number
  /** "YYYY-MM-DD HH:mm:ss" */
  t: string
  lv: LogLevel
  mod: LogModule
  msg: string
}

/* ── 通用信封（api.md §1.1） ──────────────────────────────── */

export interface ApiEnvelope<T> {
  code: number
  msg: string
  data: T
}

/* ── 请求体 ───────────────────────────────────────────────── */

export interface CredentialsBody {
  /** 手机号 / 邮箱 / 账号 */
  userAccount: string
  /** 明文，仅此一次传输 */
  password: string
  /** 可选备注名；留空则后端自动回填 userName */
  alias?: string
}

export interface PatchSettingsBody {
  /** 可选，1–59 分钟 */
  interval?: number
  pointsWindow?: PointsWindow
}

/** 4.13 日志查询参数 */
export interface LogQuery {
  userId?: number
  lv?: LogLevel
  mod?: LogModule
  kw?: string
  includeSys?: boolean
  sinceSeq?: number
  limit?: number
}

/* ── 各接口响应 data ──────────────────────────────────────── */

/** 4.1 GET /api/state */
export interface StateSnapshot {
  /** 服务端毫秒时间，前端校准本地时钟 */
  serverTime: number
  /**
   * 进程纪元：每次后端启动生成一次，进程内恒定。
   * 变化 = 服务端已重启：`revision`/日志 `seq` 从 0 重新计数，
   * 前端必须先重置本地水位与日志缓存，再应用新快照。
   */
  bootId: string
  /** 账号内存态单调递增版本号（进程内单调；跨进程由 bootId 标识） */
  revision: number
  maxAccounts: number
  /** 最近一次云电脑列表成功刷新时间（"HH:mm"，契约不接受 null） */
  refreshedAt: string
  accounts: Account[]
  /** 无账号归属的系统日志 */
  syslogs: LogEntry[]
}

/** 4.2 POST /api/accounts（4.3 共用，replacedAlias 恒为 null） */
export interface AddAccountResult {
  /** 写操作响应携带，供前端乱序防护 */
  revision: number
  account: Account
  /** 因 userId 相同被顶替移除的账号标识；null = 无顶替 */
  replacedAlias: string | null
  /** 非阻断告警 */
  warnings: string[]
}

export type UpdateCredentialsResult = AddAccountResult

/** 4.4 POST /api/accounts/:userId/relogin */
export interface ReloginResult {
  revision: number
  account: Account
}

/** 4.5 DELETE /api/accounts/:userId */
export type DeleteAccountResult = null

/** 4.6 PATCH /api/accounts/:userId/settings */
export interface PatchSettingsResult {
  revision: number
  account: Account
}

/** 4.7 GET /api/accounts/:userId/desktops */
export interface DesktopsResult {
  /** "HH:mm" */
  refreshedAt: string
  pcs: PcInstance[]
}

/** 4.8 POST /api/accounts/:userId/desktops/:desktopId/keepalive */
export interface KeepaliveResult {
  revision: number
  desktopId: string
  /** 上游保活是否成功 */
  ok: boolean
  /** 本次执行耗时 */
  elapsedMs: number
  lastAt: number
  lastMsg: string
  /** auto=true 时按 interval 重排的下次倒计时；否则 null */
  left: number | null
}

/** 4.9 PATCH /api/accounts/:userId/desktops/:desktopId */
export interface SetDesktopAutoResult {
  revision: number
  desktopId: string
  auto: boolean
  left: number | null
}

/** 4.10 GET /api/accounts/:userId/points */
export interface PointsResult {
  points: PointsSummary
  tasks: PointTask[]
  updatedDate: number
}

/** 4.11 POST /api/accounts/:userId/points/tasks/:taskDefId/run */
export interface RunTaskResult {
  revision: number
  taskDefId: number
  busy: boolean
}

/** 4.12 PATCH /api/accounts/:userId/points/tasks/:taskDefId */
export interface SetTaskAutoResult {
  revision: number
  taskDefId: number
  auto: boolean
}

/** 4.15 GET /api/accounts/:userId/token */
export interface TokenResult {
  token: TokenSummary
  tasks: TokenTask[]
  updatedDate: number
}

/** 4.16 POST /api/accounts/:userId/token/tasks/:taskDefId/checkin */
export interface CheckinTokenTaskResult {
  revision: number
  taskDefId: number
  /** 上游签到 / 领取是否成功 */
  ok: boolean
  /** 操作后的最新用量与任务（上游复查失败时为操作前的缓存值） */
  token: TokenSummary
  tasks: TokenTask[]
  updatedDate: number
}

/** 4.13 GET /api/logs */
export interface LogsResult {
  /** 当前筛选口径下的总条数（未截断） */
  total: number
  /** 按 seq 降序 */
  rows: LogEntry[]
}

/** 4.14 DELETE /api/logs */
export type LogsClearResult = null
