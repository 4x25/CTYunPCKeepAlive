/**
 * sysinfo 单测：AES-ECB 解密与 SSO 配置提取。
 *
 * key 是固定常量 `chinatelecom@cnn`，所以可以自造密文做往返验证。
 */
import { assertEquals, assertRejects } from "@std/assert";
import crypto from "node:crypto";
import { decryptEaiSysInfo, getEaiSysInfo } from "./sysinfo.ts";

const KEY = Buffer.from("chinatelecom@cnn", "utf8");

function encrypt(plain: string): string {
  const c = crypto.createCipheriv("aes-128-ecb", KEY, null);
  return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
}

Deno.test("固定 key 的 AES-ECB 解密往返", () => {
  const plain = '{"sso":{"ssopk":"PK","ssopkid":"ID"}}';
  assertEquals(decryptEaiSysInfo(encrypt(plain)), plain);
});

Deno.test("getEaiSysInfo 解出 ssopk / ssopkid", async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          success: true,
          resultCode: "0",
          resultMsg: "ok",
          data: encrypt(JSON.stringify({ eai: "https://eai.example", sso: { ssopk: "PK", ssopkid: "ID" } })),
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

  const cfg = await getEaiSysInfo(mockFetch);
  assertEquals(cfg.sso.ssopk, "PK");
  assertEquals(cfg.sso.ssopkid, "ID");
  assertEquals(cfg.eai, "https://eai.example");
});

Deno.test("缺少 data 字段时抛错", async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(new Response(JSON.stringify({ success: false, resultCode: "500", resultMsg: "boom" })));

  await assertRejects(() => getEaiSysInfo(mockFetch), Error, "缺少 data");
});

Deno.test("解密后缺少 sso 字段时抛错", async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ data: encrypt(JSON.stringify({ eai: "x" })) })),
    );

  await assertRejects(() => getEaiSysInfo(mockFetch), Error, "缺少 sso");
});

Deno.test("HTTP 非 2xx 抛错", async () => {
  const mockFetch: typeof fetch = () => Promise.resolve(new Response("err", { status: 502 }));
  await assertRejects(() => getEaiSysInfo(mockFetch), Error, "HTTP 502");
});
