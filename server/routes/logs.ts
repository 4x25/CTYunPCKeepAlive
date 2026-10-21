/**
 * 日志与快照路由（api.md §4.1 / §4.13 / §4.14）。
 *
 * - 4.1 GET /state：只读内存快照，永不打上游
 * - 4.13 GET /logs：内存 ring 查询（账号 + 可选系统日志），支持增量 sinceSeq
 * - 4.14 DELETE /logs：清空指定账号的界面日志（磁盘文件不受影响）
 *
 * 只做参数校验 + 调 core/store + 信封；业务决策在 server/core 与 store/logs。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { ErrorCode, LOG_LEVELS, LOG_MODULES } from '../../shared/constants'
import { manager } from '../core/manager'
import { ApiError, ok } from '../envelope'
import { queryLogs } from '../store/logs'

/** 空串一律按"未传"处理（前端不会发空参，手写 curl 时容易带上） */
function queryOf(c: Context): Record<string, string> {
  const raw = c.req.query()
  const picked: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === '') continue
    picked[key] = value
  }
  return picked
}

const logsQuerySchema = z.object({
  userId: z.coerce.number('账号标识不合法').int('账号标识不合法').positive('账号标识不合法').optional(),
  lv: z.enum(LOG_LEVELS, '日志级别需为 DEBUG/INFO/WARN/ERROR').optional(),
  mod: z.enum(LOG_MODULES, '来源模块需为 账号/保活/积分/调度/系统').optional(),
  kw: z.string().max(128, '关键词过长（最多 128 个字符）').optional(),
  includeSys: z
    .enum(['true', 'false', '1', '0'], 'includeSys 需为 true/false')
    .transform((value) => value === 'true' || value === '1')
    .optional(),
  sinceSeq: z.coerce.number('sinceSeq 不合法').int('sinceSeq 不合法').min(0, 'sinceSeq 不合法').optional(),
  /* 上限由 store 统一钳到 1000：超出部分静默截断，不把「多要了几条」判成参数错误 */
  limit: z.coerce.number('limit 需为正整数').int('limit 需为正整数').positive('limit 需为正整数').optional(),
})

const userIdSchema = z.object({
  userId: z.coerce.number('账号标识不合法').int('账号标识不合法').positive('账号标识不合法'),
})

function invalid(message: string | undefined, fallback: string): ApiError {
  const text = message && /[\u4e00-\u9fa5]/.test(message) ? message : fallback
  return new ApiError(ErrorCode.InvalidParam, `参数校验失败：${text}`)
}

function parseLogsQuery(c: Context): ReturnType<typeof logsQuerySchema.parse> {
  const parsed = logsQuerySchema.safeParse(queryOf(c))
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message, '查询参数不合法')
  return parsed.data
}

function parseUserId(c: Context): number {
  const parsed = userIdSchema.safeParse(queryOf(c))
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message, '账号标识不合法')
  return parsed.data.userId
}

export const logsRoute = new Hono()

/* 4.1 全量快照 */
logsRoute.get('/state', async (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json(ok(await manager.state()))
})

/* 4.13 日志查询（userId 可选；不传 = 全部账号） */
logsRoute.get('/logs', (c) => {
  const query = parseLogsQuery(c)
  c.header('Cache-Control', 'no-store')
  return c.json(ok(queryLogs(query)))
})

/* 4.14 清空该账号的界面日志（userId 必填；磁盘文件不受影响） */
logsRoute.delete('/logs', async (c) => {
  const userId = parseUserId(c)
  return c.json(ok(await manager.clearLogs(userId)))
})
