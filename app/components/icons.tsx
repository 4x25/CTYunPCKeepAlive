/**
 * 图标统一出口：基础 UI 图标直接引入 heroicons 包内原始 SVG（heroicons/24/outline），
 * 品牌图标直接引入 @lobehub/icons-static-svg。一律经本文件渲染，不手写 SVG，不用字符图标。
 */
import sunSvg from 'heroicons/24/outline/sun.svg?raw'
import moonSvg from 'heroicons/24/outline/moon.svg?raw'
import plusSvg from 'heroicons/24/outline/plus.svg?raw'
import xMarkSvg from 'heroicons/24/outline/x-mark.svg?raw'
import questionSvg from 'heroicons/24/outline/question-mark-circle.svg?raw'
import checkSvg from 'heroicons/24/outline/check.svg?raw'
import arrowPathSvg from 'heroicons/24/outline/arrow-path.svg?raw'
import githubSvg from '@lobehub/icons-static-svg/icons/github.svg?raw'

interface IconProps {
  class: string
  label?: string
}

/** 库内原始 SVG 的统一挂载点：尺寸由外层 class（h-* w-*）控制，svg 强制撑满 */
function RawIcon({ svg, class: cls, label }: IconProps & { svg: string }) {
  return (
    <span
      class={`inline-flex items-center justify-center [&_svg]:block [&_svg]:h-full [&_svg]:w-full ${cls}`}
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/** Heroicons 基础图标（outline：1.5px 描边，随 currentColor） */
export function HeroIcon({ icon, class: cls, label }: IconProps & { icon: string }) {
  return <RawIcon svg={icon} class={cls} label={label} />
}

export const HERO_SUN = sunSvg
export const HERO_MOON = moonSvg
export const HERO_PLUS = plusSvg
export const HERO_X_MARK = xMarkSvg
export const HERO_QUESTION = questionSvg
export const HERO_CHECK = checkSvg
export const HERO_REFRESH = arrowPathSvg

/** @lobehub/icons: GitHub 品牌图标（Mono，fill 风格） */
export function GithubIcon(props: IconProps) {
  return <RawIcon svg={githubSvg} {...props} />
}
