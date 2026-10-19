import { useState } from 'hono/jsx'
import type { Account, PcInstance } from '../lib/types'
import StatusPill from './StatusPill'
import HelpMark from './HelpMark'
import Countdown from './Countdown'
import { HeroIcon, HERO_CHECK, HERO_REFRESH } from './icons'

/* 已关机 / 启动中 / 关机中：手动保活与自动开关一并置灰，并给出禁用原因 */
const BLOCK: Partial<Record<PcInstance['run'], string>> = {
  stopped: '实例已关机 · 工具不代为开机，请先在官方客户端或控制台开机',
  starting: '实例正在启动中 · 就绪后自动恢复计时',
  stopping: '实例正在关机中 · 本轮不保活',
}
/* 置灰行在倒计时列的短文案，与上面的 hover 长文案一一对应 */
const BLOCK_CD: Partial<Record<PcInstance['run'], string>> = {
  stopped: '已关机 · 不保活',
  starting: '启动中 · 暂停计时',
  stopping: '关机中 · 不保活',
}

/** 「下次保活 / 最近」单元格第一行：执行中优先，其次禁用原因，再次会话冲突，最后倒计时 */
function CdCell({ p }: { p: PcInstance }) {
  let first
  if (p.link != null)
    first = (
      <>
        执行中 · 剩余 <Countdown seconds={p.link} />
      </>
    )
  else if (BLOCK_CD[p.run]) first = BLOCK_CD[p.run]
  else if (p.conflict) first = <span class="badge badge-soft badge-warning badge-sm font-mono">会话冲突</span>
  else
    first =
      p.auto && p.left != null ? (
        <>
          <Countdown seconds={p.left} /> 后
        </>
      ) : (
        '—'
      )
  return (
    <span class="font-mono text-xs text-base-content/60 tabular-nums">
      {first}
      <br />
      {p.last}
    </span>
  )
}

interface Props {
  account: Account
  refreshing: boolean
  refreshedAt: string
  onIntervalCommit: (minutes: number) => void
  onRefresh: () => void
  onManualKeepalive: (pcIndex: number) => void
  onToggleAuto: (pcIndex: number, on: boolean) => void
}

/** 保活面板：设置行 + 云电脑列表 */
export default function KeepAlivePanel(props: Props) {
  const { account: a } = props
  const [draft, setDraft] = useState(() => String(a.interval))

  /* 保活间隔：失焦/回车时校验并重排倒计时；可填 1–59，非法输入回落到当前值 */
  const commit = () => {
    let v = parseInt(draft, 10)
    if (isNaN(v)) v = a.interval
    v = Math.max(1, Math.min(59, v))
    setDraft(String(v))
    if (v !== a.interval) props.onIntervalCommit(v)
  }

  return (
    <div role="tabpanel" aria-label="无感保活" class="flex h-full min-h-0 flex-col">
      {/* 设置面板：单行——左侧唯一设置项，右侧更新时间 + 刷新按钮 */}
      <div class="mb-3 flex flex-wrap items-center justify-between gap-4 rounded-box border border-base-300 bg-base-200/60 px-3.5 py-2.5">
        <div class="flex items-center gap-2">
          <span class="text-xs text-base-content/60">
            <label for="ka-interval">保活间隔</label>
          </span>
          <input
            id="ka-interval"
            class="input input-xs w-16 text-right font-mono tabular-nums"
            type="number"
            min="1"
            max="59"
            step="1"
            value={draft}
            onInput={(e: InputEvent) => setDraft((e.target as HTMLInputElement).value)}
            onBlur={commit}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter') commit()
            }}
          />
          <span class="text-xs text-base-content/60">分钟</span>
          <HelpMark
            label="保活间隔说明"
            tip="可填 1–59。官方空闲回收时长为 60 分钟，默认 19 分钟，留足重试与网络波动的余量。修改后立刻按新间隔重排该账号所有计划。"
          />
        </div>
        <div class="flex items-center gap-2.5">
          <span class="font-mono text-xs text-base-content/60">更新于 {props.refreshedAt}</span>
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square"
            aria-label="刷新列表"
            title="刷新列表"
            disabled={props.refreshing}
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

      {!a.pcs.length ? (
        <div class="grid flex-1 place-items-center text-[13px] text-base-content/60">{a.emptyText || '暂时无法获取云电脑列表'}</div>
      ) : (
        <div class="min-h-0 flex-1 overflow-auto">
          <table class="table table-sm table-pin-cols table-pin-rows whitespace-nowrap">
            <thead>
              <tr class="font-mono text-[11px] tracking-wider text-base-content/60">
                {/* pin-cols 只对 tr th 生效：不固定的列表头用 td，否则会被一起吸到左缘堆叠 */}
                <td>云电脑</td>
                <td>系统</td>
                <td>运行状态</td>
                <td>下次保活 / 最近</td>
                <td class="w-20">手动保活</td>
                <th class="w-14">自动</th>
              </tr>
            </thead>
            <tbody>
              {a.pcs.map((p, i) => {
                const blocked = !!BLOCK[p.run]
                const tip = blocked ? BLOCK[p.run] : undefined
                return (
                  <tr key={p.id} class="row-hover">
                    <td>
                      <div class="text-[13px] font-semibold">{p.name}</div>
                      <div class="font-mono text-[11.5px] text-base-content/60">{p.id}</div>
                    </td>
                    <td class="font-mono text-xs text-base-content/60">{p.os}</td>
                    <td>
                      <StatusPill run={p.run} />
                    </td>
                    <td>
                      <CdCell p={p} />
                    </td>
                    <td class="w-20" title={tip}>
                      {p.justOk ? (
                        <span class="badge badge-soft badge-success badge-sm">
                          <HeroIcon icon={HERO_CHECK} class="h-3 w-3" />
                          成功
                        </span>
                      ) : (
                        <button
                          type="button"
                          class="btn btn-xs"
                          disabled={blocked || p.busy || p.link != null}
                          onClick={() => props.onManualKeepalive(i)}
                        >
                          {p.busy || p.link != null ? '执行中' : '保活'}
                        </button>
                      )}
                    </td>
                    <th class="w-14 font-normal" title={tip}>
                      <input
                        type="checkbox"
                        class="toggle toggle-sm"
                        checked={p.auto}
                        disabled={blocked}
                        aria-label={`自动保活 ${p.name}`}
                        onChange={(e: Event) => props.onToggleAuto(i, (e.target as HTMLInputElement).checked)}
                      />
                    </th>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
