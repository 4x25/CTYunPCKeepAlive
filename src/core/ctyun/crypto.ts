/**
 * 天翼云电脑协议所需的全部密码学原语。
 *
 * 一律使用 `node:crypto`。Web Crypto 不支持本项目必需的 MD5、AES-ECB 和
 * RSAES-PKCS#1 v1.5 加解密，详见 `docs/2.0/tech-decisions.md` §5。
 */
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

/** SHA-256 小写十六进制。接口文档要求 hex，不是 Base64。 */
export function sha256Hex(input: string | Uint8Array): string {
  return crypto.createHash("sha256").update(toBuf(input)).digest("hex");
}

/** MD5 小写十六进制。用于 `Web-Signature` 的 `bodyMd5`。 */
export function md5Hex(input: string | Uint8Array): string {
  return crypto.createHash("md5").update(toBuf(input)).digest("hex");
}

/** MD5 大写十六进制。用于 `CTG-SIGNATURESTR`。 */
export function md5HexUpper(input: string | Uint8Array): string {
  return md5Hex(input).toUpperCase();
}

/**
 * AES-CBC / PKCS#7 / 16 字节零 IV，密文 Base64。
 *
 * key 是协商所得 `evalue` 的 UTF-8 字节，长度决定用 128/192/256 位变体。
 */
export function aesCbcEncrypt(key: Uint8Array, plaintext: string): string {
  const cipher = crypto.createCipheriv(aesCbcAlg(key), key, ZERO_IV);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

/** AES-CBC / PKCS#7 / 零 IV 解密，输入 Base64，输出 UTF-8 字符串。 */
export function aesCbcDecrypt(key: Uint8Array, base64Ciphertext: string): string {
  const decipher = crypto.createDecipheriv(aesCbcAlg(key), key, ZERO_IV);
  const ct = Buffer.from(base64Ciphertext, "base64");
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * AES-ECB / PKCS#7 解密，输入 Base64，输出 UTF-8 字符串。
 *
 * 用于 `eaiSysInfo` 配置解密（key `chinatelecom@cnn`）和 `sessionKey` 解密。
 */
export function aesEcbDecrypt(key: Uint8Array, base64Ciphertext: string): string {
  const decipher = crypto.createDecipheriv(aesEcbAlg(key), key, null);
  const ct = Buffer.from(base64Ciphertext, "base64");
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export interface RsaKeyPair {
  /** SPKI DER 的标准 Base64，不含 PEM 头尾。作为 `certData` 提交。 */
  publicKeySpkiBase64: string;
  privateKey: crypto.KeyObject;
}

/**
 * 生成密钥协商用的临时 RSA 密钥对。
 *
 * 线上 bundle 用 Web Crypto 以 RSA-OAEP/SHA-512 参数生成，但**解密时走
 * RSAES-PKCS#1 v1.5**（它把导出的私钥交给 JSEncrypt 兼容实现）。`node:crypto`
 * 的 RSA 密钥不绑定填充方式，因此这里只需指定模数长度。
 */
export function generateNegotiationKeyPair(): RsaKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return { publicKeySpkiBase64: spki.toString("base64"), privateKey };
}

/**
 * 用临时私钥按 RSAES-PKCS#1 v1.5 解开 `encKey`。
 *
 * 不要因为密钥生成参数叫 RSA-OAEP 就改用 OAEP —— 那是两套不同的填充。
 */
export function rsaPkcs1v15Decrypt(
  privateKey: crypto.KeyObject,
  base64Ciphertext: string,
): Uint8Array {
  return new Uint8Array(
    crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(base64Ciphertext, "base64"),
    ),
  );
}

/** 用 RSAES-PKCS#1 v1.5 加密。用于云智助手的 `clientKey`。 */
export function rsaPkcs1v15Encrypt(
  publicKeyPem: string,
  plaintext: Uint8Array,
): Uint8Array {
  return new Uint8Array(
    crypto.publicEncrypt(
      { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(plaintext),
    ),
  );
}

/**
 * Clink Ticket 的 RSA 部分：用 ServerLink 给出的 162 字节 DER 公钥，
 * 以 RSAES-OAEP/SHA-1 加密**单个 NUL 字节**，产出固定 128 字节密文。
 *
 * 该 162 字节就是标准的 1024-bit SPKI DER（已实测长度吻合），可直接解析。
 * 注意这里的 OAEP/SHA-1 与 `negotiationEncKey` 的 PKCS#1 v1.5 是两套填充，不可复用。
 */
export function clinkTicketEncrypt(serverPublicKeyDer: Uint8Array): Uint8Array {
  const key = crypto.createPublicKey({
    key: Buffer.from(serverPublicKeyDer),
    format: "der",
    type: "spki",
  });
  const ct = crypto.publicEncrypt(
    {
      key,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    Buffer.from([0x00]),
  );
  return new Uint8Array(ct);
}

/** 生成 `len` 个字符的随机 ID，字符集 `[0-9a-z]`。用于 `deviceCode`。 */
export function randomId(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHANUM_LOWER[bytes[i]! % ALPHANUM_LOWER.length];
  return out;
}

const ZERO_IV = new Uint8Array(16);
const ALPHANUM_LOWER = "0123456789abcdefghijklmnopqrstuvwxyz";

function toBuf(input: string | Uint8Array): Buffer {
  return typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
}

function aesCbcAlg(key: Uint8Array): string {
  const bits = aesBits(key);
  // Deno 的 node:crypto 缺 aes-192-cbc（aes-192-ecb 却是有的）。
  // 实测 evalue 走 128 位，真遇到 24 字节再补 ECB + 手工 CBC 链接。
  if (bits === 192) {
    throw new Error(
      "Deno 的 node:crypto 不支持 aes-192-cbc（协商得到 24 字节 evalue）。" +
        "需要基于 aes-192-ecb 手工实现 CBC 链接，详见 docs/2.0/tech-decisions.md §5",
    );
  }
  return `aes-${bits}-cbc`;
}

function aesEcbAlg(key: Uint8Array): string {
  return `aes-${aesBits(key)}-ecb`;
}

function aesBits(key: Uint8Array): 128 | 192 | 256 {
  switch (key.length) {
    case 16:
      return 128;
    case 24:
      return 192;
    case 32:
      return 256;
    default:
      throw new Error(`AES 密钥长度非法：${key.length} 字节，应为 16 / 24 / 32`);
  }
}
