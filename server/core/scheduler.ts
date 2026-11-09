/**
 * 保活调度器（backend-design §1.4 / §3.2）。
 *
 * 模型：**每个实例一条 setTimeout 链**，天然互斥。
 *   - 同一实例在途时跳过本轮（不排队），结束后按 interval 重排下一轮
 *   - 手动保活（4.8）优先：定时轮次发现手动在途则跳过本轮；手动会等定时轮次结束再执行
 *     （最多 MANUAL_WAIT_BUDGET_MS=5s，超时立即回 10005，绝不挂到前端 15s）
 *   - 不同实例、不同账号互不阻塞
 *   - 打开自动开关（4.9）立即执行一次；完成后从执行完成时刻起 `left = interval*60`
 *   - run 变化：running→stopped/starting/stopping 立即取消计划；回到 running 重新计时
 *
 * 探测：每轮执行前 `pageDesktop` 刷新该账号实例状态；失败不阻断本轮（降级用旧状态 + 节流 WARN）。
 *       成功写 INFO（静默刷新），失败按「同账号 + 同原因」1 小时节流；兜底探测命中 30060（设备未绑定）
 *       时暂停该账号的兜底拉取（保活前探测不受影响），列表刷新成功后自动解除。
 * 无任何 auto=true 实例的账号降为 30 分钟兜底拉取。
 * 过渡态：发现 starting/stopping 时为该账号开 10s 追踪任务，5 分钟（30 次）未收敛则放弃；
 * 追踪与保活探测共用 session.refreshDesktops 的单飞请求，不重复打上游（不逐次写日志）。
 */
import { ErrorCode } from '../../shared/constants'
import type { RunState } from '../../shared/types'
import { maskOf } from '../../shared/utils'
import type { CtyunRunState } from '../upstream/ctyun-client'
import { UpstreamError, UpstreamNetworkError } from '../upstream/errors'
import { ApiError } from '../envelope'
import { runKeepalive, type KeepaliveOutcome } from './keepalive'
import { WARN_THROTTLE_MS } from './warn-throttle'
import type { AccountSession } from './session'

/** 过渡态追踪间隔 / 上限（backend-design §1.4） */
const TRANSITION_INTERVAL_MS = 10_000
const TRANSITION_MAX_TICKS = 30
/** 无 auto 实例的账号兜底拉取间隔 */
const FALLBACK_REFRESH_MS = 30 * 60_000
/** 探测超时：取小值，保证「探测 + 保活」落在前端 15s 预算内 */
const PROBE_TIMEOUT_MS = 8_000
/** 手动保活整轮预算（4.8 / 4.9 前端 15s）：等定时轮次收尾 + 探测 + 保活 + 必要的 eaichat 重登共享 */
const MANUAL_ROUND_BUDGET_MS = 12_000
/** 等待已开跑的定时轮次收尾的上限：超出即回 10005，绝不让请求悬挂到前端超时 */
const MANUAL_WAIT_BUDGET_MS = 5_000
/** 探测（跳过）WARN 节流：同账号同类 10 分钟内只记一次，避免上游故障时刷屏 */
const PROBE_WARN_GAP_MS = WARN_THROTTLE_MS
/** 探测失败 WARN 进 ring 的节流：同账号 + 同原因（code/kind）1 小时一条，避免每轮刷屏 */
const PROBE_WARN_RING_GAP_MS = 60 * 60_000
/** 设备未绑定（4xx 业务码）：兜底探测无意义，命中后暂停该账号的 30 分钟兜底拉取 */
const DEVICE_UNBOUND_CODE = 30060

interface Plan {
  key: string
  userId: number
  desktopId: string
  session: AccountSession
  timer: ReturnType<typeof setTimeout> | null
  /** 0 = 未安排（仅手动保活时存在） */
  nextFireAt: number
  /** 定时轮次在途 */
  autoInFlight: boolean
  /** 手动/开关触发的保活在途 */
  manualBusy: boolean
  /** 手动请求已到达：定时轮次立即让位（跳过本轮，不排队） */
  manualPending: boolean
  /** 定时轮次在途时的 Promise：手动/开关请求据此等它收尾，保证同实例只有一个上游请求 */
  current: Promise<KeepaliveOutcome> | null
}

interface Tracker {
  timer: ReturnType<typeof setTimeout> | null
  /** 已发起的拉取次数（每 tick 一次） */
  ticks: number
  /** 被跟踪的过渡态实例名（收敛/放弃日志用） */
  names: string[]
  /** 开始跟踪的时刻（收敛日志耗时用） */
  startedAt: number
}

/** 一次探测失败的归类（用于 WARN 文案与节流键） */
interface ProbeFailure {
  detail: string
  /** 节流键：`code=xxx` / network / timeout / unknown */
  reason: string
  code: number | null
}

const planKey = (userId: number, desktopId: string) => `${userId}:${desktopId}`

const RUN_LABEL: Record<CtyunRunState, string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '关机中',
  stopped: '已关机',
  error: '异常',
}

function isTransitional(run: RunState): boolean {
  return run === 'starting' || run === 'stopping'
}

/** error 属稳态（可继续保活）；仅 stopped/starting/stopping 暂停 */
function isEligible(run: RunState): boolean {
  return run === 'running' || run === 'error'
}

export class KeepaliveScheduler {
  private readonly plans = new Map<string, Plan>()
  private readonly trackers = new Map<AccountSession, Tracker>()
  private readonly fallbacks = new Map<AccountSession, ReturnType<typeof setInterval>>()
  private readonly warnAt = new Map<AccountSession, Partial<Record<'scheduler' | 'keepalive', number>>>()
  /** 探测失败 WARN 的按原因节流水位：session → reason → 上次记录时间 */
  private readonly probeWarnAt = new Map<AccountSession, Map<string, number>>()
  /** 30060（设备未绑定）导致暂停兜底探测的账号；列表刷新成功后解除 */
  private readonly fallbackPaused = new Set<AccountSession>()
  /** 上一次同步时各实例的 run：用于「暂停/恢复计时」日志 */
  private readonly lastRun = new Map<AccountSession, Map<string, RunState>>()
  private closed = false
  private exitHookInstalled = false

  constructor() {
    /* dev HMR 会重新求值本模块：先关掉上一份实例的定时器，避免双份计划同时打上游 */
    const holder = globalThis as typeof globalThis & { __ctkaScheduler?: KeepaliveScheduler }
    holder.__ctkaScheduler?.close()
    holder.__ctkaScheduler = this
  }

  /* ── 生命周期 ───────────────────────────────────────────── */

  /** 进程退出时清理全部定时器（timer 已 unref，这里做显式收口） */
  private installExitHook(): void {
    if (this.exitHookInstalled) return
    this.exitHookInstalled = true
    process.once('exit', () => this.close())
  }

  close(): void {
    this.closed = true
    for (const plan of this.plans.values()) this.clearPlanTimer(plan)
    this.plans.clear()
    for (const tracker of this.trackers.values()) if (tracker.timer) clearTimeout(tracker.timer)
    this.trackers.clear()
    for (const timer of this.fallbacks.values()) clearInterval(timer)
    this.fallbacks.clear()
    this.warnAt.clear()
    this.probeWarnAt.clear()
    this.fallbackPaused.clear()
    this.lastRun.clear()
  }

  /** 账号删除 / 会话替换 / 登录失败：清掉该会话所有计划、追踪与兜底定时器 */
  dropSession(session: AccountSession): void {
    for (const [key, plan] of [...this.plans]) {
      if (plan.session !== session) continue
      this.clearPlanTimer(plan)
      this.plans.delete(key)
    }
    const tracker = this.trackers.get(session)
    if (tracker?.timer) clearTimeout(tracker.timer)
    this.trackers.delete(session)
    const fallback = this.fallbacks.get(session)
    if (fallback) clearInterval(fallback)
    this.fallbacks.delete(session)
    this.warnAt.delete(session)
    this.probeWarnAt.delete(session)
    this.fallbackPaused.delete(session)
    this.lastRun.delete(session)
  }

  /**
   * 云电脑列表成功刷新（4.7 / 登录恢复 / 保活前探测 / 过渡态追踪）后由 session 通知：
   * 清除 30060 兜底暂停标记；若确实从暂停中恢复，补一条 INFO（避免静默）。
   * 调用方随后会 `syncSession`（内含 `syncFallback`）按最新状态重排兜底定时器。
   */
  noteDesktopsRefreshed(session: AccountSession): void {
    if (!this.fallbackPaused.delete(session)) return
    session.log('INFO', '调度', `${maskOf(session.accountName)} 云电脑列表刷新成功，兜底探测暂停已解除`)
  }

  /* ── 计划派生（/state 实时计算，不缓存） ─────────────────── */

  leftFor(userId: number, desktopId: string): number | null {
    const plan = this.plans.get(planKey(userId, desktopId))
    if (!plan || !plan.nextFireAt) return null
    return Math.max(0, Math.ceil((plan.nextFireAt - Date.now()) / 1000))
  }

  /* ── 计划同步（每次列表刷新后调用） ─────────────────────── */

  /**
   * 按当前快照对齐计划：
   *   - auto && run ∈ {running,error} → 保证有计划
   *   - 其余 → 取消计划（auto 开关保留在配置里，等实例回到 running 再恢复）
   *   - 缺失实例（列表里没有）→ 只取消计划，不删开关（沿用 S2 补拉降级不丢开关的口径）
   */
  syncSession(session: AccountSession): void {
    if (this.closed) return
    this.installExitHook()
    const userId = session.userId
    const present = new Map(session.desktopList.map((desktop) => [desktop.desktopId, desktop]))
    const previousRuns = this.lastRun.get(session) ?? new Map<string, RunState>()
    const nextRuns = new Map<string, RunState>()

    for (const [key, plan] of [...this.plans]) {
      if (plan.session !== session) {
        /* 同 userId 的旧会话计划（修正凭据/重新登录后的新会话）：让位给当前会话 */
        if (plan.userId === userId) {
          this.cancelPlan(plan)
          this.plans.delete(key)
        }
        continue
      }
      /* 会话 userId 变化（重新登录出不同账号）时丢弃旧键计划 */
      if (plan.key !== planKey(userId, plan.desktopId) || !present.has(plan.desktopId)) {
        this.cancelPlan(plan)
        this.plans.delete(key)
      }
    }

    for (const desktop of session.desktopList) {
      const key = planKey(userId, desktop.desktopId)
      const previousRun = previousRuns.get(desktop.desktopId)
      nextRuns.set(desktop.desktopId, desktop.run)
      const auto = session.isDesktopAuto(desktop.desktopId)
      const existing = this.plans.get(key)

      if (!auto || !session.isLoggedIn || session.hasBanner) {
        if (existing) {
          /* 在途轮次不能强杀：只清计划时间，让 finally 的 nextFireAt>0 判断不再重排 */
          this.cancelPlan(existing)
          if (!existing.manualBusy && !existing.autoInFlight) this.plans.delete(key)
        }
        continue
      }

      if (!isEligible(desktop.run)) {
        if (existing) {
          this.cancelPlan(existing)
          if (!existing.manualBusy && !existing.autoInFlight) this.plans.delete(key)
        }
        if (previousRun && previousRun !== desktop.run && isEligible(previousRun)) {
          session.log(
            'INFO',
            '调度',
            `${desktop.desktopName} 状态变为「${RUN_LABEL[desktop.run]}」，自动保活计划已暂停（实例恢复运行后自动重新计时）`,
          )
        }
        continue
      }

      if (!existing) {
        const plan = this.ensurePlan(session, desktop.desktopId)
        this.scheduleIn(plan, session.intervalMinutes * 60_000)
        if (previousRun && !isEligible(previousRun) && previousRun !== desktop.run) {
          session.log(
            'INFO',
            '调度',
            `${desktop.desktopName} 已恢复运行，自动保活将在 ${session.intervalMinutes} 分钟后执行`,
          )
        }
      } else if (!existing.nextFireAt && !existing.autoInFlight && !existing.manualBusy) {
        /* 之前因 stopped/过渡态被暂停（nextFireAt=0）但计划仍在：实例回到稳态后恢复计时 */
        this.scheduleIn(existing, session.intervalMinutes * 60_000)
        if (previousRun && !isEligible(previousRun) && previousRun !== desktop.run) {
          session.log(
            'INFO',
            '调度',
            `${desktop.desktopName} 已恢复运行，自动保活将在 ${session.intervalMinutes} 分钟后执行`,
          )
        }
      }
    }

    this.lastRun.set(session, nextRuns)
    this.syncFallback(session)
    this.maybeStartTracker(session)
  }

  /** 4.6 修改间隔：该账号全部已有计划从「现在」起按新间隔重排 */
  applyInterval(session: AccountSession): void {
    for (const plan of this.plans.values()) {
      if (plan.session !== session || plan.autoInFlight || plan.manualBusy) continue
      if (!plan.nextFireAt) continue
      this.scheduleIn(plan, session.intervalMinutes * 60_000)
    }
  }

  /* ── 4.9 开关 ───────────────────────────────────────────── */

  /** 打开：立即执行一次；执行完从当前时刻按 interval 计秒（失败也计秒，下轮重试） */
  async enable(session: AccountSession, desktopId: string): Promise<KeepaliveOutcome> {
    this.installExitHook()
    let plan = this.plans.get(planKey(session.userId, desktopId))
    if (!plan) plan = this.ensurePlan(session, desktopId)
    if (plan.manualBusy) throw new ApiError(ErrorCode.StateNotAllowed, '该实例的保活正在执行中，请稍候')

    /* 整轮预算从进入请求算起：等定时轮次收尾也计入，保证 4.9 在前端 15s 内收口 */
    const deadline = Date.now() + MANUAL_ROUND_BUDGET_MS
    /* 先占住手动位（manualPending 让排队中的定时轮次让位），再等已开跑的定时轮次收尾 */
    plan.manualBusy = true
    plan.manualPending = true
    let outcome: KeepaliveOutcome
    try {
      await this.waitForAutoRound(plan, deadline)
      outcome = await this.executeRound(session, desktopId, 'manual', deadline)
    } finally {
      plan.manualBusy = false
      plan.manualPending = false
    }

    const current = this.plans.get(planKey(session.userId, desktopId))
    const latest = session.findDesktop(desktopId)
    /* 计划可能在执行期间被 syncSession 取消/删除（run 变化、关闭开关）：只恢复仍然存在的计划 */
    if (!current) return outcome
    if (!latest || !isEligible(latest.run) || !session.isDesktopAuto(desktopId)) {
      this.cancelPlan(current)
      return outcome
    }
    this.scheduleIn(current, session.intervalMinutes * 60_000)
    this.syncFallback(session)
    return outcome
  }

  /** 4.9 关闭：取消计划（关闭永远允许） */
  disable(session: AccountSession, desktopId: string): void {
    const key = planKey(session.userId, desktopId)
    const plan = this.plans.get(key)
    if (plan) {
      this.cancelPlan(plan)
      this.plans.delete(key)
    }
    this.syncFallback(session)
  }

  /* ── 4.8 手动保活 ───────────────────────────────────────── */

  /** 手动保活：定时轮次在途时等它收尾，再以本次手动为准执行一次（不排队第二个定时轮次） */
  async manual(session: AccountSession, desktopId: string): Promise<KeepaliveOutcome> {
    this.installExitHook()
    const key = planKey(session.userId, desktopId)
    let plan = this.plans.get(key)
    if (!plan) plan = this.ensurePlan(session, desktopId)
    if (plan.manualBusy) throw new ApiError(ErrorCode.StateNotAllowed, '该实例的保活正在执行中，请稍候')

    /* 先占住手动位（manualPending 让排队中的定时轮次立即让位），再等已开跑的定时轮次收尾 */
    plan.manualBusy = true
    plan.manualPending = true
    /* 整轮预算从进入请求算起：等定时轮次收尾计入同一预算，前端 15s 内必有响应 */
    const deadline = Date.now() + MANUAL_ROUND_BUDGET_MS
    let outcome: KeepaliveOutcome
    try {
      await this.waitForAutoRound(plan, deadline)
      outcome = await this.executeRound(session, desktopId, 'manual', deadline)
    } finally {
      plan.manualBusy = false
      plan.manualPending = false
    }

    const current = this.plans.get(key)
    const latest = session.findDesktop(desktopId)
    if (!current) return outcome
    if (session.isDesktopAuto(desktopId) && latest && isEligible(latest.run)) {
      this.scheduleIn(current, session.intervalMinutes * 60_000)
    } else if (!session.isDesktopAuto(desktopId)) {
      this.cancelPlan(current)
      this.plans.delete(key)
    }
    return outcome
  }

  /* ── 内部：计划 / 定时轮次 ──────────────────────────────── */

  /**
   * 等已开跑的定时轮次收尾；有预算上限（MANUAL_WAIT_BUDGET_MS 且不越过整轮 deadline）。
   * 超时直接抛 10005，不把请求挂到前端 15s 超时（4.8 / 4.9 都必须有明确响应）。
   */
  private async waitForAutoRound(plan: Plan, deadline: number): Promise<void> {
    if (!plan.autoInFlight || !plan.current) return
    const budget = Math.min(MANUAL_WAIT_BUDGET_MS, deadline - Date.now())
    if (budget <= 0) throw new ApiError(ErrorCode.StateNotAllowed, '上一轮保活仍在执行中，请稍后重试')

    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      /* 请求级短计时器：不 unref，保证请求未响应前进程不会因为只剩 unref 句柄而退出 */
      timer = setTimeout(() => resolve('timeout'), budget)
    })
    try {
      const result = await Promise.race([plan.current.catch(() => 'done' as const), timeout])
      if (result === 'timeout') throw new ApiError(ErrorCode.StateNotAllowed, '上一轮保活仍在执行中，请稍后重试')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private ensurePlan(session: AccountSession, desktopId: string): Plan {
    const key = planKey(session.userId, desktopId)
    const existing = this.plans.get(key)
    /* 同 userId 但换了会话实例（修正凭据 / 重新登录）：旧计划属于旧会话，整条替换 */
    if (existing && existing.session === session) return existing
    if (existing) {
      this.cancelPlan(existing)
      this.plans.delete(key)
    }
    const plan: Plan = {
      key,
      userId: session.userId,
      desktopId,
      session,
      timer: null,
      nextFireAt: 0,
      autoInFlight: false,
      manualBusy: false,
      manualPending: false,
      current: null,
    }
    this.plans.set(key, plan)
    return plan
  }

  private scheduleIn(plan: Plan, delayMs: number): void {
    if (this.closed) return
    if (plan.timer) clearTimeout(plan.timer)
    const delay = Math.max(0, delayMs)
    plan.nextFireAt = Date.now() + delay
    const timer = setTimeout(() => {
      plan.timer = null
      void this.autoRound(plan)
    }, delay)
    timer.unref?.()
    plan.timer = timer
  }

  private cancelPlan(plan: Plan): void {
    this.clearPlanTimer(plan)
    plan.nextFireAt = 0
  }

  private clearPlanTimer(plan: Plan): void {
    if (plan.timer) {
      clearTimeout(plan.timer)
      plan.timer = null
    }
  }

  private async autoRound(plan: Plan): Promise<void> {
    const session = plan.session
    if (this.closed) return
    if (this.plans.get(plan.key) !== plan || !plan.nextFireAt) return
    if (!session.isLoggedIn || session.hasBanner || !session.isDesktopAuto(plan.desktopId)) {
      this.cancelPlan(plan)
      this.plans.delete(plan.key)
      return
    }
    if (plan.manualPending || plan.manualBusy) {
      /* 手动保活优先：本轮定时直接作废（由手动轮次结束后统一重排），不排队 */
      this.scheduleIn(plan, session.intervalMinutes * 60_000)
      return
    }
    if (plan.autoInFlight) {
      /* 同实例在途（理论上 timer 链不会并发）：跳过本轮 */
      this.scheduleIn(plan, session.intervalMinutes * 60_000)
      return
    }

    plan.autoInFlight = true
    const run = this.executeRound(session, plan.desktopId, 'auto')
    plan.current = run
    try {
      await run
    } catch (error) {
      const detail = error instanceof ApiError ? error.message : '未知错误'
      session.log('WARN', '调度', `${this.desktopName(plan)} 本轮自动保活异常：${detail}`)
    } finally {
      plan.autoInFlight = false
      if (plan.current === run) plan.current = null
      /* 执行期间可能被关闭/删除/run 变化：plan.nextFireAt 已被清零则不再重排 */
      if (this.plans.get(plan.key) === plan && plan.nextFireAt > 0) {
        this.scheduleIn(plan, session.intervalMinutes * 60_000)
      } else if (this.plans.get(plan.key) === plan && !session.isDesktopAuto(plan.desktopId)) {
        this.plans.delete(plan.key)
      }
    }
  }

  /**
   * 一轮完整执行（手动/定时共用）：
   *   1) 探测（失败降级，不阻断）
   *   2) 用最新状态重新校验（不存在 → 取消计划；关/过渡 → 取消计划并跳过）
   *   3) eaichat 未就绪 → 10008 语义（手动抛错，定时跳过）
   *   4) 执行一次保活并写 lastAt/lastMsg + 日志
   * `deadline` 为手动整轮截止时间（由调用方从请求入口计算，含等待定时轮次的耗时）。
   */
  private async executeRound(
    session: AccountSession,
    desktopId: string,
    reason: 'manual' | 'auto',
    deadline?: number,
  ): Promise<KeepaliveOutcome> {
    const startedAt = Date.now()
    /* 手动请求在前端 15s 预算内必须收口；定时轮次没有等待方，探测/保活可各用较长上限 */
    const roundDeadline = deadline ?? (reason === 'manual' ? startedAt + MANUAL_ROUND_BUDGET_MS : undefined)
    /* 探测也吃整轮预算：等待定时轮次已花掉的时间必须从探测里扣，否则「等 5s + 探 4s + 保活」会顶破 12s */
    const probeBudget =
      roundDeadline == null ? PROBE_TIMEOUT_MS : Math.min(PROBE_TIMEOUT_MS, 4_000, roundDeadline - Date.now())
    /* 预算已耗尽（极端情况）：跳过探测直接进入保活，由 callUpstream 在剩余预算内立即收口 */
    if (probeBudget > 0) await this.probe(session, probeBudget)

    const desktop = session.findDesktop(desktopId)
    if (!desktop) {
      if (reason === 'manual') throw new ApiError(ErrorCode.DesktopNotFound, '云电脑不存在，请刷新后重试')
      this.dropPlan(session, desktopId)
      return {
        ok: false,
        elapsedMs: 0,
        lastAt: Date.now(),
        lastMsg: '保活失败：云电脑已不在列表中',
        failureKind: 'business',
      }
    }

    if (!isEligible(desktop.run)) {
      if (reason === 'manual') {
        throw new ApiError(
          ErrorCode.StateNotAllowed,
          `实例当前为「${RUN_LABEL[desktop.run]}」状态，不允许保活（工具不代为开机）`,
        )
      }
      this.dropPlan(session, desktopId)
      this.logWarnThrottled(session, `${desktop.desktopName} 当前${RUN_LABEL[desktop.run]}，本轮保活跳过`, 'scheduler')
      return {
        ok: false,
        elapsedMs: 0,
        lastAt: Date.now(),
        lastMsg: `保活失败：实例当前${RUN_LABEL[desktop.run]}，本轮跳过`,
        failureKind: 'business',
      }
    }

    if (!session.isEaichatReady) {
      if (reason === 'manual') throw new ApiError(ErrorCode.EaichatUnavailable, '云智助手会话不可用，无感保活暂不可用')
      this.logWarnThrottled(
        session,
        `${desktop.desktopName} 自动保活本轮跳过：云智助手会话不可用，下个周期重试`,
        'keepalive',
      )
      return {
        ok: false,
        elapsedMs: 0,
        lastAt: Date.now(),
        lastMsg: '保活失败：云智助手会话不可用',
        failureKind: 'auth',
      }
    }

    return runKeepalive(session, desktop, reason, roundDeadline)
  }

  private dropPlan(session: AccountSession, desktopId: string): void {
    const key = planKey(session.userId, desktopId)
    const plan = this.plans.get(key)
    if (!plan) return
    this.cancelPlan(plan)
    this.plans.delete(key)
  }

  private desktopName(plan: Plan): string {
    return plan.session.findDesktop(plan.desktopId)?.desktopName ?? '实例'
  }

  /* ── 探测 / 过渡态 / 兜底 ───────────────────────────────── */

  /**
   * 探测：保活前探测与 30 分钟兜底探测共用。
   *   - 成功：写 INFO「静默刷新云电脑列表 · N 台 · 耗时 Xms」（可观测「静默刷新确实在工作」）
   *   - 失败：不阻断本轮（降级用旧状态）；同账号 + 同原因 WARN 进 ring 按 1 小时节流
   *   - `source='fallback'` 且错误为 30060（设备未绑定）时暂停兜底探测并只记一次
   */
  private async probe(
    session: AccountSession,
    timeoutMs = PROBE_TIMEOUT_MS,
    source: 'keepalive' | 'fallback' = 'keepalive',
  ): Promise<boolean> {
    const startedAt = Date.now()
    const attempt = session.refreshDesktops({ timeoutMs, retries: 0 }).then(
      () => 'ok' as const,
      (error: unknown) => {
        this.reportProbeFailure(session, this.classifyProbeFailure(error), source)
        return 'failed' as const
      },
    )
    /* 硬上限：host 回退内部可能重登（最长 28s），单次探测不得拖住整个保活轮次 */
    let timer: ReturnType<typeof setTimeout> | null = null
    const guard = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs + 1_000)
      timer.unref?.()
    })
    try {
      const result = await Promise.race([attempt, guard])
      if (result === 'timeout') {
        this.reportProbeFailure(session, { detail: '探测超时', reason: 'timeout', code: null }, source)
        return false
      }
      if (result === 'ok') {
        session.log(
          'INFO',
          '调度',
          `${maskOf(session.accountName)} 静默刷新云电脑列表 · ${session.desktopList.length} 台 · 耗时 ${Math.max(
            0,
            Date.now() - startedAt,
          )}ms`,
        )
        return true
      }
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 上游错误 → 固定归类（不写上游原文以外的 ID / 账号） */
  private classifyProbeFailure(error: unknown): ProbeFailure {
    if (error instanceof UpstreamNetworkError) {
      return { detail: '上游网络异常或超时', reason: 'network', code: null }
    }
    if (error instanceof UpstreamError) {
      return { detail: `上游返回错误（code=${error.code}）`, reason: `code=${error.code}`, code: error.code }
    }
    return { detail: '未知错误', reason: 'unknown', code: null }
  }

  /**
   * 探测失败：
   *   - 兜底探测命中 30060（设备未绑定）→ 暂停兜底（只记一次），保活前探测不受影响
   *   - 其余错误 → 同账号 + 同原因 1 小时内只记一次 WARN（不暂停）
   */
  private reportProbeFailure(session: AccountSession, failure: ProbeFailure, source: 'keepalive' | 'fallback'): void {
    if (source === 'fallback' && failure.code === DEVICE_UNBOUND_CODE) {
      this.pauseFallbackProbe(session)
      return
    }
    const record = this.probeWarnAt.get(session) ?? new Map<string, number>()
    const last = record.get(failure.reason) ?? 0
    if (Date.now() - last < PROBE_WARN_RING_GAP_MS) return
    record.set(failure.reason, Date.now())
    this.probeWarnAt.set(session, record)
    session.log(
      'WARN',
      '调度',
      `${maskOf(session.accountName)} 保活前探测失败：${failure.detail}，本轮降级使用上次状态`,
    )
  }

  /** 暂停某账号的 30 分钟兜底探测（30060 设备未绑定），并写唯一一条说明日志 */
  private pauseFallbackProbe(session: AccountSession): void {
    if (this.fallbackPaused.has(session)) return
    this.fallbackPaused.add(session)
    const existing = this.fallbacks.get(session)
    if (existing) {
      clearInterval(existing)
      this.fallbacks.delete(session)
    }
    session.log(
      'WARN',
      '调度',
      `已暂停 ${maskOf(session.accountName)} 的兜底探测：该账号需要先在官方客户端完成设备绑定；手动刷新列表或重新登录后恢复`,
    )
  }

  /** 同类 WARN 10 分钟内只记一次（探测/跳过可能高频触发） */
  private logWarnThrottled(session: AccountSession, message: string, kind: 'scheduler' | 'keepalive'): void {
    const record = this.warnAt.get(session) ?? {}
    const last = record[kind] ?? 0
    if (Date.now() - last < PROBE_WARN_GAP_MS) return
    record[kind] = Date.now()
    this.warnAt.set(session, record)
    session.log('WARN', kind === 'scheduler' ? '调度' : '保活', message)
  }

  private maybeStartTracker(session: AccountSession): void {
    if (this.closed || !session.isLoggedIn || session.hasBanner) return
    const transitional = session.desktopList.filter((desktop) => isTransitional(desktop.run))
    const existing = this.trackers.get(session)
    if (!transitional.length) {
      if (existing) this.stopTracker(session, existing, 'converged')
      return
    }
    if (existing) return

    const names = transitional.map((desktop) => desktop.desktopName)
    session.log('INFO', '调度', `发现过渡态 ${names.join('、')}，开始 10s 跟踪`)
    const tracker: Tracker = { timer: null, ticks: 0, names, startedAt: Date.now() }
    this.trackers.set(session, tracker)
    this.trackTracker(session, tracker)
  }

  /**
   * 停止过渡态跟踪并收口：
   *   - converged：已回到稳态（INFO，含共拉取次数与耗时）
   *   - gaveUp：5 分钟未收敛（WARN，保留原口径）
   *   - silent：会话不可用/已销毁（不刷日志）
   */
  private stopTracker(session: AccountSession, tracker: Tracker, reason: 'converged' | 'gaveUp' | 'silent'): void {
    if (tracker.timer) {
      clearTimeout(tracker.timer)
      tracker.timer = null
    }
    this.trackers.delete(session)
    if (reason === 'converged') {
      const seconds = Math.max(1, Math.round((Date.now() - tracker.startedAt) / 1000))
      session.log(
        'INFO',
        '调度',
        `${tracker.names.join('、')} 已回到稳态，停止跟踪（共拉取 ${tracker.ticks} 次，耗时 ${seconds}s）`,
      )
      return
    }
    if (reason === 'gaveUp') {
      session.log(
        'WARN',
        '调度',
        `${tracker.names.join('、')} 连续 5 分钟未进入稳态，已停止跟踪，回落常规保活节奏`,
      )
    }
  }

  private trackTracker(session: AccountSession, tracker: Tracker): void {
    if (this.closed) return
    const timer = setTimeout(() => {
      tracker.timer = null
      void this.trackerTick(session, tracker)
    }, TRANSITION_INTERVAL_MS)
    timer.unref?.()
    tracker.timer = timer
  }

  private async trackerTick(session: AccountSession, tracker: Tracker): Promise<void> {
    if (this.closed || this.trackers.get(session) !== tracker) return
    if (!session.isLoggedIn || session.hasBanner) {
      this.stopTracker(session, tracker, 'silent')
      return
    }

    tracker.ticks += 1
    try {
      /* 与保活前探测共用 session.refreshDesktops 的单飞请求：同时到达时不重复打上游。
         拉取成功会触发 desktopsUpdated → syncSession → 这里可能已被 maybeStartTracker 收敛收口。 */
      await session.refreshDesktops({ timeoutMs: PROBE_TIMEOUT_MS, retries: 0 })
    } catch {
      /* 追踪失败不刷屏：下一 tick 再试，到上限统一放弃 */
    }

    if (this.trackers.get(session) !== tracker) return
    const stillTransitional = session.desktopList.filter((desktop) => isTransitional(desktop.run))
    if (!stillTransitional.length) {
      this.stopTracker(session, tracker, 'converged')
      return
    }
    if (tracker.ticks >= TRANSITION_MAX_TICKS) {
      this.stopTracker(session, tracker, 'gaveUp')
      return
    }
    this.trackTracker(session, tracker)
  }

  /** 无 auto 实例的账号：30 分钟兜底拉取，保证 run/列表变化不会长期失真（30060 暂停期间不重排） */
  private syncFallback(session: AccountSession): void {
    const needFallback =
      session.isLoggedIn && !session.hasBanner && !session.hasAutoDesktop && !this.fallbackPaused.has(session)
    const existing = this.fallbacks.get(session)
    if (!needFallback) {
      if (existing) clearInterval(existing)
      this.fallbacks.delete(session)
      return
    }
    if (existing) return
    const timer = setInterval(() => {
      if (this.closed || !session.isLoggedIn || session.hasBanner || session.hasAutoDesktop) return
      void this.probe(session, PROBE_TIMEOUT_MS, 'fallback')
    }, FALLBACK_REFRESH_MS)
    timer.unref?.()
    this.fallbacks.set(session, timer)
  }
}

/** 全局单例：与 manager 共用一份调度状态 */
export const scheduler = new KeepaliveScheduler()
