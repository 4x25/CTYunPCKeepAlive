import type { ApiEnvelope } from '../shared/types'

/**
 * 后端业务异常：路由层抛出，由统一的错误中间件转成信封。
 * code 语义与 shared/constants 的 ErrorCode / UpstreamCode 对齐。
 * 注意：HTTP 状态码仍为 200，仅网络/框架层错误使用 4xx/5xx（api.md §1.1）。
 */
export class ApiError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/** 成功信封 */
export function ok<T>(data: T): ApiEnvelope<T> {
  return { code: 0, msg: '', data }
}

/** 失败信封（业务错误一律 HTTP 200） */
export function err(code: number, msg: string): ApiEnvelope<null> {
  return { code, msg, data: null }
}
