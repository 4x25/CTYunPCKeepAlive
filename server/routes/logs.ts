import { Hono } from 'hono'
import { manager } from '../core/manager'
import { ok } from '../envelope'

/**
 * 日志与快照路由（backend-design §1.3：/logs 与 /state 同属 logs.ts）。
 * S2 的 GET /state 返回真实内存快照（只读内存、永不打上游）；4.13/4.14 在 S5 补齐。
 */
export const logsRoute = new Hono()

logsRoute.get('/state', async (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json(ok(await manager.state()))
})
