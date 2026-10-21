/**
 * 前端类型出口：
 * - 领域类型一律来自 shared/types.ts（与 api.md §2 一一对应），这里只做 re-export；
 * - 前端私有类型（弹窗、Toast、日志视图等）留在本文件。
 */
import type { LogEntry } from '../../shared/types'

export type {
  Account,
  Banner,
  DotTone,
  LogEntry,
  LogLevel,
  LogModule,
  LogQuery,
  PcInstance,
  PointTask,
  RunState,
  StateSnapshot,
} from '../../shared/types'

/** 弹窗：新增 / 修正凭据（editUid 非空） / 删除确认 */
export type Dlg =
  | { kind: 'add'; editUid: number | null }
  | { kind: 'del'; uid: number }
  | null

/** 服务端报错 Toast（组件 ToastStack 使用） */
export interface ToastItem {
  id: number
  msg: string
  code?: string
}

/** 每个账号一份日志视图缓存（island 内部结构） */
export interface LogView {
  rows: LogEntry[]
  total: number
  loading: boolean
}

/** 日志筛选条件（按账号各存一份，切 Tab 不串味） */
export interface LogFilters {
  lv: string
  mod: string
  kw: string
  includeSys: boolean
}
