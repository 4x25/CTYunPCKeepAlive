/**
 * 云智助手 AI 对话（SSE 流式）。
 *
 * 接口：`/eai/chat/completions`，返回 `text/event-stream`。
 */
import type { CookieJar } from "../cookiejar.ts";
import { signRequest, type SignatureContext } from "./sign.ts";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatRequest {
  /** 对话历史。 */
  messages: ChatMessage[];
  /** 是否流式返回（固定 true）。 */
  stream: true;
  /** 模型（可选）。 */
  model?: string;
}

export interface ChatChunk {
  /** 增量文本。 */
  delta: string;
  /** 是否结束。 */
  done: boolean;
  /** 原始 SSE data（调试用）。 */
  raw?: string;
}

/**
 * 发起对话，返回 SSE 流的 ReadableStream。
 *
 * 调用方需自行解析 `data: {...}` 格式的 SSE 事件。
 */
export async function chatCompletions(
  ctx: SignatureContext,
  cookies: CookieJar,
  request: ChatRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadableStream<Uint8Array>> {
  const req = signRequest("/eai/chat/completions", request, ctx);
  const res = await fetchImpl(req.url, {
    method: req.method,
    headers: {
      ...req.headers,
      "Cookie": cookies.toString(),
      "Accept": "text/event-stream",
    },
    body: req.body,
  });

  if (!res.ok) {
    throw new Error(`chatCompletions HTTP ${res.status}: ${await res.text()}`);
  }

  if (!res.body) {
    throw new Error("chatCompletions: response body is null");
  }

  return res.body;
}

/**
 * 解析 SSE 流为 ChatChunk 的异步迭代器。
 *
 * 示例用法：
 * ```ts
 * const stream = await chatCompletions(ctx, cookies, { messages: [...], stream: true });
 * for await (const chunk of parseSSE(stream)) {
 *   console.log(chunk.delta);
 *   if (chunk.done) break;
 * }
 * ```
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") {
          yield { delta: "", done: true, raw: dataStr };
          return;
        }

        try {
          const json = JSON.parse(dataStr) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
          };
          const delta = json.choices?.[0]?.delta?.content ?? "";
          const finishReason = json.choices?.[0]?.finish_reason;
          yield { delta, done: finishReason === "stop", raw: dataStr };
          if (finishReason === "stop") return;
        } catch {
          // 跳过无法解析的行
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
