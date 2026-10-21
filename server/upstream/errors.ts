/**
 * 上游错误与错误码语义（api.md §1.2、backend-design §2.3）。
 *
 * 客户端只抛这里定义的错误；manager 负责把它翻译成对前端的 ApiError /
 * banner 形态，路由层不感知上游细节。
 */

/** 上游业务错误（code 为上游原始 code，直接透传给前端） */
export class UpstreamError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
  }
}

/** 网络异常/超时（内部 code=-1，最终映射为 10006） */
export class UpstreamNetworkError extends UpstreamError {
  constructor(message: string) {
    super(-1, message)
    this.name = 'UpstreamNetworkError'
  }
}

export function isUpstreamNetworkError(error: unknown): error is UpstreamNetworkError {
  return error instanceof UpstreamNetworkError
}

export interface LoginFailureInfo {
  code: number
  /** danger=登录失败（可修正凭据/重试） warn=需人工处理 */
  tone: 'danger' | 'warn'
  /** 按钮动作：修正凭据 / 重试登录 */
  action: 'relogin' | 'retry'
  /** 需要人工完成的验证类型；非人工类为 null */
  manualLabel: string | null
  /** 面向用户的固定短句（不含账号/密钥等敏感值） */
  message: string
}

const MANUAL_LABELS: Record<number, string> = {
  51030: '图形验证码',
  51031: '图形验证码',
  51040: '图形验证码',
  51085: '图形验证码',
  51090: '短信验证码',
  51091: '短信验证码',
  30060: '设备绑定验证',
}

const MESSAGES: Record<number, string> = {
  40010: '登录信息已过期',
  40011: '上游鉴权失败（签名错误）',
  40050: '上游参数错误',
  30010: '上游系统处理中',
  30020: '上游要求切换区域服务节点',
  30060: '需要先完成设备绑定',
  51010: '账号或密码不正确',
  51020: '账号已被锁定',
  51030: '图形验证码错误',
  51031: '图形验证码已过期',
  51040: '需要图形验证码',
  51085: '图形验证码错误',
  51090: '短信验证码错误',
  51091: '短信验证码已过期',
  52070: '该云电脑已有操作在执行',
}

/** 上游 code / 网络错误 → 固定可展示文案（绝不回显上游原文，避免带出账号等敏感值） */
export function upstreamMessage(code: number): string {
  if (code === -1) return '上游网络异常或超时'
  return MESSAGES[code] ?? `上游返回错误（code=${code}）`
}

/** 登录失败分档：验证码/短信/设备类 ⇒ warn + 停止自动重登；其余 ⇒ danger */
export function classifyLoginFailure(error: unknown): LoginFailureInfo {
  const code = error instanceof UpstreamError ? error.code : -1
  const message = upstreamMessage(code)
  const manualLabel = MANUAL_LABELS[code] ?? null
  if (manualLabel) {
    return { code, tone: 'warn', action: 'retry', manualLabel, message }
  }
  if (code === 51010) {
    return { code, tone: 'danger', action: 'relogin', manualLabel: null, message }
  }
  /* 网络/处理中/锁定等一律可点「重试登录」，不自动反复重登 */
  return { code, tone: 'danger', action: 'retry', manualLabel: null, message }
}
