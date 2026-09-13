/**
 * SSR 外壳：首屏 HTML 框架。
 *
 * 包含：
 * - 完整的 HTML 结构（dark theme、viewport、favicon）
 * - 加载 Tailwind CSS
 * - 加载客户端 JS（hono/jsx/dom）
 * - 根容器 #root
 */
import type { FC } from "@hono/hono/jsx";

export const Layout: FC = ({ children }) => {
  return (
    <html lang="zh-CN" data-theme="dark">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>CTYun PC KeepAlive</title>
        <link rel="stylesheet" href="/assets/styles.css" />
        <style>{`
          :root {
            --surface-0: #05070C;
            --surface-1: #0A0D12;
            --surface-2: #0F131C;
            --surface-3: #161D2B;
            --surface-4: #1E2636;
            --accent: #38BDF8;
            --accent-dim: #0284C7;
          }
          body {
            background: var(--surface-0);
            color: #E5E7EB;
            font-family: system-ui, -apple-system, sans-serif;
          }
          * { box-sizing: border-box; }
        `}</style>
      </head>
      <body>
        <div id="app">
          <div class="min-h-screen flex items-center justify-center">
            <span class="loading loading-spinner loading-lg text-primary"></span>
          </div>
        </div>
        <script type="module" src="/assets/client.js"></script>
      </body>
    </html>
  );
};

/** 首屏骨架（SSR） */
export const Shell: FC = () => {
  return (
    <Layout>
      <div class="min-h-screen flex items-center justify-center">
        <div class="text-center space-y-4">
          <div class="loading loading-spinner loading-lg text-primary"></div>
          <p class="text-base-content/60">加载中...</p>
        </div>
      </div>
    </Layout>
  );
};
