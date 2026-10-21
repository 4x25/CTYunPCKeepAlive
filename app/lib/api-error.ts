/**
 * 前端 API 错误：业务错误 code 为 api.md §1.2 原值；
 * HTTP 500 / 网络异常 / 超时统一为 -1（frontend-design §3.1）。
 *
 * 单独成文件是为了让 api.ts 与 api-mock.ts 共用，避免二者循环依赖。
 */
import { ErrorCode } from '../../shared/constants'

export class ApiError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

/**
 * 客户端超时（AbortError → code=-1）≠ 操作失败：后端可能仍在执行且最终成功。
 * 调用方不得据此回滚乐观更新，只 Toast + 拉 4.1 校正（frontend-design §3.2）。
 */
export function isTimeout(value: unknown): boolean {
  return isApiError(value) && value.code === ErrorCode.Network && value.message.includes('超时')
}
