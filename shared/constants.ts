/**
 * 前后端共享常量。不得 import app/ 或 server/ 下的任何文件。
 */

/** 账号数量上限：避免并发请求过密（api.md §1.2 / backend-design §2.2） */
export const MAX_ACCOUNTS = 10

/** 保活间隔边界与默认值（backend-design §3.2） */
export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_MINUTES = 59
export const DEFAULT_INTERVAL_MINUTES = 19

/** 积分任务时间窗口默认值 */
export const DEFAULT_POINTS_WINDOW = { winStart: '09:00', winEnd: '11:30' } as const

/** 时长型任务（totalProgress 单位为秒；映射表由前端维护，api.md §2.4） */
export const TASK_DURATION_IDS = [1003, 1105, 1106] as const

/**
 * 工具可代为执行的任务：只有「与AI对话1次」类（1004/1102）能通过 eaichat
 * 发一轮对话完成；其余任务需要真实桌面会话或官方渠道人工操作（backend-design §4.2）。
 */
export const TASK_EXECUTABLE_IDS = [1004, 1102] as const

/** 不可自动执行任务的固定提示（前后端共用，不含任务 ID） */
export const TASK_UNSUPPORTED_REASON: Record<number, string> = {
  1002: '需真实连接云电脑后自动完成，工具不代为连接',
  1003: '需保持云电脑在线累计时长，本期不自动执行',
  1101: '需在官方渠道绑定手机号',
  1104: '需连续登录，工具不代为执行',
  1105: '需保持云电脑在线累计时长，本期不自动执行',
  1106: '需保持云电脑在线累计时长，本期不自动执行',
}

/** 「使用1小时」类任务本期不实现自动执行，link 恒为 null（backend-design §4.2） */
export const LINK_TOTAL_SECONDS = 3600

/* ── 枚举取值（S2 路由层 zod 校验 / 遍历用；S1 暂未全部消费） ── */

export const DOT_TONES = ['ok', 'danger', 'warn', 'load'] as const
export const RUN_STATES = ['running', 'starting', 'stopping', 'stopped', 'error'] as const
export const TASK_STATUSES = [0, 1, 2, 3] as const
export const BANNER_TONES = ['danger', 'warn', 'idle'] as const
export const BANNER_ACTIONS = ['relogin', 'retry'] as const
export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const
export const LOG_MODULES = ['账号', '保活', '积分', '调度', '系统'] as const

/** 这些运行状态下不允许手动/自动保活（工具不代为开机） */
export const KEEPALIVE_BLOCKED_RUNS = ['stopped', 'starting', 'stopping'] as const

/* ── 错误码 ───────────────────────────────────────────────── */

/** 本工具错误码（api.md §1.2 ②），另含前端网络/超时统一使用的 -1 */
export const ErrorCode = {
  /** 前端专用：HTTP 500 / 网络异常 / 超时 */
  Network: -1,
  AccountLimit: 10001,
  AccountNotFound: 10002,
  DesktopNotFound: 10003,
  InvalidParam: 10004,
  StateNotAllowed: 10005,
  UpstreamNetwork: 10006,
  TaskNotFound: 10007,
  EaichatUnavailable: 10008,
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

/** 上游业务错误码（api.md §1.2 ①，直接透传） */
export const UpstreamCode = {
  LoginExpired: 40010,
  SignatureInvalid: 40011,
  ParamInvalid: 40050,
  InvalidPassword: 51010,
  AccountLocked: 51020,
  CaptchaInvalid31: 51031,
  CaptchaRequired30: 51030,
  CaptchaRequired: 51040,
  CaptchaInvalid: 51085,
  SmsCodeInvalid: 51090,
  SmsCodeExpired: 51091,
  Processing: 30010,
  SwitchRegion: 30020,
  OperationConflict: 52070,
} as const

export type UpstreamCodeValue = (typeof UpstreamCode)[keyof typeof UpstreamCode]

/** 默认用户可读文案（接口可覆盖） */
export const ERROR_MESSAGES: Record<number, string> = {
  [ErrorCode.Network]: '网络异常，请稍后重试',
  [ErrorCode.AccountLimit]: `最多 ${MAX_ACCOUNTS} 个账号，避免并发请求过密`,
  [ErrorCode.AccountNotFound]: '账号不存在，请刷新后重试',
  [ErrorCode.DesktopNotFound]: '云电脑不存在，请刷新后重试',
  [ErrorCode.InvalidParam]: '参数校验失败',
  [ErrorCode.StateNotAllowed]: '账号或资源当前状态不允许该操作',
  [ErrorCode.UpstreamNetwork]: '上游网络异常或超时，请稍后重试',
  [ErrorCode.TaskNotFound]: '任务不存在，请刷新后重试',
  [ErrorCode.EaichatUnavailable]: '云智助手会话不可用，无感保活暂不可用',
}

/* ── 超时预算（frontend-design §3.2） ─────────────────────── */

export const TIMEOUT_MS = {
  /** 4.2–4.5：双平台登录同步阻塞，后端 30s + 5s 余量 */
  accountOp: 35_000,
  /** 4.8 / 4.9：上游 prevent-power-strategy 实测 <1s */
  keepalive: 15_000,
  /** 4.1 / 4.7 / 4.10 / 4.13：列表拉取 */
  list: 15_000,
  /** 4.6 / 4.11 / 4.12 / 4.14：轻量写 */
  light: 10_000,
} as const
