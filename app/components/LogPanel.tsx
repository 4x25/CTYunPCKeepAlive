import type { LogEntry, LogLevel } from '../lib/types'

const LV_CLS: Record<LogLevel, string> = {
  DEBUG: 'text-base-content/50',
  INFO: 'text-base-content/60',
  WARN: 'text-warning',
  ERROR: 'text-error',
}

interface Props {
  rows: LogEntry[]
  total: number
  /** 「主号 138****6021」 */
  accountLabel: string
  lv: string
  mod: string
  kw: string
  includeSys: boolean
  autoScroll: boolean
  clearArmed: boolean
  onLv: (v: string) => void
  onMod: (v: string) => void
  onKw: (v: string) => void
  onIncludeSys: (on: boolean) => void
  onAutoScroll: (on: boolean) => void
  onExport: () => void
  onClear: () => void
}

/** 日志面板：级别 / 模块 / 关键字三个条件可叠加，按账号归属渲染 */
export default function LogPanel(props: Props) {
  const { rows, total } = props
  return (
    <div role="tabpanel" aria-label="运行日志" class="flex h-full min-h-0 flex-col">
      <div class="mb-2.5 flex flex-wrap items-center gap-2.5">
        <select class="select select-xs w-28 font-mono" aria-label="日志级别" value={props.lv} onChange={(e: Event) => props.onLv((e.target as HTMLSelectElement).value)}>
          <option value="ALL">全部级别</option>
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>
        <select class="select select-xs w-28 font-mono" aria-label="来源模块" value={props.mod} onChange={(e: Event) => props.onMod((e.target as HTMLSelectElement).value)}>
          <option value="ALL">全部模块</option>
          <option value="保活">保活</option>
          <option value="积分">积分</option>
          <option value="账号">账号</option>
          <option value="调度">调度</option>
          <option value="系统">系统</option>
        </select>
        <input
          class="input input-xs w-36 font-mono"
          type="search"
          placeholder="关键字"
          aria-label="关键字搜索"
          value={props.kw}
          onInput={(e: Event) => props.onKw((e.target as HTMLInputElement).value)}
        />
        <label class="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            class="toggle toggle-sm"
            aria-label="包含系统日志"
            checked={props.includeSys}
            onChange={(e: Event) => props.onIncludeSys((e.target as HTMLInputElement).checked)}
          />
          <span class="font-mono text-xs text-base-content/60">包含系统日志</span>
        </label>
        <label class="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            class="toggle toggle-sm"
            aria-label="自动滚动到底部"
            checked={props.autoScroll}
            onChange={(e: Event) => props.onAutoScroll((e.target as HTMLInputElement).checked)}
          />
          <span class="font-mono text-xs text-base-content/60">自动滚动</span>
        </label>
        <span class="flex-1" />
        <button type="button" class="btn btn-xs" onClick={props.onExport}>
          导出
        </button>
        <button type="button" class="btn btn-xs" onClick={props.onClear}>
          {props.clearArmed ? '确认清空？' : '清空'}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto border-y border-base-300">
        {!rows.length ? (
          <div class="py-7 text-center text-[13px] text-base-content/60">
            {total ? '当前筛选条件下没有日志' : '这个账号还没有日志'}
          </div>
        ) : (
          <table class="table table-xs">
            <tbody>
              {rows.map((r) => (
                <tr key={r.seq}>
                  <td class="w-20 font-mono text-[11.5px] text-base-content/60 tabular-nums">{r.t}</td>
                  <td class={`w-14 font-mono text-[11.5px] font-semibold ${LV_CLS[r.lv]}`}>{r.lv}</td>
                  <td class="w-20 font-mono text-[11.5px] text-base-content/60">{r.mod}</td>
                  <td class="font-mono text-[11.5px] break-words">{r.msg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p class="mt-2 font-mono text-xs text-base-content/60">
        {`显示 ${rows.length} / ${total} 条 · 归属「${props.accountLabel}」${props.includeSys ? '，已并入系统日志' : '，未并入系统日志'}`}
      </p>
    </div>
  )
}
