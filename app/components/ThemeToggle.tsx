import { useEffect, useState } from 'hono/jsx'
import { HeroIcon, HERO_MOON, HERO_SUN } from './icons'

const STORAGE_KEY = 'od-keepalive-theme'

/**
 * 明暗主题切换：未显式选择时跟随系统（daisyUI 默认 light/dark 按 prefers-color-scheme 解析），
 * 选择后写入 localStorage 并由 _renderer 的内联脚本在首帧前应用。
 */
export default function ThemeToggle() {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    let stored: string | null = null
    try {
      stored = localStorage.getItem(STORAGE_KEY)
    } catch {}
    setDark(stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches)
  }, [])

  const onChange = (e: Event) => {
    const next = (e.target as HTMLInputElement).checked
    setDark(next)
    const theme = next ? 'dark' : 'light'
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {}
  }

  return (
    <label class="btn btn-ghost btn-sm btn-square swap swap-rotate" title={dark ? '切换到浅色主题' : '切换到深色主题'}>
      <input type="checkbox" checked={dark} onChange={onChange} aria-label="切换明暗主题" />
      {/* lucide: sun —— 浅色态显示 */}
      <HeroIcon icon={HERO_SUN} class="swap-off h-4 w-4" />
      {/* lucide: moon —— 深色态显示 */}
      <HeroIcon icon={HERO_MOON} class="swap-on h-4 w-4" />
    </label>
  )
}
