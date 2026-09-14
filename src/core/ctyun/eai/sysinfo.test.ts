/**
 * sysinfo 单测：AES-ECB 加解密往返。
 */
import { assertEquals } from "@std/assert";
import { aesEcbDecrypt, aesEcbEncrypt } from "./sysinfo.ts";

Deno.test("AES-ECB 加解密往返", () => {
  const plain = '{"sso":{"ssopk":"test-key","ssopkid":"id-123"}}';
  const enc = aesEcbEncrypt(plain);
  const dec = aesEcbDecrypt(enc);
  assertEquals(dec, plain);
});

Deno.test("解密实测密文（若有）", () => {
  // 接口文档里没有样本密文，留空占位。真实联调时若拿到样本可补充验证
});
