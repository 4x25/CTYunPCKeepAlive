import { Fragment, type Child } from 'hono/jsx'

export type TabKey = 'keepalive' | 'points' | 'log'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'keepalive', label: '无感保活' },
  { key: 'points', label: '积分任务' },
  { key: 'log', label: '运行日志' },
]

interface Props {
  tab: TabKey
  onChange: (key: TabKey) => void
  /** 三个页签的内容，全部渲染，由 daisyUI 的 :checked + .tab-content 机制控制显示 */
  panels: Record<TabKey, Child>
  /** radio 组名（多个 SubTabs 实例并存时必须互不相同） */
  name: string
}

/** 功能页签（官网 radio tabs-box + tab content 结构）：保活 / 积分任务 / 日志 */
export default function SubTabs({ tab, onChange, panels, name }: Props) {
  return (
    <div class="tabs tabs-box h-full rounded-none shadow-none" aria-label="功能页">
      {TABS.map((t) => (
        <Fragment key={t.key}>
          <input
            type="radio"
            name={name}
            class="tab whitespace-nowrap"
            aria-label={t.label}
            checked={tab === t.key}
            onChange={() => onChange(t.key)}
          />
          <div class="tab-content mt-0! min-w-0 overflow-x-hidden border-0 bg-base-100 p-4 md:p-6">{panels[t.key]}</div>
        </Fragment>
      ))}
    </div>
  )
}
