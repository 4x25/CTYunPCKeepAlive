/**
 * 用户与租户初始化单测。
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  pickCurrentTenant,
  queryUserConfig,
  queryUserInfo,
  queryUserTenantInfo,
  type EaiTransport,
} from "./user.ts";
import type { SignatureContext } from "./sign.ts";

const CTX: SignatureContext = {
  sk: "SK",
  xuid: "pubweb_test",
  tenantIdStr: "7",
};

function transport(responder: (url: string) => unknown): EaiTransport {
  return {
    fetch: ((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      const r = responder(url);
      if (r instanceof Response) return Promise.resolve(r);
      return Promise.resolve(
        new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } }),
      );
    }) as typeof fetch,
    cookieHeader: () => "SESSION=abc",
  };
}

Deno.test("queryUserInfo 解出 data", async () => {
  const t = transport(() => ({ resultCode: 0, data: { userName: "张三", userId: 42 } }));
  const profile = await queryUserInfo(CTX, t);
  assertEquals(profile["userName"], "张三");
});

Deno.test("queryUserConfig 解出 currentTenantIdStr", async () => {
  const t = transport(() => ({ resultCode: 0, data: { currentTenantIdStr: "999" } }));
  const cfg = await queryUserConfig(CTX, t);
  assertEquals(cfg.currentTenantIdStr, "999");
});

Deno.test("queryUserTenantInfo 处理两层 data", async () => {
  const t = transport(() => ({
    resultCode: 0,
    data: { data: [{ tenantId: 1, tenantIdStr: "1" }, { tenantId: 2, tenantIdStr: "2" }] },
  }));
  const list = await queryUserTenantInfo(CTX, t);
  assertEquals(list.length, 2);
  assertEquals(list[0]!.tenantIdStr, "1");
});

Deno.test("queryUserTenantInfo 对非预期结构返回空数组（降级不抛错）", async () => {
  const t = transport(() => ({ resultCode: 0, data: null }));
  assertEquals(await queryUserTenantInfo(CTX, t), []);
});

Deno.test("resultCode 非 0 时抛错并带上服务端文案", async () => {
  const t = transport(() => ({ resultCode: 401, resultMsg: "会话已失效" }));
  await assertRejects(() => queryUserInfo(CTX, t), Error, "会话已失效");
});

Deno.test("HTTP 非 2xx 抛错", async () => {
  const t = transport(() => new Response("boom", { status: 500 }));
  await assertRejects(() => queryUserConfig(CTX, t), Error, "HTTP 500");
});

Deno.test("pickCurrentTenant：用宽松相等匹配 currentTenantIdStr", () => {
  const list = [
    { tenantId: 1, tenantIdStr: "111" },
    { tenantId: 2, tenantIdStr: "222" },
  ];
  assertEquals(pickCurrentTenant(list, "222")?.tenantId, 2);
  // 数字也能匹配字符串（宽松相等）
  assertEquals(pickCurrentTenant(list, "111")?.tenantId, 1);
});

Deno.test("pickCurrentTenant：匹配不到回退首项", () => {
  const list = [
    { tenantId: 1, tenantIdStr: "111" },
    { tenantId: 2, tenantIdStr: "222" },
  ];
  assertEquals(pickCurrentTenant(list, "NOT-EXIST")?.tenantId, 1);
  assertEquals(pickCurrentTenant(list)?.tenantId, 1);
});

Deno.test("pickCurrentTenant：空列表返回 null（不回退 IAM 的 tenantId）", () => {
  assertEquals(pickCurrentTenant([], "7"), null);
});

Deno.test("请求带上了签名头与 Cookie", async () => {
  let seenHeaders: Headers | undefined;
  const t: EaiTransport = {
    fetch: ((_input: string | URL | Request, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return Promise.resolve(new Response(JSON.stringify({ resultCode: 0, data: {} })));
    }) as typeof fetch,
    cookieHeader: () => "SESSION=xyz",
  };

  await queryUserInfo(CTX, t);

  assertEquals(seenHeaders?.get("Web-Signature")?.length, 64);
  assertEquals(seenHeaders?.get("x-eai-tenant-id"), "7");
  assertEquals(seenHeaders?.get("Cookie"), "SESSION=xyz");
  assertEquals(seenHeaders?.get("Content-Type"), null, "GET 不应带 Content-Type");
});
