/**
 * Clink Ticket 生成。
 *
 * 依据 `docs/ctyun-clink-protocol.md` §5.1.5。
 *
 * 流程：
 * 1. 从 CHANNELS_LIST(104) 响应中提取 162 字节 DER 格式 RSA 公钥
 * 2. 用 RSA-OAEP（SHA-1）加密**单个 NUL 字节**（`0x00`）→ 128 字节密文
 * 3. 拼接：`auth_mechanism=1`(u32) + 密文 = 132 字节 ticket
 *
 * 注意这是 RSA-OAEP，与 `negotiationEncKey` 的 RSAES-PKCS#1 v1.5 **不同**。
 */

import { constants, createPublicKey, publicEncrypt } from "node:crypto";

/**
 * 生成 Clink ticket（132 字节）。
 *
 * @param spkiDer 162 字节 SPKI DER 格式 RSA 公钥（从 CHANNELS_LIST 响应提取）
 * @returns 132 字节 ticket：u32(1) + RSA-OAEP 加密的 NUL
 */
export function generateTicket(spkiDer: Uint8Array): Uint8Array {
  if (spkiDer.length !== 162) {
    throw new Error(`SPKI DER 必须是 162 字节，实际 ${spkiDer.length}`);
  }

  // 1. 解析 DER → 公钥对象
  const publicKey = createPublicKey({
    key: Buffer.from(spkiDer),
    format: "der",
    type: "spki",
  });

  // 2. RSA-OAEP/SHA-1 加密单个 NUL 字节
  const plaintext = Buffer.from([0x00]);
  const ciphertext = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    plaintext,
  );

  if (ciphertext.length !== 128) {
    throw new Error(`RSA-OAEP 密文应为 128 字节，实际 ${ciphertext.length}`);
  }

  // 3. 拼接 auth_mechanism=1 (u32 little-endian) + 密文
  const ticket = new Uint8Array(132);
  const view = new DataView(ticket.buffer);
  view.setUint32(0, 1, true); // auth_mechanism = 1
  ticket.set(ciphertext, 4);

  return ticket;
}
