/**
 * M2 多账号运行时 CLI。
 *
 * 用法：`deno task daemon`
 *
 * 从配置文件启动运行时，持续保活。
 * 按 Ctrl+C 优雅退出（自动保存状态）。
 */
import { Runtime } from "../core/runtime.ts";
import { Logger } from "../core/logger.ts";

async function main(): Promise<number> {
  console.log("M2 多账号运行时启动");

  const logDir = Deno.env.get("CTYUNPC_LOG_DIR");
  const runtime = await Runtime.start(
    logDir ? new Logger({ verbose: true, logDir }) : undefined,
  );
  void runtime;

  console.log("运行时已启动，按 Ctrl+C 退出");

  // 优雅退出
  const shutdown = () => {
    console.log("\n收到退出信号，退出");
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  // 保持运行
  await new Promise(() => {});
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
