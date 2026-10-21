/**
 * AccountSession：一个账号的全量运行时（backend-design §1.1 / §1.5）。
 *
 * 持有两套上游登录态、云电脑列表、积分/任务占位与登录失败分档；
 * 任何内存态变化都通过 revision 计数器 + 变更事件对外暴露。
 */
import type {
  Account,
  Banner,
  DotTone,
  LogLevel,
  LogModule,
  PcInstance,
  PointTask,
  PointsSummary,
} from '../../shared/types'
import { maskOf, nowHm } from '../../shared/utils'
import { CtyunClient, type CtyunDesktop, type CtyunLoginProfile } from '../upstream/ctyun-client'
import {
  EaiChatClient,
  JWT_RENEW_THRESHOLD_MS,
  type EaiChatUserInfo,
} from '../upstream/eaichat-client'
import { classifyLoginFailure, upstreamMessage } from '../upstream/errors'
import type { PersistedAccount } from '../store/config'

const EAI_RENEW_CHECK_MS = 12 * 60 * 60 * 1000
/** 登录链路整体预算：negotiate + login + eaichat 共享（backend-design §2.1） */
export const LOGIN_BUDGET_MS = 28_000

export class RevisionCounter {
  private current = 0

  get value(): number {
    return this.current
  }

  bump(): number {
    this.current += 1
    return this.current
  }
}

export interface SessionDeps {
  revision: RevisionCounter
  log: (lv: LogLevel, mod: LogModule, msg: string) => void
  refreshed: () => void
  /** 每次列表成功刷新（登录 / 4.7 / 保活前探测 / 过渡态追踪）后通知调度器 */
  desktopsUpdated: () => void
  /** 会话被删除/替换时通知调度器清理定时器 */
  disposed: () => void
  /** 计划层派生：按 desktopId 实时读取距下次保活的秒数（调度器持有 nextFireAt） */
  planLeft: (desktopId: string) => number | null
}

function emptyPoints(): PointsSummary {
  return { pointsList: [], updatedDate: 0 }
}

export class AccountSession {
  private readonly deps: SessionDeps
  private readonly configUserId: number
  private readonly requestedAlias: string
  private userAccount: string
  private password: string
  private alias = ''
  private interval: number
  private pointsWindow: { winStart: string; winEnd: string }
  private dot: DotTone = 'load'
  private banner: Banner | null = null
  private eaichatOk = false
  private eaichatMsg: string | null = '尚未登录云智助手'
  private desktops: CtyunDesktop[] = []
  private desktopAuto = new Map<string, boolean>()
  /** 最近一次保活（成功/失败都更新；不持久化，重启后回到「从未执行」） */
  private desktopLast = new Map<string, { at: number; msg: string }>()
  /** 列表刷新单飞：4.7 与保活前探测并发时共用同一次上游请求 */
  private desktopRefresh: Promise<CtyunDesktop[]> | null = null
  private taskAuto = new Map<number, boolean>()
  private tasks: PointTask[] = []
  private points: PointsSummary = emptyPoints()
  private ctyun: CtyunClient | null = null
  private eai: EaiChatClient | null = null
  private profile: CtyunLoginProfile | null = null
  private eaiNickName: string | null = null
  private renewTimer: ReturnType<typeof setInterval> | null = null
  /** 登录互斥：relogin/updateCredentials/restore 共用（review MAJOR-4） */
  private loginInFlight = false

  constructor(persisted: PersistedAccount, deps: SessionDeps) {
    this.deps = deps
    this.configUserId = persisted.userId
    this.userAccount = persisted.userAccount
    this.password = persisted.password
    this.requestedAlias = persisted.alias
    this.alias = persisted.alias
    this.interval = persisted.interval
    this.pointsWindow = { ...persisted.pointsWindow }
    for (const item of persisted.desktops) {
      if (item.auto) this.desktopAuto.set(item.desktopId, true)
    }
    for (const item of persisted.tasks) {
      if (item.auto) this.taskAuto.set(item.taskDefId, true)
    }
  }

  /* ── 身份与访问 ─────────────────────────────────────────── */

  get userId(): number {
    return this.profile?.userId ?? this.configUserId
  }

  get persistedUserId(): number {
    return this.configUserId
  }

  get accountName(): string {
    return this.userAccount
  }

  get intervalMinutes(): number {
    return this.interval
  }

  get pointsWindowSnapshot(): { winStart: string; winEnd: string } {
    return { ...this.pointsWindow }
  }

  /** banner 非空 = 账号处于 danger/warn（4.7/4.10/保活一律 10005） */
  get hasBanner(): boolean {
    return this.banner != null
  }

  get isLoggedIn(): boolean {
    return this.profile != null
  }

  /** 登录是否在途（relogin/updateCredentials/restore 互斥用） */
  get isLoginInFlight(): boolean {
    return this.loginInFlight
  }

  /** 尝试占用登录位：已在途返回 false */
  tryBeginLogin(): boolean {
    if (this.loginInFlight) return false
    this.loginInFlight = true
    return true
  }

  endLogin(): void {
    this.loginInFlight = false
  }

  get isEaichatReady(): boolean {
    return this.eaichatOk
  }

  /** 保活执行需要直接拿 eaichat client；未就绪返回 null（4.8 → 10008） */
  getEaichatClient(): EaiChatClient | null {
    return this.eai
  }

  /** 保活执行/探测写日志的统一出口（manager 注入，内部 bump revision） */
  log(lv: LogLevel, mod: LogModule, msg: string): void {
    this.deps.log(lv, mod, msg)
  }

  /** 4.6 修改保活间隔（调用方负责落盘与重排） */
  setIntervalMinutes(minutes: number): void {
    this.interval = minutes
    this.touch()
  }

  /** 4.6 修改积分时间窗口 */
  setPointsWindow(window: { winStart: string; winEnd: string }): void {
    this.pointsWindow = { ...window }
    this.touch()
  }

  get autoDesktopCount(): number {
    let count = 0
    for (const value of this.desktopAuto.values()) if (value) count += 1
    return count
  }

  /** 是否存在任何 auto=true 实例（调度器决定 30 分钟兜底探测） */
  get hasAutoDesktop(): boolean {
    for (const value of this.desktopAuto.values()) if (value) return true
    return false
  }

  /** 按 desktopId 取当前实例快照 */
  findDesktop(desktopId: string): CtyunDesktop | undefined {
    return this.desktops.find((desktop) => desktop.desktopId === desktopId)
  }

  /** 积分任务对实例的占用（本期恒 null；机制保留，4.8 拒绝条件沿用 link != null） */
  linkFor(_desktopId: string): number | null {
    return null
  }

  get desktopList(): readonly CtyunDesktop[] {
    return this.desktops
  }

  /** 调度器写入计划前需要知道「用户是否打开过这台实例的自动开关」 */
  isDesktopAuto(desktopId: string): boolean {
    return this.desktopAuto.get(desktopId) ?? false
  }

  setDesktopAuto(desktopId: string, auto: boolean): void {
    this.desktopAuto.set(desktopId, auto)
    this.touch()
  }

  /** 执行完一次保活：成功/失败都更新 lastAt/lastMsg */
  recordKeepalive(desktopId: string, at: number, msg: string): void {
    this.desktopLast.set(desktopId, { at, msg })
    this.touch()
  }

  private touch(): void {
    this.deps.revision.bump()
  }

  /* ── 登录编排（backend-design §2.1） ─────────────────────── */

  /**
   * 云电脑侧登录。调用方必须先 await negotiate() 再 login()（硬约束），
   * 这里按此顺序执行；失败原样抛出 UpstreamError 由 manager 分档。
   */
  async loginCtyun(budget?: { deadline: number }): Promise<void> {
    const client = new CtyunClient({ userAccount: this.userAccount, password: this.password })
    const deadline = budget?.deadline ?? Date.now() + LOGIN_BUDGET_MS
    try {
      await client.negotiate({ deadline })
      const profile = await client.login()
      const stale = this.ctyun
      this.ctyun = client
      if (stale && stale !== client) void stale.logout()
      this.profile = profile
    } catch (error) {
      /* 半成品 client 尽力退出，不留悬挂会话 */
      void client.logout()
      throw error
    }
    this.dot = 'load'
    this.banner = null
    this.eaichatOk = false
    this.eaichatMsg = null
    this.touch()
  }

  /**
   * 云智助手登录；失败不阻断账号就绪（eaichat.ok=false + warnings）。
   * JWT 由客户端 CookieJar 的 YL-Token 取。
   */
  async loginEaichat(budgetDeadline?: number): Promise<void> {
    const client = new EaiChatClient({ userAccount: this.userAccount, password: this.password })
    try {
      await client.loginWithDeadline(budgetDeadline)
    } catch (error) {
      /* 半成品 client 尽力退出，清理 cookie / 中间态 */
      void client.logout()
      throw error
    }
    this.adoptEaichatClient(client)
    try {
      const info: EaiChatUserInfo = await client.queryUserInfo()
      this.eaiNickName = info.nickName
    } catch {
      /* nickName 只用于 alias 回填的兜底，失败不影响会话就绪 */
      this.eaiNickName = null
    }
  }

  /** 登录成功后统一接入新 client（renew 也复用） */
  private adoptEaichatClient(client: EaiChatClient): void {
    const stale = this.eai
    this.eai = client
    if (stale && stale !== client) void stale.logout()
    this.eaichatOk = true
    this.eaichatMsg = null
    this.startEaichatRenewal()
    this.touch()
  }

  /** eaichat 失败：账号仍可用（列表/积分），但无感保活暂不可用 */
  markEaichatFailure(error: unknown): string {
    const code = error instanceof Error && 'code' in error ? Number((error as { code?: unknown }).code) : -1
    const reason = upstreamMessage(Number.isFinite(code) ? code : -1)
    this.eaichatOk = false
    this.eaichatMsg = `云智助手会话获取失败：${reason}，无感保活暂不可用`
    this.stopEaichatRenewal()
    const stale = this.eai
    this.eai = null
    void stale?.logout()
    this.touch()
    return this.eaichatMsg
  }

  /** 登录失败分档（danger/warn + banner）；清空列表，等显式重试/修正凭据 */
  markLoginFailure(error: unknown): Banner {
    const info = classifyLoginFailure(error)
    const time = nowHm()
    const banner: Banner =
      info.manualLabel != null
        ? {
            tone: info.tone,
            act: info.action,
            text: `需要你本人处理一次：登录时要求${info.manualLabel}，工具已停止这个账号的自动重登。请静候 5–10 分钟（期间不要反复重试）后点「重试登录」，或到官方客户端完成验证。`,
            btn: '重试登录',
          }
        : {
            tone: info.tone,
            act: info.action,
            text:
              info.code === 51010
                ? `登录失败：账号或密码不正确（${time}），该账号下所有自动任务已挂起。`
                : `登录失败：${info.message}（${time}），该账号下所有自动任务已挂起。`,
            btn: info.action === 'relogin' ? '重新登录' : '重试登录',
          }

    this.stopEaichatRenewal()
    void this.ctyun?.logout()
    void this.eai?.logout()
    this.ctyun = null
    this.eai = null
    this.profile = null
    this.dot = info.tone
    this.banner = banner
    this.eaichatOk = false
    this.eaichatMsg = '云电脑侧未登录，云智助手会话不可用'
    this.desktops = []
    this.tasks = []
    this.points = emptyPoints()
    /* 登录失败：该账号的自动保活计划与过渡态追踪一并取消 */
    this.deps.disposed()
    this.touch()
    return banner
  }

  /** 登录成功后统一收口：alias 回填、dot/banner 复位 */
  finalizeLogin(): void {
    const provided = this.requestedAlias.trim()
    this.alias = provided || this.profile?.userName?.trim() || this.eaiNickName?.trim() || ''
    this.dot = 'ok'
    this.banner = null
    if (!this.eaichatOk && this.eaichatMsg == null) {
      this.eaichatMsg = '云智助手会话获取失败，无感保活暂不可用'
    }
    this.touch()
  }

  /** 仅重试登录/修正凭据期间使用：前端显示 dot=load、无 banner */
  beginRelogin(): void {
    this.dot = 'load'
    this.banner = null
    this.touch()
  }

  /* ── 云电脑列表 ─────────────────────────────────────────── */

  /**
   * 列表刷新（4.7 / 保活前探测共用）：同一账号同一时刻只发一次上游请求，
   * 并发调用共享结果（过渡态追踪与保活探测不重复请求）。
   */
  refreshDesktops(options: { timeoutMs?: number; retries?: number } = {}): Promise<CtyunDesktop[]> {
    if (this.desktopRefresh) return this.desktopRefresh
    const run = this.doRefreshDesktops(options).finally(() => {
      if (this.desktopRefresh === run) this.desktopRefresh = null
    })
    this.desktopRefresh = run
    return run
  }

  private async doRefreshDesktops(options: { timeoutMs?: number; retries?: number }): Promise<CtyunDesktop[]> {
    if (!this.ctyun) throw new Error('云电脑侧未登录')
    const list = await this.ctyun.listDesktops(options)
    this.applyDesktopList(list)
    this.deps.refreshed()
    this.touch()
    this.deps.desktopsUpdated()
    return list
  }

  /**
   * 成功拉取列表后按 desktopId 合并保留 auto；新实例默认 false；
   * 上游暂时缺失的实例保留其 auto 条目（等它重新出现或被用户显式删除，
   * review S2-3：补拉降级不得丢开关），缺失实例记账号日志。
   */
  applyDesktopList(list: CtyunDesktop[]): void {
    const present = new Set(list.map((desktop) => desktop.desktopId))
    const dropped: string[] = []
    for (const [desktopId] of this.desktopAuto) {
      if (!present.has(desktopId)) dropped.push(desktopId)
    }
    if (dropped.length) {
      const names = new Map(this.desktops.map((desktop) => [desktop.desktopId, desktop.desktopName]))
      const detail = dropped.map((id) => names.get(id) ?? id).join('、')
      this.deps.log(
        'WARN',
        '账号',
        `${maskOf(this.userAccount)} 本次列表缺少 ${dropped.length} 台实例（${detail}），其自动保活开关已保留，稍后重新出现时自动生效`,
      )
    }
    const nextAuto = new Map(this.desktopAuto)
    for (const desktop of list) {
      if (!nextAuto.has(desktop.desktopId)) nextAuto.set(desktop.desktopId, false)
    }
    this.desktopAuto = nextAuto
    this.desktops = list.map((desktop) => ({ ...desktop }))
  }

  /**
   * 修正凭据：保活间隔、积分时间窗口、实例/任务 auto 按位置继承。
   * 新账号列表为空时保留旧开关映射（按 desktopId），避免登录后列表拉取失败丢配置。
   */
  inheritSettingsFrom(previous: AccountSession): void {
    this.interval = previous.interval
    this.pointsWindow = { ...previous.pointsWindow }

    if (this.desktops.length) {
      this.desktopAuto.clear()
      if (previous.desktops.length) {
        this.desktops.forEach((desktop, index) => {
          const old = previous.desktops[index]
          if (old && previous.desktopAuto.get(old.desktopId)) this.desktopAuto.set(desktop.desktopId, true)
        })
      } else if (previous.desktopAuto.size) {
        /* 旧账号从未成功拉到列表：按配置文件中的顺序尽力恢复 */
        const flags = [...previous.desktopAuto.values()]
        this.desktops.forEach((desktop, index) => {
          if (flags[index]) this.desktopAuto.set(desktop.desktopId, true)
        })
      }
    } else {
      this.desktopAuto = new Map(previous.desktopAuto)
    }

    if (this.tasks.length) {
      this.taskAuto.clear()
      if (previous.tasks.length) {
        this.tasks.forEach((task, index) => {
          const old = previous.tasks[index]
          if (old && previous.taskAuto.get(old.taskDefId)) this.taskAuto.set(task.taskDefId, true)
        })
      } else if (previous.taskAuto.size) {
        const flags = [...previous.taskAuto.values()]
        this.tasks.forEach((task, index) => {
          if (flags[index]) this.taskAuto.set(task.taskDefId, true)
        })
      }
    } else {
      this.taskAuto = new Map(previous.taskAuto)
    }
  }

  /* ── 无感保活前置：JWT 12h 检查续期（backend-design §6.2） ── */

  private startEaichatRenewal(): void {
    this.stopEaichatRenewal()
    this.renewTimer = setInterval(() => {
      void this.renewEaichatIfNeeded()
    }, EAI_RENEW_CHECK_MS)
    /* 定时器不得阻止进程退出 */
    this.renewTimer.unref?.()
  }

  private stopEaichatRenewal(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer)
      this.renewTimer = null
    }
  }

  async renewEaichatIfNeeded(): Promise<void> {
    if (!this.eai || !this.eai.needsRenewal(JWT_RENEW_THRESHOLD_MS)) return
    try {
      const next = new EaiChatClient({ userAccount: this.userAccount, password: this.password })
      await next.login()
      this.adoptEaichatClient(next)
      this.deps.log('INFO', '账号', `${maskOf(this.userAccount)} 云智助手会话已自动续期`)
    } catch {
      this.stopEaichatRenewal()
      this.eai = null
      this.eaichatOk = false
      this.eaichatMsg = '云智助手会话自动续期失败，无感保活暂不可用'
      this.deps.log('WARN', '账号', `${maskOf(this.userAccount)} 云智助手会话自动续期失败，无感保活暂不可用`)
    }
    this.touch()
  }

  /**
   * 保活命中 HTTP 401 时的静默重登（backend-design §3.3）：
   * 重走 eaichat 登录链路后由调用方重试一次；失败原样抛出，由调用方置 10008。
   */
  async silentReloginEaichat(budgetMs?: number): Promise<void> {
    const next = new EaiChatClient({ userAccount: this.userAccount, password: this.password })
    try {
      /* 保活链路里重登必须受总预算约束（默认独立登录 28s 会撑破 4.8 的 30s 上限） */
      await next.loginWithDeadline(budgetMs == null ? undefined : Date.now() + budgetMs)
    } catch (error) {
      void next.logout()
      throw error
    }
    this.adoptEaichatClient(next)
    this.deps.log('INFO', '账号', `${maskOf(this.userAccount)} 云智助手会话已自动重新登录`)
  }

  /* ── 契约输出 ───────────────────────────────────────────── */

  toAccount(): Account {
    const pcs: PcInstance[] = this.desktops.map((desktop) => {
      const last = this.desktopLast.get(desktop.desktopId)
      return {
        desktopId: desktop.desktopId,
        desktopName: desktop.desktopName,
        osType: desktop.osType,
        run: desktop.run,
        auto: this.desktopAuto.get(desktop.desktopId) ?? false,
        /* 计划层由调度器持有 nextFireAt：请求到达时实时算，不缓存 */
        left: this.deps.planLeft(desktop.desktopId),
        /* 「使用1小时」类任务本期不实现（backend-design §4.2），link 恒 null */
        link: null,
        lastAt: last?.at ?? null,
        lastMsg: last?.msg ?? null,
        expireDate: desktop.expireDate,
      }
    })
    return {
      userId: this.userId,
      alias: this.alias,
      userAccount: this.userAccount,
      password: this.password,
      dot: this.dot,
      interval: this.interval,
      banner: this.banner ? { ...this.banner } : null,
      pointsWindow: { ...this.pointsWindow },
      eaichat: { ok: this.eaichatOk, msg: this.eaichatOk ? null : this.eaichatMsg },
      /* 快照不得与内部状态共享引用 */
      pcs: pcs.map((pc) => ({ ...pc })),
      points: {
        ...this.points,
        pointsList: this.points.pointsList.map((item) => ({ ...item })),
      },
      tasks: this.tasks.map((task) => ({
        ...task,
        pointsList: task.pointsList.map((item) => ({ ...item })),
        auto: this.taskAuto.get(task.taskDefId) ?? false,
      })),
    }
  }

  toPersistedAccount(): PersistedAccount {
    const desktops: PersistedAccount['desktops'] = []
    for (const [desktopId, auto] of this.desktopAuto) {
      if (auto) desktops.push({ desktopId, auto: true })
    }
    const tasks: PersistedAccount['tasks'] = []
    for (const [taskDefId, auto] of this.taskAuto) {
      if (auto) tasks.push({ taskDefId, auto: true })
    }
    return {
      userId: this.userId,
      userAccount: this.userAccount,
      password: this.password,
      alias: this.alias,
      interval: this.interval,
      pointsWindow: { ...this.pointsWindow },
      desktops,
      tasks,
    }
  }

  /** 删除/替换时尽力退出两套会话（不阻塞调用方） */
  dispose(): void {
    this.stopEaichatRenewal()
    const ctyun = this.ctyun
    const eai = this.eai
    this.ctyun = null
    this.eai = null
    this.profile = null
    this.eaichatOk = false
    this.desktopRefresh = null
    void ctyun?.logout()
    void eai?.logout()
    this.deps.disposed()
  }
}
