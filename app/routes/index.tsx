import { createRoute } from 'honox/factory'
import KeepAliveApp from '../islands/KeepAliveApp'

export default createRoute((c) => {
  return c.render(
    <div>
      <title>天翼云保活助手</title>
      <KeepAliveApp />
    </div>,
  )
})
