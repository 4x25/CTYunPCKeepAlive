/**
 * 云智助手系统信息获取与解密。
 *
 * 依据 `docs/ctyun-eaichat-api.md` §3。
 *
 * `eaiSysInfo` 返回 AES-ECB 加密的 JSON，key 是固定的 `chinatelecom@cnn`
 * （16 字节恰好是 AES-128 的 key 长度）。解密后的 `sso.ssopk` / `ssopkid`
 * 用于后续的 IAM 登录流程。
 */
import { createCipheriv, createDecipheriv } from "node:crypto";

// 16 字节恰好是 AES-128 的 key 长度
const SYSINFO_KEY = Buffer.from("chinatelecom@cnn", "utf8");
// ECB 不需要 IV，但 API 要求传参
const NO_IV = Buffer.alloc(0);

/**
 * AES-ECB 解密（固定 key）。
 *
 * 云智助手这条链路用 ECB 而不是云电脑链的 CBC，且 key 是明文常量。
 */
export function aesEcbDecrypt(cipherBase64: string): string {
  const decipher = createDecipheriv("aes-128-ecb", SYSINFO_KEY, NO_IV);
  let plain = decipher.update(cipherBase64, "base64", "utf8");
  plain += decipher.final("utf8");
  return plain;
}

/**
 * AES-ECB 加密（固定 key）。
 *
 * 仅用于单测验证，生产代码不需要加密 sysinfo。
 */
export function aesEcbEncrypt(plain: string): string {
  const cipher = createCipheriv("aes-128-ecb", SYSINFO_KEY, NO_IV);
  let enc = cipher.update(plain, "utf8", "base64");
  enc += cipher.final("base64");
  return enc;
}

export interface SysInfo {
  sso: {
    ssopk: string;
    ssopkid: string;
  };
}

export interface EaiSysInfoResponse {
  resultCode: string;
  resultMessage: string;
  sysInfo: string; // AES-ECB 加密的 JSON
}

/**
 * 获取并解密云智助手系统信息。
 *
 * 该接口不需要登录态，但响应是加密的；解密后拿到的 `ssopk` / `ssopkid`
 * 用于后续 IAM 登录的 `clientKey` 加密。
 */
export async function getEaiSysInfo(
  fetch: typeof globalThis.fetch,
): Promise<SysInfo> {
  const url = "https://eaichat.ctyun.cn/api/v1/sysInfo/eaiSysInfo";
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://eaichat.ctyun.cn",
    },
  });

  if (!res.ok) {
    throw new Error(`eaiSysInfo HTTP ${res.status}`);
  }

  const body = await res.json() as EaiSysInfoResponse;
  if (body.resultCode !== "0") {
    throw new Error(`eaiSysInfo failed: ${body.resultMessage} (${body.resultCode})`);
  }

  const plain = aesEcbDecrypt(body.sysInfo);
  return JSON.parse(plain) as SysInfo;
}
