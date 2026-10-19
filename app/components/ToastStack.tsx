import { HeroIcon, HERO_X_MARK } from './icons'

export interface ToastItem {
  id: number
  msg: string
  code?: string
}

interface Props {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
}

/**
 * 服务端报错的唯一出口；前端必填校验仍然贴在字段下方。
 * 压在弹窗之上，弹窗保持打开、已填内容不清空。
 */
export default function ToastStack({ toasts, onDismiss }: Props) {
  if (!toasts.length) return null
  return (
    /* 压在弹窗（daisyUI modal z-index:999）之上 */
    <div class="toast toast-bottom toast-center z-[1000] w-full max-w-md" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role="alert" class="alert alert-soft alert-error w-full py-2 text-xs">
          <span class="flex-1 break-words">
            {t.msg}
            {t.code && <code class="ml-1 font-mono whitespace-nowrap">{t.code}</code>}
          </span>
          <button type="button" class="btn btn-ghost btn-xs btn-square flex-none" aria-label="关闭提示" onClick={() => onDismiss(t.id)}>
            <HeroIcon icon={HERO_X_MARK} class="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
