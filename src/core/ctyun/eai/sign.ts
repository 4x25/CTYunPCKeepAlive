/**
 * 云智助手 `Web-Signature` 请求签名。
 *
 * 依据 `docs/ctyun-ctyun-eaichat-chat-sse-api.md` §3。
 *
 * ```text
 * query   = sortedNonNullParams.map(([k,v]) => `${k}=${String(v)}`).join("&")
 * bodyMd5 = bodyExists ? lowercaseHex(MD5(exactBodyString)) : absent
 * source  = [query, bodyMd5, sessionSigningKey, timestamp, random]
 *             .filter(componentIsPresent).join("&")
 * Web-Signature = lowercaseHex(SHA256(source))
 * ```
 *
 * 两个必须遵守的约束：
 * - **不 URL 编码**：`key=value` 直接拼接（第 3 步明确）
 * - 签名必须基于**最终发给 `fetch` 的那一份 body 字符串**；对象签名后再调整
 *   字段顺序、增删空数组或重新序列化都会导致验签失败
 */
import crypto from "node:crypto";
import { md5Hex, sha256Hex } from "../crypto.ts";

/** `x-eai-version` / `YL-Main-Version` 的固定值。 */
export const EAI_VERSION = "202060305";
/** `YL-Product-Id` 固定值。 */
export const EAI_PRODUCT_ID = "5";

/** 8 位随机串的字符集：大小写字母 + 数字。 */
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export interface SignatureContext {
  /** IAM `ticketAuthorize` 解出的内存签名密钥，绝不持久化。 */
  sk: string;
  /** Web 设备标识，`pubweb_` + UUID v4，长期持久化。 */
  xuid: string;
  /** 当前租户 ID 字符串。 */
  tenantIdStr: string;
  /** 私有网关环境代码；公有环境为空字符串。 */
  envCode?: string;
  /** 浏览器 UA 副本。 */
  userAgent?: string;
}

export interface SignRequestOptions {
  /** 相对路径，如 `/ai/portal/v1/user/queryUserInfo`。 */
  path?: string;
  /** 完整 URL；给了它就用它，否则用 `path` 拼默认 Origin。 */
  url?: string;
  method?: "GET" | "POST";
  /** 查询参数。值为 null / undefined 的项会被剔除。 */
  query?: Record<string, string | number | null | undefined>;
  /**
   * 请求体。
   *
   * **传字符串**（推荐）可保证签名与发送完全一致；传对象时这里会
   * `JSON.stringify` 一次并把结果同时用于签名和 `body`，调用方不要
   * 再自行序列化，否则两份字符串可能不一致。
   */
  body?: string | Record<string, unknown>;
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** 需要原样发出的请求体字符串；GET 时为 undefined。 */
  body?: string;
}

const DEFAULT_ORIGIN = "https://eaichat.ctyun.cn";

/** 生成 8 位字母数字随机串。 */
export function randomAlnum(len = 8): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALNUM[bytes[i]! % ALNUM.length];
  return out;
}

/** 生成新的 `xuid`（`pubweb_` + UUID v4）。调用方负责持久化。 */
export function newXuid(): string {
  return `pubweb_${crypto.randomUUID()}`;
}

/** 生成 UUID v4，用于 `x-client-trace-id`。 */
export function newTraceId(): string {
  return crypto.randomUUID();
}

/**
 * 按文档规则把查询参数拼成签名用的字符串。
 *
 * 参数名用 `localeCompare` 排序，值直接强转字符串，不编码。
 */
export function buildQueryString(
  query: Record<string, string | number | null | undefined>,
): string {
  return Object.entries(query)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * 计算签名。
 *
 * 单独导出便于单测直接对拍公式。
 */
export function computeSignature(p: {
  queryString: string;
  bodyMd5?: string;
  sk: string;
  timestamp: string;
  random: string;
}): string {
  const source = [p.queryString, p.bodyMd5, p.sk, p.timestamp, p.random]
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .join("&");
  return sha256Hex(source);
}

/**
 * 构造一个已签名的请求。
 *
 * 返回的 `body` 就是参与签名的那份字符串，调用方必须原样发送。
 */
export function signRequest(
  ctx: SignatureContext,
  opts: SignRequestOptions,
): SignedRequest {
  const method = opts.method ?? "GET";
  const url = opts.url ?? `${DEFAULT_ORIGIN}${opts.path ?? ""}`;

  // 查询串：既用于签名，也用于最终 URL
  const queryString = opts.query ? buildQueryString(opts.query) : "";
  const finalUrl = queryString
    ? `${url}${url.includes("?") ? "&" : "?"}${queryString}`
    : url;

  // 请求体：字符串直接用；对象序列化一次，签名与发送共用同一份
  const bodyString = typeof opts.body === "string"
    ? opts.body
    : opts.body === undefined
    ? undefined
    : JSON.stringify(opts.body);

  const bodyMd5 = bodyString === undefined ? undefined : md5Hex(bodyString);
  const timestamp = String(Date.now());
  const random = randomAlnum(8);

  const signature = computeSignature({
    queryString,
    ...(bodyMd5 !== undefined && { bodyMd5 }),
    sk: ctx.sk,
    timestamp,
    random,
  });

  const headers: Record<string, string> = {
    "Accept": "application/json, text/plain, */*",
    "Origin": DEFAULT_ORIGIN,
    "x-client-trace-id": newTraceId(),
    "x-eai-xuid": ctx.xuid,
    "x-eai-env": "pubWeb",
    "x-eai-version": EAI_VERSION,
    "x-eai-source": "web-eai",
    "x-eai-tenant-id": ctx.tenantIdStr,
    "x-eai-env-code": ctx.envCode ?? "",
    "x-eai-mode": "eai",
    "YL-Main-Version": EAI_VERSION,
    "YL-Product-Id": EAI_PRODUCT_ID,
    "Web-Signature": signature,
    "Web-Random": random,
    "Web-Timestamp": timestamp,
  };

  if (ctx.userAgent) headers["x-user-agent"] = ctx.userAgent;
  if (bodyString !== undefined) headers["Content-Type"] = "application/json";

  return {
    url: finalUrl,
    method,
    headers,
    ...(bodyString !== undefined && { body: bodyString }),
  };
}
