/**
 * 用户信息查询单测。
 */
import { assertEquals, assertRejects } from "@std/assert";
import { queryUserConfig, queryUserInfo, queryUserTenantInfo } from "./user.ts";
import { CookieJar } from "../cookiejar.ts";

const CTX = { sk: "test-sk", userId: 123, tenantIdStr: "456" };
const COOKIES = new CookieJar();

function mockFetch(code: number, data: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ code, data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

Deno.test("queryUserInfo 成功返回用户信息", async () => {
  const fetchImpl = mockFetch(200, { userId: 123, userName: "test" });
  const result = await queryUserInfo(CTX, COOKIES, fetchImpl);
  assertEquals(result.userId, 123);
  assertEquals(result.userName, "test");
});

Deno.test("queryUserInfo code !== 200 抛错", async () => {
  const fetchImpl = mockFetch(400, null);
  await assertRejects(
    () => queryUserInfo(CTX, COOKIES, fetchImpl),
    Error,
    "code=400",
  );
});

Deno.test("queryUserConfig 成功返回配置", async () => {
  const fetchImpl = mockFetch(200, { enableAI: true });
  const result = await queryUserConfig(CTX, COOKIES, fetchImpl);
  assertEquals(result.enableAI, true);
});

Deno.test("queryUserTenantInfo 成功返回租户信息", async () => {
  const fetchImpl = mockFetch(200, { tenantId: "456", tenantName: "test-tenant" });
  const result = await queryUserTenantInfo(CTX, COOKIES, fetchImpl);
  assertEquals(result.tenantId, "456");
  assertEquals(result.tenantName, "test-tenant");
});

Deno.test("HTTP 非 2xx 抛错", async () => {
  const fetchImpl = () =>
    Promise.resolve(new Response("Server error", { status: 500 }));
  await assertRejects(
    () => queryUserInfo(CTX, COOKIES, fetchImpl),
    Error,
    "HTTP 500",
  );
});
