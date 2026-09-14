/**
 * 云智助手 AI 对话（SSE）。
 *
 * 依据 `docs/ctyun-eaichat-chat-sse-api.md`。
 *
 * 三处容易踩坑的地方：
 * 1. **没有 `[DONE]`**：结束靠 `finish_reason === "stop"` 加流关闭
 * 2. 网络分块边界与 SSE 事件边界不一致（实测 5 个分块出 7 个事件），
 *    必须自己维护缓冲区
 * 3. 签名必须覆盖**最终发出的那份 JSON 字符串**
 */
import crypto from "node:crypto";
import type { SignatureContext } from "./sign.ts";
import { signRequest } from "./sign.ts";

const CHAT_PATH = "/ai/portal/wenc/v3/openai/chat/completions";
const MODELS_PATH = "/ai/portal/v2/openai/chat/queryModels";

/** 默认模型。 */
export const DEFAULT_MODEL = "TEXT_DEEPSEEK_V4";

/** 文档标注的服务端拼写就是 `avaiable`，照抄。 */
const AVAILABLE_STATUS = "avaiable";

export interface ChatOptions {
  /** 用户输入文本。 */
  prompt: string;
  /** 模型，默认 `TEXT_DEEPSEEK_V4`。 */
  model?: string;
  /** 当前租户数字 ID，缺席时省略字段。 */
  tenantId?: number;
  /** 会话 ID，已有会话追问时带上。 */
  conversationId?: string;
  /** 消息校验 ID；不传则新建 UUID v4。 */
  verifyId?: string;
  /** 超时预算（毫秒），文档默认约 90 秒。 */
  timeoutMs?: number;
}

export interface ChatTransport {
  fetch: typeof fetch;
  cookieHeader: (url: string) => string;
}

export interface ChatResult {
  /** 拼接后的完整回答文本。 */
  content: string;
  /** 实际使用的模型。 */
  modelUsed: string;
  /** 会话 ID。 */
  conversationId?: string;
  /** 本次使用的 verify_id，模型回退时需复用以避免重复消息。 */
  verifyId: string;
}

/** SSE 解析出的事件。只消费文档列出的字段。 */
interface SseChoice {
  delta?: { content?: string; role?: string; type?: string };
  finish_reason?: string;
}

interface SseEvent {
  status?: string;
  model?: string;
  conversation_id?: string;
  message_id?: number;
  choices?: SseChoice[];
}

/**
 * 构造请求体。
 *
 * 字段集合与文档一致；`tenantId` 缺席时**省略**而不是发 null
 * —— 签名基于最终字符串，多一个字段就验签失败。
 */
export function buildChatBody(opts: {
  prompt: string;
  model: string;
  verifyId: string;
  tenantId?: number;
  conversationId?: string;
}): Record<string, unknown> {
  return {
    key_model: opts.model,
    messages: [{
      role: "user",
      content: opts.prompt,
      verify_id: opts.verifyId,
      ref: { type: "file", file: [] },
    }],
    stream: true,
    client_retry: true,
    web_search: false,
    ...(opts.tenantId !== undefined && { tenantId: opts.tenantId }),
    enable_thinking: false,
    ...(opts.conversationId !== undefined && { conversation_id: opts.conversationId }),
    tools: [],
    action: {},
  };
}

/**
 * 发起对话并读完整个 SSE 流。
 *
 * 一次调用只用一个模型；模型回退由 {@link chatWithFallback} 负责，
 * 那里才需要排除集合，避免在两个不可用模型间无限循环。
 */
export async function chat(
  ctx: SignatureContext,
  t: ChatTransport,
  opts: ChatOptions,
): Promise<ChatResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const verifyId = opts.verifyId ?? crypto.randomUUID();

  const body = buildChatBody({
    prompt: opts.prompt,
    model,
    verifyId,
    ...(opts.tenantId !== undefined && { tenantId: opts.tenantId }),
    ...(opts.conversationId !== undefined && { conversationId: opts.conversationId }),
  });

  // 签名与发送共用同一份字符串
  const bodyStr = JSON.stringify(body);
  const req = signRequest(ctx, { path: CHAT_PATH, method: "POST", body: bodyStr });

  const headers = new Headers(req.headers);
  headers.set("Accept", "text/event-stream");
  const cookie = t.cookieHeader(req.url);
  if (cookie) headers.set("Cookie", cookie);

  const controller = new AbortController();
  const budget = opts.timeoutMs ?? 90_000;
  const timer = setTimeout(() => controller.abort(), budget);

  try {
    const res = await t.fetch(req.url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });

    if (res.status === 401) {
      throw new EaiUnauthorizedError("云智助手会话已失效（HTTP 401）");
    }
    if (!res.ok) {
      throw new Error(`对话接口 HTTP ${res.status}`);
    }
    if (!res.body) {
      throw new Error("对话接口响应没有 body");
    }

    let content = "";
    let conversationId: string | undefined;
    let modelUsed = model;

    for await (const ev of parseSseStream(res.body)) {
      if (ev.conversation_id) conversationId = ev.conversation_id;
      if (ev.model) modelUsed = ev.model;

      const choice = ev.choices?.[0];
      // 只拼接文本增量
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) content += delta;

      // 结束判定：finish_reason 或流关闭（parseSseStream 会自然结束）
      if (choice?.finish_reason === "stop") break;
    }

    return {
      content,
      modelUsed,
      verifyId,
      ...(conversationId !== undefined && { conversationId }),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 会话失效。上层据此清理本地会话并重走 IAM 链。 */
export class EaiUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EaiUnauthorizedError";
  }
}

/**
 * 解析 SSE 字节流。
 *
 * 必须以空行分隔完整帧 —— 一次 `read()` 可能包含多个事件，
 * 一个事件也可能跨多次 `read()`。
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 按空行切出完整帧
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseFrame(frame);
        if (ev) yield ev;
      }
    }

    // 流结束时可能残留最后一帧（没有尾部空行）
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** 解析单个 SSE 帧。无 `data` 行时返回 undefined。 */
function parseFrame(frame: string): SseEvent | undefined {
  // 支持一个事件多行 data（多行用换行拼接）
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return undefined;

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return undefined;

  try {
    return JSON.parse(payload) as SseEvent;
  } catch {
    return undefined;
  }
}

/** `queryModels` 返回的模型项。 */
export interface ModelItem {
  keyModel: string;
  status: string;
  type: string;
}

/**
 * 查询模型列表，用于模型回退。
 *
 * 同时被用于推导 `industry.curIndustry`：按 `item.type` 分组，
 * 取当前 `key_model` 所在项的 `type`。
 */
export async function queryModels(
  ctx: SignatureContext,
  t: ChatTransport,
): Promise<ModelItem[]> {
  const req = signRequest(ctx, {
    path: MODELS_PATH,
    method: "GET",
    query: { type: "all" },
  });

  const headers = new Headers(req.headers);
  const cookie = t.cookieHeader(req.url);
  if (cookie) headers.set("Cookie", cookie);

  const res = await t.fetch(req.url, { method: "GET", headers });
  if (!res.ok) throw new Error(`queryModels HTTP ${res.status}`);

  const body = await res.json() as { resultCode?: number; data?: unknown };
  return Array.isArray(body.data) ? body.data as ModelItem[] : [];
}

/**
 * 在同产业模型里挑一个可用的。
 *
 * 文档要求：`type` 与当前模型一致、`status === "avaiable"`、
 * 且不在排除集合内。当前 key 不在结果里时**不能跨行业盲选**。
 */
export function pickFallbackModel(
  models: ModelItem[],
  currentKeyModel: string,
  excluded: Set<string>,
): ModelItem | undefined {
  const current = models.find((m) => m.keyModel === currentKeyModel);
  const currentType = current?.type;
  if (!currentType) return undefined;

  return models.find((m) =>
    m.type === currentType &&
    m.status === AVAILABLE_STATUS &&
    !excluded.has(m.keyModel)
  );
}
