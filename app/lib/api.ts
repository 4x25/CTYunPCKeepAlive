import { ErrorCode, TIMEOUT_MS } from '../../shared/constants'
import type {
  AddAccountResult,
  ApiEnvelope,
  CheckinTokenTaskResult,
  CredentialsBody,
  DeleteAccountResult,
  DesktopsResult,
  KeepaliveResult,
  LogQuery,
  LogsClearResult,
  LogsResult,
  PatchSettingsBody,
  PatchSettingsResult,
  PointsResult,
  ReloginResult,
  RunTaskResult,
  SetDesktopAutoResult,
  SetTaskAutoResult,
  StateSnapshot,
  TokenResult,
  UpdateCredentialsResult,
} from '../../shared/types'
import { ApiError } from './api-error'
import { mockApi } from './api-mock'

export { ApiError, isApiError, isTimeout } from './api-error'

/** 与 api.md §3 的 16 个接口一一对应；api-mock.ts 实现同一份签名 */
export interface ApiClient {
  /** 4.1 全量快照 */
  getState(): Promise<StateSnapshot>
  /** 4.2 新增账号（同步） */
  createAccount(body: CredentialsBody): Promise<AddAccountResult>
  /** 4.3 修正凭据（同步） */
  updateCredentials(userId: number, body: CredentialsBody): Promise<UpdateCredentialsResult>
  /** 4.4 重试登录（同步） */
  relogin(userId: number): Promise<ReloginResult>
  /** 4.5 删除账号（同步） */
  deleteAccount(userId: number): Promise<DeleteAccountResult>
  /** 4.6 修改保活间隔 / 积分时间窗口 */
  updateSettings(userId: number, body: PatchSettingsBody): Promise<PatchSettingsResult>
  /** 4.7 刷新云电脑列表 */
  listDesktops(userId: number): Promise<DesktopsResult>
  /** 4.8 手动保活（同步） */
  keepalive(userId: number, desktopId: string): Promise<KeepaliveResult>
  /** 4.9 切换自动保活开关 */
  setDesktopAuto(userId: number, desktopId: string, auto: boolean): Promise<SetDesktopAutoResult>
  /** 4.10 刷新积分与任务 */
  getPoints(userId: number): Promise<PointsResult>
  /** 4.11 手动执行积分任务（异步受理） */
  runTask(userId: number, taskDefId: number): Promise<RunTaskResult>
  /** 4.12 切换任务自动开关 */
  setTaskAuto(userId: number, taskDefId: number, auto: boolean): Promise<SetTaskAutoResult>
  /** 4.15 刷新云智助手 Token 用量与任务 */
  getToken(userId: number): Promise<TokenResult>
  /** 4.16 签到 / 领取 Token 任务 */
  checkinTokenTask(userId: number, taskDefId: number): Promise<CheckinTokenTaskResult>
  /** 4.13 日志查询 */
  queryLogs(query: LogQuery): Promise<LogsResult>
  /** 4.14 清空界面日志 */
  clearLogs(userId: number): Promise<LogsClearResult>
}

const BASE = '/api'

type QueryValue = string | number | boolean | undefined

interface RequestOptions {
  body?: unknown
  query?: Record<string, QueryValue>
  timeoutMs?: number
}

function toQueryString(query?: Record<string, QueryValue>): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/**
 * 统一请求封装（frontend-design §3.1）：
 * 信封解析（code !== 0 抛 ApiError）、超时、JSON 头。
 */
async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const { body, query, timeoutMs = TIMEOUT_MS.light } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8'

  try {
    let res: Response
    try {
      res = await fetch(`${BASE}${path}${toQueryString(query)}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        throw new ApiError(ErrorCode.Network, '请求超时，结果未知')
      }
      throw new ApiError(ErrorCode.Network, '网络异常，请稍后重试')
    }

    if (!res.ok) {
      /* 非 2xx 也尽量解析服务端信封：404/500 的 msg 可能比通用兜底文案更有用 */
      let failure: ApiEnvelope<unknown> | null = null
      try {
        failure = (await res.json()) as ApiEnvelope<unknown>
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          throw new ApiError(ErrorCode.Network, '请求超时，结果未知')
        }
      }
      if (failure && typeof failure.code === 'number' && failure.msg) {
        throw new ApiError(failure.code, failure.msg)
      }
      throw new ApiError(
        ErrorCode.Network,
        res.status === 500 ? '服务异常，请查看磁盘日志' : `请求失败（HTTP ${res.status}）`,
      )
    }

    let envelope: ApiEnvelope<T>
    try {
      envelope = (await res.json()) as ApiEnvelope<T>
    } catch (error) {
      /* body 读取期间超时也会抛 AbortError，先按超时口径处理 */
      if ((error as { name?: string }).name === 'AbortError') {
        throw new ApiError(ErrorCode.Network, '请求超时，结果未知')
      }
      throw new ApiError(ErrorCode.Network, '响应格式异常，请稍后重试')
    }

    if (!envelope || typeof envelope.code !== 'number') {
      throw new ApiError(ErrorCode.Network, '响应格式异常，请稍后重试')
    }
    if (envelope.code !== 0) {
      throw new ApiError(envelope.code, envelope.msg || `请求失败（code=${envelope.code}）`)
    }
    return envelope.data
  } finally {
    clearTimeout(timer)
  }
}

const uid = (userId: number) => encodeURIComponent(String(userId))
const did = (desktopId: string) => encodeURIComponent(desktopId)
const tid = (taskDefId: number) => encodeURIComponent(String(taskDefId))

const realApi: ApiClient = {
  getState: () => request<StateSnapshot>('GET', '/state', { timeoutMs: TIMEOUT_MS.list }),

  createAccount: (body) =>
    request<AddAccountResult>('POST', '/accounts', { body, timeoutMs: TIMEOUT_MS.accountOp }),

  updateCredentials: (userId, body) =>
    request<UpdateCredentialsResult>('PUT', `/accounts/${uid(userId)}/credentials`, {
      body,
      timeoutMs: TIMEOUT_MS.accountOp,
    }),

  relogin: (userId) =>
    request<ReloginResult>('POST', `/accounts/${uid(userId)}/relogin`, {
      timeoutMs: TIMEOUT_MS.accountOp,
    }),

  deleteAccount: (userId) =>
    request<DeleteAccountResult>('DELETE', `/accounts/${uid(userId)}`, {
      timeoutMs: TIMEOUT_MS.accountOp,
    }),

  updateSettings: (userId, body) =>
    request<PatchSettingsResult>('PATCH', `/accounts/${uid(userId)}/settings`, {
      body,
      timeoutMs: TIMEOUT_MS.light,
    }),

  listDesktops: (userId) =>
    request<DesktopsResult>('GET', `/accounts/${uid(userId)}/desktops`, {
      timeoutMs: TIMEOUT_MS.list,
    }),

  keepalive: (userId, desktopId) =>
    request<KeepaliveResult>('POST', `/accounts/${uid(userId)}/desktops/${did(desktopId)}/keepalive`, {
      timeoutMs: TIMEOUT_MS.keepalive,
    }),

  setDesktopAuto: (userId, desktopId, auto) =>
    request<SetDesktopAutoResult>('PATCH', `/accounts/${uid(userId)}/desktops/${did(desktopId)}`, {
      body: { auto },
      timeoutMs: TIMEOUT_MS.keepalive,
    }),

  getPoints: (userId) =>
    request<PointsResult>('GET', `/accounts/${uid(userId)}/points`, { timeoutMs: TIMEOUT_MS.list }),

  runTask: (userId, taskDefId) =>
    request<RunTaskResult>('POST', `/accounts/${uid(userId)}/points/tasks/${tid(taskDefId)}/run`, {
      timeoutMs: TIMEOUT_MS.light,
    }),

  setTaskAuto: (userId, taskDefId, auto) =>
    request<SetTaskAutoResult>('PATCH', `/accounts/${uid(userId)}/points/tasks/${tid(taskDefId)}`, {
      body: { auto },
      timeoutMs: TIMEOUT_MS.light,
    }),

  getToken: (userId) =>
    request<TokenResult>('GET', `/accounts/${uid(userId)}/token`, { timeoutMs: TIMEOUT_MS.list }),

  checkinTokenTask: (userId, taskDefId) =>
    request<CheckinTokenTaskResult>('POST', `/accounts/${uid(userId)}/token/tasks/${tid(taskDefId)}/checkin`, {
      timeoutMs: TIMEOUT_MS.list,
    }),

  queryLogs: (query) =>
    request<LogsResult>('GET', '/logs', {
      query: {
        userId: query.userId,
        lv: query.lv,
        mod: query.mod,
        kw: query.kw,
        includeSys: query.includeSys,
        sinceSeq: query.sinceSeq,
        limit: query.limit,
      },
      timeoutMs: TIMEOUT_MS.list,
    }),

  clearLogs: (userId) =>
    request<LogsClearResult>('DELETE', '/logs', {
      query: { userId },
      timeoutMs: TIMEOUT_MS.light,
    }),
}

/** 切换点收敛在这一行：VITE_USE_MOCK=1 时走内存假实现 */
export const useMockApi = ['1', 'true'].includes(import.meta.env.VITE_USE_MOCK ?? '')

export const api: ApiClient = useMockApi ? mockApi : realApi
