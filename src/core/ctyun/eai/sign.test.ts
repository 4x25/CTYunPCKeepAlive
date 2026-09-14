/**
 * 签名算法单测。
 */
import { assertEquals } from "@std/assert";
import { signRequest } from "./sign.ts";
import { md5Hex, sha256Hex } from "../crypto.ts";

Deno.test("signRequest 生成正确的头和签名", () => {
  const payload = { message: "test" };
  const ctx = { sk: "test-sk", userId: 123, tenantIdStr: "456" };

  const req = signRequest("/eai/test", payload, ctx);

  assertEquals(req.url, "https://eaichat.ctyun.cn/eai/test");
  assertEquals(req.method, "POST");
  assertEquals(req.headers["Content-Type"], "application/json");
  assertEquals(req.headers["User-Id"], "123");
  assertEquals(req.headers["Tenant-Id"], "456");
  assertEquals(req.headers["Origin"], "https://desk.ctyun.cn");
  assertEquals(req.headers["Referer"], "https://desk.ctyun.cn/");

  // 验证签名格式
  const sig = req.headers["Web-Signature"]!;
  assertEquals(typeof sig, "string");
  assertEquals(sig.length, 64); // SHA256 hex
  assertEquals(/^[0-9a-f]{64}$/.test(sig), true);

  // 验证时间戳
  const ts = Number(req.headers["Web-Timestamp"]);
  assertEquals(ts > Date.now() - 1000 && ts <= Date.now(), true);

  // 验证随机数
  const rand = req.headers["Web-Random"]!;
  assertEquals(/^\d{6}$/.test(rand), true);
});

Deno.test("签名基于最终 JSON 字符串的 MD5", () => {
  const payload = { a: 1, b: 2 };
  const ctx = { sk: "sk", userId: 1, tenantIdStr: "1" };

  const req = signRequest("/test", payload, ctx);
  const body = req.body;
  const bodyMd5 = md5Hex(body);
  const ts = req.headers["Web-Timestamp"];
  const rand = req.headers["Web-Random"];

  const expected = sha256Hex(bodyMd5 + "sk" + ts + rand);
  assertEquals(req.headers["Web-Signature"], expected);
});

Deno.test("不同 payload 产生不同签名", () => {
  const ctx = { sk: "sk", userId: 1, tenantIdStr: "1" };

  const req1 = signRequest("/test", { a: 1 }, ctx);
  const req2 = signRequest("/test", { a: 2 }, ctx);

  assertEquals(req1.headers["Web-Signature"] !== req2.headers["Web-Signature"], true);
});
