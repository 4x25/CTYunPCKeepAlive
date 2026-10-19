import type { RunState } from '../lib/types'

const MAP: Record<RunState, { cls: string; label: string }> = {
  running: { cls: 'badge-success', label: '运行中' },
  starting: { cls: 'badge-warning', label: '启动中' },
  stopping: { cls: 'badge-warning', label: '关机中' },
  stopped: { cls: 'badge-neutral', label: '已关机' },
  error: { cls: 'badge-error', label: '异常' },
}

/** 云电脑运行状态胶囊 */
export default function StatusPill({ run }: { run: RunState }) {
  const s = MAP[run]
  return <span class={`badge badge-soft badge-sm font-mono ${s.cls}`}>{s.label}</span>
}
