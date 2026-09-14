/**
 * 云智助手 Web-Signature 签名算法。
 *
 * 公式：`SHA256(bodyMd5 & sk & timestamp & random)`
 *
 * 关键点：
 * - bodyMd5 必须基于**最终发出的 JSON 字符串**（不是对象）
 * - sk 来自 IAM ticketAuthorize 解密
 * - timestamp 是 13 位毫秒时间戳
 * - random 是 6 位随机数字串
 * - 四者直接拼接（无分隔符），然后 SHA256 取十六进制小写
 */
import { md5Hex, sha256Hex } from "../crypto.ts";

export interface SignatureContext {
  /** IAM ticketAuthorize 解密得到的 sk。 */
  sk: string;
  /** 用户 ID。 */
  userId: number;
  /** 租户 ID（字符串形式，放在请求头）。 */
  tenantIdStr: string;
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * 生成带签名的请求。
 *
 * @param path API 路径（如 `/eai/chat/completions`）
 * @param payload 请求体对象
 * @param ctx 签名上下文
 * @returns 包含完整头和 body 的请求参数
 */
export function signRequest(
  path: string,
  payload: unknown,
  ctx: SignatureContext,
): SignedRequest {
  const body = JSON.stringify(payload);
  const bodyMd5 = md5Hex(body);
  const timestamp = Date.now().toString();
  const random = Math.floor(100000 + Math.random() * 900000).toString();

  // SHA256(bodyMd5 & sk & timestamp & random)
  const signature = sha256Hex(bodyMd5 + ctx.sk + timestamp + random);

  const url = `https://eaichat.ctyun.cn${path}`;

  return {
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Id": ctx.userId.toString(),
      "Tenant-Id": ctx.tenantIdStr,
      "Web-Timestamp": timestamp,
      "Web-Random": random,
      "Web-Signature": signature,
      "Origin": "https://desk.ctyun.cn",
      "Referer": "https://desk.ctyun.cn/",
    },
    body,
  };
}
