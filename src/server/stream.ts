/**
 * SSE 流：向前端推送状态快照和日志。
 *
 * 事件名：`snapshot` / `log` / `ping`
 * 每个事件体带单调递增的 `rev`，客户端用它检测丢包。
 */
import type { Context } from "@hono/hono";
import { streamSSE } from "@hono/hono/streaming";
import { bus } from "../core/bus.ts";
import { state } from "../core/state.ts";
import type { LogRecord } from "../core/logger.ts";

let globalRev = 0;

export function createSSEStream(c: Context): Response {
  return streamSSE(c, async (stream) => {
    const push = async (type: "snapshot" | "log", data: unknown) => {
      await stream.writeSSE({
        event: type,
        data: JSON.stringify({ rev: ++globalRev, type, data }),
      });
    };

    // 首次发送完整快照
    await push("snapshot", state.getSnapshot());

    // 状态变更 → 推快照（全量，量级很小且客户端按 key 增量渲染）
    const offState = bus.on("state:snapshot", () => {
      push("snapshot", state.getSnapshot()).catch(() => {});
    });

    const offLog = bus.on("log:entry", (r: LogRecord) => {
      push("log", r).catch(() => {});
    });

    stream.onAbort(() => {
      offState();
      offLog();
    });

    // 心跳，兼作断线检测
    while (true) {
      await stream.sleep(30_000);
      await stream.writeSSE({ event: "ping", data: String(Date.now()) });
    }
  });
}
