import build from '@hono/vite-build/node'
import adapter from '@hono/vite-dev-server/node'
import tailwindcss from '@tailwindcss/vite'
import honox from 'honox/vite'
import { defineConfig } from 'vite'

const port = 3000

export default defineConfig({
  plugins: [
    honox({
      devServer: { adapter },
      client: { input: ['/app/client.ts', '/app/style.css'] }
    }),
    tailwindcss(),
    build({
      port,
      /* 覆盖默认的 serve 调用，在监听成功后输出访问地址 */
      entryContentAfterHooks: [
        (appName) => `import { serve } from '@hono/node-server'

serve({ fetch: ${appName}.fetch, port: ${port} }, (info) => {
  console.log(\`\\nServer running at http://localhost:\${info.port}\`)
})`
      ]
    })
  ]
})
