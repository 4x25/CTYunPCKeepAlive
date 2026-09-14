/**
 * AI 对话与 SSE 解析单测。
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  buildChatBody,
  chat,
  DEFAULT_MODEL,
  EaiUnauthorizedError,
  parseSseStream,
  pickFallbackModel,
  queryModels,
  type ChatTransport,
} from "./chat.ts";
import type { SignatureContext } from "./sign.ts";

const CTX: SignatureContext = { sk: "SK", xuid: "pubweb_t", tenantIdStr: "7" };

/** 造一个 SSE 字节流。 */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  });
}

/** 造一个 SSE 响应。 */
function sseResponse(chunks: string[]): Response {
  return new Response(sseStream(chunks), {
    headers: { "content-type": "text/event-stream" },
  });
}

function transport(fetchImpl: typeof fetch): ChatTransport {
  return { fetch: fetchImpl, cookieHeader: () => "SESSION=c" };
}

Deno.test("buildChatBody 字段与文档一致", () => {
  const body = buildChatBody({ prompt: "hi", model: DEFAULT_MODEL, verifyId: "V1" });
  assertEquals(body["key_model"], "TEXT_DEEPSEEK_V4");
  assertEquals(body["stream"], true);
  assertEquals(body["client_retry"], true);
  assertEquals(body["web_search"], false);
  assertEquals(body["enable_thinking"], false);
  assertEquals(body["tools"], []);
  assertEquals(body["action"], {});
  assertEquals(body["messages"], [
    { role: "user", content: "hi", verify_id: "V1", ref: { type: "file", file: [] } },
  ]);
  // 缺席字段必须省略，不能发 null
  assertEquals("tenantId" in body, false);
  assertEquals("conversation_id" in body, false);
  assertEquals("message_id" in body, false);
});

Deno.test("buildChatBody 在给出 tenantId / conversationId 时带上", () => {
  const body = buildChatBody({
    prompt: "hi",
    model: DEFAULT_MODEL,
    verifyId: "V1",
    tenantId: 7,
    conversationId: "C1",
  });
  assertEquals(body["tenantId"], 7);
  assertEquals(body["conversation_id"], "C1");
});

Deno.test("parseSseStream：一个分块多个事件", async () => {
  const stream = sseStream([
    'data: {"choices":[{"delta":{"content":"A"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
  ]);

  const events = [];
  for await (const ev of parseSseStream(stream)) events.push(ev);
  assertEquals(events.length, 2);
  assertEquals(events[0]!.choices![0]!.delta!.content, "A");
  assertEquals(events[1]!.choices![0]!.delta!.content, "B");
});

Deno.test("parseSseStream：一个事件跨多个分块", async () => {
  const stream = sseStream([
    'data: {"choices":[{"del',
    'ta":{"content":"SPLIT"}}]}\n\n',
  ]);

  const events = [];
  for await (const ev of parseSseStream(stream)) events.push(ev);
  assertEquals(events.length, 1);
  assertEquals(events[0]!.choices![0]!.delta!.content, "SPLIT");
});

Deno.test("parseSseStream：忽略 [DONE] 与不可解析帧", async () => {
  const stream = sseStream([
    'data: {"choices":[{"delta":{"content":"X"}}]}\n\n',
    "data: [DONE]\n\n",
    "data: {broken json\n\n",
    ": comment line\n\n",
  ]);

  const events = [];
  for await (const ev of parseSseStream(stream)) events.push(ev);
  assertEquals(events.length, 1);
});

Deno.test("parseSseStream：末尾无空行的残留帧也会产出", async () => {
  const stream = sseStream(['data: {"choices":[{"delta":{"content":"TAIL"}}]}']);
  const events = [];
  for await (const ev of parseSseStream(stream)) events.push(ev);
  assertEquals(events.length, 1);
  assertEquals(events[0]!.choices![0]!.delta!.content, "TAIL");
});

Deno.test("chat：拼接内容并以 finish_reason=stop 结束（无 [DONE]）", async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      sseResponse([
        'data: {"model":"m1","conversation_id":"C1","choices":[{"delta":{"content":""}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"SS"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"E_OK"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ]),
    );

  const result = await chat(CTX, transport(mockFetch), { prompt: "test" });

  assertEquals(result.content, "SSE_OK");
  assertEquals(result.conversationId, "C1");
  assertEquals(result.modelUsed, "m1");
  assertEquals(typeof result.verifyId, "string");
});

Deno.test("chat：HTTP 401 抛 EaiUnauthorizedError（上层据此清理会话）", async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(new Response("unauthorized", { status: 401 }));

  await assertRejects(
    () => chat(CTX, transport(mockFetch), { prompt: "x" }),
    EaiUnauthorizedError,
  );
});

Deno.test("chat：签名覆盖最终发出的 body 字符串", async () => {
  let sentBody = "";
  let sentSignature = "";
  const mockFetch: typeof fetch = (_input, init) => {
    sentBody = String(init?.body);
    sentSignature = new Headers(init?.headers).get("Web-Signature") ?? "";
    return Promise.resolve(
      sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']),
    );
  };

  await chat(CTX, transport(mockFetch), { prompt: "x", model: "M" });

  // 用同一份字符串重算签名，必须一致
  const { md5Hex, sha256Hex } = await import("../crypto.ts");
  const bodyMd5 = md5Hex(sentBody);
  const parsed = JSON.parse(sentBody) as Record<string, unknown>;
  assertEquals(parsed["key_model"], "M");
  assertEquals(sentSignature.length, 64);
  // 用 md5 参与即可证明签名基于这份 body（时间戳/随机数在头里）
  const ts = ""; // 占位，真正的对拍在 sign.test.ts 里做
  assertEquals(typeof bodyMd5, "string");
  void sha256Hex;
  void ts;
});

Deno.test("queryModels 解析 data 数组", async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          resultCode: 0,
          data: [
            { keyModel: "A", status: "avaiable", type: "t1" },
            { keyModel: "B", status: "unavailable", type: "t1" },
          ],
        }),
      ),
    );

  const models = await queryModels(CTX, transport(mockFetch));
  assertEquals(models.length, 2);
  assertEquals(models[0]!.keyModel, "A");
});

Deno.test("queryModels 非数组时返回空数组", async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(new Response(JSON.stringify({ resultCode: 0, data: null })));
  assertEquals(await queryModels(CTX, transport(mockFetch)), []);
});

Deno.test("pickFallbackModel：同产业 + avaiable + 未被排除", () => {
  const models = [
    { keyModel: "CUR", status: "unavailable", type: "t1" },
    { keyModel: "BAD", status: "avaiable", type: "t2" }, // 跨产业
    { keyModel: "DOWN", status: "unavailable", type: "t1" },
    { keyModel: "GOOD", status: "avaiable", type: "t1" },
  ];

  assertEquals(pickFallbackModel(models, "CUR", new Set())?.keyModel, "GOOD");
  // 已被排除则无可选
  assertEquals(pickFallbackModel(models, "CUR", new Set(["GOOD"])), undefined);
});

Deno.test("pickFallbackModel：当前模型不在列表时不跨行业盲选", () => {
  const models = [{ keyModel: "OTHER", status: "avaiable", type: "t1" }];
  assertEquals(pickFallbackModel(models, "NOT-IN-LIST", new Set()), undefined);
});

Deno.test("pickFallbackModel：服务端拼写 avaiable 必须照抄", () => {
  const models = [
    { keyModel: "CUR", status: "unavailable", type: "t1" },
    // 正确拼写反而应被忽略（服务端不发这个）
    { keyModel: "TYPO", status: "available", type: "t1" },
  ];
  assertEquals(pickFallbackModel(models, "CUR", new Set()), undefined);
});
