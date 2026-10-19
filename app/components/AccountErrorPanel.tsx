import type { Banner } from '../lib/types'

const TONE: Record<Banner['tone'], { alert: string; btn: string }> = {
  danger: { alert: 'alert-soft alert-error', btn: 'btn-error' },
  warn: { alert: 'alert-soft alert-warning', btn: 'btn-warning' },
  idle: { alert: 'alert-soft', btn: '' },
}

interface Props {
  banner: Banner
  onAction: (act: 'relogin' | 'retry') => void
}

/**
 * 报错账号的错误提示：该账号不展示功能页签，警示条铺满整个内容区、内容在其中居中（上下布局）。
 * 登录失败给「重新登录」，需人工处理给「重试登录」，重试中显示加载态。
 */
export default function AccountErrorPanel({ banner, onAction }: Props) {
  const tone = TONE[banner.tone]
  const retrying = banner.tone === 'idle'
  return (
    <div role="alert" class={`alert ${tone.alert} alert-vertical h-full content-center justify-items-center rounded-none`}>
      {retrying && <span class="loading loading-spinner loading-sm flex-none" aria-hidden="true" />}
      <p class="max-w-md text-sm leading-relaxed">{banner.text}</p>
      {banner.btn && banner.act && (
        <button type="button" class={`btn btn-sm flex-none whitespace-nowrap ${tone.btn}`} onClick={() => onAction(banner.act as 'relogin' | 'retry')}>
          {banner.btn}
        </button>
      )}
    </div>
  )
}
