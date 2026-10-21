import { useEffect, useState } from 'hono/jsx'
import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from '../../shared/constants'
import type { Account, PcInstance } from '../lib/types'
import { lastCell, pcsEmptyText, refreshedLabel } from '../lib/derive'
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

/** 「下次保活 / 最近」单元格：第一行倒计时，第二行 lastAt + lastMsg 摘要 */
function CdCell({ p }: { p: PcInstance }) {
  let first
  if (p.link != null)
    first = (
      <>
        执行中 · 剩余 <Countdown seconds={p.link} />
      </>
    )
  else if (BLOCK_CD[p.run]) first = BLOCK_CD[p.run]
  else if (p.auto && p.left != null)
    first = (
      <>
        <Countdown seconds={p.left} /> 后
      </>
    )
  else first = '—'

  const last = lastCell(p)
  return (
    <span class="font-mono text-xs text-base-content/60 tabular-nums">
      {first}
      <br />
      {last.summary ? (
        <span title={last.title ?? undefined}>
          {last.at} {last.summary}
        </span>
      ) : (
        last.at
      )}
    </span>
  )
}

interface Props {
  account: Account
  refreshing: boolean
  refreshedAt: string
  /** 前端短态：成功胶囊 2 秒 */
  justOkPc: Readonly<Record<string, boolean>>
  /** 手动保活与自动开关共用的在途状态（键为 `userId:desktopId`），请求期间一并 disabled */
  busyDesktop: Readonly<Record<string, boolean>>
  onIntervalCommit: (minutes: number) => Promise<boolean>
  onRefresh: () => void
  onManualKeepalive: (desktopId: string) => void
  onToggleAuto: (desktopId: string, on: boolean) => void
}

/** 保活面板：设置行 + 云电脑列表 */
export default function KeepAlivePanel(props: Props) {
  const { account: a } = props
  const [draft, setDraft] = useState(() => String(a.interval))
  const [intervalErr, setIntervalErr] = useState('')

  /* 服务端 interval 变化（操作响应 / 快照校正）时同步输入框 */
  useEffect(() => {
    setDraft(String(a.interval))
    setIntervalErr('')
  }, [a.interval])

  /* 保活间隔：失焦/回车时校验并重排倒计时；可填 1–59，非法输入回滚原值并提示，不静默夹取 */
  const commit = async () => {
    const text = draft.trim()
    const v = Number(text)
    if (!text || !Number.isInteger(v) || v < MIN_INTERVAL_MINUTES || v > MAX_INTERVAL_MINUTES) {
      setDraft(String(a.interval))
      setIntervalErr(`保活间隔需为 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 的整数，已恢复原值`)
      return
    }
    setIntervalErr('')
    setDraft(String(v))
    if (v !== a.interval) {
      const ok = await props.onIntervalCommit(v)
      if (!ok) setDraft(String(a.interval))
    }
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
            class={`input input-xs w-16 text-right font-mono tabular-nums ${intervalErr ? 'input-error' : ''}`}
            type="number"
            min={MIN_INTERVAL_MINUTES}
            max={MAX_INTERVAL_MINUTES}
            step="1"
            value={draft}
            aria-invalid={intervalErr ? 'true' : undefined}
            aria-describedby={intervalErr ? 'ka-interval-err' : undefined}
            onInput={(e: InputEvent) => {
              setDraft((e.target as HTMLInputElement).value)
              if (intervalErr) setIntervalErr('')
            }}
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
          {intervalErr && (
            <span id="ka-interval-err" role="alert" class="text-xs font-medium text-error">
              {intervalErr}
            </span>
          )}
          {!a.eaichat.ok && (
            <span class="badge badge-soft badge-warning badge-sm" title={a.eaichat.msg ?? undefined}>
              云智助手会话不可用
            </span>
          )}
        </div>
        <div class="flex items-center gap-2.5">
          <span class="font-mono text-xs text-base-content/60">更新于 {refreshedLabel(props.refreshedAt)}</span>
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
        <div class="grid flex-1 place-items-center text-[13px] text-base-content/60">{pcsEmptyText(a)}</div>
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
              {a.pcs.map((p) => {
                const blocked = !!BLOCK[p.run]
                const tip = blocked ? BLOCK[p.run] : undefined
                const key = `${a.userId}:${p.desktopId}`
                const busy = !!props.busyDesktop[key]
                const justOk = !!props.justOkPc[key]
                const autoBusy = busy
                return (
                  <tr key={p.desktopId} class="row-hover">
                    <td>
                      <div class="text-[13px] font-semibold">{p.desktopName}</div>
                      <div class="font-mono text-[11.5px] text-base-content/60">{p.desktopId}</div>
                    </td>
                    <td class="font-mono text-xs text-base-content/60">{p.osType}</td>
                    <td>
                      <StatusPill run={p.run} />
                    </td>
                    <td>
                      <CdCell p={p} />
                    </td>
                    <td class="w-20" title={tip}>
                      {justOk ? (
                        <span class="badge badge-soft badge-success badge-sm">
                          <HeroIcon icon={HERO_CHECK} class="h-3 w-3" />
                          成功
                        </span>
                      ) : (
                        <button
                          type="button"
                          class="btn btn-xs"
                          disabled={blocked || busy || p.link != null}
                          onClick={() => props.onManualKeepalive(p.desktopId)}
                        >
                          {busy || p.link != null ? '执行中' : '保活'}
                        </button>
                      )}
                    </td>
                    <th class="w-14 font-normal" title={blocked && !p.auto ? tip : autoBusy ? '该实例有操作正在进行…' : undefined}>
                      <input
                        type="checkbox"
                        class="toggle toggle-sm"
                        checked={p.auto}
                        /* 仅“打开”会被实例状态拦住；关闭永远允许 */
                        disabled={autoBusy || (blocked && !p.auto)}
                        aria-label={`自动保活 ${p.desktopName}`}
                        onChange={(e: Event) => props.onToggleAuto(p.desktopId, (e.target as HTMLInputElement).checked)}
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
