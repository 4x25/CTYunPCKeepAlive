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
    types.ts             Account / PcInstance / LogEntry / PointTask / Banner 类型
    utils.ts             nowStr / maskOf（日期时间格式化一律走 dayjs）
    mock-data.ts         演示数据：4 个账号种子、系统日志、积分任务、UID 表、demoPcs/demoUid
  components/            被 island 引用的展示组件（随 island 打包到客户端）
    AccountTabBar.tsx    账号 Tab 条（radio tabs-lift + 状态点 + × 关闭；＋与全局操作区（GitHub + ThemeToggle）包装成 tab 与账号 Tab 同行，超宽横向滚动；所有账号的 tab-content 全部挂载，显隐纯 CSS 驱动）
    SubTabs.tsx          功能页签（radio tabs-box + tab content：保活 / 积分任务 / 日志）
    AccountErrorPanel.tsx 报错账号的错误提示（有警示条的账号不展示功能页签，警示条铺满内容区、内容上下居中）
    EmptyAccountPanel.tsx 零账号空态（不展示功能页签，整幅提示 + 添加账号按钮）
    KeepAlivePanel.tsx   保活面板：设置行 + 云电脑表格 + 空态
    PointsPanel.tsx      积分任务面板：时间窗口 + 积分概览 + 任务表格
    LogPanel.tsx         日志面板：筛选工具栏 + 日志表 + 归属脚注
    ModalLayer.tsx       模态容器（常驻原生 dialog，open 态驱动 showModal/close；method="dialog" 表单：角落关闭按钮/遮罩关闭；Escape 与焦点圈定走原生）
    AddAccountForm.tsx   添加账号 / 修正凭据表单（只做必填校验）
    DeleteConfirm.tsx    删除账号确认
    ToastStack.tsx       服务端报错 Toast（压在弹窗之上，z-[1000]）
    StatusPill.tsx       运行状态胶囊；HelpMark.tsx 行内 ? 说明；Countdown.tsx 倒计时（daisyUI countdown mm:ss）
    ThemeToggle.tsx      明暗主题切换（swap 图标；localStorage 持久化，_renderer 内联脚本首帧前应用）
    icons.tsx            图标统一出口：HeroIcon（heroicons 包原始 SVG）+ lobehub 品牌图标（GitHub 等），均 ?raw 直引库文件
```

## 约定

- UI 一律用 daisyUI 5 组件与语义色（badge/toggle/table/alert/modal/toast…），不够用时再上 Tailwind 工具类；禁止引入 React。
- 图标：品牌图标（GitHub 等）用 @lobehub/icons，基础 UI 图标用 Heroicons；一律经 `components/icons.tsx` 渲染，不手写 SVG，不用 ? ! + × ✓ 之类的字符图标。
- hono/jsx 注意：`onChange` 被别名映射为 `input` 事件（失焦提交用 `onBlur`）；内联 `ref` 回调每次渲染都会重跑，不做焦点逻辑；island 首渲染在服务端，浏览器 API 只能出现在事件回调 / `useEffect` 里。
- 交互稿 `/home/agent/keepalive-demo.html` 是行为基准：文案、日志格式、状态流转照抄；窗口外壳（标题栏/最小化/最大化/关闭/边框）不实现，只做窗口内部界面。
- 数据全部是前端 mock（`mock-data.ts`），后续接真实接口时替换 island 里的状态来源。
