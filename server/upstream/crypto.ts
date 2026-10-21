/**
 * 上游加解密公共能力（backend-design §1.3 / §6）：
 * - MD5 / SHA-256 摘要（CTG 业务签名、登录密码摘要）
 * - AES-CBC / IV 16 字节 0（云电脑请求/响应体）
 * - AES-ECB（eaichat 网关配置、sessionKey）
 * - RSA PKCS#1 v1.5（云电脑协商密钥、eaichat clientKey）
 *
 * 这里只做纯函数，不持有任何会话密钥。
 */
import crypto from 'node:crypto'

export const md5 = (text: string): string => crypto.createHash('md5').update(text, 'utf8').digest('hex')

export const sha256 = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

export const toBase64 = (value: Buffer | string): string => Buffer.from(value).toString('base64')

/** AES key 是 UTF-8 字符串，按字节长度选 128/192/256 位 */
function aesCbcAlgorithm(key: string): string {
  const bits = Buffer.byteLength(key, 'utf8') * 8
  if (![128, 192, 256].includes(bits)) throw new Error(`不支持的 AES key 长度: ${bits} bit`)
  return `aes-${bits}-cbc`
}

/** AES-CBC / PKCS#7 / IV 固定 16 字节 0 */
export function aesCbcEncrypt(plain: string, key: string): string {
  const cipher = crypto.createCipheriv(aesCbcAlgorithm(key), Buffer.from(key, 'utf8'), Buffer.alloc(16, 0))
  return toBase64(Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]))
}

export function aesCbcDecrypt(cipherBase64: string, key: string): string {
  const decipher = crypto.createDecipheriv(aesCbcAlgorithm(key), Buffer.from(key, 'utf8'), Buffer.alloc(16, 0))
  return Buffer.concat([decipher.update(Buffer.from(cipherBase64, 'base64')), decipher.final()]).toString('utf8')
}

function aesEcbAlgorithm(key: string): string {
  const bits = Buffer.byteLength(key, 'utf8') * 8
  if (![128, 192, 256].includes(bits)) throw new Error(`不支持的 AES key 长度: ${bits} bit`)
  return `aes-${bits}-ecb`
}

/** AES-ECB / PKCS#7（eaichat sessionKey / 网关配置） */
export function aesEcbEncrypt(plain: string, key: string): string {
  const cipher = crypto.createCipheriv(aesEcbAlgorithm(key), Buffer.from(key, 'utf8'), null)
  return toBase64(Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]))
}

export function aesEcbDecrypt(cipherBase64: string, key: string): string {
  const decipher = crypto.createDecipheriv(aesEcbAlgorithm(key), Buffer.from(key, 'utf8'), null)
  return Buffer.concat([decipher.update(Buffer.from(cipherBase64, 'base64')), decipher.final()]).toString('utf8')
}

export interface RsaKeyPair {
  publicKey: crypto.KeyObject
  privateKey: crypto.KeyObject
  /** SPKI DER 的 base64，用于 negotiationEncKey.certData */
  spkiBase64: string
}

export function generateRsaKeyPair(modulusLength = 2048): RsaKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength })
  const spkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return { publicKey, privateKey, spkiBase64 }
}

/** 上游按 PKCS#1 v1.5 加密（不是 OAEP） */
export function rsaDecryptPkcs1(privateKey: crypto.KeyObject, cipherBase64: string): string {
  return crypto
    .privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(cipherBase64, 'base64'),
    )
    .toString('utf8')
}

/** eaichat clientKey：公钥 SPKI base64 → PEM，再 PKCS#1 v1.5 加密后 hex 提交 */
export function rsaEncryptPkcs1Hex(spkiBase64: string, plain: string): string {
  const pem = `-----BEGIN PUBLIC KEY-----\n${spkiBase64}\n-----END PUBLIC KEY-----`
  return crypto
    .publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plain, 'utf8'))
    .toString('hex')
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function randomAlphaNum(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALNUM[crypto.randomInt(ALNUM.length)]
  return out
}

/** 前端 Xp() 同口径：可打印 ASCII（32..126） */
export function randomPrintable(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(32 + crypto.randomInt(95))
  return out
}

export function randomDeviceCode(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url').slice(0, 32)}`
}
