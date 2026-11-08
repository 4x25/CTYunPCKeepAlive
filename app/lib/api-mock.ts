/**
 * 与 api.ts 同签名的内存假实现（frontend-design §3.3）。
 *
 * - 内置演示种子（无外部种子文件），字段换算为 api.md §2 的模型；
 * - revision 按「任何变更 +1」维护；
 * - 保活计划用 nextAt 惰性推进：getState 时结算已到点的实例并写日志，
 *   与真实后端「left 实时计算」的口径一致。
 *
 * 切换点只在 api.ts 一行：VITE_USE_MOCK=1 时启用本文件。
 */
import {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_POINTS_WINDOW,
  ErrorCode,
  MAX_ACCOUNTS,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  TASK_EXECUTABLE_IDS,
  TASK_UNSUPPORTED_REASON,
} from '../../shared/constants'
import type {
  Account,
  AddAccountResult,
  CredentialsBody,
  DeleteAccountResult,
  DesktopsResult,
  KeepaliveResult,
  LogEntry,
  LogLevel,
  LogModule,
  LogQuery,
  LogsClearResult,
  LogsResult,
  PatchSettingsBody,
  PatchSettingsResult,
  PcInstance,
  PointTask,
  PointsResult,
  PointsSummary,
  ReloginResult,
  RunTaskResult,
  SetDesktopAutoResult,
  SetTaskAutoResult,
  StateSnapshot,
  UpdateCredentialsResult,
} from '../../shared/types'
import { formatDateTime, isHm, maskOf, nowHm, nowStr } from '../../shared/utils'
import type { ApiClient } from './api'
import { ApiError } from './api-error'

const MINUTE = 60_000

/** mock 的 bootId：模块加载时生成一次（与真实后端「每次进程启动一次」同口径） */
const MOCK_BOOT_ID = `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** 与后端一致：error 属稳态可保活，仅 stopped/starting/stopping 暂停计时 */
const isCountedRun = (run: PcInstance['run']) => run !== 'stopped' && run !== 'starting' && run !== 'stopping'

interface MockPc extends PcInstance {
  /** 下次自动保活的时间戳（内部调度用，不下发） */
  nextAt: number | null
  /** starting/stopping 还需几次 getState 才收敛到稳态（内部演示用，不下发） */
  transitionTicks?: number
}

interface MockAccount extends Omit<Account, 'pcs'> {
  pcs: MockPc[]
}

interface MockState {
  accounts: MockAccount[]
  logs: Map<number, LogEntry[]>
  syslogs: LogEntry[]
  revision: number
  seq: number
  refreshedAt: string
  /** 进程纪元：mock 生命周期内恒定（前端 bootId 变更 = 重置本地水位） */
  bootId: string
}

interface RawLog {
  /** 种子里的 "HH:mm:ss" */
  t: string
  lv: LogLevel
  mod: LogModule
  msg: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const latency = (base: number, spread: number) => base + Math.floor(Math.random() * spread)

/** 固定演示触发：用这个账号登录会透传上游 51010（不要用密码长度推断） */
const DEMO_ERROR_ACCOUNT = 'error@demo'

/** alias 留空时后端自动回填的演示 userName（api.md §2.1） */
const DEMO_USER_NAME = '斜阳流水长风'

/** 今天某个 "HH:mm:ss" 的时间戳（种子数据用） */
function atTime(hms: string): number {
  const [h, m, s = 0] = hms.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, s, 0)
  return d.getTime()
}

function expireIn(days: number): number {
  return Date.now() + days * 24 * 60 * MINUTE
}

/* ── 种子数据 ─────────────────────────────────────────────── */

function seedPoints(updatedAt = atTime('09:41:22')): PointsSummary {
  /* 与真实账号一致：多个积分分组各自展示，不合并计数 */
  return {
    pointsList: [
      { pointType: 1, pointTypeName: '通用积分', points: 1280 },
      { pointType: 500, pointTypeName: '云智手机通用积分', points: 230 },
    ],
    updatedDate: updatedAt,
  }
}

function emptyPoints(): PointsSummary {
  return { pointsList: [], updatedDate: 0 }
}

function seedTasks(): PointTask[] {
  /* isDisplayProgress 实测恒为 null（不是 boolean）：只有明确 false 才隐藏进度 */
  return [
    {
      taskDefId: 1002,
      taskDefName: '登录AI云电脑',
      taskCalendarType: 5,
      pointsList: [{ type: 1, typeDesc: '通用积分', value: 100 }],
      currentProgress: 0,
      totalProgress: 1,
      status: 0,
      isDisplayProgress: null,
      busy: false,
      /* 需真实连接云电脑才能完成，工具不代为执行 */
      auto: false,
    },
    {
      taskDefId: 1003,
      taskDefName: '使用1小时',
      taskCalendarType: 5,
      pointsList: [{ type: 1, typeDesc: '通用积分', value: 100 }],
      currentProgress: 1452,
      totalProgress: 3600,
      status: 0,
      isDisplayProgress: null,
      busy: false,
      /* 时长类任务需会话在线累计，本期不自动执行（backend-design §4.2） */
      auto: false,
    },
    {
      taskDefId: 1004,
      taskDefName: '与AI对话1次',
      taskCalendarType: 5,
      pointsList: [{ type: 1, typeDesc: '通用积分', value: 100 }],
      currentProgress: 0,
      totalProgress: 1,
      status: 0,
      isDisplayProgress: null,
      busy: false,
      auto: true,
    },
  ]
}

function seedPc(
  desktopId: string,
  desktopName: string,
  run: PcInstance['run'],
  auto: boolean,
  left: number | null,
  lastAt: string | null,
  lastMsg: string | null,
  expireDate: number | null = null,
): MockPc {
  const scheduled = auto && isCountedRun(run) && left != null
  return {
    desktopId,
    desktopName,
    osType: 'Windows',
    run,
    auto,
    left,
    link: null,
    lastAt: lastAt ? atTime(lastAt) : null,
    lastMsg,
    expireDate,
    nextAt: scheduled ? Date.now() + (left ?? 0) * 1000 : null,
    transitionTicks: run === 'starting' || run === 'stopping' ? 2 : undefined,
  }
}

/** 新账号的实例开关一律默认关闭——这是已确认口径，不是演示取巧 */
function demoPcs(): MockPc[] {
  const rid = () => 'ecd-' + Math.random().toString(16).slice(2, 8)
  return [
    seedPc(rid(), '云电脑 1', 'running', false, null, null, null),
    seedPc(rid(), '云电脑 2', 'stopped', false, null, null, null),
  ]
}

interface AccountSeed {
  account: MockAccount
  logs: RawLog[]
}

function buildSeedState(): MockState {
  const success = (ms: number) => `保活成功 · 耗时 ${ms}ms`

  const accountSeeds: AccountSeed[] = [
    {
      account: {
        userId: 41288301,
        alias: '主号',
        userAccount: '13800006021',
        password: 'Demo#Pass2026',
        dot: 'ok',
        interval: 19,
        banner: null,
        pointsWindow: { ...DEFAULT_POINTS_WINDOW },
        eaichat: { ok: true, msg: null },
        pcs: [
          seedPc('ecd-7f21a9', '办公云电脑', 'running', true, 372, '14:26:03', success(540), expireIn(30)),
          seedPc('ecd-2b83c4', '剪辑云电脑', 'running', true, 1080, '14:24:30', success(512), expireIn(45)),
          seedPc('ecd-9d0e17', '备份云电脑', 'stopped', false, null, null, null),
          seedPc('ecd-31c8a2', '渲染农场 01', 'running', true, 483, '14:31:47', success(503), expireIn(18)),
          seedPc('ecd-31c8b7', '渲染农场 02', 'running', true, 1074, '14:29:12', success(498), expireIn(18)),
          seedPc('ecd-77aa09', '深度学习训练机', 'running', false, null, '13:58:40', success(604)),
          seedPc(
            'ecd-5e21d4',
            '测试环境-支付',
            'error',
            true,
            null,
            '14:18:52',
            '保活失败：连接超时（step=ws-display code=ETIMEDOUT），本轮整轮作废，下个周期重试',
            expireIn(9),
          ),
          seedPc(
            'ecd-5e21f1',
            '测试环境-订单',
            'running',
            true,
            936,
            '14:36:20',
            '保活失败：上游返回系统处理中（code=30010），下个周期重试',
            expireIn(9),
          ),
          seedPc('ecd-b209ce', 'Win11 尝鲜机', 'starting', false, null, null, null),
          seedPc('ecd-04f17c', '老项目维护机', 'stopping', true, null, '14:10:03', success(611)),
          seedPc('ecd-8d42e6', '客服演示机', 'stopped', false, null, null, null),
          seedPc('ecd-60b3f8', '数据同步节点', 'running', true, 58, '14:32:01', success(476), expireIn(60)),
        ],
        points: seedPoints(),
        tasks: seedTasks(),
      },
      /* 日志的「对象」列只写实例名或任务名：ID 与密码一律不进日志 */
      logs: [
        { t: '14:36:20', lv: 'WARN', mod: '保活', msg: '测试环境-订单 保活失败：上游返回系统处理中（code=30010），本轮退避，下个周期重试' },
        { t: '14:32:08', lv: 'INFO', mod: '保活', msg: '办公云电脑 保活成功 · 耗时 540ms' },
        { t: '14:32:01', lv: 'INFO', mod: '保活', msg: '数据同步节点 保活成功 · 耗时 476ms' },
        { t: '14:31:47', lv: 'INFO', mod: '保活', msg: '渲染农场 01 保活成功 · 耗时 503ms' },
        { t: '14:29:12', lv: 'INFO', mod: '保活', msg: '渲染农场 02 保活成功 · 耗时 498ms' },
        { t: '14:26:55', lv: 'WARN', mod: '调度', msg: '命中账号级限流，本次请求延后 1.2s 入队' },
        { t: '14:18:52', lv: 'ERROR', mod: '保活', msg: '测试环境-支付 保活失败：连接超时（step=ws-display code=ETIMEDOUT），本轮整轮作废，下个周期重试' },
        { t: '14:14:00', lv: 'INFO', mod: '积分', msg: '「使用1小时」为时长类任务，本期不自动执行（进度取自上游，不占用实例保活）' },
        { t: '14:05:19', lv: 'ERROR', mod: '保活', msg: '测试环境-支付 保活失败：连接超时（step=ws-display code=ETIMEDOUT），本轮整轮作废，下个周期重试' },
        { t: '13:58:40', lv: 'INFO', mod: '保活', msg: '深度学习训练机 手动保活成功 · 耗时 604ms' },
        { t: '11:42:36', lv: 'WARN', mod: '调度', msg: '测试环境-订单 本轮跳过：实例状态探测未通过，下个周期重试' },
        { t: '10:05:31', lv: 'WARN', mod: '积分', msg: '「与AI对话1次」执行时云智助手会话不可用，已自动续期后继续' },
        { t: '09:41:22', lv: 'INFO', mod: '积分', msg: '「登录AI云电脑」已完成 · 通用积分 1,280' },
        { t: '09:20:03', lv: 'INFO', mod: '保活', msg: '数据同步节点 保活成功 · 耗时 512ms' },
        { t: '09:00:41', lv: 'INFO', mod: '保活', msg: '渲染农场 01 保活成功 · 耗时 487ms' },
        { t: '09:00:20', lv: 'INFO', mod: '账号', msg: '138****6021 登录成功 · 已恢复 8 条自动保活计划' },
      ],
    },
    {
      account: {
        userId: 41288712,
        alias: '备用号',
        userAccount: '15900003374',
        password: 'Demo#Pass2026',
        dot: 'ok',
        interval: 19,
        banner: null,
        pointsWindow: { ...DEFAULT_POINTS_WINDOW },
        eaichat: { ok: true, msg: null },
        pcs: [
          seedPc('ecd-4a55b0', '测试机 A', 'error', true, null, '14:22:10', '保活失败：连接超时', expireIn(7)),
          seedPc('ecd-6c1802', '测试机 B', 'running', true, 540, '14:30:55', success(612), expireIn(20)),
          seedPc('ecd-8e42d1', '测试机 C', 'running', true, 1140, '14:41:02', '保活失败：上游返回系统处理中（code=30010），下个周期重试'),
        ],
        points: seedPoints(),
        tasks: seedTasks(),
      },
      logs: [
        { t: '14:41:02', lv: 'WARN', mod: '保活', msg: '测试机 C 保活失败：上游返回系统处理中（code=30010），本轮退避，下个周期重试' },
        { t: '14:30:55', lv: 'INFO', mod: '保活', msg: '测试机 B 保活成功 · 耗时 612ms' },
        { t: '14:22:10', lv: 'ERROR', mod: '保活', msg: '测试机 A 保活失败：连接超时（step=ws-display code=ETIMEDOUT），本轮整轮作废，下个周期重试' },
        { t: '09:00:20', lv: 'INFO', mod: '账号', msg: '159****3374 登录成功 · 已恢复 3 条自动保活计划' },
      ],
    },
    {
      account: {
        userId: 41290455,
        alias: '测试号',
        userAccount: '17700008802',
        password: 'Demo#Pass2026',
        dot: 'danger',
        interval: 19,
        banner: {
          tone: 'danger',
          act: 'relogin',
          text: '登录失败：账号或密码不正确（09:14），该账号下所有自动任务已挂起。',
          btn: '重新登录',
        },
        pointsWindow: { ...DEFAULT_POINTS_WINDOW },
        eaichat: { ok: false, msg: '云电脑侧未登录，云智助手会话不可用' },
        pcs: [],
        points: emptyPoints(),
        tasks: [],
      },
      logs: [
        { t: '09:14:03', lv: 'ERROR', mod: '账号', msg: '177****8802 登录失败：账号或密码不正确（code=51010 INVALID_PASSWORD），该账号自动任务已挂起，等待用户修正凭据' },
      ],
    },
    {
      account: {
        userId: 41291038,
        alias: '验证号',
        userAccount: '18600005140',
        password: 'Demo#Pass2026',
        dot: 'warn',
        interval: 19,
        banner: {
          tone: 'warn',
          act: 'retry',
          text: '需要你本人处理一次：登录时要求输入图形验证码，工具已停止这个账号的自动重登。请到官方客户端登录一次，完成后回来点「重试登录」。',
          btn: '重试登录',
        },
        pointsWindow: { ...DEFAULT_POINTS_WINDOW },
        eaichat: { ok: false, msg: '需人工完成验证后才能恢复云智助手会话' },
        pcs: [],
        points: emptyPoints(),
        tasks: [],
      },
      logs: [
        { t: '09:12:40', lv: 'ERROR', mod: '账号', msg: '186****5140 登录被要求图形验证码（code=51085），工具不做自动重试，等待人工在官方客户端完成一次验证' },
      ],
    },
    {
      /* dot=ok + banner=null + eaichat.ok=false：10008 的唯一可演示入口 */
      account: {
        userId: 41291766,
        alias: '助手异常号',
        userAccount: '13300002211',
        password: 'Demo#Pass2026',
        dot: 'ok',
        interval: 19,
        banner: null,
        pointsWindow: { ...DEFAULT_POINTS_WINDOW },
        eaichat: { ok: false, msg: '云智助手会话失效，正在自动重新登录' },
        pcs: [
          seedPc('ecd-7c31aa', '辅助办公云电脑', 'running', true, 240, '08:56:03', success(521), expireIn(12)),
          seedPc('ecd-7c31bb', '辅助备用机', 'stopped', false, null, null, null),
        ],
        points: seedPoints(),
        tasks: seedTasks(),
      },
      logs: [
        { t: '09:06:30', lv: 'WARN', mod: '保活', msg: '辅助办公云电脑 自动保活本轮跳过：云智助手会话失效，正在自动重新登录，下个周期重试' },
        { t: '08:56:03', lv: 'INFO', mod: '保活', msg: '辅助办公云电脑 保活成功 · 耗时 521ms' },
        { t: '09:00:24', lv: 'INFO', mod: '账号', msg: '133****2211 登录成功 · 云智助手会话获取失败，无感保活暂不可用' },
      ],
    },
  ]

  const syslogSeed: RawLog[] = [
    { t: '09:00:12', lv: 'INFO', mod: '系统', msg: '应用启动 · 载入 5 个账号 · 恢复 12 条自动保活计划' },
    { t: '09:00:05', lv: 'INFO', mod: '系统', msg: '按「日志保留 7 天」清理了 2 个超期日志文件' },
  ]

  /* 全部种子日志按时间升序统一赋 seq（与交互稿一致） */
  type Pending = { sort: string; userId: number | null; raw: RawLog }
  const pending: Pending[] = [
    ...syslogSeed.map((raw) => ({ sort: raw.t, userId: null, raw })),
    ...accountSeeds.flatMap((seed) =>
      seed.logs.map((raw) => ({ sort: raw.t, userId: seed.account.userId, raw })),
    ),
  ]
  pending.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0))

  const logs = new Map<number, LogEntry[]>()
  for (const seed of accountSeeds) logs.set(seed.account.userId, [])
  const syslogs: LogEntry[] = []
  let seq = 0
  for (const item of pending) {
    const entry: LogEntry = {
      seq: ++seq,
      t: formatDateTime(atTime(item.raw.t)),
      lv: item.raw.lv,
      mod: item.raw.mod,
      msg: item.raw.msg,
    }
    if (item.userId == null) syslogs.push(entry)
    else logs.get(item.userId)?.push(entry)
  }

  return {
    accounts: accountSeeds.map((seed) => seed.account),
    logs,
    syslogs,
    revision: 0,
    seq,
    refreshedAt: '14:32',
    bootId: MOCK_BOOT_ID,
  }
}

let state = buildSeedState()

/* ── 内部工具 ─────────────────────────────────────────────── */

function findAccount(userId: number): MockAccount {
  const account = state.accounts.find((a) => a.userId === userId)
  if (!account) throw new ApiError(ErrorCode.AccountNotFound, '账号不存在，请刷新后重试')
  return account
}

function findPc(account: MockAccount, desktopId: string): MockPc {
  const pc = account.pcs.find((p) => p.desktopId === desktopId)
  if (!pc) throw new ApiError(ErrorCode.DesktopNotFound, '云电脑不存在，请刷新后重试')
  return pc
}

function findTask(account: MockAccount, taskDefId: number): PointTask {
  const task = account.tasks.find((t) => t.taskDefId === taskDefId)
  if (!task) throw new ApiError(ErrorCode.TaskNotFound, '任务不存在，请刷新后重试')
  return task
}

function appendLog(userId: number | null, lv: LogLevel, mod: LogModule, msg: string): LogEntry {
  const entry: LogEntry = { seq: ++state.seq, t: nowStr(), lv, mod, msg }
  if (userId == null) {
    state.syslogs.unshift(entry)
  } else {
    const list = state.logs.get(userId)
    if (list) list.unshift(entry)
    else state.logs.set(userId, [entry])
  }
  state.revision += 1
  return entry
}

function toPc(pc: MockPc): PcInstance {
  const { nextAt: _nextAt, transitionTicks: _transitionTicks, ...rest } = pc
  return { ...rest }
}

function toAccount(account: MockAccount): Account {
  return {
    ...account,
    /* 快照不得与内部状态共享引用：banner / pointsWindow / eaichat 同样深拷贝 */
    banner: account.banner ? { ...account.banner } : null,
    pointsWindow: { ...account.pointsWindow },
    eaichat: { ...account.eaichat },
    pcs: account.pcs.map(toPc),
    points: {
      ...account.points,
      pointsList: account.points.pointsList.map((item) => ({ ...item })),
    },
    tasks: account.tasks.map((task) => ({ ...task, pointsList: task.pointsList.map((item) => ({ ...item })) })),
  }
}

function toSnapshot(): StateSnapshot {
  return {
    serverTime: Date.now(),
    bootId: state.bootId,
    revision: state.revision,
    maxAccounts: MAX_ACCOUNTS,
    refreshedAt: state.refreshedAt,
    accounts: state.accounts.map(toAccount),
    syslogs: state.syslogs.map((entry) => ({ ...entry })),
  }
}

/** 结算已到点的自动保活计划：写 lastAt/lastMsg/日志并重排下一轮 */
function advanceSchedules(): void {
  const now = Date.now()
  for (const account of state.accounts) {
    if (account.dot !== 'ok' || account.banner) {
      account.pcs.forEach((pc) => {
        pc.left = null
      })
      continue
    }
    for (const pc of account.pcs) {
      /* 过渡态演示：starting/stopping 在两次 getState 后收敛到 running/stopped */
      if (pc.run === 'starting' || pc.run === 'stopping') {
        pc.left = null
        pc.nextAt = null
        const ticks = (pc.transitionTicks ?? 1) - 1
        if (ticks > 0) {
          pc.transitionTicks = ticks
          continue
        }
        pc.transitionTicks = undefined
        pc.run = pc.run === 'starting' ? 'running' : 'stopped'
        state.revision += 1
        if (pc.auto && isCountedRun(pc.run)) schedulePc(pc, account)
        continue
      }
      if (!pc.auto || !isCountedRun(pc.run) || pc.link != null) {
        pc.left = null
        if (!pc.auto || !isCountedRun(pc.run)) pc.nextAt = null
        continue
      }
      if (pc.nextAt == null) pc.nextAt = now + (pc.left ?? account.interval * 60) * 1000
      if (pc.nextAt <= now) {
        /* 无感保活的前置条件是云智助手会话就绪：不可用时跳过并写 WARN，等下个周期 */
        if (!account.eaichat.ok) {
          appendLog(
            account.userId,
            'WARN',
            '保活',
            `${pc.desktopName} 自动保活本轮跳过：云智助手会话不可用，下个周期重试`,
          )
        } else {
          const elapsedMs = latency(380, 180)
          pc.lastAt = now
          pc.lastMsg = `保活成功 · 耗时 ${elapsedMs}ms`
          appendLog(account.userId, 'INFO', '保活', `${pc.desktopName} 保活成功 · 耗时 ${elapsedMs}ms`)
        }
        pc.nextAt = now + account.interval * 60 * 1000
      }
      pc.left = Math.max(0, Math.ceil((pc.nextAt - now) / 1000))
    }
  }
}

function schedulePc(pc: MockPc, account: MockAccount): void {
  pc.nextAt = pc.auto && isCountedRun(pc.run) ? Date.now() + account.interval * 60 * 1000 : null
  pc.left = pc.nextAt == null ? null : account.interval * 60
}

function applyAutoByPosition(account: MockAccount, previous: Account): void {
  account.pcs.forEach((pc, index) => {
    const old = previous.pcs[index]
    pc.auto = old?.auto ?? false
    if (pc.auto && isCountedRun(pc.run)) {
      pc.left = account.interval * 60
      pc.nextAt = Date.now() + account.interval * 60 * 1000
    }
  })
  account.tasks.forEach((task, index) => {
    const old = previous.tasks[index]
    if (old) task.auto = old.auto
  })
}

function validateCredentials(body: CredentialsBody): void {
  if (!body.userAccount.trim()) throw new ApiError(ErrorCode.InvalidParam, '请填写账号')
  if (!body.password) throw new ApiError(ErrorCode.InvalidParam, '请填写密码')
}

/* ── 可代为执行的任务（与真实后端 shared/constants 同口径） ── */
function isMockExecutable(taskDefId: number): boolean {
  return (TASK_EXECUTABLE_IDS as readonly number[]).includes(taskDefId)
}

function mockUnsupportedReason(taskDefId: number): string {
  return TASK_UNSUPPORTED_REASON[taskDefId] ?? '该类任务需在官方客户端完成，工具不代为执行'
}

/* ── userId 演示表：真实实现只认登录响应，绝不本地推算 ───── */
const UID_BOOK: Record<string, number> = {
  '13800006021': 41288301,
  'demo6021@189.cn': 41288301,
  '15900003374': 41288712,
  '17700008802': 41290455,
  '18600005140': 41291038,
  '13300002211': 41291766,
}
let uidSeed = 41300000

function demoUid(userAccount: string): number {
  const key = userAccount.trim()
  if (!UID_BOOK[key]) UID_BOOK[key] = ++uidSeed
  return UID_BOOK[key]
}

/* ── 接口实现 ─────────────────────────────────────────────── */

export const mockApi: ApiClient = {
  async getState() {
    await sleep(latency(80, 80))
    advanceSchedules()
    return toSnapshot()
  },

  async createAccount(body) {
    validateCredentials(body)
    await sleep(latency(700, 500))
    const userAccount = body.userAccount.trim()
    /* 固定演示触发：账号 error@demo 登录失败，透传上游 51010（不按密码长度推断） */
    if (userAccount.toLowerCase() === DEMO_ERROR_ACCOUNT) {
      throw new ApiError(51010, '账号或密码不正确，请检查后重新提交')
    }

    const userId = demoUid(userAccount)
    const replaced = state.accounts.find((a) => a.userId === userId)
    if (!replaced && state.accounts.length >= MAX_ACCOUNTS) {
      throw new ApiError(ErrorCode.AccountLimit, `最多 ${MAX_ACCOUNTS} 个账号，避免并发请求过密`)
    }

    if (replaced) {
      state.accounts = state.accounts.filter((a) => a.userId !== userId)
      state.logs.delete(userId)
      appendLog(
        null,
        'INFO',
        '账号',
        `本次添加的 ${maskOf(userAccount)} 与已有账号 ${replaced.alias ? replaced.alias + ' ' + maskOf(replaced.userAccount) : maskOf(replaced.userAccount)} 是同一个天翼云账号（登录返回的 userId 相同）· 已按「只保留最后一次添加的账号信息」删除旧的那条 · 它的配置（含 password）、保活间隔、积分时间窗口与日志一并移除`,
      )
    }

    /* api.md §2.1：用户没填备注名时后端回填云电脑侧 userName */
    const alias = body.alias?.trim() || DEMO_USER_NAME
    const account: MockAccount = {
      userId,
      alias,
      userAccount,
      password: body.password,
      dot: 'ok',
      interval: DEFAULT_INTERVAL_MINUTES,
      banner: null,
      pointsWindow: { ...DEFAULT_POINTS_WINDOW },
      eaichat: { ok: true, msg: null },
      pcs: demoPcs(),
      points: seedPoints(),
      tasks: seedTasks(),
    }
    state.accounts.push(account)
    state.logs.set(userId, [])
    state.revision += 1
    appendLog(
      userId,
      'INFO',
      '账号',
      `${maskOf(userAccount)} 登录成功 · 密码已明文写入配置文件 · 该账号所有实例的自动保活开关默认关闭，需逐台打开`,
    )

    return {
      revision: state.revision,
      account: toAccount(account),
      /* 顶替提示只用别名；旧账号没有别名时返回 null（前端不展示空引号） */
      replacedAlias: replaced?.alias.trim() ? replaced.alias : null,
      warnings: [],
    }
  },

  async updateCredentials(userId, body) {
    validateCredentials(body)
    const previous = findAccount(userId)
    await sleep(latency(600, 400))
    const userAccount = body.userAccount.trim()
    /* 固定演示触发：账号 error@demo 登录失败（与新增共用同一入口） */
    if (userAccount.toLowerCase() === DEMO_ERROR_ACCOUNT) {
      throw new ApiError(51010, '账号或密码不正确，请检查后重新提交')
    }

    const nextUserId = demoUid(userAccount)
    const sameAccount = userAccount === previous.userAccount
    const nextIndex = state.accounts.findIndex((a) => a.userId === userId)
    const pcs = sameAccount ? previous.pcs.map((pc) => ({ ...pc })) : demoPcs()
    /* 新凭据登录出另一个已存在的 userId：那条记录会被整条顶替 */
    const displaced = nextUserId === userId ? undefined : state.accounts.find((a) => a.userId === nextUserId)

    const account: MockAccount = {
      userId: nextUserId,
      alias: body.alias?.trim() || DEMO_USER_NAME,
      userAccount,
      password: body.password,
      dot: 'ok',
      interval: previous.interval,
      banner: null,
      pointsWindow: { ...previous.pointsWindow },
      eaichat: { ok: true, msg: null },
      pcs,
      points: previous.points,
      tasks: seedTasks(),
    }
    applyAutoByPosition(account, toAccount(previous))

    /* 删旧加新：同 userId 的其它记录一并整条移除；不同 userId 时新记录落尾部 */
    state.accounts = state.accounts.filter((a) => a.userId !== userId && a.userId !== nextUserId)
    state.logs.delete(userId)
    if (nextUserId !== userId) state.logs.delete(nextUserId)

    if (nextUserId === userId) state.accounts.splice(nextIndex, 0, account)
    else state.accounts.push(account)

    state.logs.set(nextUserId, [])
    state.revision += 1
    if (displaced) {
      appendLog(
        null,
        'INFO',
        '账号',
        `本次修正凭据登录出的账号与已有账号 ${displaced.alias ? displaced.alias + ' ' + maskOf(displaced.userAccount) : maskOf(displaced.userAccount)} 是同一个天翼云账号（登录返回的 userId 相同）· 已按「只保留最后一次添加的账号信息」顶替原记录 · 它的配置与日志一并移除`,
      )
    }
    appendLog(
      nextUserId,
      'INFO',
      '账号',
      (sameAccount
        ? `账号 ${maskOf(userAccount)} 的凭据已更正并登录成功：仍然按「先删原账号、再加新账号」执行`
        : `账号 ${maskOf(previous.userAccount)} 已替换为 ${maskOf(userAccount)}`) +
        `（保活间隔 ${previous.interval} 分钟、积分时间窗口与各实例自动开关按位置继承；原账号的日志已清除）`,
    )

    return { revision: state.revision, account: toAccount(account), replacedAlias: null, warnings: [] } satisfies UpdateCredentialsResult
  },

  async relogin(userId) {
    const account = findAccount(userId)
    await sleep(latency(600, 500))
    account.dot = 'ok'
    account.banner = null
    account.eaichat = { ok: true, msg: null }
    if (!account.pcs.length) account.pcs = demoPcs()
    if (!account.points.pointsList.length) account.points = seedPoints()
    if (!account.tasks.length) account.tasks = seedTasks()
    account.pcs.forEach((pc) => {
      if (pc.auto && isCountedRun(pc.run)) {
        pc.left = account.interval * 60
        pc.nextAt = Date.now() + account.interval * 60 * 1000
      }
    })
    state.revision += 1
    appendLog(
      userId,
      'INFO',
      '账号',
      `${maskOf(account.userAccount)} 重试登录成功 · 已恢复该账号的自动任务排程 · 实例自动开关保持你上次设置的状态`,
    )
    return { revision: state.revision, account: toAccount(account) } satisfies ReloginResult
  },

  async deleteAccount(userId) {
    const account = findAccount(userId)
    await sleep(latency(250, 150))
    state.accounts = state.accounts.filter((a) => a.userId !== userId)
    state.logs.delete(userId)
    appendLog(
      null,
      'INFO',
      '账号',
      `已删除账号 ${maskOf(account.userAccount)} · 配置文件中该条（含 password）已整条移除并覆盖写盘 · 已取消该账号的全部排队与进行中任务 · 该账号的日志已随之删除`,
    )
    return null satisfies DeleteAccountResult
  },

  async updateSettings(userId, body) {
    const account = findAccount(userId)
    await sleep(latency(120, 120))
    const hasInterval = body.interval !== undefined
    const hasWindow = body.pointsWindow !== undefined
    if (!hasInterval && !hasWindow) throw new ApiError(ErrorCode.InvalidParam, '参数校验失败：至少传一个字段')

    /* 先全部校验再落库，避免 interval 已改、window 报错时出现半更新 */
    if (hasInterval) {
      const interval = body.interval as number
      if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MINUTES || interval > MAX_INTERVAL_MINUTES) {
        throw new ApiError(ErrorCode.InvalidParam, `保活间隔需为 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟`)
      }
    }
    if (hasWindow) {
      const { winStart, winEnd } = body.pointsWindow!
      if (!isHm(winStart) || !isHm(winEnd)) {
        throw new ApiError(ErrorCode.InvalidParam, '积分时间窗口格式需为 HH:mm')
      }
      if (winStart >= winEnd) throw new ApiError(ErrorCode.InvalidParam, '积分时间窗口起止时间倒置')
    }

    if (hasInterval) {
      const interval = body.interval as number
      account.interval = interval
      account.pcs.forEach((pc) => {
        if (pc.auto && isCountedRun(pc.run)) {
          pc.left = interval * 60
          pc.nextAt = Date.now() + interval * 60 * 1000
        } else {
          pc.left = null
        }
      })
    }

    if (hasWindow) {
      const { winStart, winEnd } = body.pointsWindow!
      account.pointsWindow = { winStart, winEnd }
    }

    state.revision += 1
    return { revision: state.revision, account: toAccount(account) } satisfies PatchSettingsResult
  },

  async listDesktops(userId) {
    const account = findAccount(userId)
    if (account.banner) throw new ApiError(ErrorCode.StateNotAllowed, '账号处于异常状态，暂时无法获取云电脑列表')
    await sleep(latency(320, 200))
    if (!account.pcs.length) account.pcs = demoPcs()
    /* 列表刷新会重算过渡态与倒计时；这里保持已有开关，新实例一律 auto=false */
    account.pcs.forEach((pc) => {
      if (pc.auto && isCountedRun(pc.run) && pc.nextAt == null) schedulePc(pc, account)
      if (!pc.auto || !isCountedRun(pc.run)) pc.left = null
    })
    state.refreshedAt = nowHm()
    state.revision += 1
    return { refreshedAt: state.refreshedAt, pcs: account.pcs.map(toPc) } satisfies DesktopsResult
  },

  async keepalive(userId, desktopId) {
    const account = findAccount(userId)
    /* banner 判定先于资源查找：报错账号下没有列表，仍应返回 10005 而不是 10003 */
    if (account.banner) throw new ApiError(ErrorCode.StateNotAllowed, '账号处于异常状态，暂时无法保活')
    const pc = findPc(account, desktopId)
    /* 拒绝顺序对齐真实后端（manager.keepalive）：run → link → eaichat */
    if (pc.run === 'stopped' || pc.run === 'starting' || pc.run === 'stopping') {
      throw new ApiError(ErrorCode.StateNotAllowed, `实例当前为「${pc.run}」状态，不允许保活`)
    }
    if (pc.link != null) throw new ApiError(ErrorCode.StateNotAllowed, '实例正被积分任务占用，本轮保活暂停')
    if (!account.eaichat.ok) {
      throw new ApiError(ErrorCode.EaichatUnavailable, account.eaichat.msg ?? '云智助手会话不可用，无感保活暂不可用')
    }

    await sleep(latency(380, 140))

    /* 演示用失败分支：固定让这台实例返回上游超时 */
    if (pc.desktopName.includes('支付')) {
      const failure = '保活失败：连接超时（step=ws-display code=ETIMEDOUT），本轮整轮作废，下个周期重试'
      /* 失败同样要落 lastAt/lastMsg（模型 §2.2 的“最近一次保活”包含失败） */
      pc.lastAt = Date.now()
      pc.lastMsg = failure
      appendLog(userId, 'ERROR', '保活', `${pc.desktopName} ${failure}`)
      throw new ApiError(ErrorCode.UpstreamNetwork, '保活请求失败：网络异常或超时，请稍后重试')
    }

    const elapsedMs = latency(380, 140)
    const lastAt = Date.now()
    const lastMsg = `保活成功 · 耗时 ${elapsedMs}ms`
    pc.lastAt = lastAt
    pc.lastMsg = lastMsg
    if (pc.auto) {
      pc.left = account.interval * 60
      pc.nextAt = Date.now() + account.interval * 60 * 1000
    } else {
      pc.left = null
      pc.nextAt = null
    }
    appendLog(userId, 'INFO', '保活', `${pc.desktopName} 保活成功 · 耗时 ${elapsedMs}ms`)

    return {
      revision: state.revision,
      desktopId,
      ok: true,
      elapsedMs,
      lastAt,
      lastMsg,
      left: pc.left,
    } satisfies KeepaliveResult
  },

  async setDesktopAuto(userId, desktopId, auto) {
    const account = findAccount(userId)
    /* banner 判定先于资源查找：报错账号一律 10005 */
    if (account.banner) throw new ApiError(ErrorCode.StateNotAllowed, '账号处于异常状态，暂时无法修改自动保活')
    const pc = findPc(account, desktopId)
    if (auto && (pc.run === 'stopped' || pc.run === 'starting' || pc.run === 'stopping')) {
      throw new ApiError(ErrorCode.StateNotAllowed, '实例当前状态不允许开启自动保活')
    }
    if (auto && !account.eaichat.ok) {
      throw new ApiError(ErrorCode.EaichatUnavailable, account.eaichat.msg ?? '云智助手会话不可用，无感保活暂不可用')
    }

    await sleep(auto ? latency(380, 160) : latency(80, 80))
    pc.auto = auto
    if (!auto) {
      pc.left = null
      pc.nextAt = null
    } else {
      /* 打开开关即由后端立即保活一次：running 与 error 都尝试 */
      const elapsedMs = latency(380, 140)
      if (pc.desktopName.includes('支付')) {
        pc.lastAt = Date.now()
        pc.lastMsg = '保活失败：连接超时（step=ws-display code=ETIMEDOUT），下个周期重试'
        appendLog(userId, 'WARN', '保活', `${pc.desktopName} ${pc.lastMsg}`)
      } else {
        pc.lastAt = Date.now()
        pc.lastMsg = `保活成功 · 耗时 ${elapsedMs}ms`
        if (pc.run === 'error') pc.run = 'running'
        appendLog(userId, 'INFO', '保活', `${pc.desktopName} 保活成功 · 耗时 ${elapsedMs}ms`)
      }
      pc.left = account.interval * 60
      pc.nextAt = Date.now() + account.interval * 60 * 1000
    }
    state.revision += 1
    appendLog(
      userId,
      'INFO',
      '保活',
      auto
        ? `已开启 ${pc.desktopName} 的自动保活（立即执行一次，随后每 ${account.interval} 分钟一轮）`
        : `已关闭 ${pc.desktopName} 的自动保活（该实例不再产生任何保活请求）`,
    )

    return { revision: state.revision, desktopId, auto, left: pc.left } satisfies SetDesktopAutoResult
  },

  async getPoints(userId) {
    const account = findAccount(userId)
    if (account.banner) throw new ApiError(ErrorCode.StateNotAllowed, '账号处于异常状态，暂时无法获取积分与任务')
    await sleep(latency(280, 200))
    const updatedDate = Date.now()
    account.points = { ...account.points, updatedDate }
    /* updatedDate 变化也是一次内存态变更，revision 必须 +1 */
    state.revision += 1
    return {
      points: structuredClone(account.points),
      tasks: structuredClone(account.tasks),
      updatedDate,
    } satisfies PointsResult
  },

  async runTask(userId, taskDefId) {
    const account = findAccount(userId)
    /* banner 判定先于资源查找 */
    if (account.banner) throw new ApiError(ErrorCode.StateNotAllowed, '账号处于异常状态，暂时无法执行任务')
    const task = findTask(account, taskDefId)
    /* 与真实后端一致：只有「与AI对话」类可代为执行，其余返回 10005 */
    if (!isMockExecutable(taskDefId)) {
      throw new ApiError(ErrorCode.StateNotAllowed, `该任务无法由工具代为执行：${mockUnsupportedReason(taskDefId)}`)
    }
    if (task.status === 2) throw new ApiError(ErrorCode.StateNotAllowed, '该任务今日已完成，不再重复执行')
    if (task.status === 1) {
      throw new ApiError(ErrorCode.StateNotAllowed, '该任务已完成，积分正在发放，无需重复执行')
    }
    if (task.status === 3) throw new ApiError(ErrorCode.StateNotAllowed, '该任务已失效，无需执行')
    /* 拒绝顺序与真实后端一致：状态 → 在途 → 云智助手会话（在途优先于 10008） */
    if (task.busy) throw new ApiError(ErrorCode.StateNotAllowed, '该任务正在执行中，请稍候')
    /* 与真实后端同口径：云智助手会话不可用时 10008（「助手异常号」演示这个分支） */
    if (!account.eaichat.ok) {
      throw new ApiError(ErrorCode.EaichatUnavailable, account.eaichat.msg ?? '云智助手会话不可用，无感保活暂不可用')
    }
    task.busy = true
    state.revision += 1
    appendLog(userId, 'INFO', '积分', `${task.taskDefName} 已受理，开始执行`)

    /* 异步受理：响应即返回；执行约 1.5s + 复查 5s，状态经后续 getPoints / 日志回显 */
    setTimeout(() => {
      const current = state.accounts.find((a) => a.userId === userId)
      const currentTask = current?.tasks.find((t) => t.taskDefId === taskDefId)
      if (!current || !currentTask) return
      currentTask.busy = false
      currentTask.status = 2
      /* 完成态同步进度与积分合计，UI 观察项 */
      currentTask.currentProgress = currentTask.totalProgress
      const reward = currentTask.pointsList.reduce((sum, item) => sum + item.value, 0)
      const pointsList = current.points.pointsList.map((item) => ({ ...item }))
      const general = pointsList.find((item) => item.pointType === 1)
      if (general) general.points += reward
      else pointsList.push({ pointType: 1, pointTypeName: '通用积分', points: reward })
      current.points = { ...current.points, pointsList, updatedDate: Date.now() }
      state.revision += 1
      appendLog(
        userId,
        'INFO',
        '积分',
        `${currentTask.taskDefName} 执行成功 · 已到账 ${reward} 通用积分（同一天重复对话不重复加分）`,
      )
    }, 4000)

    return { revision: state.revision, taskDefId, busy: true } satisfies RunTaskResult
  },

  async setTaskAuto(userId, taskDefId, auto) {
    const account = findAccount(userId)
    const task = account.tasks.find((item) => item.taskDefId === taskDefId)

    /* 关闭永远允许：任务已不在列表（banner 清空/已下线）时也算清理偏好成功 */
    if (!task && !auto) return { revision: state.revision, taskDefId, auto: false } satisfies SetTaskAutoResult
    if (!task) throw new ApiError(ErrorCode.TaskNotFound, '任务不存在，请刷新后重试')

    /* 打开才受账号状态与在途执行限制：banner 期间关闭同样允许（与真实后端同口径） */
    if (auto && account.banner) {
      throw new ApiError(ErrorCode.StateNotAllowed, '账号处于异常状态，暂时无法修改任务自动开关')
    }
    if (auto && task.busy) throw new ApiError(ErrorCode.StateNotAllowed, '该任务正在执行中，请稍后再切换自动开关')

    await sleep(latency(80, 80))
    task.auto = auto
    state.revision += 1
    appendLog(userId, 'INFO', '积分', `${task.taskDefName} 已${auto ? '开启' : '关闭'}自动执行`)
    return { revision: state.revision, taskDefId, auto } satisfies SetTaskAutoResult
  },

  async queryLogs(query: LogQuery) {
    await sleep(latency(60, 60))
    let source: LogEntry[] = []
    if (query.userId !== undefined) {
      /* 与真实后端同口径：账号已不存在（删除/顶替）时给空结果，不抛 10002 */
      source = [...(state.logs.get(query.userId) ?? [])]
    } else {
      for (const account of state.accounts) source.push(...(state.logs.get(account.userId) ?? []))
    }
    if (query.includeSys) source.push(...state.syslogs)

    const kw = query.kw?.trim().toLowerCase()
    const filtered = source.filter((entry) => {
      if (query.lv && entry.lv !== query.lv) return false
      if (query.mod && entry.mod !== query.mod) return false
      if (kw && !`${entry.msg} ${entry.mod}`.toLowerCase().includes(kw)) return false
      if (query.sinceSeq !== undefined && entry.seq <= query.sinceSeq) return false
      return true
    })
    filtered.sort((a, b) => b.seq - a.seq)

    const limit = Math.min(1000, Math.max(1, query.limit ?? 200))
    return {
      total: filtered.length,
      rows: filtered.slice(0, limit).map((entry) => ({ ...entry })),
    } satisfies LogsResult
  },

  async clearLogs(userId) {
    const account = findAccount(userId)
    state.logs.set(userId, [])
    appendLog(
      null,
      'INFO',
      '系统',
      `已清空 ${maskOf(account.userAccount)} 的界面日志 · 磁盘上的日志文件不受影响`,
    )
    return null satisfies LogsClearResult
  },
}
