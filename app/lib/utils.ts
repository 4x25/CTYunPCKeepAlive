/* 用官方 ESM 构建：dayjs 主包是纯 CJS，Vite dev SSR 的 CJS 互操作会让 default 导入变 undefined */
import dayjs from 'dayjs/esm'

/** 当前时刻 HH:mm:ss */
export function nowStr(): string {
  return dayjs().format('HH:mm:ss')
}

/** 当前时刻 HH:mm */
export function nowHm(): string {
  return dayjs().format('HH:mm')
}

/** 掩码：日志、通知与导出里账号一律只出现掩码 */
export function maskOf(acct: string): string {
  if (/^\d{11}$/.test(acct)) return acct.slice(0, 3) + '****' + acct.slice(7)
  if (acct.length <= 4) return acct.charAt(0) + '****'
  return acct.slice(0, 2) + '****' + acct.slice(-2)
}
