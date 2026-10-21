import { Hono } from 'hono'
import { ErrorCode } from '../shared/constants'
import { ApiError, err } from './envelope'
import { accountsRoute } from './routes/accounts'
import { logsRoute } from './routes/logs'

/**
 * /api 子应用：在 app/server.ts 通过 `app.route('/api', apiApp)` 挂载。
 *
 * S2：/state 真实快照 + 4.2–4.5 账号生命周期；实例/积分/日志接口按里程碑补齐。
 * 路由层只做校验与信封包装，业务编排在 server/core。
 */
export const apiApp = new Hono()

apiApp.route('/', logsRoute)
apiApp.route('/accounts', accountsRoute)

/* 未匹配的 /api/* 属于路由层错误：HTTP 404 + 明确 msg；信封 code 归入请求错误段（10004），不用前端专用的 -1 */
apiApp.all('*', (c) => c.json(err(ErrorCode.InvalidParam, `接口不存在：${c.req.method} ${c.req.path}`), 404))

/* 统一错误出口：ApiError 转业务信封，其它异常保持 500（框架层） */
apiApp.onError((error, c) => {
  if (error instanceof ApiError) return c.json(err(error.code, error.message))
  console.error('[api] unhandled error', error)
  return c.json(err(ErrorCode.Network, '服务异常，请查看磁盘日志'), 500)
})
