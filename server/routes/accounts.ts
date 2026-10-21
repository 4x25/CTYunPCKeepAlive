/**
 * 账号路由（api.md §4.2–4.5）。
 * 只做 zod 校验 + 调 manager + 信封；业务决策全部在 core/manager。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { ErrorCode } from '../../shared/constants'
import { manager } from '../core/manager'
import { ApiError, ok } from '../envelope'

const credentialsSchema = z.object({
  userAccount: z.string().trim().min(1, '请填写账号').max(128, '账号过长'),
  password: z.string().min(1, '请填写密码').max(256, '密码过长'),
  alias: z.string().trim().max(12, '备注名过长（最多 12 个字符）').optional().default(''),
})

const userParamsSchema = z.object({
  userId: z.coerce.number().int().positive('账号标识不合法'),
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
    const field = String(issue?.path?.[0] ?? '')
    const label = field === 'userAccount' ? '账号' : field === 'password' ? '密码' : field === 'alias' ? '备注名' : ''
    /* zod 内置 invalid_type 文案是英文：有中文字段文案时用我们的，否则给中文兜底 */
    const message = /[\u4e00-\u9fa5]/.test(rawMessage) ? rawMessage : label ? `${label}参数不正确` : '请求体不正确'
    throw new ApiError(ErrorCode.InvalidParam, `参数校验失败：${message}`)
  }
  return parsed.data
}

function parseUserId(c: Context): number {
  const parsed = userParamsSchema.safeParse({ userId: c.req.param('userId') })
  if (!parsed.success) throw new ApiError(ErrorCode.InvalidParam, '参数校验失败：账号标识不合法')
  return parsed.data.userId
}

export const accountsRoute = new Hono()

/* 4.2 新增账号（同步：双平台登录 + 去重落库后才返回） */
accountsRoute.post('/', async (c) => {
  const body = await parseJson(c, credentialsSchema)
  return c.json(ok(await manager.addAccount(body)))
})

/* 4.3 修正凭据（同步：删旧加新，失败不生效） */
accountsRoute.put('/:userId/credentials', async (c) => {
  const userId = parseUserId(c)
  const body = await parseJson(c, credentialsSchema)
  return c.json(ok(await manager.updateCredentials(userId, body)))
})

/* 4.4 重试登录（同步：用已存凭据双平台重登） */
accountsRoute.post('/:userId/relogin', async (c) => {
  const userId = parseUserId(c)
  return c.json(ok(await manager.relogin(userId)))
})

/* 4.5 删除账号（同步：先落盘成功再移除内存态） */
accountsRoute.delete('/:userId', async (c) => {
  const userId = parseUserId(c)
  return c.json(ok(await manager.deleteAccount(userId)))
})
