import { useEffect, useState } from 'hono/jsx'
import type { Account, PointTask } from '../lib/types'
import {
  isExecutableTask,
  pointsDetail,
  pointsText,
  pointsTotal,
  rewardOf,
  taskDoneLabel,
  taskProgressRatio,
  taskProgressText,
  taskStatusBadge,
  taskUnsupportedReason,
  tasksEmptyText,
  todayDone,
} from '../lib/derive'
import { formatHm } from '../../shared/utils'
import HelpMark from './HelpMark'

function StatusBadge({ task }: { task: PointTask }) {
  const badge = taskStatusBadge(task)
  return <span class={`badge badge-soft badge-sm font-mono ${badge.cls}`}>{badge.label}</span>
}

interface Props {
  account: Account
  /** 「刷新任务」单飞在途 */
  refreshing: boolean
  /** 任务执行与自动开关共用的在途状态，键为 `userId:taskDefId` */
  busyTask: Readonly<Record<string, boolean>>
  onRunTask: (taskDefId: number) => void
  onToggleTask: (taskDefId: number, on: boolean) => void
  onWindowCommit: (winStart: string, winEnd: string) => Promise<boolean>
  onRefresh: () => void
}

/** 积分任务面板：执行时间窗口 + 积分概览 + 任务列表 */
export default function PointsPanel(props: Props) {
  const { account } = props
  const [winStart, setWinStart] = useState(account.pointsWindow.winStart)
  const [winEnd, setWinEnd] = useState(account.pointsWindow.winEnd)

  /* 服务端窗口变化（操作响应 / 快照校正）时同步输入框 */
  useEffect(() => {
    setWinStart(account.pointsWindow.winStart)
    setWinEnd(account.pointsWindow.winEnd)
  }, [account.pointsWindow.winStart, account.pointsWindow.winEnd])

  const commitWindow = async () => {
    if (winStart !== account.pointsWindow.winStart || winEnd !== account.pointsWindow.winEnd) {
      const ok = await props.onWindowCommit(winStart, winEnd)
      if (!ok) {
        setWinStart(account.pointsWindow.winStart)
        setWinEnd(account.pointsWindow.winEnd)
      }
    }
  }

  const tasks = account.tasks
  const done = todayDone(tasks)
  const points = pointsTotal(account.points)

  return (
    <div role="tabpanel" aria-label="积分任务" class="flex h-full min-h-0 flex-col">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-4 rounded-box border border-base-300 bg-base-200/60 px-3.5 py-2.5">
        <div class="flex items-center gap-2">
          <span class="text-xs text-base-content/60">自动执行时间</span>
          <input
            class="input input-xs w-24 font-mono"
            type="time"
            aria-label="窗口开始时间"
            value={winStart}
            onInput={(e: Event) => setWinStart((e.target as HTMLInputElement).value)}
            onBlur={commitWindow}
          />
          <span class="font-mono text-xs text-base-content/60">～</span>
          <input
            class="input input-xs w-24 font-mono"
            type="time"
            aria-label="窗口结束时间"
            value={winEnd}
            onInput={(e: Event) => setWinEnd((e.target as HTMLInputElement).value)}
            onBlur={commitWindow}
          />
          <HelpMark
            label="执行时间说明"
            tip="每天在这个窗口内随机取一个起跑时刻执行一轮；起跑前会先复查任务状态，只跑未完成且打开了自动开关的任务。工具只能代为执行「与AI对话」类任务；「登录AI云电脑」需真实连接云电脑，「使用1小时」需会话在线累计时长，这两类请到官方客户端完成。"
          />
        </div>
        <div class="flex items-center gap-2.5">
          <span class="font-mono text-xs text-base-content/60">
            更新于 {account.points.updatedDate ? formatHm(account.points.updatedDate) : '—'}
          </span>
          <button type="button" class="btn btn-xs" disabled={props.refreshing} onClick={props.onRefresh}>
            {props.refreshing && <span class="loading loading-spinner loading-xs" aria-hidden="true" />}
            刷新任务
          </button>
        </div>
      </div>

      <div class="flex flex-wrap items-baseline gap-8 px-2 pb-3.5">
        <div>
          <p class="font-mono text-xs text-base-content/60">当前积分</p>
          <div class="font-mono text-4xl font-semibold tabular-nums tracking-tight">{pointsText(points)}</div>
          {account.points.pointsList.length > 0 && (
            <p class="mt-1 font-mono text-[11px] text-base-content/50">{pointsDetail(account.points)}</p>
          )}
        </div>
        <div class="min-w-40 flex-1 basis-44">
          <div class="mb-1.5 flex items-center justify-between">
            <span class="font-mono text-xs text-base-content/60">今日任务完成度</span>
            <span class="font-mono text-xs tabular-nums text-base-content/60">
              {done.done} / {done.total}
            </span>
          </div>
          <progress class="progress progress-success h-1.5 w-full" value={Math.round(done.ratio * 100)} max="100" />
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-auto">
        {!tasks.length ? (
          <div class="grid h-full place-items-center text-[13px] text-base-content/60">{tasksEmptyText()}</div>
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
                const executable = isExecutableTask(task.taskDefId)
                const unsupported = taskUnsupportedReason(task.taskDefId)
                const doneToday = task.status === 2
                const runnable = executable && task.status === 0
                const disabled = !runnable || busy
                const tip = !executable
                  ? unsupported ?? undefined
                  : doneToday
                    ? taskDoneLabel(task)
                    : task.status === 1
                      ? '任务已完成，积分正在发放，无需重复执行'
                      : task.status === 3
                        ? '任务已失效，无需执行'
                        : busy
                          ? '该任务正在执行中…'
                          : undefined
                /* 自动开关：4.12 对所有任务可切换并持久化；只有可代为执行的任务会真正起跑 */
                const autoDisabled = busy
                const autoTip = busy
                  ? '该任务有操作正在进行…'
                  : executable
                    ? undefined
                    : `${unsupported ?? '该类任务需在官方客户端完成'} · 开关仅记录偏好，不会自动起跑`
                return (
                  <tr key={task.taskDefId} class="row-hover">
                    <td class="text-[13px] font-semibold">{task.taskDefName}</td>
                    <td class="font-mono tabular-nums">+{rewardOf(task)}</td>
                    <td class="min-w-28" title={task.isDisplayProgress === false ? '该任务不展示进度' : undefined}>
                      <span class="block font-mono text-[11.5px] tabular-nums whitespace-nowrap text-base-content/60">
                        {taskProgressText(task)}
                      </span>
                      {task.isDisplayProgress !== false && (
                        <progress
                          class="progress progress-success mt-1 h-[3px] w-full"
                          value={Math.round(taskProgressRatio(task) * 100)}
                          max="100"
                        />
                      )}
                    </td>
                    <td>
                      <StatusBadge task={task} />
                    </td>
                    <td class="w-20">
                      <button
                        type="button"
                        class="btn btn-xs"
                        disabled={disabled}
                        title={tip}
                        onClick={() => props.onRunTask(task.taskDefId)}
                      >
                        {busy
                          ? '执行中…'
                          : doneToday
                            ? '已完成'
                            : task.status === 1
                              ? '发放中'
                              : task.status === 3
                                ? '已失效'
                                : executable
                                  ? '执行'
                                  : '不可代执行'}
                      </button>
                    </td>
                    <th class="w-14 font-normal" title={autoTip}>
                      <input
                        type="checkbox"
                        class="toggle toggle-sm"
                        checked={task.auto}
                        disabled={autoDisabled}
                        aria-label={`自动执行 ${task.taskDefName}`}
                        onChange={(e: Event) => props.onToggleTask(task.taskDefId, (e.target as HTMLInputElement).checked)}
                      />
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
