# CTYunPCKeepAlive

天翼云电脑保活助手的 Web 前端（交互原型阶段）。技术栈：HonoX（hono/jsx + islands）· Vite · Tailwind CSS 4 · daisyUI 5 · dayjs。

## 常用命令

- `npm run dev` — 启动开发服务器（默认 5173；对外提供访问时追加 `-- --host`）
- `npm run build` — 客户端 + 服务端构建到 `dist/`
- `npm start` — 运行构建产物
- `./node_modules/.bin/tsc --noEmit` — 类型检查（改动后必须过）

## 结构

```
app/
  routes/
    index.tsx            首页：渲染 <KeepAliveApp />（唯一页面）
    _renderer.tsx        html 骨架（lang="zh-CN"）
  islands/
    KeepAliveApp.tsx     全部客户端状态与交互编排（唯一 island）
  lib/                   领域代码（非组件，components/ 下只放 .tsx）
    types.ts             前端私有类型（Dlg / ToastItem / LogView / LogFilters）+ shared/types 的 re-export
    api.ts               14 个接口的 fetch 封装（信封 / ApiError / 超时预算）+ 单一切换点 api
    api-error.ts         ApiError / isApiError / isTimeout
    api-mock.ts          VITE_USE_MOCK=1 时的内存假实现（演示种子、revision、调度推进）
    derive.ts            纯展示派生：掩码 / Tab 名 / last 单元格 / 任务进度与徽章 / 导出文件名
    time.ts              serverTime 校准、倒计时投影、过渡态判定
  components/            被 island 引用的展示组件（随 island 打包到客户端）
    AccountTabBar.tsx    账号 Tab 条（radio tabs-lift + 状态点 + × 关闭；＋与全局操作区（GitHub + ThemeToggle）包装成 tab 与账号 Tab 同行，超宽横向滚动；所有账号的 tab-content 全部挂载，显隐纯 CSS 驱动）
    SubTabs.tsx          功能页签（radio tabs-box + tab content：保活 / 积分任务 / 日志）
    AccountErrorPanel.tsx 报错账号的错误提示（有警示条的账号不展示功能页签，警示条铺满内容区、内容上下居中）
    EmptyAccountPanel.tsx 零账号空态（不展示功能页签，整幅提示 + 添加账号按钮）
    KeepAlivePanel.tsx   保活面板：设置行 + 云电脑表格 + 空态
    PointsPanel.tsx      积分任务面板：时间窗口 + 积分概览 + 任务表格
    LogPanel.tsx         日志面板：筛选工具栏 + 日志表 + 归属脚注
    ModalLayer.tsx       模态容器（常驻原生 dialog，open 态驱动 showModal/close；method="dialog" 表单：角落关闭按钮/遮罩关闭；Escape 由 onKeyDown 拦截，cancel 事件仅做锁定兜底；焦点圈定/归还走原生）
    AddAccountForm.tsx   添加账号 / 修正凭据表单（只做必填校验）
    DeleteConfirm.tsx    删除账号确认
    ToastStack.tsx       服务端报错 Toast（压在弹窗之上，z-[1000]）
    StatusPill.tsx       运行状态胶囊；HelpMark.tsx 行内 ? 说明；Countdown.tsx 倒计时（daisyUI countdown mm:ss）
    ThemeToggle.tsx      明暗主题切换（swap 图标；localStorage 持久化，_renderer 内联脚本首帧前应用）
    icons.tsx            图标统一出口：HeroIcon（heroicons 包原始 SVG）+ lobehub 品牌图标（GitHub 等），均 ?raw 直引库文件
shared/                  前后端共享层（不得 import app/ 或 server/）
  types.ts               契约类型：与 api.md §2 / §4 一一对应，响应 data 统一在此命名导出
  constants.ts           账号上限、保活间隔、错误码、超时预算、枚举与默认文案
  utils.ts               时间格式化（nowStr/nowHm/formatHm/formatHms）、maskOf、isHm
server/                  /api 后端（同进程挂载；按业务纵切补齐）
  index.ts               /api 子应用：路由挂载、未匹配 404、统一错误信封
  envelope.ts            ok / err / ApiError
  routes/                accounts.ts（4.2–4.5）、logs.ts（4.1 /state；4.13/4.14 在 S5）
  core/                  manager.ts（账号生命周期/启动恢复）、session.ts（双平台登录态与快照）
  upstream/              ctyun-client.ts / eaichat-client.ts / crypto.ts / errors.ts
  store/                 config.ts（~/.ctyun-pc-keep-alive/config.json 原子写）、logs.ts（内存 ring + 磁盘）
```

## 约定

- UI 一律用 daisyUI 5 组件与语义色（badge/toggle/table/alert/modal/toast…），不够用时再上 Tailwind 工具类；禁止引入 React。
- 图标：品牌图标（GitHub 等）用 @lobehub/icons，基础 UI 图标用 Heroicons；一律经 `components/icons.tsx` 渲染，不手写 SVG，不用 ? ! + × ✓ 之类的字符图标。
- hono/jsx 注意：`onChange` 被别名映射为 `input` 事件（失焦提交用 `onBlur`）；内联 `ref` 回调每次渲染都会重跑，不做焦点逻辑；island 首渲染在服务端，浏览器 API 只能出现在事件回调 / `useEffect` 里。
- 交互稿 `/home/agent/keepalive-demo.html` 是行为基准：文案、日志格式、状态流转照抄；窗口外壳（标题栏/最小化/最大化/关闭/边框）不实现，只做窗口内部界面。
- 数据来源：默认走真实 `/api`（HonoX 同进程挂载，入口 `app/server.ts`）；本地无后端时用 `VITE_USE_MOCK=1 npm run dev` 走 `app/lib/api-mock.ts`。`app/lib/api.ts` 导出的 `api` 是唯一数据入口，island / components 不直接 `fetch`。
- 字段命名一律照抄 api.md：共享契约类型放 `shared/types.ts`，前端私有类型（弹窗、Toast、日志视图）才放 `app/lib/types.ts`。
