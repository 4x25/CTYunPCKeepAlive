/**
 * AI 对话 SSE 解析单测。
 */
import { assertEquals } from "@std/assert";
import { parseSSE } from "./chat.ts";

function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

Deno.test("parseSSE 解析标准 SSE 流", async () => {
  const stream = createSSEStream([
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  ]);

  const chunks = [];
  for await (const chunk of parseSSE(stream)) {
    chunks.push(chunk);
  }

  assertEquals(chunks.length, 3);
  assertEquals(chunks[0]!.delta, "Hello");
  assertEquals(chunks[0]!.done, false);
  assertEquals(chunks[1]!.delta, " world");
  assertEquals(chunks[1]!.done, false);
  assertEquals(chunks[2]!.delta, "");
  assertEquals(chunks[2]!.done, true);
});

Deno.test("parseSSE 处理 [DONE] 标记", async () => {
  const stream = createSSEStream([
    'data: {"choices":[{"delta":{"content":"test"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);

  const chunks = [];
  for await (const chunk of parseSSE(stream)) {
    chunks.push(chunk);
  }

  assertEquals(chunks.length, 2);
  assertEquals(chunks[0]!.delta, "test");
  assertEquals(chunks[1]!.delta, "");
  assertEquals(chunks[1]!.done, true);
});

Deno.test("parseSSE 跳过无效行", async () => {
  const stream = createSSEStream([
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    "invalid line\n",
    'data: invalid json\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  ]);

  const chunks = [];
  for await (const chunk of parseSSE(stream)) {
    chunks.push(chunk);
  }

  assertEquals(chunks.length, 2);
  assertEquals(chunks[0]!.delta, "ok");
  assertEquals(chunks[1]!.done, true);
});

Deno.test("parseSSE 处理跨块的行", async () => {
  const stream = createSSEStream([
    'data: {"choices":[{"del',
    'ta":{"content":"split"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  ]);

  const chunks = [];
  for await (const chunk of parseSSE(stream)) {
    chunks.push(chunk);
  }

  assertEquals(chunks.length, 2);
  assertEquals(chunks[0]!.delta, "split");
  assertEquals(chunks[1]!.done, true);
});
