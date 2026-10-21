/**
 * 云电脑实例路由（api.md §4.7–4.9）与账号设置（§4.6）。
 * 只做 zod 校验 + 调 manager + 信封；业务决策全部在 core（manager / scheduler / keepalive）。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { ErrorCode, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from '../../shared/constants'
import { isHm } from '../../shared/utils'
import { manager } from '../core/manager'
import { ApiError, ok } from '../envelope'

const userParamsSchema = z.object({
  userId: z.coerce.number().int().positive('账号标识不合法'),
})

const desktopParamsSchema = z.object({
  userId: z.coerce.number().int().positive('账号标识不合法'),
  desktopId: z.string().trim().min(1, '云电脑标识不合法').max(128, '云电脑标识不合法'),
})

const settingsSchema = z.object({
  interval: z
    .number('保活间隔需为 1–59 分钟的整数')
    .int(`保活间隔需为 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟的整数`)
    .min(MIN_INTERVAL_MINUTES, `保活间隔需为 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟`)
    .max(MAX_INTERVAL_MINUTES, `保活间隔需为 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟`)
    .optional(),
  pointsWindow: z
    .object(
      {
        winStart: z.string().refine(isHm, '积分时间窗口格式需为 HH:mm'),
        winEnd: z.string().refine(isHm, '积分时间窗口格式需为 HH:mm'),
      },
      '积分时间窗口必须是 { winStart, winEnd } 对象',
    )
    .optional(),
})

const setAutoSchema = z.object({
  auto: z.boolean('auto 必须是布尔值'),
})

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

function parseParams<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.param())
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message
    throw new ApiError(ErrorCode.InvalidParam, `参数校验失败：${message && /[\u4e00-\u9fa5]/.test(message) ? message : '路径参数不合法'}`)
  }
  return parsed.data
}

export const desktopsRoute = new Hono()

/* 4.7 刷新云电脑列表（banner 期间 10005） */
desktopsRoute.get('/:userId/desktops', async (c) => {
  const { userId } = parseParams(c, userParamsSchema)
  return c.json(ok(await manager.listDesktops(userId)))
})

/* 4.8 手动保活（同步；run/link 拒绝 10005，eaichat 不可用 10008） */
desktopsRoute.post('/:userId/desktops/:desktopId/keepalive', async (c) => {
  const { userId, desktopId } = parseParams(c, desktopParamsSchema)
  return c.json(ok(await manager.keepalive(userId, desktopId)))
})

/* 4.9 切换自动保活（关闭永远允许；打开受状态限制并立即执行一次） */
desktopsRoute.patch('/:userId/desktops/:desktopId', async (c) => {
  const { userId, desktopId } = parseParams(c, desktopParamsSchema)
  const { auto } = await parseJson(c, setAutoSchema)
  return c.json(ok(await manager.setDesktopAuto(userId, desktopId, auto)))
})

/* 4.6 修改设置（interval / pointsWindow，至少一个；越界/倒置 10004） */
desktopsRoute.patch('/:userId/settings', async (c) => {
  const { userId } = parseParams(c, userParamsSchema)
  const body = await parseJson(c, settingsSchema)
  return c.json(ok(await manager.updateSettings(userId, body)))
})
