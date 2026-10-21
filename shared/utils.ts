/* 用官方 ESM 构建：dayjs 主包是纯 CJS，Vite dev SSR 的 CJS 互操作会让 default 导入变 undefined */
import dayjs from 'dayjs/esm'

/** 当前时刻 "YYYY-MM-DD HH:mm:ss"（日志时间戳口径） */
export function nowStr(date: Date | number = new Date()): string {
  return dayjs(date).format('YYYY-MM-DD HH:mm:ss')
}

/** 当前时刻 "HH:mm" */
export function nowHm(date: Date | number = new Date()): string {
  return dayjs(date).format('HH:mm')
}

/** 时间戳 → "HH:mm"；空值返回空串，由调用方决定占位符 */
export function formatHm(ts: number | null | undefined): string {
  return ts == null ? '' : dayjs(ts).format('HH:mm')
}

/** 时间戳 → "HH:mm:ss"；空值返回空串 */
export function formatHms(ts: number | null | undefined): string {
  return ts == null ? '' : dayjs(ts).format('HH:mm:ss')
}

/** 时间戳/日期字符串 → "YYYY-MM-DD HH:mm:ss" */
export function formatDateTime(value: number | string | Date): string {
  return dayjs(value).format('YYYY-MM-DD HH:mm:ss')
}

/**
 * 掩码：日志、通知与导出里账号一律只出现掩码。
 * 11 位手机号保留前 3 后 4；其它账号保留前 2 后 2。
 */
export function maskOf(acct: string): string {
  if (/^\d{11}$/.test(acct)) return acct.slice(0, 3) + '****' + acct.slice(7)
  if (acct.length <= 4) return acct.charAt(0) + '****'
  return acct.slice(0, 2) + '****' + acct.slice(-2)
}

/** "HH:mm" 格式校验（积分时间窗口用） */
export function isHm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}
