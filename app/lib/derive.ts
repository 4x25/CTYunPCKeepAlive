/**
 * 纯展示派生（frontend-design §4.3）：组件只调不改，所有函数不依赖浏览器 API。
 */
import dayjs from 'dayjs/esm'
import {
  TASK_DURATION_IDS,
  TASK_EXECUTABLE_IDS,
  TASK_UNSUPPORTED_REASON,
  TOKEN_DAILY_TASK_ID,
} from '../../shared/constants'
import type { Account, PcInstance, PointTask, TaskStatus, TokenSummary, TokenTask } from '../../shared/types'
import { formatHms, formatTokenCount, maskOf } from '../../shared/utils'

/** Tab 名：填了别名只显示别名，留空回落到完整账号 */
export function tabLabel(account: Account): string {
  return account.alias || account.userAccount
}

/** Tab hover：完整账号与别名说明 */
export function tabTitle(account: Account): string {
  return `完整账号：${account.userAccount}\n别名：${account.alias || '未设置（Tab 名直接用完整账号）'}`
}

/** 日志面板「归属」：主号 138****6021 */
export function accountLabel(account: Account): string {
  return (account.alias ? account.alias + ' ' : '') + maskOf(account.userAccount)
}

/**
 * 导出文件名里的账号标识：别名优先，否则掩码（绝不使用完整账号）；
 * 同时剔除 `\ / : * ? " < > |` 等文件系统非法字符。
 */
export function accountFileSlug(account: Account): string {
  const raw = account.alias || maskOf(account.userAccount)
  const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return safe || 'export'
}

/* ── 保活单元格 ───────────────────────────────────────────── */

export interface LastCellView {
  /** 最近一次时间 "HH:mm:ss"；从未执行时 "—" */
  at: string
  /** 成功 / 失败 · 原因短句；从 lastMsg 派生 */
  summary: string | null
  tone: 'ok' | 'fail' | 'info' | 'none'
  /** 完整 lastMsg，放 title */
  title: string | null
}

function shortFailureReason(message: string): string {
  const reason = message.split(/失败[:：·]\s*/)[1]
  if (!reason) return '失败'
  const trimmed = reason.replace(/（.*$/, '').replace(/[，,].*$/, '').trim()
  return trimmed ? `失败 · ${trimmed.slice(0, 24)}` : '失败'
}

/** 「下次保活 / 最近」单元格第二行：lastAt + lastMsg 摘要 */
export function lastCell(pc: PcInstance): LastCellView {
  if (pc.lastAt == null) {
    return { at: '—', summary: null, tone: 'none', title: pc.lastMsg }
  }
  const message = pc.lastMsg ?? ''
  if (!message) return { at: formatHms(pc.lastAt), summary: null, tone: 'info', title: null }
  if (message.includes('成功')) return { at: formatHms(pc.lastAt), summary: '成功', tone: 'ok', title: message }
  if (message.includes('失败')) {
    return { at: formatHms(pc.lastAt), summary: shortFailureReason(message), tone: 'fail', title: message }
  }
  return { at: formatHms(pc.lastAt), summary: message, tone: 'info', title: message }
}

/** 云电脑列表空态文案（后端只维护数据，不下发占位文案） */
export function pcsEmptyText(account: Account): string {
  if (account.banner?.tone === 'danger') return '登录失败，暂时无法获取云电脑列表'
  if (account.banner?.tone === 'warn') return '需人工处理期间不拉取列表——先在官方客户端完成一次验证，再点上方「重试登录」'
  return '暂时无法获取云电脑列表'
}

/** 积分任务空态文案（与 pcsEmptyText 同口径；banner 期间不展示功能页签，这里只需正常态文案） */
export function tasksEmptyText(): string {
  return '暂时无法获取积分任务列表 · 点右上角「刷新任务」重试'
}

/* ── 积分任务 ─────────────────────────────────────────────── */

function isDurationTask(taskDefId: number): boolean {
  return (TASK_DURATION_IDS as readonly number[]).includes(taskDefId)
}

/** 工具可代为执行的任务（仅「与AI对话」类，backend-design §4.2） */
export function isExecutableTask(taskDefId: number): boolean {
  return (TASK_EXECUTABLE_IDS as readonly number[]).includes(taskDefId)
}

/** 不可执行任务的置灰原因；可执行任务返回 null */
export function taskUnsupportedReason(taskDefId: number): string | null {
  if (isExecutableTask(taskDefId)) return null
  return TASK_UNSUPPORTED_REASON[taskDefId] ?? '该类任务需在官方客户端完成，工具不代为执行'
}

/** 进度文本：次数型 "1 / 1 次"；时长型 "24 / 60 分钟"；不展示进度时 "—" */
export function taskProgressText(task: PointTask): string {
  /* 上游 isDisplayProgress 实测为 null：仅明确 false 时隐藏 */
  if (task.isDisplayProgress === false) return '—'
  if (isDurationTask(task.taskDefId)) {
    return `${Math.floor(task.currentProgress / 60)} / ${Math.floor(task.totalProgress / 60)} 分钟`
  }
  return `${task.currentProgress} / ${task.totalProgress} 次`
}

/** 进度条比例 0–1 */
export function taskProgressRatio(task: PointTask): number {
  if (task.isDisplayProgress === false || !task.totalProgress) return 0
  return Math.max(0, Math.min(1, task.currentProgress / task.totalProgress))
}

/** 任务状态徽章：0 未完成(neutral) 1 执行中(success) 2 已完成(success) 3 已失效(warning) */
export function taskStatusBadge(task: PointTask): { label: string; cls: string } {
  const map: Partial<Record<TaskStatus, { label: string; cls: string }>> = {
    0: { label: '未完成', cls: 'badge-neutral' },
    1: { label: '执行中', cls: 'badge-success' },
    2: { label: '已完成', cls: 'badge-success' },
    3: { label: '已失效', cls: 'badge-warning' },
  }
  /* 上游状态可能扩展：未知值给中性徽章，避免运行时崩 */
  return map[task.status] ?? { label: '未知', cls: 'badge-neutral' }
}

/** 已完成任务的按钮 title */
export function taskDoneLabel(task: PointTask): string {
  if (task.status !== 2) return ''
  return task.taskCalendarType === 5 ? '今日已完成，明日 00:00 后重置' : '已完成'
}

/** 奖励 = sum(pointsList[].value) */
export function rewardOf(task: PointTask): number {
  return task.pointsList.reduce((sum, item) => sum + item.value, 0)
}

export function pointsText(value: number): string {
  return value.toLocaleString('en-US')
}

/** 今日任务完成度 */
export function todayDone(tasks: PointTask[]): { done: number; total: number; ratio: number } {
  const done = tasks.filter((task) => task.status === 2).length
  const total = tasks.length
  return { done, total, ratio: total ? done / total : 0 }
}

/* ── 云智助手 Token ──────────────────────────────────────── */

/** 可用 Token 展示（与上游「我的 Token」卡片同口径：万 / 亿） */
export function tokenAvailableText(token: TokenSummary): string {
  return formatTokenCount(token.remainTokens)
}

/** 「已消耗 / 共」文本 */
export function tokenUsageText(token: TokenSummary): string {
  return `已消耗 ${formatTokenCount(token.usedTokens)} / 共 ${formatTokenCount(token.totalTokens)}`
}

/** 用量进度 0–1（总量为 0 时归零） */
export function tokenUsageRatio(token: TokenSummary): number {
  if (!token.totalTokens) return 0
  return Math.max(0, Math.min(1, token.usedTokens / token.totalTokens))
}

/** 任务进度：优先 currentProgress，连续签到 map 兜底（上游 currentProgress 可能延迟一天） */
export function tokenTaskProgress(task: TokenTask): { current: number; total: number; ratio: number } {
  const total =
    task.totalProgress > 0
      ? task.totalProgress
      : Math.max(1, Object.keys(task.receiveProgressMap).length || 1)
  const checked = Object.values(task.receiveProgressMap).filter((value) => value === 1).length
  const current = Math.max(0, Math.min(total, Math.max(task.currentProgress, checked)))
  return { current, total, ratio: total ? current / total : 0 }
}

/** 进度文本：默认「0 / 7 天」；明确不展示时为「—」 */
export function tokenTaskProgressText(task: TokenTask): string {
  if (task.isDisplayProgress === false) return '—'
  const { current, total } = tokenTaskProgress(task)
  return `${current} / ${total} 天`
}

/** 任务奖励文本：`+20万 Token` */
export function tokenTaskRewardText(task: TokenTask): string {
  const reward = task.pointsList.reduce((sum, item) => sum + item.value, 0)
  return `+${formatTokenCount(reward)} Token`
}

/** Token 任务状态徽章 */
export function tokenTaskStatusBadge(task: TokenTask): { label: string; cls: string } {
  if (task.busy) return { label: '操作中', cls: 'badge-info' }
  if (task.status === 3) return { label: '已失效', cls: 'badge-warning' }
  if (task.status === 2) return { label: '已完成', cls: 'badge-success' }
  if (task.status === 1) return { label: '发放中', cls: 'badge-success' }
  if (task.canReceive) {
    return { label: task.taskDefId === TOKEN_DAILY_TASK_ID ? '可签到' : '可领取', cls: 'badge-success' }
  }
  if (task.taskDefId === TOKEN_DAILY_TASK_ID) {
    return { label: task.isSatisfiedCondition ? '已签到' : '未完成', cls: 'badge-neutral' }
  }
  return { label: '未达标', cls: 'badge-warning' }
}

/** Token 任务操作按钮：签到 / 领取 / 置灰态 */
export function tokenTaskAction(task: TokenTask): { label: string; disabled: boolean; tip?: string } {
  const daily = task.taskDefId === TOKEN_DAILY_TASK_ID
  if (task.busy) return { label: daily ? '签到中…' : '领取中…', disabled: true, tip: '该任务正在操作中…' }
  if (task.status === 2) return { label: '已完成', disabled: true, tip: '该任务已完成，无需重复操作' }
  if (task.status === 3) return { label: '已失效', disabled: true, tip: '该任务已失效' }
  if (task.status === 1) return { label: '发放中', disabled: true, tip: '奖励正在发放中，无需重复操作' }
  if (task.canReceive) return { label: daily ? '签到' : '领取', disabled: false }
  if (daily) {
    return task.isSatisfiedCondition
      ? { label: '已签到', disabled: true, tip: '今日已签到，明日 00:00 后重置' }
      : { label: '未完成', disabled: true, tip: '任务条件尚未满足' }
  }
  return {
    label: '未达标',
    disabled: true,
    tip: `需连续签到 ${tokenTaskProgress(task).total} 天，当前 ${tokenTaskProgress(task).current} 天`,
  }
}

/** 避免重复数字符串；TokenPanel 与行内提示共用 */
export function tokenTaskEmptyText(): string {
  return '暂时无法获取 Token 任务列表 · 点右上角「刷新」重试'
}

/* ── 日志 ────────────────────────────────────────────────── */

/** 日志时间列：完整 "YYYY-MM-DD HH:mm:ss" → "HH:mm:ss"（title 放全值） */
export function logTime(t: string): string {
  const parsed = dayjs(t)
  return parsed.isValid() ? parsed.format('HH:mm:ss') : t
}

/** 列表刷新时间展示：从未刷新时占位 */
export function refreshedLabel(value: string): string {
  return value || '—'
}
