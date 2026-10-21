import { showRoutes } from 'hono/dev'
import { createApp } from 'honox/server'
import { apiApp } from '../server'
import { manager } from '../server/core/manager'

/**
 * 后端与前端同进程：HonoX 服务端即 /api 宿主（backend-design §1.3）。
 *
 * init 在 HonoX 注册页面路由与兜底 404 之前执行，保证 /api/*（含未匹配的
 * /api/* 404）先于页面兜底路由命中。
 */
const app = createApp({
  init: (app) => {
    app.route('/api', apiApp)
  },
})

/* 启动恢复在后台执行：先载入配置建立内存账号，再逐账号登录，不阻塞服务启动 */
void manager.start()

showRoutes(app)

export default app
