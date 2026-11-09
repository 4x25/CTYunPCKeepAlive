/**
 * 云智助手 Token 任务的数据聚合（与云电脑积分任务分开维护）。
 *
 * - 上游字段只做类型归一化；`busy` 由会话层补充；
 * - 奖励取 `pointsList[].value` 累加（type 600 = TOKEN 通用积分）；
 * - `receiveProgressMap` 原样保留，前端用它兜底连续签到天数。
 */
import type { TaskStatus, TokenSummary, TokenTask, TokenResult as TokenResultContract } from '../../shared/types'
import type { EaiTokenTask, EaiTokenUsage } from '../upstream/eaichat-client'

export function emptyTokenSummary(): TokenSummary {
  return { totalTokens: 0, usedTokens: 0, expTokens: 0, remainTokens: 0, updatedDate: 0 }
}

/** 上游任务 → 契约任务（busy 由会话层补充） */
export function toTokenTask(task: EaiTokenTask, busy: boolean): TokenTask {
  return {
    taskDefId: task.taskDefId,
    taskDefName: task.taskDefName,
    taskCalendarType: task.taskCalendarType,
    pointsList: task.pointsList.map((item) => ({ ...item })),
    currentProgress: task.currentProgress,
    totalProgress: task.totalProgress,
    status: task.status as TaskStatus,
    isDisplayProgress: task.isDisplayProgress,
    canReceive: task.canReceive,
    isSatisfiedCondition: task.isSatisfiedCondition,
    receiveProgressMap: { ...task.receiveProgressMap },
    busy,
  }
}

/** 单次签到 / 领取可获得的 Token 数 */
export function tokenRewardOf(task: TokenTask): number {
  return task.pointsList.reduce((sum, item) => sum + item.value, 0)
}

/** 已签到天数（receiveProgressMap 中值为 1 的项数） */
export function tokenCheckedDays(task: TokenTask): number {
  return Object.values(task.receiveProgressMap).filter((value) => value === 1).length
}

export interface TokenSnapshot {
  token: TokenSummary
  tasks: TokenTask[]
  updatedDate: number
}

export function tokenUsageSummary(usage: EaiTokenUsage, now = Date.now()): TokenSummary {
  return {
    totalTokens: usage.totalTokens,
    usedTokens: usage.usedTokens,
    expTokens: usage.expTokens,
    remainTokens: usage.remainTokens,
    updatedDate: now,
  }
}

export function toTokenResult(snapshot: TokenSnapshot): TokenResultContract {
  return {
    token: { ...snapshot.token },
    tasks: snapshot.tasks.map((task) => ({ ...task, pointsList: task.pointsList.map((item) => ({ ...item })) })),
    updatedDate: snapshot.updatedDate,
  }
}