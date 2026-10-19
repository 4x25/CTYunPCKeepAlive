import { HeroIcon, HERO_QUESTION } from './icons'

/** 行内帮助标记：把长说明收进 tooltip，设置面板保持单行 */
export default function HelpMark({ tip, label }: { tip: string; label: string }) {
  return (
    <span class="tooltip tooltip-right tooltip-info before:w-52 before:whitespace-normal before:break-words before:text-start" data-tip={tip}>
      <span
        tabindex={0}
        role="note"
        aria-label={label}
        class="inline-flex cursor-help items-center justify-center text-base-content/60 hover:text-base-content"
      >
        <HeroIcon icon={HERO_QUESTION} class="h-3.5 w-3.5" />
      </span>
    </span>
  )
}
