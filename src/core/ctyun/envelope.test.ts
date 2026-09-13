/**
 * 请求层单测：CTG 头、签名、AES 报文封装。
 *
 * 全部用 mock fetch，不触网。
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { aesCbcDecrypt, aesCbcEncrypt } from "./crypto.ts";
import { CtyunApiError, CtyunClient, signature } from "./envelope.ts";
import { createDeviceContext } from "./device.ts";

const EVALUE = new TextEncoder().encode("0123456789abcdef");
const KEY = { eid: "EID-1", evalue: EVALUE };

function setup(handler: (req: Request, body: string) => Response) {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    calls.push({ url, headers, body });
    return Promise.resolve(handler(new Request("https://x/", { headers }), body));
  };
  const client = new CtyunClient(createDeviceContext({ deviceCode: "web_test" }), fetchImpl);
  client.setNegotiatedKey(KEY);
  return { client, calls };
}

function edata(payload: unknown): Response {
  return new Response(JSON.stringify({ edata: aesCbcEncrypt(EVALUE, JSON.stringify(payload)) }));
}

Deno.test("signature 是七字段直接拼接的大写 MD5", () => {
  const sig = signature({
    deviceType: "60",
    requestId: "1000",
    tenantId: "7",
    timestamp: "2000",
    userId: "42",
    version: "204000100",
    secretKey: "SK",
  });
  // 等价于 MD5("60" + "1000" + "7" + "2000" + "42" + "204000100" + "SK")
  assertEquals(
    sig,
    signature({
      deviceType: "6010007",
      requestId: "2000",
      tenantId: "42",
      timestamp: "204000100",
      userId: "S",
      version: "K",
      secretKey: "",
    }),
    "无分隔符拼接，因此等长重切应产生同一签名",
  );
  assert(/^[0-9A-F]{32}$/.test(sig), "必须是 32 位大写十六进制");
});

Deno.test("登录前请求不带 USERID / TENANTID / SIGNATURESTR", async () => {
  const { client, calls } = setup(() => edata({ code: 0, data: { ok: 1 } }));
  await client.request({ path: "/p", body: {} });

  const h = calls[0]!.headers;
  assertEquals(h.get("CTG-NEGO-EKEYID"), "EID-1");
  assertEquals(h.get("CTG-DEVICETYPE"), "60");
  assertEquals(h.get("CTG-VERSION"), "204000100");
  assertEquals(h.get("CTG-REQDATA-ETYPE"), "2");
  assertEquals(h.get("CTG-SOFTWARECODE"), "web_client");
  assertEquals(h.get("CTG-USERID"), null);
  assertEquals(h.get("CTG-TENANTID"), null);
  assertEquals(h.get("CTG-SIGNATURESTR"), null);
});

Deno.test("登录态请求的签名与实际发出的 requestId/timestamp 完全一致", async () => {
  const { client, calls } = setup(() => edata({ code: 0, data: true }));
  const auth = { userId: 42, tenantId: 7, secretKey: "SK", offsetTime: 0 };
  await client.request({ path: "/p", encoding: "none", auth });

  const h = calls[0]!.headers;
  const expected = signature({
    deviceType: "60",
    requestId: h.get("CTG-REQUESTID")!,
    tenantId: "7",
    timestamp: h.get("CTG-TIMESTAMP")!,
    userId: "42",
    version: "204000100",
    secretKey: "SK",
  });
  assertEquals(h.get("CTG-SIGNATURESTR"), expected);
});

Deno.test("offsetTime 参与 CTG-TIMESTAMP 校正", async () => {
  const { client, calls } = setup(() => edata({ code: 0, data: true }));
  const offset = 5_000;
  const before = Date.now();
  await client.request({
    path: "/p",
    encoding: "none",
    auth: { userId: 1, tenantId: 1, secretKey: "K", offsetTime: offset },
  });
  const ts = Number(calls[0]!.headers.get("CTG-TIMESTAMP"));
  assert(ts <= before - offset + 50 && ts >= before - offset - 50, `时间戳未按偏移校正：${ts}`);
});

Deno.test('json 编码走 {"data":…}，form 编码走 eParams', async () => {
  const payload = { getCnt: 20, desktopTypes: ["1"] };

  const j = setup(() => edata({ code: 0, data: {} }));
  await j.client.request({ path: "/p", encoding: "json", body: payload });
  assertEquals(j.calls[0]!.headers.get("Content-Type"), "application/json");
  const jBody = JSON.parse(j.calls[0]!.body) as { data: string };
  assertEquals(JSON.parse(aesCbcDecrypt(EVALUE, jBody.data)), payload);

  const f = setup(() => edata({ code: 0, data: {} }));
  await f.client.request({ path: "/p", encoding: "form", body: payload });
  assertEquals(
    f.calls[0]!.headers.get("Content-Type"),
    "application/x-www-form-urlencoded",
  );
  assert(f.calls[0]!.body.startsWith("eParams="));
  const enc = decodeURIComponent(f.calls[0]!.body.slice("eParams=".length));
  assertEquals(JSON.parse(aesCbcDecrypt(EVALUE, enc)), payload);
});

Deno.test("GET 查询参数加密为唯一的 eUrlParams", async () => {
  const { client, calls } = setup(() => edata({ code: 0, data: {} }));
  await client.request({
    path: "/p",
    method: "GET",
    encoding: "none",
    query: { pageNum: "1", pageSize: "10" },
  });
  const url = new URL(calls[0]!.url);
  assertEquals([...url.searchParams.keys()], ["eUrlParams"]);
  assertEquals(aesCbcDecrypt(EVALUE, url.searchParams.get("eUrlParams")!), "pageNum=1&pageSize=10");
});

Deno.test("HTTP 200 但 code !== 0 必须抛错", async () => {
  const { client } = setup(() => edata({ code: 51010, msg: "账号或密码不正确" }));
  const err = await assertRejects(
    () => client.request({ path: "/api/auth/client/login", body: {} }),
    CtyunApiError,
  );
  assertEquals(err.code, 51010);
  assertEquals(err.message, "账号或密码不正确");
  assertEquals(err.path, "/api/auth/client/login");
});

Deno.test("非 2xx 抛错而不是尝试解密", async () => {
  const { client } = setup(() => new Response("oops", { status: 502 }));
  await assertRejects(() => client.request({ path: "/p", body: {} }), CtyunApiError, "HTTP 502");
});

Deno.test("未协商密钥时拒绝发起加密请求", async () => {
  const client = new CtyunClient(createDeviceContext(), () => {
    throw new Error("不应发出请求");
  });
  await assertRejects(() => client.request({ path: "/p", body: {} }), Error, "尚未完成密钥协商");
});

Deno.test("requestId 单调递增且不重复", () => {
  const { client } = setup(() => edata({ code: 0 }));
  const ids = new Set(Array.from({ length: 50 }, () => client.nextRequestId()));
  assertEquals(ids.size, 50);
});
