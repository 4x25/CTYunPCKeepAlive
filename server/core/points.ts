/**
 * 积分与任务的数据聚合（backend-design §4.1）。
 *
 * - 积分：按 pointType 分组累加，过滤 `willOutDate` truthy 的「即将过期」行；
 *   主数字（pointType=1）由前端派生，后端只给全量分组（research §2.1）。
 * - 任务：字段透传；`pointsList` 优先，`points` JSON 字符串仅作兜底（已在客户端归一化）。
 * - `isDisplayProgress` 实测恒为 null：只有明确 false 才视为「不展示进度」。
 */
import { TASK_EXECUTABLE_IDS, TASK_UNSUPPORTED_REASON } from '../../shared/constants'
import type { PointTask, PointsSummary, TaskStatus } from '../../shared/types'
import type { CtyunPointRow, CtyunTask, CtyunTaskReward } from '../upstream/ctyun-client'

/** 上游 willOutDate truthy 的行按官方口径过滤（research §2.1） */
export function aggregatePoints(rows: readonly CtyunPointRow[], now = Date.now()): PointsSummary {
  const grouped = new Map<number, { pointTypeName: string; points: number }>()
  for (const row of rows) {
    if (row.willOutDate) continue
    const hit = grouped.get(row.pointType)
    if (hit) hit.points += row.points
    else grouped.set(row.pointType, { pointTypeName: row.pointTypeName, points: row.points })
  }
  const pointsList = [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pointType, value]) => ({
      pointType,
      pointTypeName: value.pointTypeName,
      points: value.points,
    }))
  return { pointsList, updatedDate: now }
}

/** 奖励文案：`100 通用积分`（多类型时用 + 连接；用于日志，不含任务 ID） */
export function rewardText(pointsList: readonly CtyunTaskReward[]): string {
  if (!pointsList.length) return '积分'
  return pointsList.map((item) => `${item.value} ${item.typeDesc}`).join(' + ')
}

/** 仅「与AI对话」类任务可由工具代为执行（research §6.2） */
export function isExecutableTask(taskDefId: number): boolean {
  return (TASK_EXECUTABLE_IDS as readonly number[]).includes(taskDefId)
}

/** 不可执行任务的固定原因文案；可执行任务返回 null */
export function unsupportedReason(taskDefId: number): string | null {
  if (isExecutableTask(taskDefId)) return null
  return TASK_UNSUPPORTED_REASON[taskDefId] ?? '该类任务需在官方客户端完成，工具不代为执行'
}

/** 上游任务 → 契约任务（busy/auto 由会话层补充） */
export function toPointTask(
  task: CtyunTask,
  flags: { auto: boolean; busy: boolean },
): PointTask {
  return {
    taskDefId: task.taskDefId,
    taskDefName: task.taskDefName,
    taskCalendarType: task.taskCalendarType,
    pointsList: task.pointsList.map((item) => ({ ...item })),
    currentProgress: task.currentProgress,
    totalProgress: task.totalProgress,
    status: task.status as TaskStatus,
    isDisplayProgress: task.isDisplayProgress,
    busy: flags.busy,
    auto: flags.auto,
  }
}
