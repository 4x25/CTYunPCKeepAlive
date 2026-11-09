import { TOKEN_DAILY_TASK_ID } from '../../shared/constants'
import type { Account } from '../lib/types'
import {
  tokenAvailableText,
  tokenTaskAction,
  tokenTaskEmptyText,
  tokenTaskProgress,
  tokenTaskProgressText,
  tokenTaskRewardText,
  tokenTaskStatusBadge,
  tokenUsageRatio,
  tokenUsageText,
} from '../lib/derive'
import { formatHm } from '../../shared/utils'
import HelpMark from './HelpMark'
import { HeroIcon, HERO_REFRESH } from './icons'

interface Props {
  account: Account
  /** 「刷新 Token」单飞在途 */
  refreshing: boolean
  /** 签到 / 领取在途，键为 `userId:taskDefId` */
  busyTask: Readonly<Record<string, boolean>>
  /** 自动开关保存在途，键为 `userId:taskDefId` */
  busyAutoTask: Readonly<Record<string, boolean>>
  onCheckin: (taskDefId: number) => void
  onToggleAuto: (taskDefId: number, auto: boolean) => void
  onRefresh: () => void
}

/** 云智助手 Token 面板：可用 Token + 用量进度 + 签到任务表 */
export default function TokenPanel(props: Props) {
  const { account } = props
  const token = account.token
  const ratioPercent = Math.round(tokenUsageRatio(token) * 100)
  const tasks = account.tokenTasks
  const eaichatUnavailable = !account.eaichat.ok

  return (
    <div role="tabpanel" aria-label="云智助手 Token" class="flex h-full min-h-0 flex-col">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-4 rounded-box border border-base-300 bg-base-200/60 px-3.5 py-2.5">
        <div class="flex items-center gap-2">
          <span class="text-xs text-base-content/60">签到奖励预计 1 分钟内到账</span>
          <HelpMark
            label="Token 签到说明"
            tip="Token 任务由云智助手发放奖励：每日签到 +20万 Token，连续 7 天签到 +100万 Token。工具只代为点击「签到」，不会替你订购 Token 套餐；连续 7 天任务当前仅展示进度，不提供操作与自动签到。打开「自动」后，每天 00:10 后检查并补签一次。"
          />
        </div>
        <div class="flex items-center gap-2.5">
          <span class="font-mono text-xs text-base-content/60">
            更新于 {token.updatedDate ? formatHm(token.updatedDate) : '—'}
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square"
            aria-label="刷新 Token"
            title="刷新 Token"
            disabled={props.refreshing || eaichatUnavailable}
            onClick={props.onRefresh}
          >
            {props.refreshing ? (
              <span class="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : (
              <HeroIcon icon={HERO_REFRESH} class="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {eaichatUnavailable && (
        <div role="alert" class="alert alert-soft alert-warning mb-3 py-2 text-xs">
          <span>{account.eaichat.msg || '云智助手会话不可用，Token 任务暂不可用'}</span>
        </div>
      )}

      <div class="flex flex-wrap items-baseline gap-8 px-2 pb-3.5">
        <div>
          <p class="font-mono text-xs whitespace-nowrap text-base-content/60">可用 Token</p>
          <div class="font-mono text-4xl font-semibold tabular-nums tracking-tight">
            {tokenAvailableText(token)}
          </div>
        </div>
        <div class="min-w-40 flex-1 basis-44">
          <div class="mb-1.5 flex items-center justify-between">
            <span class="font-mono text-xs tabular-nums text-base-content/60">{tokenUsageText(token)}</span>
            <span class="font-mono text-xs tabular-nums text-base-content/60">{ratioPercent}%</span>
          </div>
          <progress class="progress progress-success h-1.5 w-full" value={ratioPercent} max="100" />
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-auto">
        {!tasks.length ? (
          <div class="grid h-full place-items-center text-[13px] text-base-content/60">
            {eaichatUnavailable ? '云智助手会话不可用，恢复后可点「刷新」重试' : tokenTaskEmptyText()}
          </div>
        ) : (
          <table class="table table-sm table-pin-cols table-pin-rows whitespace-nowrap">
            <thead>
              <tr class="font-mono text-[11px] tracking-wider text-base-content/60">
                {/* pin-cols 只对 tr th 生效：不固定的列表头用 td，否则会被一起吸到左缘堆叠 */}
                <td>任务</td>
                <td>奖励</td>
                <td>进度</td>
                <td>状态</td>
                <td class="w-20">执行</td>
                <th class="w-14">自动</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const key = `${account.userId}:${task.taskDefId}`
                const busy = task.busy || !!props.busyTask[key]
                const busyAuto = !!props.busyAutoTask[key]
                const anyBusy = busy || busyAuto
                const canAutomate = task.taskDefId === TOKEN_DAILY_TASK_ID
                const action = tokenTaskAction(task)
                const badge = tokenTaskStatusBadge(task)
                const progress = tokenTaskProgress(task)
                const label = busy && !task.busy ? '签到中…' : action.label
                const tip = eaichatUnavailable
                  ? (account.eaichat.msg ?? '云智助手会话不可用，Token 任务暂不可用')
                  : action.tip
                const autoTip = busyAuto
                  ? '自动开关正在保存…'
                  : busy
                    ? '该任务有操作正在进行…'
                    : eaichatUnavailable
                      ? (account.eaichat.msg ?? '云智助手会话不可用，Token 任务暂不可用')
                      : '每天 00:10 后自动检查并补签；已签到则不再重复请求'
                return (
                  <tr key={task.taskDefId} class="row-hover">
                    <td class="text-[13px] font-semibold">{task.taskDefName || '任务'}</td>
                    <td class="font-mono tabular-nums">{tokenTaskRewardText(task)}</td>
                    <td class="min-w-28" title={task.isDisplayProgress === false ? '该任务不展示进度' : undefined}>
                      <span class="block font-mono text-[11.5px] tabular-nums whitespace-nowrap text-base-content/60">
                        {tokenTaskProgressText(task)}
                      </span>
                      {task.isDisplayProgress !== false && (
                        <progress
                          class="progress progress-success mt-1 h-[3px] w-full"
                          value={Math.round(progress.ratio * 100)}
                          max="100"
                        />
                      )}
                    </td>
                    <td>
                      <span class={`badge badge-soft badge-sm font-mono ${badge.cls}`}>{badge.label}</span>
                    </td>
                    <td class="w-20">
                      {canAutomate && (
                        <button
                          type="button"
                          class="btn btn-xs"
                          disabled={action.disabled || anyBusy || eaichatUnavailable}
                          title={tip}
                          onClick={() => props.onCheckin(task.taskDefId)}
                        >
                          {label}
                        </button>
                      )}
                    </td>
                    <th class="w-14 font-normal" title={canAutomate ? autoTip : undefined}>
                      {canAutomate && (
                        <input
                          type="checkbox"
                          class="toggle toggle-sm"
                          checked={task.auto}
                          disabled={anyBusy || eaichatUnavailable}
                          aria-label={`自动签到 ${task.taskDefName}`}
                          onChange={(e: Event) => props.onToggleAuto(task.taskDefId, (e.target as HTMLInputElement).checked)}
                        />
                      )}
                    </th>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}