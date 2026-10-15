import { useState } from 'hono/jsx'

export default function Counter() {
  const [count, setCount] = useState(0)
  return (
    <div class="stats shadow">
      <div class="stat">
        <div class="stat-title">Count</div>
        <div class="stat-value">{count}</div>
        <div class="stat-actions">
          <button class="btn" onClick={() => setCount(count + 1)}>
            Increment
          </button>
        </div>
      </div>
    </div>
  )
}
