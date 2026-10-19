import { Fragment, type Child } from 'hono/jsx'
import type { Account, DotTone } from '../lib/types'
import { MAX_ACCOUNTS } from '../lib/mock-data'
import ThemeToggle from './ThemeToggle'
import { GithubIcon, HeroIcon, HERO_PLUS, HERO_X_MARK } from './icons'

const DOT: Record<DotTone, string> = {
  ok: 'status status-success',
  danger: 'status status-error',
  warn: 'status status-warning',
  /* 登录中：灰点脉冲，不引入第四种颜色 */
  load: 'status status-neutral animate-pulse',
}

/* Tab 名：填了别名只显示别名，留空就显示完整账号；完整值靠 hover 的 title 补全 */
function tabLabel(a: Account): string {
  return a.alias || a.full
}
function tabTitle(a: Account): string {
  return `完整账号：${a.full}\n别名：${a.alias || '未设置（Tab 名直接用完整账号）'}`
}

interface Props {
  accounts: Account[]
  active: number
  /** 每个账号各自的页签内容（保活/积分/日志面板或错误面板），全部挂载 */
  renderContent: (account: Account, index: number) => Child
  onSelect: (i: number) => void
  onDelete: (i: number) => void
  onAdd: () => void
}

/**
 * 账号 Tab 条（官网 radio tabs-lift with icons + tab content 结构）：label.tab 包裹 radio +
 * 状态点 + 名称 + ×，每个账号的内容区全部挂载，显隐由 :checked + .tab-content 纯 CSS 驱动
 * （水合前切账号也能正常显示）；＋ 与全局操作区（GitHub + 主题切换）包装成 tab 与账号 Tab 同行。
 *
 * 不换行 + 超宽滚动按官方「tabs-box with a horizontal scroll when there's no space」口径：
 * 外层 overflow-x-auto + .tabs min-w-max + tab 加 z-1 + tab-content sticky start-0。
 * 关键点：tab-content 必须 [contain:inline-size]，否则它的固有宽度（表格等内容物）
 * 会被 min-w-max 并进 .tabs 单行宽度，桌面宽度下也出现整条横滚、内容被顶到标签右侧
 * （官方示例内容是纯文本短句，不触发；此处用 contain 把固有宽度贡献归零，同时
 * max-w 把使用宽度截在滚动视口内）。
 */
export default function AccountTabBar({ accounts, active, renderContent, onSelect, onDelete, onAdd }: Props) {
  const atMax = accounts.length >= MAX_ACCOUNTS
  return (
    <div class={accounts.length > 0 ? 'min-h-0 flex-1 overflow-x-auto' : 'overflow-x-auto'}>
      <div class="tabs tabs-lift h-full min-w-max" aria-label="账号列表">
        {accounts.map((a, i) => (
          <Fragment key={String(a.uid)}>
            <label class="tab group z-1 gap-1.5 whitespace-nowrap [--tab-bg:var(--color-base-200)]" title={tabTitle(a)}>
              <input
                type="radio"
                name="acct-tabs"
                aria-label={tabLabel(a)}
                checked={i === active}
                onChange={() => onSelect(i)}
                onKeyDown={(e: KeyboardEvent) => {
                  /* 键盘用 Delete 关闭当前 Tab——可关闭 Tab 的标准做法 */
                  if (e.key === 'Delete') {
                    e.preventDefault()
                    onDelete(i)
                  }
                }}
              />
              <span class={DOT[a.dot]} aria-hidden="true" />
              <span class="max-w-44 truncate">{tabLabel(a)}</span>
              <span
                aria-hidden="true"
                class={`btn btn-ghost btn-xs btn-circle relative z-10 text-base-content/50 transition-opacity hover:text-error ${
                  i === active ? '' : 'opacity-0 group-hover:opacity-100'
                }`}
                onClick={(e: MouseEvent) => {
                  /* Tab 上的「×」走二次确认，不切换 Tab（preventDefault 阻止 label 激活 radio） */
                  e.preventDefault()
                  e.stopPropagation()
                  onDelete(i)
                }}
              >
                <HeroIcon icon={HERO_X_MARK} class="h-3 w-3" />
              </span>
            </label>
            {/* 每个账号的内容区全部挂载：显隐交给 :checked + .tab-content（水合前即可用）。
                [contain:inline-size] 让固有宽度脱离内容物（表格等）——否则 min-w-max 会把
                表格固有宽度并进 .tabs 单行宽度，桌面也出现横滚；max-w 截到滚动视口内，
                sticky start-0 让横滚时钉在左缘 */}
            <div class="tab-content sticky start-0 z-0 min-w-0 w-full max-w-[calc(100vw-2rem)] overflow-x-hidden border-base-300 bg-base-100 p-0 md:max-w-[calc(100vw-4rem)] [contain:inline-size]">
              {renderContent(a, i)}
            </div>
          </Fragment>
        ))}
        {/* 新增账号：btn 样式，包装在一个 tab 槽位内与账号 Tab 同行 */}
        <div class="tab z-1 cursor-default border-b-transparent whitespace-nowrap">
          <button
            type="button"
            class="btn btn-ghost btn-sm btn-square"
            aria-label="新增账号"
            disabled={atMax}
            title={atMax ? `最多 ${MAX_ACCOUNTS} 个账号，避免并发请求过密` : '新增账号'}
            onClick={onAdd}
          >
            <HeroIcon icon={HERO_PLUS} class="h-4 w-4" />
          </button>
        </div>
        {/* 全局操作区：包装成一个 tab，宽屏下伸展到行尾（GitHub 主页入口 + 明暗主题切换） */}
        <div class="tab z-1 flex-1 cursor-default justify-end gap-1 border-b-transparent whitespace-nowrap" role="group" aria-label="全局操作">
          <a
            class="btn btn-ghost btn-sm btn-square"
            href="https://github.com/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="打开 GitHub 主页（新标签页）"
            title="打开 GitHub 主页（新标签页）"
          >
            <GithubIcon class="h-4 w-4" />
          </a>
          <ThemeToggle />
        </div>
      </div>
    </div>
  )
}
