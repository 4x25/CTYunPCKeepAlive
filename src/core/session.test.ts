/**
 * 云智助手会话管理单测。
 */
import { assertEquals, assertRejects } from "@std/assert";
import crypto from "node:crypto";
import { EaiSessionManager } from "./session.ts";
import { CookieJar } from "./ctyun/cookiejar.ts";
import { Logger } from "./logger.ts";

const log = new Logger({ verbose: false });

const TEST_KEYPAIR = crypto.generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** 固定 key 加密，用于伪造 `eaiSysInfo` 的 `data`。 */
function encryptSysInfo(obj: unknown): string {
  const key = Buffer.from("chinatelecom@cnn", "utf8");
  const c = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]).toString("base64");
}

/** 模拟完整云智助手链的 fetch。 */
function makeFetch(opts: { loginFails?: boolean; tenantList?: unknown[] } = {}) {
  let loginCalls = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.includes("eaiSysInfo")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            resultCode: "0",
            data: encryptSysInfo({
              sso: { ssopk: TEST_KEYPAIR.publicKey, ssopkid: "KID" },
            }),
          }),
        ),
      );
    }

    if (url.includes("/iam/login")) {
      loginCalls++;
      if (opts.loginFails) {
        return Promise.resolve(new Response(JSON.stringify({ code: 51010, msg: "密码错误" })));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            data: { returnUrl: null, userId: 42, tenantId: 7 },
          }),
        ),
      );
    }

    if (url.includes("/cas/login")) {
      const h = new Headers();
      h.set("location", "https://eaichat.ctyun.cn/chat/?ticket=T");
      return Promise.resolve(new Response("", { status: 302, headers: h }));
    }

    if (url.includes("/ticketAuthorize")) {
      const form = new URLSearchParams(String(init?.body));
      const clientKeyBytes = crypto.privateDecrypt(
        {
          key: TEST_KEYPAIR.privateKey as string,
          padding: crypto.constants.RSA_PKCS1_PADDING,
        },
        Buffer.from(form.get("clientKey") ?? "", "hex"),
      );
      const cipher = crypto.createCipheriv("aes-128-ecb", clientKeyBytes, null);
      const sessionKey = Buffer.concat([
        cipher.update("SK-1", "utf8"),
        cipher.final(),
      ]).toString("base64");
      return Promise.resolve(
        new Response(JSON.stringify({ resultCode: 0, data: { sessionKey } })),
      );
    }

    if (url.includes("/queryUserTenantInfo")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            resultCode: 0,
            data: { data: opts.tenantList ?? [{ tenantId: 7, tenantIdStr: "7" }] },
          }),
        ),
      );
    }

    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  return { fetchImpl, loginCalls: () => loginCalls };
}

function makeManager(fetchImpl: typeof fetch) {
  return new EaiSessionManager(
    {
      account: "user@example.com",
      password: "pw",
      cookieJar: new CookieJar(),
      deviceCode: "iam:fixed",
    xuid: "pubweb_test",
      baseFetch: fetchImpl,
    },
    log,
  );
}

Deno.test("首次 getSession 建立会话", async () => {
  const { fetchImpl } = makeFetch();
  const session = await makeManager(fetchImpl).getSession();

  assertEquals(session.sk, "SK-1");
  assertEquals(session.userId, "42");
  assertEquals(session.tenantIdStr, "7");
});

Deno.test("缓存有效期内复用会话，不重复登录", async () => {
  const { fetchImpl, loginCalls } = makeFetch();
  const manager = makeManager(fetchImpl);

  await manager.getSession();
  await manager.getSession();
  await manager.getSession();

  assertEquals(loginCalls(), 1, "登录只应发生一次");
});

Deno.test("isFresh 反映缓存状态", async () => {
  const { fetchImpl } = makeFetch();
  const manager = makeManager(fetchImpl);

  assertEquals(manager.isFresh, false, "初始无缓存");
  await manager.getSession();
  assertEquals(manager.isFresh, true);
  manager.clear();
  assertEquals(manager.isFresh, false);
});

Deno.test("clear 后重新建立会话", async () => {
  const { fetchImpl, loginCalls } = makeFetch();
  const manager = makeManager(fetchImpl);

  await manager.getSession();
  manager.clear();
  await manager.getSession();

  assertEquals(loginCalls(), 2);
});

Deno.test("登录失败时抛出异常", async () => {
  const { fetchImpl } = makeFetch({ loginFails: true });
  await assertRejects(() => makeManager(fetchImpl).getSession(), Error, "密码错误");
});

Deno.test("重登次数超限后拒绝再试（3 次/小时）", async () => {
  const { fetchImpl } = makeFetch({ loginFails: true });
  const manager = makeManager(fetchImpl);

  // 前 3 次是真实失败
  for (let i = 0; i < 3; i++) {
    await assertRejects(() => manager.getSession());
  }
  // 第 4 次直接被限流拦下
  await assertRejects(() => manager.getSession(), Error, "重登次数超限");
});

Deno.test("租户列表为空时抛错", async () => {
  const { fetchImpl } = makeFetch({ tenantList: [] });
  await assertRejects(() => makeManager(fetchImpl).getSession(), Error, "没有可用租户");
});
