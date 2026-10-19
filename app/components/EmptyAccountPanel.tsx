import { HeroIcon, HERO_PLUS } from './icons'

interface Props {
  onAdd: () => void
}

/** 零账号空态：不展示功能页签，整幅提示 + 唯一主按钮（视觉与报错账号一致） */
export default function EmptyAccountPanel({ onAdd }: Props) {
  return (
    <div role="status" class="alert alert-soft alert-vertical flex-1 content-center justify-items-center rounded-t-none">
      <p class="max-w-md text-sm leading-relaxed">还没有添加账号。添加一个账号后，工具会自动登录并列出它的云电脑。</p>
      <button type="button" class="btn btn-neutral btn-sm" onClick={onAdd}>
        <HeroIcon icon={HERO_PLUS} class="h-4 w-4" />
        添加账号
      </button>
    </div>
  )
}
