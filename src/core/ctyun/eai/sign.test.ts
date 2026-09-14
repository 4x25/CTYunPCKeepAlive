/**
 * 云智助手请求签名单测。
 *
 * 公式必须逐条对拍，任何一处不符都会导致线上验签失败且难以排查。
 */
import { assertEquals } from "@std/assert";
import crypto from "node:crypto";
import {
  buildQueryString,
  computeSignature,
  newTraceId,
  newXuid,
  randomAlnum,
  signRequest,
} from "./sign.ts";
import { md5Hex, sha256Hex } from "../crypto.ts";

const CTX = {
  sk: "SESSION-SIGNING-KEY",
  xuid: "pubweb_00000000-0000-4000-8000-000000000000",
  tenantIdStr: "123456",
  userAgent: "Mozilla/5.0 (Test)",
};

Deno.test("buildQueryString 排序、剔除空值、不编码", () => {
  assertEquals(
    buildQueryString({ b: 2, a: "1", c: null, d: undefined }),
    "a=1&b=2",
  );
  // 不 URL 编码：冒号、斜杠、中文都原样保留
  assertEquals(
    buildQueryString({ u: "https://x/y:z", q: "中文" }),
    "q=中文&u=https://x/y:z",
  );
});

Deno.test("computeSignature 严格等于文档公式", () => {
  const ts = "1700000000000";
  const rand = "Ab3xY9zQ";
  const bodyMd5 = md5Hex('{"a":1}');

  const expected = sha256Hex(
    `${bodyMd5}&${CTX.sk}&${ts}&${rand}`,
  );
  assertEquals(
    computeSignature({ queryString: "", bodyMd5, sk: CTX.sk, timestamp: ts, random: rand }),
    expected,
  );

  // 无 query、无 body 时只剩三截
  assertEquals(
    computeSignature({ queryString: "", sk: CTX.sk, timestamp: ts, random: rand }),
    sha256Hex(`${CTX.sk}&${ts}&${rand}`),
  );

  // 有 query 时排在最前，顺序为 query & bodyMd5 & sk & ts & rand
  assertEquals(
    computeSignature({ queryString: "a=1", bodyMd5, sk: CTX.sk, timestamp: ts, random: rand }),
    sha256Hex(`a=1&${bodyMd5}&${CTX.sk}&${ts}&${rand}`),
  );
});

Deno.test("GET 请求：签名基于查询串，无 bodyMd5", () => {
  const req = signRequest(CTX, {
    path: "/ai/portal/v1/user/queryUserInfo",
    method: "GET",
    query: { b: 2, a: 1 },
  });

  assertEquals(req.url, "https://eaichat.ctyun.cn/ai/portal/v1/user/queryUserInfo?a=1&b=2");
  assertEquals(req.body, undefined);
  assertEquals(req.headers["Content-Type"], undefined);

  const expected = sha256Hex(
    `a=1&b=2&${CTX.sk}&${req.headers["Web-Timestamp"]}&${req.headers["Web-Random"]}`,
  );
  assertEquals(req.headers["Web-Signature"], expected);
});

Deno.test("POST 请求：签名基于最终 body 字符串", () => {
  const payload = { key_model: "TEXT_DEEPSEEK_V4", stream: true, tools: [], action: {} };
  const req = signRequest(CTX, {
    path: "/ai/portal/wenc/v3/openai/chat/completions",
    method: "POST",
    body: payload,
  });

  // body 就是签名时用的那份字符串
  const expected = sha256Hex(
    `${md5Hex(req.body!)}&${CTX.sk}&${req.headers["Web-Timestamp"]}&${req.headers["Web-Random"]}`,
  );
  assertEquals(req.headers["Web-Signature"], expected);
  assertEquals(req.headers["Content-Type"], "application/json");
  assertEquals(JSON.parse(req.body!), payload);
});

Deno.test("传字符串 body 时签名对象与发送内容逐字节一致", () => {
  // 手工构造一个字段顺序敏感的 body
  const raw = '{"b":2,"a":1}';
  const req = signRequest(CTX, { path: "/x", method: "POST", body: raw });
  assertEquals(req.body, raw, "body 必须原样保留，不得重新序列化");
});

Deno.test("签名对 body 字段顺序敏感（顺序变化即验签失败）", () => {
  const ts1 = signRequest(CTX, { path: "/x", method: "POST", body: '{"a":1,"b":2}' });
  const ts2 = signRequest(CTX, { path: "/x", method: "POST", body: '{"b":2,"a":1}' });
  // 两次时间戳不同，所以只能比较 bodyMd5 的差异
  assertEquals(md5Hex(ts1.body!) === md5Hex(ts2.body!), false);
});

Deno.test("必带的云智助手请求头", () => {
  const req = signRequest(CTX, { path: "/x", method: "GET" });
  assertEquals(req.headers["x-eai-env"], "pubWeb");
  assertEquals(req.headers["x-eai-version"], "202060305");
  assertEquals(req.headers["x-eai-source"], "web-eai");
  assertEquals(req.headers["x-eai-tenant-id"], "123456");
  assertEquals(req.headers["x-eai-mode"], "eai");
  assertEquals(req.headers["YL-Main-Version"], "202060305");
  assertEquals(req.headers["YL-Product-Id"], "5");
  assertEquals(req.headers["x-eai-env-code"], "", "公有环境为空串");
  assertEquals(req.headers["x-user-agent"], "Mozilla/5.0 (Test)");
  assertEquals(/^[0-9a-f-]{36}$/.test(req.headers["x-client-trace-id"]!), true);
});

Deno.test("Web-Random 是 8 位字母数字", () => {
  for (let i = 0; i < 20; i++) {
    assertEquals(/^[A-Za-z0-9]{8}$/.test(randomAlnum()), true);
  }
});

Deno.test("newXuid / newTraceId 格式", () => {
  assertEquals(newXuid().startsWith("pubweb_"), true);
  assertEquals(/^[0-9a-f-]{36}$/.test(newTraceId()), true);
});

Deno.test("已带查询串的 URL 用 & 连接", () => {
  const req = signRequest(CTX, {
    url: "https://eaichat.ctyun.cn/x?existing=1",
    method: "GET",
    query: { a: 1 },
  });
  assertEquals(req.url, "https://eaichat.ctyun.cn/x?existing=1&a=1");
});

Deno.test("签名字符串长度固定 64 位小写十六进制", () => {
  const req = signRequest(CTX, { path: "/x", method: "GET" });
  assertEquals(/^[0-9a-f]{64}$/.test(req.headers["Web-Signature"]!), true);
  // 顺带确认 Node 的 MD5 输出可直接用于 bodyMd5
  assertEquals(md5Hex("").length, 32);
});
