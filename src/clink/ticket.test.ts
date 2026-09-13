import { assert, assertEquals, assertThrows } from "@std/assert";
import { generateTicket } from "./ticket.ts";
import { constants, createPrivateKey, generateKeyPairSync, privateDecrypt } from "node:crypto";

// 生成一对真实的 1024-bit RSA 密钥用于测试
const testKeyPair = generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "der" },
});

Deno.test("162B SPKI DER 生成 132B ticket", () => {
  const spki = new Uint8Array(testKeyPair.publicKey);
  assertEquals(spki.length, 162, "测试用 1024-bit RSA 公钥应为 162 字节");

  const ticket = generateTicket(spki);
  assertEquals(ticket.length, 132);

  // 前 4 字节应为 auth_mechanism=1（little-endian）
  const view = new DataView(ticket.buffer);
  assertEquals(view.getUint32(0, true), 1);
});

Deno.test("ticket 的 128B 密文可被私钥解密为单个 NUL", () => {
  const spki = new Uint8Array(testKeyPair.publicKey);
  const ticket = generateTicket(spki);

  // 提取密文（跳过前 4 字节 auth_mechanism）
  const ciphertext = Buffer.from(ticket.subarray(4, 132));

  // 用私钥解密
  const privateKey = createPrivateKey({
    key: Buffer.from(testKeyPair.privateKey),
    format: "der",
    type: "pkcs8",
  });
  const plaintext = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    ciphertext,
  );

  assertEquals(plaintext.length, 1);
  assertEquals(plaintext[0], 0x00);
});

Deno.test("非 162 字节的 SPKI 拒绝", () => {
  assertThrows(
    () => generateTicket(new Uint8Array(160)),
    Error,
    "必须是 162 字节",
  );
  assertThrows(
    () => generateTicket(new Uint8Array(200)),
    Error,
    "必须是 162 字节",
  );
});

Deno.test("ticket 在相同公钥下每次生成不同（OAEP 带随机填充）", () => {
  const spki = new Uint8Array(testKeyPair.publicKey);
  const t1 = generateTicket(spki);
  const t2 = generateTicket(spki);
  // 前 4 字节（auth_mechanism）应相同
  assertEquals(t1.subarray(0, 4), t2.subarray(0, 4));
  // 密文部分因 OAEP 随机填充应不同
  assert(
    !t1.subarray(4).every((b, i) => b === t2[i + 4]),
    "OAEP 随机填充应导致密文不同",
  );
});
