import { Hono } from 'hono'
import { MAX_ACCOUNTS } from '../../shared/constants'
import type { StateSnapshot } from '../../shared/types'
import { nowHm } from '../../shared/utils'
import { ok } from '../envelope'

/**
 * 日志与快照路由（backend-design §1.3：/logs 与 /state 同属 logs.ts）。
 * S1 只实现 GET /state 空态快照；4.13/4.14 在后续里程碑补齐。
 */
export const logsRoute = new Hono()

logsRoute.get('/state', (c) => {
  const snapshot: StateSnapshot = {
    serverTime: Date.now(),
    revision: 0,
    maxAccounts: MAX_ACCOUNTS,
    /* api.md §4.1：refreshedAt 是 "HH:mm" 字符串，契约没有 null；空快照给当前时刻 */
    refreshedAt: nowHm(),
    accounts: [],
    syslogs: [],
  }
  return c.json(ok(snapshot))
})
