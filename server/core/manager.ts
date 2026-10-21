/**
 * AccountManager：账号生命周期编排（backend-design §2 / §7.3）。
 *
 * - 新增 / 修正凭据 / 重试登录 / 删除全部同步执行，失败不生效
 * - 以登录响应 userId 去重：同 userId 旧记录整条移除，新记录落列表尾部
 * - 修正凭据 = 删旧加新：间隔/窗口/实例与任务 auto 按位置继承，旧日志清除
 * - 启动恢复后台执行，不阻塞 /state；登录失败按 danger/warn 分档，不自动反复重登
 */
import {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_POINTS_WINDOW,
  ERROR_MESSAGES,
  ErrorCode,
  MAX_ACCOUNTS,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
} from '../../shared/constants'
import type {
  AddAccountResult,
  CredentialsBody,
  DeleteAccountResult,
  DesktopsResult,
  KeepaliveResult,
  PatchSettingsBody,
  PatchSettingsResult,
  ReloginResult,
  RunState,
  SetDesktopAutoResult,
  StateSnapshot,
  UpdateCredentialsResult,
} from '../../shared/types'
import { isHm, maskOf, nowHm } from '../../shared/utils'
import { ApiError } from '../envelope'
import type { PersistedAccount, PersistedConfig } from '../store/config'
import { CONFIG_DIR, loadConfig, saveConfig } from '../store/config'
import { appendLog, clearAccountLogs, ensureLogDir } from '../store/logs'
import { UpstreamError, upstreamMessage } from '../upstream/errors'
import { AccountSession, LOGIN_BUDGET_MS, RevisionCounter } from './session'
import { scheduler } from './scheduler'
import type { KeepaliveOutcome } from './keepalive'

function sessionApiMessage(code: number): string {
  switch (code) {
    case 51010:
      return '账号或密码不正确，请检查后重新提交'
    case 51020:
      return '账号已被锁定，请稍后再试或联系管理员'
    case 51030:
    case 51031:
    case 51040:
    case 51085:
      return '需要图形验证码，请在官方客户端完成验证后重试'
    case 51090:
    case 51091:
      return '需要短信验证码，请在官方客户端完成验证后重试'
    case 30060:
      return '该账号需要先完成设备绑定'
    default:
      return upstreamMessage(code)
  }
}

function errorCode(error: unknown): number {
  return error instanceof UpstreamError ? error.code : -1
}

const RUN_LABEL: Record<RunState, string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '关机中',
  stopped: '已关机',
  error: '异常',
}

/** 4.8/4.9 的拒绝口径：stopped/starting/stopping 不允许；error 属稳态可保活 */
function isEligibleRun(run: RunState): boolean {
  return run === 'running' || run === 'error'
}

export class AccountManager {
  private sessions: AccountSession[] = []
  private readonly revision = new RevisionCounter()
  private refreshedAt = ''
  private bootPromise: Promise<void> | null = null
  private restorePromise: Promise<void> | null = null

  /* ── 启动 / 恢复（backend-design §7.3） ─────────────────── */

  /** 载入配置并建立内存账号（不登录）；/state 只等这一步 */
  ready(): Promise<void> {
    if (!this.bootPromise) this.bootPromise = this.loadConfigIntoMemory()
    return this.bootPromise
  }

  /** app/server.ts 挂载后调用：后台恢复登录，不阻塞服务启动 */
  async start(): Promise<void> {
    await this.ready()
    void this.restore()
  }

  private async loadConfigIntoMemory(): Promise<void> {
    await ensureLogDir()
    this.refreshedAt = ''
    const { config, error } = await loadConfig()
    if (error) this.logSystem('WARN', '系统', error)
    for (const account of config.accounts) {
      this.sessions.push(this.createSession(account))
    }
    if (this.sessions.length) this.revision.bump()
  }

  /** 启动恢复：逐账号双平台登录 + 列表；失败置 banner，不自动反复重登 */
  restore(): Promise<void> {
    if (!this.restorePromise) this.restorePromise = this.runRestore()
    return this.restorePromise
  }

  private async runRestore(): Promise<void> {
    await this.ready()
    let autoPlans = 0
    /* 恢复开始时的列表引用：尾部回写配置前校验未被并发增删替换 */
    const snapshotRef = this.sessions

    for (const session of [...this.sessions]) {
      if (!this.sessions.includes(session)) continue
      const label = maskOf(session.accountName)
      /* 与 relogin/updateCredentials 互斥：在途时跳过，交由对方收口 */
      if (!session.tryBeginLogin()) {
        this.logAccount(session, 'WARN', '账号', `${label} 启动恢复与重试登录并发，跳过本次恢复`)
        continue
      }
      try {
        /* 与 loginSession 同一口径：双平台共享一份 28s 总预算，eaichat 拿剩余预算 */
        const deadline = Date.now() + LOGIN_BUDGET_MS
        await session.loginCtyun({ deadline })

        try {
          await session.loginEaichat(deadline)
        } catch (error) {
          const warning = session.markEaichatFailure(error)
          this.logAccount(session, 'WARN', '账号', `${label} ${warning}`)
        }

        try {
          await session.refreshDesktops()
        } catch (error) {
          const code = errorCode(error)
          this.logAccount(
            session,
            'WARN',
            '账号',
            `${label} 云电脑列表获取失败：${upstreamMessage(code)}（code=${code}），可稍后手动刷新`,
          )
        }

        /* 登录期间用户可能已删除/顶替该账号：放弃并关闭这个孤儿会话 */
        if (!this.sessions.includes(session)) {
          session.dispose()
          continue
        }
        session.finalizeLogin()
        autoPlans += session.autoDesktopCount
        this.dedupeSessions(session, label)
        const pcCount = session.toAccount().pcs.length
        this.logAccount(
          session,
          'INFO',
          '账号',
          `${label} 登录成功 · 已载入 ${pcCount} 台云电脑` +
            (session.isEaichatReady ? ' · 云智助手会话就绪' : ' · 云智助手会话不可用'),
        )
      } catch (error) {
        /* relogin/修正凭据可能在等待期间已让该账号登录成功：失败不得覆盖 */
        if (session.isLoggedIn) {
          this.logAccount(
            session,
            'WARN',
            '账号',
            `${label} 启动恢复失败，但该账号已有可用会话（可能是重试登录完成），状态保持不变`,
          )
          continue
        }
        const code = errorCode(error)
        session.markLoginFailure(error)
        this.logAccount(
          session,
          'ERROR',
          '账号',
          `${label} 启动恢复失败：${upstreamMessage(code)}（code=${code}），等待用户修正凭据或重试登录`,
        )
      } finally {
        session.endLogin()
      }
    }

    this.logSystem(
      'INFO',
      '系统',
      `应用启动 · 载入 ${this.sessions.length} 个账号 · 恢复 ${autoPlans} 条自动保活计划`,
    )

    /* 启动后把解析出的 alias / 去重结果写回配置（失败只记日志，不影响运行）；
       快照引用与当前不一致 = 期间发生过并发 add/delete（各自已落盘）：跳过，避免覆盖 */
    if (snapshotRef !== this.sessions) {
      this.logSystem('INFO', '系统', '启动恢复期间账号列表发生变化，跳过恢复后配置回写')
      return
    }
    try {
      await this.persistSessions(this.sessions)
    } catch {
      this.logSystem('WARN', '系统', '启动恢复后配置写盘失败，内存态继续可用')
    }
  }

  /** 登录出的 userId 与其它配置记录重复时，保留本次登录的记录（backend-design §2.2） */
  private dedupeSessions(keep: AccountSession, label: string): void {
    const duplicates = this.sessions.filter((item) => item !== keep && item.userId === keep.userId)
    if (!duplicates.length) return
    for (const duplicate of duplicates) duplicate.dispose()
    this.logSystem(
      'WARN',
      '系统',
      `启动恢复时发现重复账号 ${label}（登录返回的 userId 相同），已保留本次登录的记录并移除旧条目`,
    )
    /* 原地去重：不换数组引用，restore 的快照引用校验不受影响 */
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      if (duplicates.includes(this.sessions[i])) this.sessions.splice(i, 1)
    }
  }

  /* ── 4.1 /state ─────────────────────────────────────────── */

  async state(): Promise<StateSnapshot> {
    await this.ready()
    return {
      serverTime: Date.now(),
      revision: this.revision.value,
      maxAccounts: MAX_ACCOUNTS,
      refreshedAt: this.refreshedAt,
      accounts: this.sessions.map((session) => session.toAccount()),
      /* S2 的日志面板尚未接入：系统日志只写内存 ring + system.jsonl，/state 暂不下发（S5 补齐） */
      syslogs: [],
    }
  }

  /* ── 4.2 新增账号 ───────────────────────────────────────── */

  async addAccount(body: CredentialsBody): Promise<AddAccountResult> {
    await this.ready()
    const userAccount = body.userAccount.trim()
    const alias = (body.alias ?? '').trim()
    const label = maskOf(userAccount)

    /* 满额不做登录前预检：同一账号换一种标识（手机号/邮箱/别名）登录出的 userId 相同，
       accountName 粗筛会把「顶替」误判成「新账号」而 10001 误拒。
       正确性优先于省一次登录：一律先登录，登录后按 userId 判定去重/满额（见下方）。 */

    const session = this.createSession({
      userId: 0,
      userAccount,
      password: body.password,
      alias,
      interval: DEFAULT_INTERVAL_MINUTES,
      pointsWindow: { ...DEFAULT_POINTS_WINDOW },
      desktops: [],
      tasks: [],
    })

    let warnings: string[]
    try {
      warnings = await this.loginSession(session)
    } catch (error) {
      session.dispose()
      const code = errorCode(error)
      this.logSystem('WARN', '系统', `添加账号 ${label} 失败：${upstreamMessage(code)}（code=${code}），未写入配置`)
      throw this.toApiError(error)
    }

    const existing = this.sessions.filter((item) => item.userId === session.userId)
    if (!existing.length && this.sessions.length >= MAX_ACCOUNTS) {
      session.dispose()
      this.logSystem('WARN', '系统', `账号数量已达上限 ${MAX_ACCOUNTS}，拒绝添加 ${label}`)
      throw new ApiError(ErrorCode.AccountLimit, ERROR_MESSAGES[ErrorCode.AccountLimit])
    }

    const replaced = existing[0] ?? null
    const replacedAlias = replaced && replaced.toAccount().alias.trim() ? replaced.toAccount().alias : null
    const next = [...this.sessions.filter((item) => item.userId !== session.userId), session]

    try {
      await this.persistSessions(next)
    } catch (error) {
      session.dispose()
      throw error
    }

    this.sessions = next
    const replacedIds = existing.map((item) => item.userId)
    for (const old of existing) old.dispose()
    for (const oldUserId of replacedIds) clearAccountLogs(oldUserId)
    /* 新账号的自动开关全部默认关闭；确保没有同 userId 的残留计划 */
    scheduler.syncSession(session)
    if (replaced) {
      this.logSystem(
        'INFO',
        '系统',
        `本次添加的 ${label} 与已有账号 ${
          replacedAlias ? `${replacedAlias} ` : ''
        }${maskOf(replaced.accountName)} 是同一个天翼云账号（登录返回的 userId 相同）· 已按「只保留最后一次添加的账号信息」删除旧的那条 · 它的配置、保活开关与日志一并移除`,
      )
    }
    this.logAccount(
      session,
      'INFO',
      '账号',
      `${label} 登录成功 · 密码已明文写入配置文件 · 该账号所有实例的自动保活开关默认关闭，需逐台打开` +
        (session.isEaichatReady ? ' · 云智助手会话就绪' : ' · 云智助手会话不可用'),
    )

    return {
      revision: this.revision.value,
      account: session.toAccount(),
      replacedAlias,
      warnings,
    }
  }

  /* ── 4.3 修正凭据 ───────────────────────────────────────── */

  async updateCredentials(userId: number, body: CredentialsBody): Promise<UpdateCredentialsResult> {
    await this.ready()
    const previous = this.requireSession(userId)
    if (!previous.tryBeginLogin()) {
      throw new ApiError(ErrorCode.StateNotAllowed, '该账号正在登录中，请稍后再试')
    }
    try {
      return await this.runUpdateCredentials(previous, userId, body)
    } finally {
      previous.endLogin()
    }
  }

  private async runUpdateCredentials(
    previous: AccountSession,
    userId: number,
    body: CredentialsBody,
  ): Promise<UpdateCredentialsResult> {
    const oldIndex = this.sessions.indexOf(previous)
    const oldLabel = maskOf(previous.accountName)
    const oldUserId = previous.userId
    const userAccount = body.userAccount.trim()
    const newLabel = maskOf(userAccount)

    const draft = this.createSession({
      userId: 0,
      userAccount,
      password: body.password,
      alias: (body.alias ?? '').trim(),
      interval: previous.intervalMinutes,
      pointsWindow: { ...DEFAULT_POINTS_WINDOW },
      desktops: [],
      tasks: [],
    })

    let warnings: string[]
    try {
      warnings = await this.loginSession(draft)
    } catch (error) {
      draft.dispose()
      const code = errorCode(error)
      this.logAccount(
        previous,
        'WARN',
        '账号',
        `${oldLabel} 修正凭据失败：${upstreamMessage(code)}（code=${code}），原账号保持不变`,
      )
      throw this.toApiError(error)
    }

    draft.inheritSettingsFrom(previous)
    draft.finalizeLogin()
    /* 继承的 auto 开关要立刻生效（登录时的列表拉取发生在继承之前） */
    scheduler.syncSession(draft)

    const displaced = this.sessions.filter((item) => item !== previous && item.userId === draft.userId)
    const sameUserId = draft.userId === previous.userId
    const remaining = this.sessions.filter((item) => item !== previous && item.userId !== draft.userId)
    if (sameUserId) remaining.splice(Math.min(Math.max(oldIndex, 0), remaining.length), 0, draft)
    else remaining.push(draft)

    try {
      await this.persistSessions(remaining)
    } catch (error) {
      /* 落盘失败：新会话作废，旧会话的计划按原状态恢复（syncSession 已先清过旧计划） */
      draft.dispose()
      scheduler.syncSession(previous)
      throw error
    }

    this.sessions = remaining
    const displacedInfo = displaced.map((item) => ({
      userId: item.userId,
      alias: item.toAccount().alias,
      maskedAccount: maskOf(item.accountName),
    }))
    previous.dispose()
    clearAccountLogs(oldUserId)
    for (const old of displaced) old.dispose()
    for (const item of displacedInfo) {
      clearAccountLogs(item.userId)
      this.logSystem(
        'INFO',
        '系统',
        `本次修正凭据登录出的账号 ${item.alias.trim() ? `${item.alias} ` : ''}${item.maskedAccount} 与已有账号是同一个天翼云账号（登录返回的 userId 相同）· 已按「只保留最后一次添加的账号信息」顶替原记录 · 它的配置与日志一并移除`,
      )
    }

    const keptSettings =
      `（保活间隔 ${draft.intervalMinutes} 分钟、积分时间窗口与各实例自动开关按位置继承；原账号的日志已清除）`
    this.logAccount(
      draft,
      'INFO',
      '账号',
      (sameUserId
        ? `账号 ${newLabel} 的凭据已更正并登录成功：仍然按「先删原账号、再加新账号」执行`
        : `账号 ${oldLabel} 已替换为 ${newLabel}`) + keptSettings,
    )

    return {
      revision: this.revision.value,
      account: draft.toAccount(),
      replacedAlias: null,
      warnings,
    }
  }

  /* ── 4.4 重试登录 ───────────────────────────────────────── */

  async relogin(userId: number): Promise<ReloginResult> {
    await this.ready()
    const session = this.requireSession(userId)
    if (!session.tryBeginLogin()) {
      throw new ApiError(ErrorCode.StateNotAllowed, '该账号正在登录中，请稍后再试')
    }
    try {
      return await this.runRelogin(session, userId)
    } finally {
      session.endLogin()
    }
  }

  private async runRelogin(session: AccountSession, userId: number): Promise<ReloginResult> {
    const label = maskOf(session.accountName)
    session.beginRelogin()

    try {
      const warnings = await this.loginSession(session)
      session.finalizeLogin()
      /* banner 期间被取消的计划在重新登录成功后恢复（列表拉取早于 finalize） */
      scheduler.syncSession(session)
      const suffix = warnings.length
        ? warnings.every((warning) => warning.includes('云智助手'))
          ? ' · 云智助手会话不可用，无感保活暂不可用'
          : ' · 部分数据获取失败，详见日志'
        : ''
      this.logAccount(session, 'INFO', '账号', `${label} 重试登录成功 · 已恢复该账号的云电脑列表${suffix}`)
      for (const warning of warnings) this.logAccount(session, 'WARN', '账号', `${label} ${warning}`)
    } catch (error) {
      /* restore 可能在等待期间已让该账号登录成功：失败不得覆盖 */
      if (session.isLoggedIn) {
        this.logAccount(
          session,
          'WARN',
          '账号',
          `${label} 重试登录失败，但该账号已有可用会话（可能是启动恢复完成），状态保持不变`,
        )
        throw this.toApiError(error)
      }
      const code = errorCode(error)
      session.markLoginFailure(error)
      this.logAccount(
        session,
        'ERROR',
        '账号',
        `${label} 重试登录失败：${upstreamMessage(code)}（code=${code}），该账号自动任务继续挂起`,
      )
      throw this.toApiError(error)
    }

    return { revision: this.revision.value, account: session.toAccount() }
  }

  /* ── 4.5 删除账号 ───────────────────────────────────────── */

  async deleteAccount(userId: number): Promise<DeleteAccountResult> {
    await this.ready()
    const session = this.requireSession(userId)
    const label = maskOf(session.accountName)
    const next = this.sessions.filter((item) => item !== session)

    await this.persistSessions(next)

    this.sessions = next
    const removedUserId = session.userId
    /* dispose 内部通知 scheduler.dropSession：取消该账号全部计划/追踪/兜底定时器 */
    session.dispose()
    clearAccountLogs(removedUserId)
    this.logSystem(
      'INFO',
      '账号',
      `已删除账号 ${label} · 配置文件中该条（含 password）已整条移除并覆盖写盘 · 该账号的日志已随之删除`,
    )
    return null
  }

  /* ── 4.6 修改设置 ───────────────────────────────────────── */

  async updateSettings(userId: number, body: PatchSettingsBody): Promise<PatchSettingsResult> {
    await this.ready()
    const session = this.requireSession(userId)
    const hasInterval = body.interval !== undefined
    const hasWindow = body.pointsWindow !== undefined
    if (!hasInterval && !hasWindow) throw new ApiError(ErrorCode.InvalidParam, '参数校验失败：至少传一个字段')

    const previousInterval = session.intervalMinutes
    const previousWindow = session.pointsWindowSnapshot

    if (hasInterval) {
      const interval = body.interval as number
      if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MINUTES || interval > MAX_INTERVAL_MINUTES) {
        throw new ApiError(
          ErrorCode.InvalidParam,
          `参数校验失败：保活间隔需为 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟`,
        )
      }
      session.setIntervalMinutes(interval)
    }
    if (hasWindow) {
      const { winStart, winEnd } = body.pointsWindow as { winStart: string; winEnd: string }
      if (!isHm(winStart) || !isHm(winEnd)) {
        session.setIntervalMinutes(previousInterval)
        throw new ApiError(ErrorCode.InvalidParam, '参数校验失败：积分时间窗口格式需为 HH:mm')
      }
      if (winStart >= winEnd) {
        session.setIntervalMinutes(previousInterval)
        throw new ApiError(ErrorCode.InvalidParam, '参数校验失败：积分时间窗口起止时间倒置')
      }
      session.setPointsWindow({ winStart, winEnd })
    }

    try {
      await this.persistSessions(this.sessions)
    } catch (error) {
      session.setIntervalMinutes(previousInterval)
      session.setPointsWindow(previousWindow)
      throw error
    }

    if (hasInterval) {
      scheduler.applyInterval(session)
      this.logAccount(
        session,
        'INFO',
        '保活',
        `${maskOf(session.accountName)} 保活间隔已改为 ${session.intervalMinutes} 分钟，全部自动保活计划已按新间隔重排`,
      )
    }
    if (hasWindow) {
      this.logAccount(
        session,
        'INFO',
        '积分',
        `${maskOf(session.accountName)} 积分任务时间窗口已改为 ${session.pointsWindowSnapshot.winStart}–${session.pointsWindowSnapshot.winEnd}`,
      )
    }

    return { revision: this.revision.value, account: session.toAccount() }
  }

  /* ── 4.7 刷新云电脑列表 ─────────────────────────────────── */

  async listDesktops(userId: number): Promise<DesktopsResult> {
    await this.ready()
    const session = this.requireSession(userId)
    if (session.hasBanner) {
      throw new ApiError(ErrorCode.StateNotAllowed, '账号处于异常状态，暂时无法获取云电脑列表')
    }
    try {
      await session.refreshDesktops({ timeoutMs: 10_000, retries: 0 })
    } catch (error) {
      throw this.toApiError(error)
    }
    return { refreshedAt: nowHm(), pcs: session.toAccount().pcs }
  }

  /* ── 4.8 手动保活 ───────────────────────────────────────── */

  async keepalive(userId: number, desktopId: string): Promise<KeepaliveResult> {
    await this.ready()
    const session = this.requireSession(userId)
    if (session.hasBanner) throw new ApiError(ErrorCode.StateNotAllowed, '账号处于异常状态，暂时无法保活')

    const desktop = session.findDesktop(desktopId)
    if (!desktop) throw new ApiError(ErrorCode.DesktopNotFound, ERROR_MESSAGES[ErrorCode.DesktopNotFound])
    if (!isEligibleRun(desktop.run)) {
      throw new ApiError(
        ErrorCode.StateNotAllowed,
        `实例当前为「${RUN_LABEL[desktop.run]}」状态，不允许保活（工具不代为开机）`,
      )
    }
    if (session.linkFor(desktopId) != null) {
      throw new ApiError(ErrorCode.StateNotAllowed, '实例正被积分任务占用，本轮保活暂停')
    }
    if (!session.isEaichatReady) {
      throw new ApiError(ErrorCode.EaichatUnavailable, ERROR_MESSAGES[ErrorCode.EaichatUnavailable])
    }

    const outcome = await scheduler.manual(session, desktopId)
    /* 网络/会话类失败才走错误信封；上游业务拒绝按 4.8 契约用 ok=false + lastMsg 表达 */
    if (!outcome.ok && outcome.failureKind === 'network') {
      throw new ApiError(ErrorCode.UpstreamNetwork, outcome.apiMsg ?? '保活请求失败，请稍后重试')
    }
    if (!outcome.ok && outcome.failureKind === 'auth') {
      throw new ApiError(ErrorCode.EaichatUnavailable, outcome.apiMsg ?? ERROR_MESSAGES[ErrorCode.EaichatUnavailable])
    }

    return {
      revision: this.revision.value,
      desktopId,
      ok: outcome.ok,
      elapsedMs: outcome.elapsedMs,
      lastAt: outcome.lastAt,
      lastMsg: outcome.lastMsg,
      /* 契约口径：auto=true 时按 interval 重排，否则 null */
      left: session.isDesktopAuto(desktopId) ? session.intervalMinutes * 60 : null,
    }
  }

  /* ── 4.9 切换自动保活 ───────────────────────────────────── */

  async setDesktopAuto(userId: number, desktopId: string, auto: boolean): Promise<SetDesktopAutoResult> {
    await this.ready()
    const session = this.requireSession(userId)

    const desktop = session.findDesktop(desktopId)
    if (!desktop) throw new ApiError(ErrorCode.DesktopNotFound, ERROR_MESSAGES[ErrorCode.DesktopNotFound])

    /* 关闭永远允许（账号处于 banner 期间也允许关闭） */
    if (!auto) {
      const wasAuto = session.isDesktopAuto(desktopId)
      session.setDesktopAuto(desktopId, false)
      scheduler.disable(session, desktopId)
      try {
        await this.persistSessions(this.sessions)
      } catch (error) {
        session.setDesktopAuto(desktopId, wasAuto)
        /* 回滚开关后按当前状态恢复计划（重新按间隔计时） */
        if (wasAuto) scheduler.syncSession(session)
        throw error
      }
      this.logAccount(
        session,
        'INFO',
        '保活',
        `${desktop.desktopName} 已关闭自动保活（该实例不再产生任何保活请求）`,
      )
      return { revision: this.revision.value, desktopId, auto: false, left: null }
    }

    /* 打开：受账号 banner、实例状态、link 占用与 eaichat 会话限制 */
    if (session.hasBanner) throw new ApiError(ErrorCode.StateNotAllowed, '账号处于异常状态，暂时无法修改自动保活')
    if (!isEligibleRun(desktop.run)) {
      throw new ApiError(
        ErrorCode.StateNotAllowed,
        `实例当前为「${RUN_LABEL[desktop.run]}」状态，不允许开启自动保活（工具不代为开机）`,
      )
    }
    if (session.linkFor(desktopId) != null) {
      throw new ApiError(ErrorCode.StateNotAllowed, '实例正被积分任务占用，本轮保活暂停')
    }
    if (!session.isEaichatReady) {
      throw new ApiError(ErrorCode.EaichatUnavailable, ERROR_MESSAGES[ErrorCode.EaichatUnavailable])
    }

    const wasAuto = session.isDesktopAuto(desktopId)
    session.setDesktopAuto(desktopId, true)
    let outcome: KeepaliveOutcome | null
    try {
      /* 打开开关立即执行一次（后端内部同步）；探测后状态不再允许时 executeRound 抛 10005/10008 并回滚 */
      outcome = await scheduler.enable(session, desktopId)
      /* 网络/会话类失败＝立即保活没有执行成功：整个开关操作不生效（对齐「失败时操作不生效」） */
      if (!outcome.ok && outcome.failureKind === 'network') {
        throw new ApiError(ErrorCode.UpstreamNetwork, outcome.apiMsg ?? ERROR_MESSAGES[ErrorCode.UpstreamNetwork])
      }
      if (!outcome.ok && outcome.failureKind === 'auth') {
        throw new ApiError(ErrorCode.EaichatUnavailable, outcome.apiMsg ?? ERROR_MESSAGES[ErrorCode.EaichatUnavailable])
      }
    } catch (error) {
      session.setDesktopAuto(desktopId, wasAuto)
      /* 回滚计划：原本就开着则重新对齐，否则彻底取消 */
      if (wasAuto) scheduler.syncSession(session)
      else scheduler.disable(session, desktopId)
      throw error
    }

    try {
      await this.persistSessions(this.sessions)
    } catch (error) {
      session.setDesktopAuto(desktopId, wasAuto)
      if (wasAuto) scheduler.syncSession(session)
      else scheduler.disable(session, desktopId)
      throw error
    }

    this.logAccount(
      session,
      'INFO',
      '保活',
      `${desktop.desktopName} 已开启自动保活（立即执行${outcome.ok ? '成功' : '失败，下个周期重试'}，随后每 ${session.intervalMinutes} 分钟一轮）`,
    )
    return {
      revision: this.revision.value,
      desktopId,
      auto: true,
      left: session.intervalMinutes * 60,
    }
  }

  /* ── 登录编排 / 持久化 / 错误映射 ────────────────────────── */

  /**
   * 登录编排：negotiate + login + eaichat 共享同一份 28s 预算（review MAJOR-1/2）；
   * 后端整体 ≤30s（eaichat 拿剩余预算），前端 35s 预算内必然有响应。
   */
  private async loginSession(session: AccountSession): Promise<string[]> {
    const deadline = Date.now() + LOGIN_BUDGET_MS
    await session.loginCtyun({ deadline })
    const warnings: string[] = []

    try {
      await session.loginEaichat(deadline)
    } catch (error) {
      warnings.push(session.markEaichatFailure(error))
    }

    try {
      await session.refreshDesktops()
    } catch (error) {
      const code = errorCode(error)
      warnings.push(`云电脑列表获取失败：${upstreamMessage(code)}，可稍后重试登录恢复`)
    }

    session.finalizeLogin()
    return warnings
  }

  private createSession(persisted: PersistedAccount): AccountSession {
    let session: AccountSession
    const deps = {
      revision: this.revision,
      log: (lv: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', mod: '账号' | '保活' | '积分' | '调度' | '系统', msg: string) =>
        this.logAccount(session, lv, mod, msg),
      refreshed: () => {
        this.refreshedAt = nowHm()
      },
      /* 列表刷新后对齐计划（run 变化即时反作用于计划、恢复计时） */
      desktopsUpdated: () => scheduler.syncSession(session),
      /* 删除/替换/登录失败：清掉该会话全部定时器与追踪任务 */
      disposed: () => scheduler.dropSession(session),
      /* left 实时派生：nextFireAt - now() */
      planLeft: (desktopId: string) => scheduler.leftFor(session.userId, desktopId),
    }
    session = new AccountSession(persisted, deps)
    return session
  }

  private requireSession(userId: number): AccountSession {
    const session = this.sessions.find((item) => item.userId === userId)
    if (!session) throw new ApiError(ErrorCode.AccountNotFound, ERROR_MESSAGES[ErrorCode.AccountNotFound])
    return session
  }

  private logAccount(
    session: AccountSession,
    lv: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    mod: '账号' | '保活' | '积分' | '调度' | '系统',
    msg: string,
  ): void {
    appendLog(session.userId, lv, mod, msg)
    this.revision.bump()
  }

  private logSystem(lv: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', mod: '账号' | '保活' | '积分' | '调度' | '系统', msg: string): void {
    appendLog(null, lv, mod, msg)
    this.revision.bump()
  }

  private async persistSessions(sessions: AccountSession[]): Promise<void> {
    const config: PersistedConfig = {
      version: 1,
      accounts: sessions.map((session) => session.toPersistedAccount()),
    }
    try {
      await saveConfig(config)
    } catch {
      throw new ApiError(ErrorCode.UpstreamNetwork, `配置保存失败，请检查 ${CONFIG_DIR} 目录权限`)
    }
  }

  private toApiError(error: unknown): ApiError {
    if (error instanceof ApiError) return error
    if (error instanceof UpstreamError) {
      if (error.code === -1) {
        return new ApiError(ErrorCode.UpstreamNetwork, '上游网络异常或超时，请稍后重试')
      }
      return new ApiError(error.code, sessionApiMessage(error.code))
    }
    return new ApiError(ErrorCode.UpstreamNetwork, '上游请求失败，请稍后重试')
  }
}

/** 全局单例：Hono 子应用与启动恢复共用同一份内存态 */
export const manager = new AccountManager()
