/** 账号状态点：正常 / 登录失败 / 需人工处理 / 登录中 */
export type DotTone = 'ok' | 'danger' | 'warn' | 'load'

/** 云电脑实例运行状态 */
export type RunState = 'running' | 'starting' | 'stopping' | 'stopped' | 'error'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

/** 账号级警示条：登录失败给「重新登录」，需人工处理给「重试登录」，重试中是纯提示 */
export interface Banner {
  tone: 'danger' | 'warn' | 'idle'
  act: 'relogin' | 'retry' | null
  text: string
  btn: string | null
}

export interface PcInstance {
  name: string
  id: string
  os: string
  run: RunState
  /** 自动保活开关 */
  auto: boolean
  /** 距下次保活的倒计时（秒），null = 未安排 */
  left: number | null
  /** 被积分任务占用的剩余秒数；非 null 时该实例本轮保活暂停 */
  link?: number | null
  /** 会话冲突：实例运行中但连接被其它设备抢走，本轮跳过且不抢回 */
  conflict?: boolean
  /** 最近一次的保活结果描述 */
  last: string
  /** 手动/开关触发的保活执行中 */
  busy?: boolean
  /** 执行成功后的短暂「✓ 成功」态 */
  justOk?: boolean
}

export interface LogEntry {
  seq: number
  t: string
  lv: LogLevel
  mod: string
  msg: string
}

export interface Account {
  alias: string
  mask: string
  full: string
  pw: string
  /** 登录响应里的 userId：账号去重只认它 */
  uid: number
  dot: DotTone
  /** 保活间隔（分钟），可填 1–59 */
  interval: number
  banner: Banner | null
  /** 拿不到列表时的空态文案 */
  emptyText?: string | null
  pcs: PcInstance[]
  logs: LogEntry[]
}

/** 积分任务 */
export interface PointTask {
  name: string
  reward: number
  /** 进度文本，如「1 / 1 次」「24 / 60 分钟」；null 时由 linkDone 推导 */
  progressText: string | null
  /** 进度 0–1；null 时由 linkDone 推导 */
  ratio: number | null
  /** 进度条的 hover 说明（接口进度口径） */
  progressTip: string
  status: 'done' | 'running' | 'idle'
  doneLabel: string
  /** 手动执行中 */
  busy: boolean
  auto: boolean
}
