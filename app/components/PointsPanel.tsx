import { useState } from 'hono/jsx'
import type { PointTask } from '../lib/types'
import { TASK_TOTAL } from '../lib/mock-data'
import HelpMark from './HelpMark'

function StatusBadge({ task }: { task: PointTask }) {
  /* 交互稿里「执行中」与「已完成」同色（绿），「未完成」灰 */
  if (task.status === 'done') return <span class="badge badge-soft badge-success badge-sm font-mono">已完成</span>
  if (task.status === 'running') return <span class="badge badge-soft badge-success badge-sm font-mono">执行中</span>
  return <span class="badge badge-soft badge-neutral badge-sm font-mono">未完成</span>
}

interface Props {
  tasks: PointTask[]
  /** 「连接满 1 小时」的接口累计秒数：与被占用实例的倒计时同源 */
  linkDone: number | null
  onRunTask: (i: number) => void
  onToggleTask: (i: number, on: boolean) => void
}

/** 积分任务面板：执行时间窗口 + 积分概览 + 任务列表 */
export default function PointsPanel({ tasks, linkDone, onRunTask, onToggleTask }: Props) {
  const [winStart, setWinStart] = useState('09:00')
  const [winEnd, setWinEnd] = useState('11:30')

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
          />
          <span class="font-mono text-xs text-base-content/60">～</span>
          <input
            class="input input-xs w-24 font-mono"
            type="time"
            aria-label="窗口结束时间"
            value={winEnd}
            onInput={(e: Event) => setWinEnd((e.target as HTMLInputElement).value)}
          />
          <HelpMark
            label="执行时间说明"
            tip="每天在这个窗口内随机取一个起跑时刻，跑完一轮就结束；窗口只约束起跑时间，「连接满 1 小时」允许跑到窗口之外。"
          />
        </div>
        <div class="flex items-center gap-2.5">
          <span class="font-mono text-xs text-base-content/60">更新于 09:41</span>
          <button type="button" class="btn btn-xs">
            刷新任务
          </button>
        </div>
      </div>

      <div class="flex flex-wrap items-baseline gap-8 px-2 pb-3.5">
        <div>
          <p class="font-mono text-xs text-base-content/60">当前积分（示例）</p>
          <div class="font-mono text-4xl font-semibold tabular-nums tracking-tight">1,280</div>
        </div>
        <div class="min-w-40 flex-1 basis-44">
          <div class="mb-1.5 flex items-center justify-between">
            <span class="font-mono text-xs text-base-content/60">今日任务完成度</span>
            <span class="font-mono text-xs tabular-nums text-base-content/60">1 / 3</span>
          </div>
          <progress class="progress progress-success h-1.5 w-full" value="33" max="100" />
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-auto">
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
            {tasks.map((t, i) => {
              /* 1 小时任务：进度列显示接口累计值 total - 剩余，与实例倒计时同源 */
              const bound = t.progressText == null
              const done = linkDone ?? 1452
              const text = bound ? `${Math.floor(done / 60)} / ${TASK_TOTAL / 60} 分钟` : t.progressText
              const ratio = bound ? done / TASK_TOTAL : (t.ratio ?? 0)
              return (
                <tr key={t.name} class="row-hover">
                  <td class="text-[13px] font-semibold">{t.name}</td>
                  <td class="font-mono tabular-nums">+{t.reward}</td>
                  <td class="min-w-28" title={t.progressTip}>
                    <span class="block font-mono text-[11.5px] tabular-nums whitespace-nowrap text-base-content/60">{text}</span>
                    <progress class="progress mt-1 h-[3px] w-full" value={Math.round(ratio * 100)} max="100" />
                  </td>
                  <td>
                    <StatusBadge task={t} />
                  </td>
                  <td class="w-20">
                    <button
                      type="button"
                      class="btn btn-xs"
                      disabled={t.status !== 'idle' || t.busy}
                      title={t.status === 'done' ? t.doneLabel || undefined : undefined}
                      onClick={() => onRunTask(i)}
                    >
                      {t.busy ? '执行中…' : t.status === 'running' ? '执行中' : '执行'}
                    </button>
                  </td>
                  <th class="w-14 font-normal">
                    <input
                      type="checkbox"
                      class="toggle toggle-sm"
                      checked={t.auto}
                      aria-label={`自动执行 ${t.name}`}
                      onChange={(e: Event) => onToggleTask(i, (e.target as HTMLInputElement).checked)}
                    />
                  </th>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
