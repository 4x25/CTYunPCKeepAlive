/**
 * 无感保活执行（backend-design §3.1 / §3.3 / §6.3）。
 *
 * 只认 eaichat 的 `prevent-power-strategy`：
 *   - desktopName 传 base64（服务端会解码，中文原名会触发 1001）
 *   - desktopUuid = 云电脑列表的 foreignDesktopId，不是 desktopId
 *   - sourceType = 0
 *   - 成功判定：HTTP 200 且响应 code === 0（不使用 resultCode/success）
 *
 * 失败一律归类成固定文案，绝不透传上游 message（可能带出账号/桌面等值）。
 * 成功与失败都写 lastAt/lastMsg + 账号日志；日志只写实例名，不写 ID。
 */
import type { CtyunDesktop } from '../upstream/ctyun-client'
import { UpstreamError, UpstreamNetworkError } from '../upstream/errors'
import { createWarnThrottle } from './warn-throttle'
import type { AccountSession } from './session'

/** 单次上游保活请求超时（异常上限；实测典型 <1s） */
export const KEEPALIVE_TIMEOUT_MS = 30_000

export type KeepaliveFailureKind = 'network' | 'auth' | 'business'

export interface KeepaliveOutcome {
  ok: boolean
  elapsedMs: number
  lastAt: number
  lastMsg: string
  failureKind?: KeepaliveFailureKind
  /** 上游业务 code（仅诊断，不写日志原文） */
  upstreamCode?: number
  /** 4.8 失败信封的固定文案（不含上游原文） */
  apiMsg?: string
}

function authFailure(): Pick<KeepaliveOutcome, 'lastMsg' | 'apiMsg'> {
  return {
    lastMsg: '云智助手会话失效，请重试登录后恢复',
    apiMsg: '云智助手会话不可用，请重试登录',
  }
}

function failureText(kind: KeepaliveFailureKind, code: number | undefined): Pick<KeepaliveOutcome, 'lastMsg' | 'apiMsg'> {
  if (kind === 'network') {
    return {
      lastMsg: '保活失败：网络异常或超时，下个周期重试',
      apiMsg: '保活请求失败：网络异常或超时，请稍后重试',
    }
  }
  if (kind === 'auth') {
    const text = authFailure()
    return { lastMsg: `保活失败：${text.lastMsg}`, apiMsg: text.apiMsg }
  }
  switch (code) {
    case 1001:
      return {
        lastMsg: '保活失败：云电脑名称参数异常，下个周期重试',
        apiMsg: '保活请求失败：云电脑名称参数异常',
      }
    case 1003:
      return {
        lastMsg: '保活失败：云电脑未在云智助手登记，无法保活',
        apiMsg: '保活请求失败：云电脑未在云智助手登记',
      }
    default:
      return {
        lastMsg: `保活失败：上游接口返回错误（code=${code ?? -1}），下个周期重试`,
        apiMsg: '保活请求失败：上游接口返回错误，请稍后重试',
      }
  }
}

function failOutcome(lastAt: number, kind: KeepaliveFailureKind, code?: number): KeepaliveOutcome {
  const text = failureText(kind, code)
  return {
    ok: false,
    elapsedMs: 0,
    lastAt,
    lastMsg: text.lastMsg,
    apiMsg: text.apiMsg,
    failureKind: kind,
    upstreamCode: code,
  }
}

/**
 * 执行一次保活；无论成败都回写 lastAt/lastMsg 与账号日志。
 * 调用方负责互斥与状态门禁（run / eaichat / link）。
 * `deadline` 为整轮截止时间（手动 4.8 用，保证前端 15s 预算内收口）。
 */
export async function runKeepalive(
  session: AccountSession,
  desktop: CtyunDesktop,
  reason: 'manual' | 'auto',
  deadline?: number,
): Promise<KeepaliveOutcome> {
  const lastAt = Date.now()
  let outcome: KeepaliveOutcome

  if (!desktop.foreignDesktopId) {
    outcome = {
      ok: false,
      elapsedMs: 0,
      lastAt,
      lastMsg: '保活失败：缺少云电脑标识，无法保活',
      apiMsg: '保活请求失败：缺少云电脑标识',
      failureKind: 'business',
    }
  } else if (!session.getEaichatClient()) {
    outcome = failOutcome(lastAt, 'auth')
  } else {
    outcome = await callUpstream(session, desktop, lastAt, deadline)
  }

  outcome = { ...outcome, elapsedMs: Math.max(0, Date.now() - lastAt) }
  if (outcome.ok) outcome.lastMsg = `保活成功 · 耗时 ${outcome.elapsedMs}ms`

  session.recordKeepalive(desktop.desktopId, outcome.lastAt, outcome.lastMsg)
  if (outcome.ok) {
    session.log('INFO', '保活', `${desktop.desktopName} ${outcome.lastMsg}`)
  } else {
    const level = outcome.failureKind === 'business' ? 'WARN' : 'ERROR'
    session.log(level, '保活', `${desktop.desktopName} ${outcome.lastMsg}`)
    if (reason === 'auto') session.log('WARN', '调度', `${desktop.desktopName} 本轮自动保活失败，下个周期重试`)
  }

  return outcome
}

async function callUpstream(
  session: AccountSession,
  desktop: CtyunDesktop,
  lastAt: number,
  deadline?: number,
): Promise<KeepaliveOutcome> {
  const uuid = desktop.foreignDesktopId as string
  const limit = Math.min(deadline ?? Number.POSITIVE_INFINITY, lastAt + KEEPALIVE_TIMEOUT_MS)
  const attempt = async (): Promise<void> => {
    const eai = session.getEaichatClient()
    if (!eai) throw new UpstreamError(40010, '云智助手未登录')
    const remaining = limit - Date.now()
    if (remaining <= 0) throw new UpstreamNetworkError('保活请求超过 30000 ms')
    await eai.preventPowerStrategy({
      desktopName: desktop.desktopName,
      desktopUuid: uuid,
      sourceType: 0,
      timeoutMs: remaining,
    })
  }

  try {
    await attempt()
    return { ok: true, elapsedMs: 0, lastAt, lastMsg: '' }
  } catch (error) {
    /* HTTP 401：静默重走 eaichat 登录链路后重试一次（backend-design §3.3），全程受 30s 预算约束 */
    if (!(error instanceof UpstreamError) || error.code !== 40010) return classify(session, lastAt, error)

    const remaining = limit - Date.now()
    if (remaining <= 0) return failOutcome(lastAt, 'auth')
    try {
      /* 重登最多拿剩余预算的一半，留一半给重试请求 */
      await session.silentReloginEaichat(Math.max(2_000, Math.floor(remaining / 2)))
    } catch (loginError) {
      /* 自动重登失败（含验证码/风控类）：会话不可用，本次与后续保活都按 10008 处理 */
      session.markEaichatFailure(loginError)
      return failOutcome(lastAt, 'auth')
    }

    try {
      await attempt()
      return { ok: true, elapsedMs: 0, lastAt, lastMsg: '' }
    } catch (retryError) {
      if (retryError instanceof UpstreamError && retryError.code === 40010) {
        session.markEaichatFailure(retryError)
        return failOutcome(lastAt, 'auth')
      }
      return classify(session, lastAt, retryError)
    }
  }
}

/*
 * console 诊断节流：与账号 ring 日志的 WARN 节流同口径（同账号同类告警 10 分钟一次）。
 * 持续故障时 network / auth / business 每类每账号 10 分钟只打一条，避免刷屏；
 * 账号界面日志仍逐轮记录，不受影响。
 */
const consoleWarnThrottle = new WeakMap<AccountSession, (key: string) => boolean>()

function shouldConsoleWarn(session: AccountSession, kind: KeepaliveFailureKind): boolean {
  let throttle = consoleWarnThrottle.get(session)
  if (!throttle) {
    throttle = createWarnThrottle()
    consoleWarnThrottle.set(session, throttle)
  }
  return throttle(kind)
}

function classify(session: AccountSession, lastAt: number, error: unknown): KeepaliveOutcome {
  if (error instanceof UpstreamNetworkError) {
    if (shouldConsoleWarn(session, 'network')) console.warn('[keepalive] upstream network failure')
    return failOutcome(lastAt, 'network')
  }
  if (error instanceof UpstreamError) {
    const kind: KeepaliveFailureKind = error.code === 40010 ? 'auth' : 'business'
    /* 诊断信息只进 console：不含账号、桌面 ID 或上游原文 */
    if (shouldConsoleWarn(session, kind)) console.warn(`[keepalive] upstream failure kind=${kind} code=${error.code}`)
    return failOutcome(lastAt, kind, error.code)
  }
  if (shouldConsoleWarn(session, 'network')) console.warn('[keepalive] unexpected failure')
  return failOutcome(lastAt, 'network')
}
