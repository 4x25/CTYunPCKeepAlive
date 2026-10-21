/**
 * 时钟校准与倒计时投影（frontend-design §2.4）。
 *
 * 后端只下发秒数，前端每秒本地自减；快照到达时以服务端值为准。
 * left 减到 0 停在 0（不本地伪造结果），由 island 在 3s 后触发一次 /state 校正。
 */
import { LINK_TOTAL_SECONDS } from '../../shared/constants'
import type { Account, PcInstance } from '../../shared/types'

/** 每次 4.1 响应：clockOffset = serverTime - Date.now() */
export function clockOffsetOf(serverTime: number, localNow = Date.now()): number {
  return serverTime - localNow
}

/** 校准后的当前时刻 */
export function nowWithOffset(offset: number, localNow = Date.now()): number {
  return localNow + offset
}

/**
 * 每秒推进倒计时，返回新数组（无变化时返回原数组，便于避免无谓渲染）。
 * - left：auto && running && left != null 时 -1，减到 0 停住；
 * - link：本期恒为 null，投影逻辑保留（到 0 回卷），供后续版本启用。
 */
export function projectCountdowns(accounts: Account[], linkTotalSeconds = LINK_TOTAL_SECONDS): Account[] {
  let touched = false

  const next = accounts.map((account) => {
    let pcs: PcInstance[] | null = null

    account.pcs.forEach((pc, index) => {
      if (pc.link != null) {
        pcs ||= account.pcs.map((item) => ({ ...item }))
        const rest = pc.link - 1
        pcs[index].link = rest <= 0 ? linkTotalSeconds : rest
        return
      }
      if (pc.auto && pc.run === 'running' && pc.left != null && pc.left > 0) {
        pcs ||= account.pcs.map((item) => ({ ...item }))
        pcs[index].left = pc.left - 1
      }
    })

    if (!pcs) return account
    touched = true
    return { ...account, pcs }
  })

  return touched ? next : accounts
}

/** 快照中存在过渡态实例时，前端以 5s 间隔轮询 /state 加速收敛 */
export function hasTransitionalRun(accounts: Account[]): boolean {
  return accounts.some((account) => account.pcs.some((pc) => pc.run === 'starting' || pc.run === 'stopping'))
}

/** left 已停 0 的实例（用于懒校正判定） */
export function hasStoppedCountdown(accounts: Account[]): boolean {
  return accounts.some((account) =>
    account.pcs.some((pc) => pc.auto && pc.run === 'running' && pc.left != null && pc.left <= 0),
  )
}
