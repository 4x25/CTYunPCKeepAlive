/**
 * 密码学原语单测。
 *
 * 断言尽量锚定接口文档里写死的字节长度和已知向量，而不是自己的实现输出 ——
 * 后者只能证明代码前后一致，证明不了协议正确。
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  aesEcbDecrypt,
  clinkTicketEncrypt,
  generateNegotiationKeyPair,
  md5Hex,
  md5HexUpper,
  randomId,
  rsaPkcs1v15Decrypt,
  rsaPkcs1v15Encrypt,
  sha256Hex,
} from "./crypto.ts";

Deno.test("sha256Hex 对已知向量", () => {
  assertEquals(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(sha256Hex("").length, 64);
});

Deno.test("md5Hex 对已知向量，md5HexUpper 为大写", () => {
  assertEquals(md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assertEquals(md5HexUpper("abc"), "900150983CD24FB0D6963F7D28E17F72");
});

Deno.test("AES-CBC 零 IV 往返，且 IV 确实为零", () => {
  const key = new TextEncoder().encode("0123456789abcdef");
  const plain = JSON.stringify({ getCnt: 20, sortType: "createTimeV1" });
  const ct = aesCbcEncrypt(key, plain);
  assertEquals(aesCbcDecrypt(key, ct), plain);

  // 与显式零 IV 的独立实现对拍，确保没有隐式随机 IV
  const ref = crypto.createCipheriv("aes-128-cbc", key, new Uint8Array(16));
  const expected = Buffer.concat([ref.update(plain, "utf8"), ref.final()]).toString("base64");
  assertEquals(ct, expected);
});

Deno.test("AES-CBC 支持 128/256；192 因 Deno 缺 aes-192-cbc 而明确报错", () => {
  for (const len of [16, 32]) {
    const key = crypto.randomBytes(len);
    assertEquals(aesCbcDecrypt(key, aesCbcEncrypt(key, "x")), "x");
  }
  // Deno 的 node:crypto 有 aes-192-ecb 但没有 aes-192-cbc。
  // 报错必须点明原因，不能是上游那句含糊的 "Unknown cipher"。
  assertThrows(() => aesCbcEncrypt(crypto.randomBytes(24), "x"), Error, "aes-192-cbc");
  assertThrows(() => aesCbcEncrypt(crypto.randomBytes(20), "x"), Error, "AES 密钥长度非法");
});

Deno.test("AES-ECB 三种长度均可用（含 192）", () => {
  for (const len of [16, 24, 32]) {
    const key = crypto.randomBytes(len);
    const c = crypto.createCipheriv(`aes-${len * 8}-ecb`, key, null);
    const ct = Buffer.concat([c.update("x", "utf8"), c.final()]).toString("base64");
    assertEquals(aesEcbDecrypt(key, ct), "x");
  }
});

Deno.test("AES-ECB 解密（eaiSysInfo 用固定 key chinatelecom@cnn）", () => {
  const key = new TextEncoder().encode("chinatelecom@cnn");
  assertEquals(key.length, 16, "该 key 必须正好 16 字节");
  const plain = JSON.stringify({ eai: "https://example", sso: { ssopkid: "k" } });
  const c = crypto.createCipheriv("aes-128-ecb", key, null);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
  assertEquals(aesEcbDecrypt(key, ct), plain);
});

Deno.test("negotiationEncKey：RSA-PKCS#1 v1.5 完整往返", () => {
  const pair = generateNegotiationKeyPair();

  // certData 必须是 SPKI DER 的裸 Base64，不带 PEM 头尾
  assert(!pair.publicKeySpkiBase64.includes("BEGIN"), "certData 不应含 PEM 头");
  const spki = Buffer.from(pair.publicKeySpkiBase64, "base64");
  assertEquals(spki.length, 294, "2048-bit SPKI DER 应为 294 字节");

  // 服务端侧：用公钥以 PKCS#1 v1.5 加密中间 AES key
  const intermediate = "0123456789abcdef";
  const pub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const encKey = crypto.publicEncrypt(
    { key: pub, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(intermediate, "utf8"),
  ).toString("base64");

  const decrypted = rsaPkcs1v15Decrypt(pair.privateKey, encKey);
  assertEquals(new TextDecoder().decode(decrypted), intermediate);

  // 再用中间 key 解 encData，闭合整条链
  const negotiated = JSON.stringify({ eid: "E1", evalue: "fedcba9876543210" });
  const key = new TextEncoder().encode(intermediate);
  assertEquals(aesCbcDecrypt(key, aesCbcEncrypt(key, negotiated)), negotiated);
});

Deno.test("rsaPkcs1v15Encrypt 可被对应私钥解开（云智助手 clientKey）", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const clientKey = "  !\"#$%&'()*+,-."; // 16 个 ASCII 32..126 可打印字符
  assertEquals(clientKey.length, 16);

  const ct = rsaPkcs1v15Encrypt(pem, new TextEncoder().encode(clientKey));
  const pt = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(ct),
  );
  assertEquals(pt.toString("utf8"), clientKey);
});

Deno.test("Clink Ticket：162 字节 DER 公钥 → 128 字节密文，明文是单个 NUL", () => {
  // ServerLink 携带的就是 1024-bit 标准 SPKI DER，长度恰为 162
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  assertEquals(der.length, 162, "ServerLink 公钥应为 162 字节 SPKI DER");

  const cipher = clinkTicketEncrypt(new Uint8Array(der));
  assertEquals(cipher.length, 128, "encrypted_data 固定 128 字节");
  // Ticket 总长 = 4 字节 auth_mechanism + 128 字节密文
  assertEquals(4 + cipher.length, 132);

  // 明文严格是一个 NUL 字节，不是 token、密码或空串
  const pt = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    Buffer.from(cipher),
  );
  assertEquals([...pt], [0]);
});

Deno.test("Clink Ticket 每次 seed 随机，密文不重复", () => {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }) as Buffer);
  const a = clinkTicketEncrypt(der);
  const b = clinkTicketEncrypt(der);
  assert(!a.every((v, i) => v === b[i]), "OAEP seed 必须随机，两次密文不应相同");
});

Deno.test("randomId 长度与字符集", () => {
  const id = randomId(32);
  assertEquals(id.length, 32);
  assert(/^[0-9a-z]+$/.test(id));
  assert(randomId(32) !== randomId(32));
});
