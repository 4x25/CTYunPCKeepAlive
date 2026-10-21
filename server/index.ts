import { Hono } from 'hono'
import { ErrorCode } from '../shared/constants'
import { ApiError, err } from './envelope'
import { accountsRoute } from './routes/accounts'
import { desktopsRoute } from './routes/desktops'
import { logsRoute } from './routes/logs'
import { pointsRoute } from './routes/points'

/**
 * /api 子应用：在 app/server.ts 通过 `app.route('/api', apiApp)` 挂载。
 *
 * S4：/state 真实快照 + 4.2–4.12（账号生命周期、设置、实例列表与无感保活、积分任务）。
 * 路由层只做校验与信封包装，业务编排在 server/core。
 */
export const apiApp = new Hono()

apiApp.route('/', logsRoute)
apiApp.route('/accounts', accountsRoute)
apiApp.route('/accounts', desktopsRoute)
apiApp.route('/accounts', pointsRoute)

/* 未匹配的 /api/* 属于路由层错误：HTTP 404 + 明确 msg；信封 code 归入请求错误段（10004），不用前端专用的 -1 */
apiApp.all('*', (c) => c.json(err(ErrorCode.InvalidParam, `接口不存在：${c.req.method} ${c.req.path}`), 404))

/* 统一错误出口：ApiError 转业务信封，其它异常保持 500（框架层） */
apiApp.onError((error, c) => {
  if (error instanceof ApiError) return c.json(err(error.code, error.message))
  console.error('[api] unhandled error', error)
  return c.json(err(ErrorCode.Network, '服务异常，请查看磁盘日志'), 500)
})
