/**
 * Web 服务器入口。
 *
 * 启动 Runtime（后台调度器）+ Hono 服务器。
 */
import app from "./app.tsx";
import { Runtime } from "../core/runtime.ts";
import { Logger } from "../core/logger.ts";
import { setRuntime } from "./api.ts";
import { bus } from "../core/bus.ts";
import type { LogRecord } from "../core/logger.ts";

async function main() {
  const port = parseInt(Deno.env.get("PORT") || "3000", 10);
  const host = Deno.env.get("HOST") || "127.0.0.1";

  // 日志同时推给 SSE
  const log = new Logger({
    verbose: true,
    logDir: Deno.env.get("CTYUNPC_LOG_DIR"),
    onRecord: (r: LogRecord) => bus.emit("log:entry", r),
  });

  log.info("系统", "正在启动 Runtime...");
  const runtime = await Runtime.start(log);
  setRuntime(runtime);

  Deno.serve({
    port,
    hostname: host,
    onListen: () => {
      console.log(`\n🚀 CTYun PC KeepAlive 已启动\n`);
      console.log(`   地址：http://${host}:${port}`);
      console.log(`\n按 Ctrl+C 停止服务\n`);
    },
  }, app.fetch);

  const shutdown = () => {
    log.info("系统", "正在停止服务...");
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("启动失败:", err);
    Deno.exit(1);
  });
}
