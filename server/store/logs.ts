/**
 * 界面日志：内存 ring + seq（backend-design §7.2）。
 *
 * S2 只落系统日志到 `log/system.jsonl`；账号日志先只留内存，完整日志面板
 * 与按天滚动/7 天清理属于 S5。所有条目必须由调用方先行脱敏——本模块不写入
 * 密码、密钥、JWT、userId/desktopId 等值。
 */
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { LogEntry, LogLevel, LogModule } from '../../shared/types'
import { nowStr } from '../../shared/utils'
import { LOG_DIR } from './config'

const RING_LIMIT = 2_000
const SYSTEM_LOG_FILE = path.join(LOG_DIR, 'system.jsonl')

const accountLogs = new Map<number, LogEntry[]>()
let systemLogs: LogEntry[] = []
let seq = 0
let diskQueue: Promise<void> = Promise.resolve()

export async function ensureLogDir(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 })
}

function pushBounded(list: LogEntry[], entry: LogEntry): void {
  list.unshift(entry)
  if (list.length > RING_LIMIT) list.length = RING_LIMIT
}

function writeSystemLine(entry: LogEntry): void {
  diskQueue = diskQueue
    .then(async () => {
      await ensureLogDir()
      await appendFile(SYSTEM_LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    })
    .catch((error: unknown) => {
      /* 磁盘日志失败只降级到 console，不影响业务 */
      console.error('[logs] 系统日志落盘失败', error instanceof Error ? error.name : 'unknown')
    })
}

/**
 * 写一条日志并分配全局递增 seq。
 * userId=null 表示无账号归属的系统日志（同时追加到 system.jsonl）。
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
    writeSystemLine(entry)
  } else {
    const list = accountLogs.get(userId)
    if (list) pushBounded(list, entry)
    else accountLogs.set(userId, [entry])
  }
  return entry
}

/** /state 的 syslogs：按 seq 倒序（最新在前），限制传输量 */
export function getSystemLogs(limit = 200): LogEntry[] {
  return systemLogs.slice(0, limit).map((entry) => ({ ...entry }))
}

export function getAccountLogs(userId: number, limit = 200): LogEntry[] {
  return (accountLogs.get(userId) ?? []).slice(0, limit).map((entry) => ({ ...entry }))
}

/** 修正凭据 / 删除账号：原账号界面日志清除（磁盘文件留待 S5 处理） */
export function clearAccountLogs(userId: number): void {
  accountLogs.delete(userId)
}

export function moveAccountLogs(fromUserId: number, toUserId: number): void {
  if (fromUserId === toUserId) return
  const from = accountLogs.get(fromUserId)
  if (from) accountLogs.delete(fromUserId)
  accountLogs.delete(toUserId)
  if (from) accountLogs.set(toUserId, from)
}

export function currentSeq(): number {
  return seq
}
