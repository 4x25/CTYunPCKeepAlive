/**
 * CookieJar 单测。
 *
 * 域名/路径匹配是 `ticketAuthorize` 能否拿到 IAM 会话的前提，
 * 匹配错了整条云智助手链都跑不通，所以这里覆盖得细一些。
 */
import { assert, assertEquals } from "@std/assert";
import { CookieJar, createCookieFetch, parseSetCookie } from "./cookiejar.ts";

function headersWith(...setCookies: string[]): Headers {
  const h = new Headers();
  for (const c of setCookies) h.append("set-cookie", c);
  return h;
}

Deno.test("解析基本 Set-Cookie", () => {
  const c = parseSetCookie("token=abc123; Path=/; HttpOnly; Secure", "desk.ctyun.cn");
  assertEquals(c?.name, "token");
  assertEquals(c?.value, "abc123");
  assertEquals(c?.path, "/");
  assertEquals(c?.httpOnly, true);
  assertEquals(c?.secure, true);
  assertEquals(c?.hostOnly, true, "未指定 Domain 即 host-only");
});

Deno.test("解析 Domain 属性并去除前导点", () => {
  const c = parseSetCookie("sid=x; Domain=.ctyun.cn; Path=/", "desk.ctyun.cn");
  assertEquals(c?.domain, "ctyun.cn");
  assertEquals(c?.hostOnly, false);
});

Deno.test("None 的 Max-Age=0 立即过期", () => {
  const c = parseSetCookie("gone=1; Max-Age=0", "a.com");
  assert(c!.expires! <= Date.now() + 5);
});

Deno.test("带逗号的 Expires 不会被误拆", () => {
  // 这正是不能用 headers.get('set-cookie') 的原因
  const c = parseSetCookie(
    "sid=xyz; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
    "eaichat.ctyun.cn",
  );
  assertEquals(c?.value, "xyz");
  assertEquals(c?.expires, Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"));
});

Deno.test("非法 Set-Cookie 返回 undefined", () => {
  assertEquals(parseSetCookie("novalue", "a.com"), undefined);
  assertEquals(parseSetCookie("", "a.com"), undefined);
});

Deno.test("host-only Cookie 只发给完全相同的主机", () => {
  const jar = new CookieJar();
  jar.storeFromResponse("https://desk.ctyun.cn/x", headersWith("a=1; Path=/"));

  assertEquals(jar.headerFor("https://desk.ctyun.cn/y"), "a=1");
  assertEquals(jar.headerFor("https://sub.desk.ctyun.cn/y"), "");
  assertEquals(jar.headerFor("https://eaichat.ctyun.cn/y"), "");
});

Deno.test("Domain Cookie 发给子域", () => {
  const jar = new CookieJar();
  jar.storeFromResponse("https://desk.ctyun.cn/x", headersWith("a=1; Domain=ctyun.cn; Path=/"));

  assertEquals(jar.headerFor("https://desk.ctyun.cn/y"), "a=1");
  assertEquals(jar.headerFor("https://eaichat.ctyun.cn/y"), "a=1", "IAM 的域 Cookie 应带到 eaichat");
  assertEquals(jar.headerFor("https://evil-ctyun.cn/y"), "", "后缀匹配不能跨域边界");
});

Deno.test("路径匹配遵循 RFC 6265 边界", () => {
  const jar = new CookieJar();
  jar.storeFromResponse("https://a.com/selforder/api", headersWith("p=1; Path=/selforder"));

  assertEquals(jar.headerFor("https://a.com/selforder"), "p=1");
  assertEquals(jar.headerFor("https://a.com/selforder/x"), "p=1");
  assertEquals(jar.headerFor("https://a.com/selforderX"), "", "同前缀但非路径边界不应匹配");
  assertEquals(jar.headerFor("https://a.com/other"), "");
});

Deno.test("Secure Cookie 不发给 http", () => {
  const jar = new CookieJar();
  jar.storeFromResponse("https://a.com/x", headersWith("s=1; Secure; Path=/"));

  assertEquals(jar.headerFor("https://a.com/y"), "s=1");
  assertEquals(jar.headerFor("http://a.com/y"), "");
});

Deno.test("过期 Cookie 不再发送，且被 snapshot 过滤", () => {
  const jar = new CookieJar();
  jar.storeFromResponse("https://a.com/x", headersWith("old=1; Max-Age=0; Path=/"));
  assertEquals(jar.headerFor("https://a.com/y"), "");
  assertEquals(jar.snapshot().length, 0);
});

Deno.test("同名 Cookie 按 domain/path 分别存储，互不覆盖", () => {
  const jar = new CookieJar();
  jar.storeFromResponse("https://a.com/x", headersWith("k=root; Path=/"));
  jar.storeFromResponse("https://a.com/x", headersWith("k=sub; Path=/api"));

  assertEquals(jar.headerFor("https://a.com/index"), "k=root");
  assertEquals(jar.headerFor("https://a.com/api/v1"), "k=root; k=sub");
});

Deno.test("多个 Set-Cookie 全部解析", () => {
  const jar = new CookieJar();
  jar.storeFromResponse(
    "https://a.com/x",
    headersWith("a=1; Path=/", "b=2; Path=/", "c=3; Path=/"),
  );
  assertEquals(jar.snapshot().length, 3);
  assertEquals(jar.headerFor("https://a.com/"), "a=1; b=2; c=3");
});

Deno.test("createCookieFetch 自动带 Cookie 并回收 Set-Cookie", async () => {
  const jar = new CookieJar();
  const seen: (string | null)[] = [];

  const mockFetch: typeof fetch = (_input, init) => {
    seen.push(new Headers(init?.headers).get("Cookie"));
    const h = new Headers();
    h.append("set-cookie", "sid=abc; Domain=ctyun.cn; Path=/");
    return Promise.resolve(new Response("ok", { headers: h }));
  };

  const f = createCookieFetch(jar, mockFetch);
  await f("https://desk.ctyun.cn/iam/login");
  await f("https://eaichat.ctyun.cn/sso/login/v2/iam/ticketAuthorize");

  assertEquals(seen[0], null, "首次请求无 Cookie");
  assertEquals(
    seen[1],
    "sid=abc",
    "IAM 写入的 Cookie 必须带到 eaichat —— ticketAuthorize 依赖它",
  );
});

Deno.test("clear 清空全部 Cookie", () => {
  const jar = new CookieJar();
  jar.storeFromResponse("https://a.com/x", headersWith("a=1; Path=/"));
  jar.clear();
  assertEquals(jar.headerFor("https://a.com/y"), "");
});
