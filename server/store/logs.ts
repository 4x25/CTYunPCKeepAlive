/**
 * 界面日志：内存 ring + 全局 seq + 磁盘 jsonl（backend-design §7.2）。
 *
 * 内存：每个账号一份 ring（最新在前）+ 一份系统 ring；全部条目共用全局单调 `seq`。
 *       「清空」只清内存缓冲，`seq` 继续递增不归零——前端 `sinceSeq` 增量无需处理回绕。
 * 磁盘：`log/log-{userId}-{YYYYMMDD}.jsonl`（每账号按天一个文件）与 `log/system.jsonl`
 *       （跨天归档为 `log/system-{YYYYMMDD}.jsonl`）。行式 JSON、串行追加、0600，
 *       目录跟随 `CTYUN_PC_KEEPALIVE_HOME`（见 store/config）。启动清理超期文件，默认保留 7 天；
 *       长跑进程不重启也能收敛：system.jsonl 跨天归档时再清理一次。
 * 脱敏：条目文案由调用方负责——只写实例名 / 任务名，不写 userId / desktopId / taskDefId /
 *       密码 / 密钥 / JWT（backend-design §7.2）。
 *
 * 磁盘失败一律降级到 console：日志是观测面，不能反过来影响业务。
 */
import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { LogEntry, LogLevel, LogModule, LogsResult } from '../../shared/types'
import { nowStr } from '../../shared/utils'
import { LOG_DIR } from './config'

/** 单账号内存 ring 上限：界面日志只需要"最近一屏 + 若干历史" */
const RING_LIMIT = 2_000
/** 4.13 分页默认值与上限（api.md §4.13） */
const DEFAULT_QUERY_LIMIT = 200
const MAX_QUERY_LIMIT = 1_000
/** /state 下发的系统日志条数 */
const STATE_SYSLOG_LIMIT = 200
/** 磁盘日志保留天数（含今天） */
export const LOG_RETENTION_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1_000
const SYSTEM_LOG_FILE = path.join(LOG_DIR, 'system.jsonl')
/** 只认本模块产出的文件，避免误删用户放在同目录的其它文件 */
const ACCOUNT_FILE_RE = /^log-\d+-\d{8}\.jsonl$/
const SYSTEM_FILE_RE = /^system(-\d{8})?\.jsonl$/
const DAY_IN_NAME_RE = /-(\d{8})\.jsonl$/

/** 账号 → 日志 ring（最新在前） */
const accountLogs = new Map<number, LogEntry[]>()
const systemLogs: LogEntry[] = []
let seq = 0
let diskQueue: Promise<void> = Promise.resolve()
/** 当前 `system.jsonl` 归属的本地日期（YYYYMMDD）；跨天时先归档再追加 */
let systemFileDay = ''

/* ── 目录 / 文件 ──────────────────────────────────────────── */

export async function ensureLogDir(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 })
}

function dayKeyOf(date: Date): string {
  const y = `${date.getFullYear()}`
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}${m}${d}`
}

/** 文件名里的日期 → 当天 00:00 的本地时间戳 */
function dayStartOf(day: string): number {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))).getTime()
}

function accountLogFile(userId: number, day: string): string {
  return path.join(LOG_DIR, `log-${userId}-${day}.jsonl`)
}

/**
 * 跨天归档：把当前的 `system.jsonl` 改名成 `system-{前一天}.jsonl`，
 * 让「按天滚动 + 保留 7 天」对系统日志同样成立（backend-design §7.2）。
 * 归档后顺带清理一次超期文件：长跑进程不重启，启动清理不会再来第二次。
 */
async function archiveSystemFileIfNeeded(day: string): Promise<void> {
  if (systemFileDay === day) return
  if (systemFileDay) {
    await rename(SYSTEM_LOG_FILE, path.join(LOG_DIR, `system-${systemFileDay}.jsonl`)).catch(() => undefined)
    /* 跨天归档顺带清理超期文件：进程不重启时启动清理不会再来第二次 */
    await cleanupExpiredLogs().catch((error: unknown) => {
      console.error('[logs] 跨天清理超期日志失败', error instanceof Error ? error.name : 'unknown')
    })
  }
  systemFileDay = day
}

/**
 * 启动时的归档口径：`system.jsonl` 已存在且修改时间不是今天（进程昨天就退出了），
 * 先按修改时间把它归档成 `system-{YYYYMMDD}.jsonl`，今天的新条目另起一行文件。
 */
async function prepareSystemFile(day: string): Promise<void> {
  const info = await stat(SYSTEM_LOG_FILE).catch(() => null)
  if (info) {
    const fileDay = dayKeyOf(new Date(info.mtimeMs))
    if (fileDay !== day) {
      await rename(SYSTEM_LOG_FILE, path.join(LOG_DIR, `system-${fileDay}.jsonl`)).catch(() => undefined)
    }
  }
  systemFileDay = day
}

/** 串行追加一行（同一队列保证行不被并发写打散） */
function enqueueLine(file: () => Promise<string>, entry: LogEntry): void {
  diskQueue = diskQueue
    .then(async () => {
      const target = await file()
      await ensureLogDir()
      await appendFile(target, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    })
    .catch((error: unknown) => {
      console.error('[logs] 磁盘日志写入失败', error instanceof Error ? error.name : 'unknown')
    })
}

/* ── 启动初始化：归档 + 清理超期文件 ──────────────────────── */

export interface LogStoreInitResult {
  /** 本次清理掉的超期文件数 */
  removedFiles: number
}

/**
 * 启动时调用一次：建目录 → 归档昨天的 system.jsonl → 清理超过保留期的日志文件。
 * 只处理本模块命名的文件，其它文件不碰。
 */
export async function initLogStore(now = Date.now()): Promise<LogStoreInitResult> {
  await ensureLogDir()
  await prepareSystemFile(dayKeyOf(new Date(now)))
  const removedFiles = await cleanupExpiredLogs(now)
  return { removedFiles }
}

/** 删除保留期之外（默认 7 天，含今天）的日志文件；返回删除数量 */
export async function cleanupExpiredLogs(now = Date.now()): Promise<number> {
  await ensureLogDir()
  const names = await readdir(LOG_DIR).catch(() => [] as string[])
  /* 保留今天与之前 6 天 = 7 个自然日 */
  const keepFrom = new Date(now)
  keepFrom.setHours(0, 0, 0, 0)
  const cutoff = keepFrom.getTime() - (LOG_RETENTION_DAYS - 1) * DAY_MS

  let removed = 0
  for (const name of names) {
    const isAccount = ACCOUNT_FILE_RE.test(name)
    if (!isAccount && !SYSTEM_FILE_RE.test(name)) continue
    const day = DAY_IN_NAME_RE.exec(name)?.[1]
    let stamp = day ? dayStartOf(day) : Number.NaN
    if (Number.isNaN(stamp)) {
      /* 无日期后缀（旧版 system.jsonl）：退回文件修改时间 */
      stamp = await stat(path.join(LOG_DIR, name))
        .then((info) => info.mtimeMs)
        .catch(() => Number.NaN)
    }
    if (Number.isNaN(stamp) || stamp >= cutoff) continue
    const ok = await unlink(path.join(LOG_DIR, name))
      .then(() => true)
      .catch(() => false)
    if (ok) removed += 1
  }
  return removed
}

/* ── 写入 ─────────────────────────────────────────────────── */

function pushBounded(list: LogEntry[], entry: LogEntry): void {
  list.unshift(entry)
  if (list.length > RING_LIMIT) list.length = RING_LIMIT
}

/**
 * 写一条日志并分配全局递增 seq。
 * `userId === null` 表示无账号归属（删除账号、去重顶替、启动恢复、清空动作等），落系统日志；
 * 账号日志与系统日志都双写内存与磁盘。
 */
export function appendLog(
  userId: number | null,
  lv: LogLevel,
  mod: LogModule,
  msg: string,
): LogEntry {
  const entry: LogEntry = { seq: ++seq, t: nowStr(), lv, mod, msg }
  if (userId == null) {
    pushBounded(systemLogs, entry)
    enqueueLine(async () => {
      await archiveSystemFileIfNeeded(dayKeyOf(new Date()))
      return SYSTEM_LOG_FILE
    }, entry)
    return entry
  }

  const list = accountLogs.get(userId)
  if (list) pushBounded(list, entry)
  else accountLogs.set(userId, [entry])
  enqueueLine(async () => accountLogFile(userId, dayKeyOf(new Date())), entry)
  return entry
}

/* ── 读取 ─────────────────────────────────────────────────── */

/** /state 的 syslogs：按 seq 倒序（最新在前），限制传输量 */
export function getSystemLogs(limit = STATE_SYSLOG_LIMIT): LogEntry[] {
  return systemLogs.slice(0, limit).map((entry) => ({ ...entry }))
}

export interface LogQueryInput {
  /** 不传 = 全部账号 */
  userId?: number
  lv?: LogLevel
  mod?: LogModule
  kw?: string
  /** 是否并入系统日志（默认 false） */
  includeSys?: boolean
  /** 增量：只返回 seq > sinceSeq 的条目 */
  sinceSeq?: number
  limit?: number
}

/**
 * 4.13 查询：`total` 是当前筛选口径下的总条数（未截断），`rows` 按 seq 降序。
 * 内存 ring 即查询边界（每账号 RING_LIMIT 条），磁盘文件不参与查询。
 */
export function queryLogs(input: LogQueryInput = {}): LogsResult {
  const pool: LogEntry[] = []
  if (input.userId != null) {
    const list = accountLogs.get(input.userId)
    if (list) pool.push(...list)
  } else {
    for (const list of accountLogs.values()) pool.push(...list)
  }
  if (input.includeSys) pool.push(...systemLogs)

  const kw = input.kw?.trim().toLowerCase() ?? ''
  const sinceSeq = input.sinceSeq
  const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, input.limit ?? DEFAULT_QUERY_LIMIT))

  const filtered = pool.filter((entry) => {
    if (input.lv && entry.lv !== input.lv) return false
    if (input.mod && entry.mod !== input.mod) return false
    if (sinceSeq != null && entry.seq <= sinceSeq) return false
    /* 关键词对 msg + mod 做大小写不敏感的 includes（api.md §4.13） */
    if (kw && !`${entry.msg} ${entry.mod}`.toLowerCase().includes(kw)) return false
    return true
  })
  filtered.sort((a, b) => b.seq - a.seq)

  return {
    total: filtered.length,
    rows: filtered.slice(0, limit).map((entry) => ({ ...entry })),
  }
}

/* ── 清空 / 生命周期 ──────────────────────────────────────── */

/**
 * 清空某账号的界面日志（4.14 / 删除账号 / 修正凭据）。
 * 只清内存缓冲：磁盘文件按 7 天保留，由 `cleanupExpiredLogs` 统一清理；
 * `seq` 不重置，清空后新条目仍然更大。
 */
export function clearAccountLogs(userId: number): void {
  accountLogs.delete(userId)
}
