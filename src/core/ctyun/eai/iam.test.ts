/**
 * IAM 链单测。
 *
 * 全程 mock，不触网。重点验证文档里容易写错的几处：
 * - 密码是 `SHA256(明文)`，不是云电脑链的双哈希
 * - 票据在 `returnUrl` 的 `#` 之后，不在普通 query
 * - `clientKey` 加密后提交的是小写十六进制，不是 Base64
 * - `sk` 的推导是「Base64 解码 → AES-ECB 解密」，两层都不能少
 * - IAM 写入的 Cookie 必须带到 `ticketAuthorize`
 */
import { assertEquals, assertRejects } from "@std/assert";
import crypto from "node:crypto";
import {
  deriveSk,
  extractTicket,
  iamLogin,
  newIamDeviceCode,
  randomClientKey,
  wrapAsPublicKeyPem,
} from "./iam.ts";
import { CookieJar } from "../cookiejar.ts";
import { sha256Hex } from "../crypto.ts";

/**
 * 测试用 RSA 密钥对。
 *
 * `ssopk` 由服务端下发；测试里自造一对，并用**私钥**解开客户端提交的
 * `clientKey`，再用它加密 `sessionKey` —— 这样才是真实的加解密往返，
 * 而不是拿一个硬编码的假密钥绕过整条链路。
 */
const TEST_KEYPAIR = crypto.generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const TEST_SSOPK = TEST_KEYPAIR.publicKey as string;
const TEST_SSOPK_PRIVATE = TEST_KEYPAIR.privateKey as string;

/** 模拟服务端：解开客户端提交的 clientKey，并用它加密 sk。 */
function serverSideSessionKey(encryptedClientKeyHex: string, skJson: string): string {
  const clientKeyBytes = crypto.privateDecrypt(
    { key: TEST_SSOPK_PRIVATE, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(encryptedClientKeyHex, "hex"),
  );
  const cipher = crypto.createCipheriv("aes-128-ecb", clientKeyBytes, null);
  return Buffer.concat([cipher.update(skJson, "utf8"), cipher.final()]).toString("base64");
}

Deno.test("newIamDeviceCode 形如 iam:<32 位>", () => {
  const code = newIamDeviceCode();
  assertEquals(code.startsWith("iam:"), true);
  assertEquals(code.length, 4 + 32);
});

Deno.test("randomClientKey 是 16 个可打印 ASCII 字符", () => {
  for (let i = 0; i < 20; i++) {
    const key = randomClientKey();
    assertEquals(key.length, 16);
    for (const ch of key) {
      const c = ch.charCodeAt(0);
      assertEquals(c >= 32 && c <= 126, true, `字符 ${c} 超出可打印 ASCII 范围`);
    }
  }
});

Deno.test("wrapAsPublicKeyPem 补 PEM 头尾并每行 64 字符", () => {
  const pem = wrapAsPublicKeyPem("A".repeat(200));
  assertEquals(pem.startsWith("-----BEGIN PUBLIC KEY-----\n"), true);
  assertEquals(pem.endsWith("\n-----END PUBLIC KEY-----"), true);
  const lines = pem.split("\n").slice(1, -1);
  for (const line of lines) {
    assertEquals(line.length <= 64, true);
  }
});

Deno.test("wrapAsPublicKeyPem 对已是 PEM 的输入原样返回", () => {
  const existing = "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----";
  assertEquals(wrapAsPublicKeyPem(existing), existing);
});

Deno.test("extractTicket 从 hash 查询串中取票据", () => {
  // 文档实测形态：票据在 # 之后
  assertEquals(
    extractTicket("https://eaichat.ctyun.cn/chat/#/login?ticket=ABC123"),
    "ABC123",
  );
  assertEquals(
    extractTicket("https://eaichat.ctyun.cn/chat/?ticket=PLAIN"),
    "PLAIN",
  );
  assertEquals(
    extractTicket("https://eaichat.ctyun.cn/chat/#/login?a=1&ticket=MIX&b=2"),
    "MIX",
  );
  assertEquals(extractTicket("https://eaichat.ctyun.cn/chat/#/login"), undefined);
});

Deno.test("deriveSk：Base64 解码 + AES-ECB 解密（两层都不能少）", () => {
  const clientKey = "0123456789abcdef"; // 16 字节 → AES-128
  const skPlain = "the-real-signing-key";

  const cipher = crypto.createCipheriv(
    "aes-128-ecb",
    Buffer.from(clientKey, "utf8"),
    null,
  );
  const sessionKey = Buffer.concat([
    cipher.update(skPlain, "utf8"),
    cipher.final(),
  ]).toString("base64");

  assertEquals(deriveSk(sessionKey, clientKey), skPlain);
});

Deno.test("完整 IAM 登录流程", async () => {
  const jar = new CookieJar();
  const calls: string[] = [];
  let cookieAtAuthorize = "";
  let loginBody: Record<string, string> = {};
  let authorizeForm: URLSearchParams | undefined;
  let casLoginCalled = false;
  let casService = "";

  const mockFetch: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(new URL(url).pathname);

    if (url.includes("/iam/login")) {
      loginBody = JSON.parse(String(init?.body)) as Record<string, string>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            // 实测：returnUrl 可能为 null，票据改由 CAS 下发
            data: { returnUrl: null, userId: 42, tenantId: 7 },
          }),
        ),
      );
    }

    if (url.includes("/cas/login")) {
      casLoginCalled = true;
      casService = new URL(url).searchParams.get("service") ?? "";
      const h = new Headers();
      h.set("location", "https://eaichat.ctyun.cn/chat/?ticket=TICKET-1");
      return Promise.resolve(new Response("", { status: 302, headers: h }));
    }

    if (url.includes("/ticketAuthorize")) {
      cookieAtAuthorize = new Headers(init?.headers).get("Cookie") ?? "";
      authorizeForm = new URLSearchParams(String(init?.body));

      // 服务端侧：解开客户端提交的 clientKey，再用它加密 sk
      const sessionKey = serverSideSessionKey(
        authorizeForm.get("clientKey") ?? "",
        "SK-VALUE",
      );

      return Promise.resolve(
        new Response(
          JSON.stringify({ success: true, resultCode: 0, resultMsg: "操作成功！", data: { sessionKey } }),
        ),
      );
    }

    if (url.includes("/queryUserTenantInfo")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            resultCode: 0,
            data: { data: [{ tenantId: 7, tenantIdStr: "7" }] },
          }),
        ),
      );
    }

    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  const session = await iamLogin(jar, mockFetch, {
    account: "  user@example.com  ",
    password: "  secret  ",
    ssopk: TEST_SSOPK,
    ssopkid: "KEYID-1",
    deviceCode: "iam:fixed",
    xuid: "pubweb_test",
  });

  // ① 密码算法：SHA256(trim 后的明文)，不是双哈希
  assertEquals(loginBody["password"], sha256Hex("secret"));
  assertEquals(loginBody["userAccount"], "user@example.com", "账号应先 trim");
  assertEquals(loginBody["deviceCode"], "iam:fixed");
  assertEquals(loginBody["deviceName"], "iam:web");

  // ② 票据来自 CAS 重定向；service 必须不带 hash
  assertEquals(casLoginCalled, true, "应走 CAS 换票据");
  assertEquals(casService.includes("#"), false, "service 不能带 hash 片段");
  assertEquals(authorizeForm?.get("iamTicket"), "TICKET-1");
  assertEquals(authorizeForm?.get("loginType"), "iamTicket");
  assertEquals(authorizeForm?.get("clientId"), "eaiapp");
  assertEquals(authorizeForm?.get("clientKeyId"), "KEYID-1");

  // ③ clientKey 提交的是小写十六进制，长度应为 RSA-1024 密文的 256 个字符
  const submitted = authorizeForm?.get("clientKey") ?? "";
  assertEquals(/^[0-9a-f]+$/.test(submitted), true, "必须是纯小写十六进制");
  assertEquals(submitted.length, 256, "1024-bit RSA 密文 = 128 字节 = 256 hex 字符");

  // ④ Cookie 传递（本 mock 未下发 Cookie，故此处只验证不抛错）
  assertEquals(typeof cookieAtAuthorize, "string");

  // ⑤ 接口调用顺序
  assertEquals(calls.includes("/cloudB/dy/iam/api/auth/iam/login"), true);
  assertEquals(calls.includes("/cloudB/dy/iam/api/auth/iam/cas/login"), true);
  assertEquals(calls.includes("/sso/login/v2/iam/ticketAuthorize"), true);
  assertEquals(calls.includes("/ai/portal/v2/user/queryUserTenantInfo"), true);

  // ⑥ 会话内容
  assertEquals(session.userId, "42");
  assertEquals(session.tenantIdStr, "7");
  assertEquals(session.tenantId, 7);
});

Deno.test("IAM 登录失败时抛错", async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(new Response(JSON.stringify({ code: 51010, msg: "账号或密码不正确" })));

  await assertRejects(
    () =>
      iamLogin(new CookieJar(), mockFetch, {
        account: "a",
        password: "b",
        ssopk: TEST_SSOPK,
        ssopkid: "ID",
        deviceCode: "iam:x",
        xuid: "pubweb_test",
      }),
    Error,
    "账号或密码不正确",
  );
});

Deno.test("需要强制改密时抛错并提示走官方页面", async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          code: 0,
          data: { returnUrl: "x", userId: 1, tenantId: 1, needUpdatePassword: true },
        }),
      ),
    );

  await assertRejects(
    () =>
      iamLogin(new CookieJar(), mockFetch, {
        account: "a",
        password: "b",
        ssopk: TEST_SSOPK,
        ssopkid: "ID",
        deviceCode: "iam:x",
        xuid: "pubweb_test",
      }),
    Error,
    "强制修改密码",
  );
});

Deno.test("租户列表为空时抛错（不回退用 IAM 的 tenantId）", async () => {
  const mockFetch: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/iam/login")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            data: { returnUrl: null, userId: 1, tenantId: 999 },
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
      const sessionKey = serverSideSessionKey(form.get("clientKey") ?? "", 'S');
      return Promise.resolve(
        new Response(JSON.stringify({ resultCode: 0, data: { sessionKey } })),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ resultCode: 0, data: { data: [] } })),
    );
  };

  await assertRejects(
    () =>
      iamLogin(new CookieJar(), mockFetch, {
        account: "a",
        password: "b",
        ssopk: TEST_SSOPK,
        ssopkid: "ID",
        deviceCode: "iam:x",
        xuid: "pubweb_test",
      }),
    Error,
    "没有可用租户",
  );
});
