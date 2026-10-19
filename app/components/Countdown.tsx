/** daisyUI countdown（Clock countdown with colons 示例）：mm:ss 两位滚动数字（--digits:2 保持前导零），冒号分隔 */
export default function Countdown({ seconds, class: cls }: { seconds: number; class?: string }) {
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  return (
    <span class={`countdown ${cls ?? ''}`}>
      <span style={`--value:${mm};--digits:2`} aria-live="polite" aria-label={String(mm)}>
        {mm}
      </span>
      :
      <span style={`--value:${ss};--digits:2`} aria-live="polite" aria-label={String(ss)}>
        {ss}
      </span>
    </span>
  )
}
