/**
 * 云智助手 SSO 配置获取与解密。
 *
 * 依据 `docs/ctyun-eaichat-account-auth-api.md` §3。
 */
import { createDecipheriv } from "node:crypto";

/** `eaiSysInfo` 的 `data` 字段用这个固定 key 做 AES-ECB 解密。 */
const SYSINFO_KEY = Buffer.from("chinatelecom@cnn", "utf8");

/** 该接口跨域，浏览器会先发 OPTIONS 预检。 */
export const EAI_SYSINFO_URL = "https://gwyilian.ctyun.cn/server/eaiSysInfo";

/** 解密后的 SSO 配置中，登录流程实际消费的字段。 */
export interface EaiSsoConfig {
  /** 云智助手 API 网关地址。 */
  eai?: string;
  sso: {
    /** 用于加密客户端随机密钥的 RSA 公钥（PEM 文本）。 */
    ssopk: string;
    /** 公钥标识，提交为 `clientKeyId`。 */
    ssopkid: string;
  };
}

/** 线上响应外层。`data` 是 AES-ECB 加密的 JSON 字符串。 */
interface EaiSysInfoResponse {
  success?: boolean;
  resultCode?: string;
  resultMsg?: string;
  /** 加密后的平台网关配置。 */
  data?: string;
}

/**
 * 用固定 key 做 AES-ECB / PKCS#7 解密。
 *
 * 注意云智助手这条链用的是 ECB，不是云电脑链的 CBC。
 */
export function decryptEaiSysInfo(cipherBase64: string): string {
  const decipher = createDecipheriv("aes-128-ecb", SYSINFO_KEY, null);
  let plain = decipher.update(cipherBase64, "base64", "utf8");
  plain += decipher.final("utf8");
  return plain;
}

/**
 * 获取并解析 SSO 配置。
 *
 * 该接口不需要登录态，但响应体是加密的；解密后的 `ssopk` / `ssopkid`
 * 用于后续 IAM 登录的 `clientKey` 加密。
 *
 * 解密后的完整配置字段超出登录所需范围（文档明确不作扩展），
 * 这里只取登录要用的部分，其余原样保留。
 */
export async function getEaiSysInfo(
  fetchImpl: typeof fetch = fetch,
): Promise<EaiSsoConfig> {
  const res = await fetchImpl(EAI_SYSINFO_URL, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://eaichat.ctyun.cn",
    },
  });

  if (!res.ok) {
    throw new Error(`eaiSysInfo HTTP ${res.status}`);
  }

  const body = await res.json() as EaiSysInfoResponse;
  if (!body.data) {
    throw new Error(
      `eaiSysInfo 响应缺少 data 字段（resultCode=${body.resultCode ?? "?"}）`,
    );
  }

  const parsed = JSON.parse(decryptEaiSysInfo(body.data)) as EaiSsoConfig;

  if (!parsed.sso?.ssopk || !parsed.sso?.ssopkid) {
    throw new Error("eaiSysInfo 解密后缺少 sso.ssopk / sso.ssopkid");
  }

  return parsed;
}
