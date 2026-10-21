/**
 * WARN 节流工具：同一类告警 10 分钟内只记录一次。
 *
 * 进程内纯内存实现，只为「持续故障不刷屏」服务；不承载业务语义。
 * 调度器的账号 ring 日志节流与保活模块的 console 诊断共用同一个窗口口径。
 */

/** 节流窗口：10 分钟（调度器 ring WARN 与保活 console WARN 一致） */
export const WARN_THROTTLE_MS = 10 * 60_000

/**
 * 创建「同 key 在窗口内只放行一次」的判定函数。
 * 返回 true 表示本次应当记录；首次出现必然放行。
 */
export function createWarnThrottle(gapMs = WARN_THROTTLE_MS): (key: string) => boolean {
  const lastAt = new Map<string, number>()
  return (key: string): boolean => {
    const now = Date.now()
    const last = lastAt.get(key)
    if (last != null && now - last < gapMs) return false
    lastAt.set(key, now)
    return true
  }
}
