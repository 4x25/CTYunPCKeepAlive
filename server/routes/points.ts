/**
 * 积分任务路由（api.md §4.10–4.12）。
 * 只做 zod 校验 + 调 manager + 信封；聚合/编排全部在 core/points 与 core/task-runner。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { ErrorCode } from '../../shared/constants'
import { manager } from '../core/manager'
import { ApiError, ok } from '../envelope'

const userParamsSchema = z.object({
  userId: z.coerce.number().int().positive('账号标识不合法'),
})

const taskParamsSchema = z.object({
  userId: z.coerce.number().int().positive('账号标识不合法'),
  taskDefId: z.coerce.number().int().positive('任务标识不合法'),
})

const setAutoSchema = z.object({
  auto: z.boolean('auto 必须是布尔值'),
})

function parseParams<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.param())
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message
    throw new ApiError(
      ErrorCode.InvalidParam,
      `参数校验失败：${message && /[\u4e00-\u9fa5]/.test(message) ? message : '路径参数不合法'}`,
    )
  }
  return parsed.data
}

async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new ApiError(ErrorCode.InvalidParam, '参数校验失败：请求体必须是合法 JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const rawMessage = issue?.message ?? ''
    const message = /[\u4e00-\u9fa5]/.test(rawMessage) ? rawMessage : '请求体不正确'
    throw new ApiError(ErrorCode.InvalidParam, `参数校验失败：${message}`)
  }
  return parsed.data
}

export const pointsRoute = new Hono()

/* 4.10 刷新积分与任务（banner 期间 10005） */
pointsRoute.get('/:userId/points', async (c) => {
  const { userId } = parseParams(c, userParamsSchema)
  return c.json(ok(await manager.listPoints(userId)))
})

/* 4.11 手动执行任务（异步受理；已完成 10005、不可执行 10005、不存在 10007） */
pointsRoute.post('/:userId/points/tasks/:taskDefId/run', async (c) => {
  const { userId, taskDefId } = parseParams(c, taskParamsSchema)
  return c.json(ok(await manager.runTask(userId, taskDefId)))
})

/* 4.12 切换任务自动开关（关闭永远允许） */
pointsRoute.patch('/:userId/points/tasks/:taskDefId', async (c) => {
  const { userId, taskDefId } = parseParams(c, taskParamsSchema)
  const { auto } = await parseJson(c, setAutoSchema)
  return c.json(ok(await manager.setTaskAuto(userId, taskDefId, auto)))
})
