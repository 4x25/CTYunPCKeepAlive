/**
 * 积分任务编排（backend-design §4.2）。
 *
 * 事实基线（docs/research/points-tasks.md）：
 *   - 没有「执行任务」接口；只有 1004/1102「与AI对话1次」能靠 eaichat 发一轮对话完成
 *   - 1002 需真实桌面会话、1003/1105/1106 需会话在线累计时长、1101 需人工绑定 → 工具不代为执行
 *   - 执行前必须 getTaskList 复查 status；复查失败顺延 10 分钟，绝不盲发
 *   - 执行后 3–5s 到账；5s 复查一次、再 15s 复查一次（最多 2 次）
 *
 * 调度模型：**每账号一条 setTimeout 链**，每天在 pointsWindow 内随机取一个起跑时刻。
 *   - 起跑前复查 → 只执行 auto=true 且未完成（status=0）且可自动执行的任务
 *   - 失败/复查失败 → 10 分钟后重试（同日最多 2 次）
 *   - 当天收口 → 排到次日窗口
 *   - 进程重启不重复执行：靠起跑前复查 status 兜底，不持久化 lastRunDate
 */
import { DEFAULT_POINTS_WINDOW, ErrorCode } from '../../shared/constants'
import type { PointTask } from '../../shared/types'
import { formatHm, isHm } from '../../shared/utils'
import { ApiError } from '../envelope'
import { UpstreamError, UpstreamNetworkError } from '../upstream/errors'
import { isExecutableTask, rewardText, unsupportedReason } from './points'
import type { AccountSession } from './session'

/** 复查失败/执行失败后的顺延间隔 */
const RETRY_DELAY_MS = 10 * 60_000
/** 同日最多重试次数（不含首轮） */
const MAX_RETRIES_PER_DAY = 2
/** 执行后复查的两次延迟（累计 5s / 20s；research §6.2） */
const VERIFY_DELAYS_MS = [5_000, 15_000]
/** 单轮对话超时（实测 3–5s 完成；异常网络留余量） */
const CHAT_TIMEOUT_MS = 30_000
/** 会话不可用时静默重登的预算 */
const RELOGIN_BUDGET_MS = 20_000
/** 排程最短延迟：非法/已过去的时间戳不得落成 setTimeout(0) 的热循环 */
const MIN_SCHEDULE_DELAY_MS = 1_000

type RoundOutcome = 'done' | 'retry'

interface Plan {
  session: AccountSession
  timer: ReturnType<typeof setTimeout> | null
  /** 0 = 未安排 */
  nextFireAt: number
  /** 自动轮次在途 */
  inFlight: boolean
  /** 已完成自动执行的日期（YYYY-MM-DD，本地时区） */
  doneDay: string | null
  /** 重试计数所属日期与次数 */
  retryDay: string | null
  retries: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 本地日期键（按天去重/计数用） */
function dayKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function addDays(base: Date, days: number): Date {
  const date = new Date(base)
  date.setDate(date.getDate() + days)
  return date
}

/**
 * 时间窗口是否可用于排程：格式必须是合法 HH:mm 且起止不倒置。
 * 配置被外部改坏时 nextWindowInstant 一律回退默认窗口（绝不返回 NaN）。
 */
export function isUsableWindow(win: { winStart: string; winEnd: string }): boolean {
  return isHm(win.winStart) && isHm(win.winEnd) && win.winStart < win.winEnd
}

/** "HH:mm" → 指定日期的本地时间戳（调用方保证格式合法，见 isUsableWindow） */
function hmAt(hm: string, base: Date): number {
  const [h, m] = hm.split(':').map(Number)
  const date = new Date(base)
  date.setHours(h, m, 0, 0)
  return date.getTime()
}

function randomBetween(from: number, to: number): number {
  if (to <= from) return from
  return from + Math.floor(Math.random() * (to - from))
}

/**
 * 窗口内随机起跑时刻。
 * - `fromTomorrow=true`：只在次日窗口内取（当天已收口）
 * - 否则今天窗口内取；窗口已过则顺延到次日
 * 末尾留 60s 余量，避免起跑时刻正好撞窗口边界。
 * 窗口非法（NaN/越界）时回退 DEFAULT_POINTS_WINDOW：NaN 会落成 setTimeout(0) 热循环。
 */
export function nextWindowInstant(
  win: { winStart: string; winEnd: string },
  now: Date = new Date(),
  fromTomorrow = false,
): number {
  const { winStart, winEnd } = isUsableWindow(win) ? win : DEFAULT_POINTS_WINDOW
  const todayStart = hmAt(winStart, now)
  const todayEnd = hmAt(winEnd, now)

  /* 今天窗口还没结束：在 [max(now, start), end) 内随机 */
  if (!fromTomorrow && now.getTime() < todayEnd) {
    return pickInWindow(todayStart, todayEnd, Math.max(now.getTime(), todayStart))
  }

  const tomorrow = addDays(now, 1)
  return pickInWindow(hmAt(winStart, tomorrow), hmAt(winEnd, tomorrow), hmAt(winStart, tomorrow))
}

/** 在 [max(from, start), end - 60s] 内随机；窗口过窄时退回 from */
function pickInWindow(start: number, end: number, from: number): number {
  const upper = Math.max(start + 1_000, end - 60_000)
  if (upper <= from) return from
  return randomBetween(from, upper)
}

/** 上游错误 → 固定文案（绝不回显上游原文） */
function failureSuffix(error: unknown): string {
  if (error instanceof UpstreamNetworkError) return '网络异常或超时'
  if (error instanceof UpstreamError) {
    if (error.message === '对话内容被审计拦截') return '对话内容被安全审计拦截'
    if (error.message === '对话未正常结束') return '对话未正常结束（未收到完成信号）'
    if (error.code === 40010) return '云智助手会话不可用'
    if ([51030, 51031, 51040, 51085].includes(error.code)) return '账号需要人工完成验证码验证'
    return `上游返回错误（code=${error.code}）`
  }
  return '未知错误'
}

/** 发一轮对话并校验完成信号；审计拦截/未正常结束按失败抛出（不含消息内容） */
async function assertChatOk(
  client: NonNullable<ReturnType<AccountSession['getEaichatClient']>>,
  timeoutMs: number,
): Promise<void> {
  const result = await client.chatOnce({ timeoutMs })
  if (result.ok) return
  if (result.audit === 'block') throw new UpstreamError(40050, '对话内容被审计拦截')
  throw new UpstreamError(-1, '对话未正常结束')
}

export class TaskRunner {
  private readonly plans = new Map<AccountSession, Plan>()
  /** 手动执行前复查失败后的顺延队列（每账号一条定时器） */
  private readonly deferred = new Map<
    AccountSession,
    { timer: ReturnType<typeof setTimeout> | null; tasks: Set<number> }
  >()
  private closed = false
  private exitHookInstalled = false

  constructor() {
    /* dev HMR 会重新求值本模块：先关掉上一份实例的定时器，避免双份计划 */
    const holder = globalThis as typeof globalThis & { __ctkaTaskRunner?: TaskRunner }
    holder.__ctkaTaskRunner?.close()
    holder.__ctkaTaskRunner = this
  }

  /* ── 生命周期 ───────────────────────────────────────────── */

  private installExitHook(): void {
    if (this.exitHookInstalled) return
    this.exitHookInstalled = true
    process.once('exit', () => this.close())
  }

  close(): void {
    this.closed = true
    for (const plan of this.plans.values()) this.clearTimer(plan)
    this.plans.clear()
    for (const item of this.deferred.values()) if (item.timer) clearTimeout(item.timer)
    this.deferred.clear()
  }

  /** 账号删除 / 会话替换 / 登录失败：取消该会话的任务计划 */
  dropSession(session: AccountSession): void {
    const plan = this.plans.get(session)
    if (plan) this.clearTimer(plan)
    this.plans.delete(session)
    const deferred = this.deferred.get(session)
    if (deferred?.timer) clearTimeout(deferred.timer)
    this.deferred.delete(session)
  }

  /* ── 计划同步（登录成功 / 开关 / 窗口变化后调用） ───────── */

  /**
   * 按当前会话对齐计划：
   *   - 已登录、无 banner、存在 auto=true 的可自动执行任务 → 保证有计划
   *   - 其余 → 取消计划（开关保留在配置里，等条件恢复后重新排程）
   * 已有定时器 / 在途轮次不重排（避免用户反复切开关导致起跑时刻漂移）。
   */
  syncSession(session: AccountSession): void {
    if (this.closed) return
    this.installExitHook()
    const plan = this.plans.get(session)
    if (!this.needsPlan(session)) {
      if (plan) {
        this.clearTimer(plan)
        this.plans.delete(session)
      }
      return
    }
    const fresh = !plan
    const current = plan ?? this.ensurePlan(session)
    if (current.inFlight || current.timer) return
    this.scheduleNext(current)
    if (fresh && current.nextFireAt) {
      const win = session.pointsWindowSnapshot
      /* 窗口非法时排程已回退默认窗口：日志同步显示实际生效的窗口 */
      const shown = isUsableWindow(win) ? win : DEFAULT_POINTS_WINDOW
      const at = new Date(current.nextFireAt)
      const when = dayKey(at) === dayKey() ? '今日' : '明日'
      session.log(
        'INFO',
        '调度',
        `积分任务自动执行已排程：${when} ${formatHm(current.nextFireAt)} 起跑（窗口 ${shown.winStart}–${shown.winEnd}，起跑前会先复查任务状态）`,
      )
    }
  }

  /** 4.6 修改时间窗口：按新窗口重排（当天已收口则排次日） */
  applyWindow(session: AccountSession): void {
    const plan = this.plans.get(session)
    if (!plan) {
      this.syncSession(session)
      return
    }
    if (plan.inFlight) return
    this.scheduleNext(plan)
  }

  /** 账号是否仍可执行任务：已登录且不处于 banner（删除/登录失败后立即失效） */
  private canRun(session: AccountSession): boolean {
    return session.isLoggedIn && !session.hasBanner
  }

  /** 是否需要为该会话保留自动计划（登录成功、无 banner、存在可自动执行的任务） */
  private needsPlan(session: AccountSession): boolean {
    if (!session.isLoggedIn || session.hasBanner) return false
    /* 用持久化的开关判断（任务表可能尚未拉到）：只有可代为执行的任务才排计划 */
    return session.autoTaskDefIds.some((taskDefId) => isExecutableTask(taskDefId))
  }

  private ensurePlan(session: AccountSession): Plan {
    const existing = this.plans.get(session)
    if (existing) return existing
    const plan: Plan = {
      session,
      timer: null,
      nextFireAt: 0,
      inFlight: false,
      doneDay: null,
      retryDay: null,
      retries: 0,
    }
    this.plans.set(session, plan)
    return plan
  }

  private scheduleNext(plan: Plan, delayMs?: number): void {
    if (this.closed) return
    const session = plan.session
    let at: number
    if (delayMs != null) {
      at = Date.now() + delayMs
    } else {
      const win = session.pointsWindowSnapshot
      if (!isUsableWindow(win)) {
        /* 配置被外部改成非法 HH:mm：回退默认窗口排程（NaN 会导致 setTimeout 立即触发） */
        session.log(
          'WARN',
          '积分',
          `积分任务时间窗口（${win.winStart}–${win.winEnd}）不合法，已按默认窗口 ${DEFAULT_POINTS_WINDOW.winStart}–${DEFAULT_POINTS_WINDOW.winEnd} 重新排程（配置文件未改动）`,
        )
      }
      at = nextWindowInstant(win, new Date(), plan.doneDay === dayKey())
    }
    this.scheduleAt(plan, at)
  }

  private scheduleAt(plan: Plan, at: number): void {
    if (this.closed) return
    this.clearTimer(plan)
    /* 兜底：NaN/已过去的时间戳一律不落成 setTimeout(0)（热循环），最短也隔 1s */
    const delay = Number.isFinite(at) ? Math.max(MIN_SCHEDULE_DELAY_MS, at - Date.now()) : MIN_SCHEDULE_DELAY_MS
    plan.nextFireAt = Date.now() + delay
    const timer = setTimeout(() => {
      plan.timer = null
      void this.autoRun(plan)
    }, delay)
    timer.unref?.()
    plan.timer = timer
  }

  private clearTimer(plan: Plan): void {
    if (plan.timer) {
      clearTimeout(plan.timer)
      plan.timer = null
    }
    plan.nextFireAt = 0
  }

  /* ── 自动轮次 ───────────────────────────────────────────── */

  private async autoRun(plan: Plan): Promise<void> {
    const session = plan.session
    if (this.closed || this.plans.get(session) !== plan) return
    if (!this.needsPlan(session)) {
      this.plans.delete(session)
      return
    }
    /* 当天已收口（或被反复调度）：直接排次日 */
    if (plan.doneDay === dayKey()) {
      this.scheduleNext(plan)
      return
    }

    plan.inFlight = true
    let outcome: RoundOutcome
    try {
      outcome = await this.runAutoRound(session)
    } catch (error) {
      if (!this.canRun(session)) {
        /* 轮次中账号被删除/登录失败：静默收口，不留幽灵日志（计划随 dispose 一并清理） */
        outcome = 'done'
      } else {
        session.log('WARN', '积分', `自动任务起跑前复查失败：${failureSuffix(error)}，10 分钟后重试（不盲发）`)
        outcome = 'retry'
      }
    } finally {
      plan.inFlight = false
    }

    if (this.plans.get(session) !== plan) return

    if (outcome === 'retry') {
      if (plan.retryDay !== dayKey()) {
        plan.retryDay = dayKey()
        plan.retries = 0
      }
      plan.retries += 1
      if (plan.retries > MAX_RETRIES_PER_DAY) {
        session.log('WARN', '积分', `自动任务今日已连续失败 ${plan.retries} 次，今日放弃，明日窗口内再试`)
        plan.doneDay = dayKey()
        plan.retries = 0
        this.scheduleNext(plan)
      } else {
        this.scheduleNext(plan, RETRY_DELAY_MS)
      }
      return
    }

    /* done：当天收口，排次日 */
    if (outcome === 'done') plan.doneDay = dayKey()
    plan.retries = 0
    this.scheduleNext(plan)
  }

  /**
   * 自动轮次：先复查（getTaskList），再逐个执行可自动执行且未完成（status=0）的任务。
   * 复查失败直接抛错（由 autoRun 顺延），不盲发执行。
   */
  private async runAutoRound(session: AccountSession): Promise<RoundOutcome> {
    /* eaichat 需人工验证（验证码/短信/设备绑定）：自动轮次不静默重登，直接放弃本轮 */
    const manual = session.eaichatManualLabel
    if (manual) {
      session.log(
        'WARN',
        '积分',
        `本轮放弃：云智助手会话需要你本人完成${manual}验证，自动轮次不会静默重登 · 今日不再自动重试（完成验证后重新登录该账号即可恢复）`,
      )
      return 'done'
    }

    const tasks = await session.refreshTasks()
    /* 口径与手动/顺延一致：只有 status=0（未完成）才执行；1=待领取、2=已领取、3=已失效一律跳过 */
    const candidates = tasks.filter(
      (task) => isExecutableTask(task.taskDefId) && session.isTaskAuto(task.taskDefId) && task.status === 0,
    )
    if (!candidates.length) {
      const pending = tasks.filter(
        (task) => isExecutableTask(task.taskDefId) && session.isTaskAuto(task.taskDefId),
      )
      session.log(
        'INFO',
        '积分',
        pending.length
          ? '起跑前复查：可自动执行的任务无需执行（已完成/已失效），本轮跳过'
          : '起跑前复查：没有可自动执行的任务，本轮跳过',
      )
      return 'done'
    }

    let failed = false
    for (const [index, task] of candidates.entries()) {
      if (index > 0) await sleep(1_500)
      if (!this.canRun(session)) return failed ? 'retry' : 'done'
      /* 前一个任务执行期间任务表可能已刷新：以最新状态为准 */
      const latest = session.findTask(task.taskDefId) ?? task
      if (latest.status !== 0) continue
      const result = await this.executeOne(session, latest, 'auto')
      if (result === 'failed') failed = true
    }
    return failed ? 'retry' : 'done'
  }

  /**
   * 执行单个任务并复查确认。
   * `slot`：'acquire' 由本方法占位（自动轮次）；'held' 表示调用方已占位（手动受理）。
   * 返回 'skipped' = 已有在途执行 / 账号已不可用，未发对话。
   */
  private async executeOne(
    session: AccountSession,
    task: PointTask,
    reason: 'auto' | 'manual',
    slot: 'acquire' | 'held' = 'acquire',
  ): Promise<'ok' | 'failed' | 'skipped'> {
    /* 账号已删除/登录失败/出现 banner：直接放弃，连「开始执行」都不写，避免幽灵日志 */
    if (!this.canRun(session)) return 'skipped'
    /* 自动轮次的 eaichat 需人工验证已在 runAutoRound 拦过；轮次中途才出现的同样不重登 */
    if (reason === 'auto' && session.eaichatManualLabel && !session.getEaichatClient()) return 'skipped'
    if (slot === 'acquire' && !session.beginTaskRun(task.taskDefId)) return 'skipped'
    const startedAt = Date.now()
    const label = task.taskDefName
    try {
      session.log('INFO', '积分', `${label} 开始执行（${reason === 'manual' ? '手动' : '自动'}）`)

      /* 会话不可用：静默重登一次；仍失败按执行失败处理（不阻断其他任务） */
      if (!session.getEaichatClient()) {
        if (!this.canRun(session)) return 'skipped'
        try {
          await session.silentReloginEaichat(RELOGIN_BUDGET_MS)
        } catch (error) {
          session.log('WARN', '积分', `${label} 执行失败：云智助手会话不可用（${failureSuffix(error)}）`)
          return 'failed'
        }
      }

      try {
        await this.chatWithRelogin(session, CHAT_TIMEOUT_MS)
      } catch (error) {
        if (
          error instanceof UpstreamError &&
          (error.code === 40010 || [51030, 51031, 51040, 51085, 51090, 51091].includes(error.code))
        ) {
          /* 会话失效/静默重登失败（含验证码风控）：与保活同口径降低账号可用度，不反复重试 */
          session.markEaichatFailure(error)
        }
        session.log('WARN', '积分', `${label} 执行失败：${failureSuffix(error)}`)
        return 'failed'
      }

      /* 执行后复查：3–5s 到账，5s 后查一次、再等 15s 查一次（research §6.2） */
      for (const delay of VERIFY_DELAYS_MS) {
        await sleep(delay)
        /* 复查前账号可能已被删除/登录失败：不再发请求，也不写「未到账」这类幽灵日志 */
        if (!this.canRun(session)) return 'skipped'
        try {
          await session.refreshTasks()
        } catch {
          /* 复查失败不判定失败：继续等下一次 */
          continue
        }
        const latest = session.findTask(task.taskDefId)
        if (latest?.status === 2) {
          session.log(
            'INFO',
            '积分',
            `${label} 执行成功 · 已到账 ${rewardText(latest.pointsList)} · 耗时 ${Math.max(
              0,
              Date.now() - startedAt,
            )}ms`,
          )
          return 'ok'
        }
      }

      if (!this.canRun(session)) return 'skipped'
      session.log('WARN', '积分', `${label} 已发起对话，但任务状态未在两次复查（约 20 秒）内更新（稍后刷新确认）`)
      return 'failed'
    } finally {
      session.endTaskRun(task.taskDefId)
    }
  }

  /** 发一轮对话；HTTP 401 / 40010 静默重登后重试一次（research §6.3 第 4 条） */
  private async chatWithRelogin(session: AccountSession, timeoutMs: number): Promise<void> {
    const client = session.getEaichatClient()
    if (!client) throw new UpstreamError(40010, '云智助手未登录')
    try {
      await assertChatOk(client, timeoutMs)
      return
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.code !== 40010) throw error
    }

    /* 账号已不可用时不重登（否则会在已删除的账号上打登录请求） */
    if (!this.canRun(session)) return
    await session.silentReloginEaichat(Math.max(5_000, Math.floor(timeoutMs / 2)))
    const next = session.getEaichatClient()
    if (!next) throw new UpstreamError(40010, '云智助手未登录')
    await assertChatOk(next, timeoutMs)
  }

  /* ── 4.11 手动执行 ──────────────────────────────────────── */

  /**
   * 手动受理：校验任务 → 占位 → 立即返回 busy=true，后台执行。
   * 执行前复查 status（拒绝用缓存盲发）；复查失败顺延 10 分钟一次。
   */
  acceptManual(session: AccountSession, taskDefId: number): void {
    if (session.hasBanner) {
      throw new ApiError(ErrorCode.StateNotAllowed, '账号处于异常状态，暂时无法执行任务')
    }
    const task = session.findTask(taskDefId)
    if (!task) throw new ApiError(ErrorCode.TaskNotFound, '任务不存在，请刷新后重试')
    if (!isExecutableTask(taskDefId)) {
      throw new ApiError(
        ErrorCode.StateNotAllowed,
        `该任务无法由工具代为执行：${unsupportedReason(taskDefId) ?? '请到官方客户端完成'}`,
      )
    }
    if (task.status === 2) {
      throw new ApiError(ErrorCode.StateNotAllowed, '该任务今日已完成，不再重复执行')
    }
    if (task.status === 1) {
      throw new ApiError(ErrorCode.StateNotAllowed, '该任务已完成，积分正在发放，无需重复执行')
    }
    if (task.status === 3) {
      throw new ApiError(ErrorCode.StateNotAllowed, '该任务已失效，无需执行')
    }
    /* 拒绝顺序：状态 → 在途 → 会话（与 api-mock 同口径）；在途优先于 10008 */
    const busyError = () => new ApiError(ErrorCode.StateNotAllowed, '该任务正在执行中，请稍候')
    if (session.isTaskRunning(taskDefId)) throw busyError()
    /* 与 4.8 同口径：云智助手会话未就绪时明确回 10008（会话失效的静默重登由执行期兜底） */
    if (!session.isEaichatReady) {
      throw new ApiError(ErrorCode.EaichatUnavailable, '云智助手会话不可用，积分任务暂不可执行')
    }
    /* 以上只是预检：占位本身仍是原子的，并发双击只有一个能拿到 */
    if (!session.beginTaskRun(taskDefId)) throw busyError()
    void this.runManual(session, task)
  }

  private async runManual(session: AccountSession, task: PointTask): Promise<void> {
    if (!this.canRun(session)) {
      /* 受理后账号被删除/登录失败：直接释放占位，不写幽灵日志 */
      session.endTaskRun(task.taskDefId)
      return
    }
    session.log('INFO', '积分', `${task.taskDefName} 已受理，开始执行`)
    try {
      /* 执行前必先复查：本地缓存可能过期（官方客户端已完成 / 跨天残留） */
      await session.refreshTasks()
    } catch (error) {
      session.endTaskRun(task.taskDefId)
      session.log(
        'WARN',
        '积分',
        `${task.taskDefName} 执行前复查失败：${failureSuffix(error)}，已顺延 10 分钟重试（不盲发）`,
      )
      this.deferAfterManualFailure(session, task.taskDefId)
      return
    }

    const latest = session.findTask(task.taskDefId)
    if (!latest) {
      session.endTaskRun(task.taskDefId)
      session.log('WARN', '积分', `${task.taskDefName} 已不在任务列表中，本次执行取消`)
      return
    }
    if (latest.status === 2) {
      session.endTaskRun(task.taskDefId)
      session.log('INFO', '积分', `${task.taskDefName} 已确认完成（可能已在官方客户端完成），本次不再执行`)
      return
    }
    if (latest.status === 1) {
      session.endTaskRun(task.taskDefId)
      session.log('INFO', '积分', `${task.taskDefName} 复查已完成，积分发放中，本次不再执行`)
      return
    }
    if (latest.status === 3) {
      session.endTaskRun(task.taskDefId)
      session.log('INFO', '积分', `${task.taskDefName} 已失效，本次执行取消`)
      return
    }
    await this.executeOne(session, latest, 'manual', 'held')
  }

  /** 手动执行前复查失败：10 分钟后重试一次（仍以复查先行，不盲发） */
  private deferAfterManualFailure(session: AccountSession, taskDefId: number): void {
    if (this.closed || !session.isLoggedIn || session.hasBanner) return
    this.installExitHook()
    let deferred = this.deferred.get(session)
    if (!deferred) {
      deferred = { timer: null, tasks: new Set() }
      this.deferred.set(session, deferred)
    }
    deferred.tasks.add(taskDefId)
    if (deferred.timer) return
    this.scheduleDeferred(session, deferred, RETRY_DELAY_MS)
  }

  private scheduleDeferred(
    session: AccountSession,
    deferred: { timer: ReturnType<typeof setTimeout> | null; tasks: Set<number> },
    delayMs: number,
  ): void {
    if (this.closed) return
    const timer = setTimeout(() => {
      deferred.timer = null
      void this.runDeferred(session, deferred)
    }, Math.max(0, delayMs))
    timer.unref?.()
    deferred.timer = timer
  }

  private async runDeferred(
    session: AccountSession,
    deferred: { timer: ReturnType<typeof setTimeout> | null; tasks: Set<number> },
  ): Promise<void> {
    if (this.closed || this.deferred.get(session) !== deferred) return
    if (!session.isLoggedIn || session.hasBanner) {
      this.deferred.delete(session)
      return
    }
    const pending = [...deferred.tasks]
    deferred.tasks.clear()
    if (!pending.length) {
      this.deferred.delete(session)
      return
    }

    try {
      await session.refreshTasks()
    } catch (error) {
      session.log(
        'WARN',
        '积分',
        `手动任务顺延复查仍失败：${failureSuffix(error)}，已停止本次重试（请稍后手动刷新）`,
      )
      this.deferred.delete(session)
      return
    }

    for (const taskDefId of pending) {
      const latest = session.findTask(taskDefId)
      if (!latest) continue
      if (latest.status !== 0) {
        session.log(
          'INFO',
          '积分',
          latest.status === 2
            ? `${latest.taskDefName} 已确认完成（顺延复查），本次不再执行`
            : `${latest.taskDefName} 当前状态无需执行（顺延复查）`,
        )
        continue
      }
      const result = await this.executeOne(session, latest, 'manual')
      if (result === 'failed') {
        session.log('WARN', '积分', `${latest.taskDefName} 顺延执行仍未确认完成，请稍后手动刷新或到官方客户端查看`)
      }
    }
    this.deferred.delete(session)
  }
}

/** 全局单例：与 manager / scheduler 共用一份编排状态 */
export const taskRunner = new TaskRunner()
