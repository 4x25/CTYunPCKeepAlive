import { useLayoutEffect, useRef, type Child } from 'hono/jsx'
import { HeroIcon, HERO_X_MARK } from './icons'
import ToastStack, { type ToastItem } from './ToastStack'

interface Props {
  /** 打开态：元素常驻 DOM，仅切换 showModal/close */
  open: boolean
  /** 无障碍：指向弹窗标题元素的 id */
  labelledBy: string
  /** 用户请求关闭（Escape / 角落× / 遮罩 / 原生 close 事件） */
  onRequestClose: () => void
  /** 初始焦点落在角落关闭按钮上（删除确认等危险弹窗） */
  focusClose?: boolean
  /** 同步操作在途：锁定 Escape / 遮罩 / 角落关闭，避免弹窗先关、状态后到 */
  locked?: boolean
  /** 服务端报错 Toast：与弹窗同处 top layer，压在弹窗之上 */
  toasts?: ToastItem[]
  onDismissToast?: (id: number) => void
  children: Child
}

/**
 * 应用内模态窗（daisyUI Method 1：HTML dialog 元素，常驻不卸载）：
 * open 变化时 showModal/close，开闭动画由 daisyUI 的 visibility/overlay
 * allow-discrete 过渡自然播放；两个 method="dialog" 表单实现「角落关闭按钮」
 * 与「点击遮罩关闭」；Escape 走 onKeyDown（部分环境不派发 cancel 事件）；
 * 焦点圈定与焦点归还交给原生 dialog。
 */
export default function ModalLayer({ open, labelledBy, onRequestClose, focusClose, locked, toasts, onDismissToast, children }: Props) {
  const dlgRef = useRef<HTMLDialogElement | null>(null)

  /* hono/jsx 的 useEffect 走 rAF，页面不可见时不会触发；useLayoutEffect 同步执行，必定生效 */
  useLayoutEffect(() => {
    const d = dlgRef.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])

  const requestClose = () => {
    if (!locked) onRequestClose()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      requestClose()
    }
  }

  /* 原生 cancel（Escape）与 method="dialog" 表单提交都会直接关闭 dialog，这里一并拦住 */
  const onCancel = (e: Event) => {
    if (locked) e.preventDefault()
  }
  const onSubmit = (e: Event) => {
    if (locked) e.preventDefault()
  }

  return (
    <dialog class="modal" aria-labelledby={labelledBy} ref={dlgRef} onKeyDown={onKeyDown} onCancel={onCancel} onClose={onRequestClose}>
      <div class="modal-box max-w-md">
        <form method="dialog" onSubmit={onSubmit}>
          <button
            class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2"
            aria-label="关闭"
            autofocus={focusClose || undefined}
            onClick={requestClose}
          >
            <HeroIcon icon={HERO_X_MARK} class="h-4 w-4" />
          </button>
        </form>
        {children}
      </div>
      <form method="dialog" class="modal-backdrop" onSubmit={onSubmit}>
        <button aria-label="关闭" onClick={requestClose}>
          close
        </button>
      </form>
      {toasts && onDismissToast && <ToastStack toasts={toasts} onDismiss={onDismissToast} />}
    </dialog>
  )
}
