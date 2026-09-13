/**
 * Hono 主应用：路由和中间件。
 */
import { Hono } from "@hono/hono";
import { serveStatic } from "@hono/hono/deno";
import { Shell } from "./ssr.tsx";
import { createSSEStream } from "./stream.ts";
import * as api from "./api.ts";

const app = new Hono();

// 静态资源
app.use("/assets/*", serveStatic({ root: "./" }));

// SSE 流
app.get("/api/stream", createSSEStream);

// API 接口
app.post("/api/accounts/add", api.addAccount);
app.post("/api/accounts/remove", api.removeAccount);
app.post("/api/accounts/update-alias", api.updateAccountAlias);
app.post("/api/devices/refresh", api.refreshDevices);
app.post("/api/devices/toggle-auto", api.toggleAutoKeepalive);
app.post("/api/devices/update-interval", api.updateKeepaliveInterval);
app.post("/api/devices/keepalive", api.manualKeepalive);

// 首屏 SSR
app.get("/", (c) => {
  return c.html(<Shell />);
});

export default app;
