/**
 * 云智助手 Token 自动签到（仅每日签到 3001）。
 *
 * 网页的每日签到在北京时间 00:00 重置；本工具在每天 00:10 后检查一次：
 *   - 任务 canReceive=true（跨天后未签到）→ 调 receivePointsV2；
 *   - canReceive=false（今天已经签过）→ 记录当天已完成，不再重复请求；
 *   - 网络/会话失败 → 10 分钟后重试，最多 6 次，之后等次日。
 *
 * 登录成功或用户打开自动开关时会立即检查一次（当天已签到则只读不写）；
 * 这样应用在白天启动也能补签，而进程重启不会重复签到。
 */
import { TOKEN_DAILY_TASK_ID } from '../../shared/constants'
import { UpstreamError, UpstreamNetworkError } from '../upstream/errors'
import type { AccountSession } from './session'

/** 每天自动检查的时刻（本地时区，00:10；确保上游跨天任务已重置） */
const DAILY_CHECK_HOUR = 0
const DAILY_CHECK_MINUTE = 10
const RETRY_DELAY_MS = 10 * 60_000
const MAX_RETRIES = 6

interface Plan {
  session: AccountSession
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  /** 已完成检查的本地日期（YYYY-MM-DD） */
  lastCheckDay: string | null
  retries: number
}

const dayKey = (date: Date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** 下一次每日检查时间：今天 00:10 已过则取明天 00:10 */
function nextDailyCheckAt(now = Date.now()): number {
  const date = new Date(now)
  date.setHours(DAILY_CHECK_HOUR, DAILY_CHECK_MINUTE, 0, 0)
  if (date.getTime() <= now) date.setDate(date.getDate() + 1)
  return date.getTime()
}

function failureSuffix(error: unknown): string {
  if (error instanceof UpstreamNetworkError) return '网络异常或超时'
  if (error instanceof UpstreamError) {
    if (error.code === 40010) return '云智助手会话不可用'
    return `上游返回错误（code=${error.code}）`
  }
  return error instanceof Error && error.message ? error.message : '未知错误'
}

export class TokenAutoRunner {
  private readonly plans = new Map<AccountSession, Plan>()
  private closed = false
  private exitHookInstalled = false

  constructor() {
    /* dev HMR 会重新求值本模块：先关掉上一份实例的定时器，避免双份计划 */
    const holder = globalThis as typeof globalThis & { __ctkaTokenAutoRunner?: TokenAutoRunner }
    holder.__ctkaTokenAutoRunner?.close()
    holder.__ctkaTokenAutoRunner = this
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return
    this.exitHookInstalled = true
    process.once('exit', () => this.close())
  }

  close(): void {
    this.closed = true
    for (const plan of this.plans.values()) {
      if (plan.timer) clearTimeout(plan.timer)
    }
    this.plans.clear()
  }

  dropSession(session: AccountSession): void {
    const plan = this.plans.get(session)
    if (plan?.timer) clearTimeout(plan.timer)
    this.plans.delete(session)
  }

  /** 登录成功 / 开关变化 / 会话恢复后调用：按需安排自动签到 */
  syncSession(session: AccountSession): void {
    if (this.closed) return
    const enabled = session.isLoggedIn && !session.hasBanner && session.isTokenTaskAuto(TOKEN_DAILY_TASK_ID)
    if (!enabled) {
      this.dropSession(session)
      return
    }
    this.installExitHook()
    const plan = this.ensurePlan(session)
    if (plan.inFlight || plan.timer) return
    this.schedule(plan)
  }

  private ensurePlan(session: AccountSession): Plan {
    const existing = this.plans.get(session)
    if (existing) return existing
    const plan: Plan = { session, timer: null, inFlight: false, lastCheckDay: null, retries: 0 }
    this.plans.set(session, plan)
    return plan
  }

  private schedule(plan: Plan): void {
    if (this.closed) return
    if (plan.timer) clearTimeout(plan.timer)
    const now = Date.now()
    let delay: number
    if (plan.lastCheckDay !== dayKey()) {
      /* 当天还没检查过：若在 00:10 之前则等到 00:10，否则立即补查 */
      const todayCheck = new Date(now)
      todayCheck.setHours(DAILY_CHECK_HOUR, DAILY_CHECK_MINUTE, 0, 0)
      delay = todayCheck.getTime() > now ? todayCheck.getTime() - now : 1_000
    } else {
      delay = Math.max(1_000, nextDailyCheckAt(now) - now)
    }
    plan.timer = setTimeout(() => {
      plan.timer = null
      void this.run(plan)
    }, delay)
    plan.timer.unref?.()
  }

  private async run(plan: Plan): Promise<void> {
    if (this.closed || this.plans.get(plan.session) !== plan) return
    const session = plan.session
    if (!session.isLoggedIn || session.hasBanner || !session.isTokenTaskAuto(TOKEN_DAILY_TASK_ID)) {
      this.dropSession(session)
      return
    }
    if (session.isTokenTaskRunning(TOKEN_DAILY_TASK_ID)) {
      /* 用户手动签到在途：稍后再看结果，不并发 */
      this.schedule(plan)
      return
    }

    plan.inFlight = true
    try {
      const snapshot = await session.refreshToken()
      const task = snapshot.tasks.find((item) => item.taskDefId === TOKEN_DAILY_TASK_ID)
      if (!task) throw new Error('每日签到任务未下发')
      if (task.canReceive && task.status === 0) {
        await session.checkinTokenTask(TOKEN_DAILY_TASK_ID)
      }
      plan.lastCheckDay = dayKey()
      plan.retries = 0
    } catch (error) {
      plan.retries += 1
      session.log(
        'WARN',
        '积分',
        `Token 自动签到检查失败：${failureSuffix(error)}，` +
          (plan.retries <= MAX_RETRIES ? `${RETRY_DELAY_MS / 60_000} 分钟后重试` : '今日不再自动重试'),
      )
    } finally {
      plan.inFlight = false
      if (this.plans.get(session) !== plan) return
      if (!session.isLoggedIn || session.hasBanner || !session.isTokenTaskAuto(TOKEN_DAILY_TASK_ID)) {
        this.dropSession(session)
        return
      }
      if (plan.lastCheckDay === dayKey()) {
        this.schedule(plan)
      } else if (plan.retries <= MAX_RETRIES) {
        if (plan.timer) clearTimeout(plan.timer)
        plan.timer = setTimeout(() => {
          plan.timer = null
          void this.run(plan)
        }, RETRY_DELAY_MS)
        plan.timer.unref?.()
      } else {
        /* 今日重试耗尽：直接排到次日 00:10，避免无限打上游 */
        plan.lastCheckDay = dayKey()
        plan.retries = 0
        this.schedule(plan)
      }
    }
  }
}

export const tokenAutoRunner = new TokenAutoRunner()