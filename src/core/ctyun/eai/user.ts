/**
 * 云智助手用户信息查询。
 *
 * 三个接口：queryUserInfo / queryUserConfig / queryUserTenantInfo。
 * 全部使用 Web-Signature 签名。
 */
import type { CookieJar } from "../cookiejar.ts";
import { signRequest, type SignatureContext } from "./sign.ts";

export interface UserInfo {
  /** 用户 ID。 */
  userId: number;
  /** 用户名。 */
  userName?: string;
  /** 手机号。 */
  phone?: string;
  /** 邮箱。 */
  email?: string;
  [key: string]: unknown;
}

export interface UserConfig {
  /** 是否开启智能助手。 */
  enableAI?: boolean;
  [key: string]: unknown;
}

export interface UserTenantInfo {
  /** 租户 ID。 */
  tenantId: string;
  /** 租户名称。 */
  tenantName?: string;
  [key: string]: unknown;
}

/**
 * 查询用户基本信息。
 */
export async function queryUserInfo(
  ctx: SignatureContext,
  cookies: CookieJar,
  fetchImpl: typeof fetch = fetch,
): Promise<UserInfo> {
  const req = signRequest("/eai/user/queryUserInfo", {}, ctx);
  const res = await fetchImpl(req.url, {
    method: req.method,
    headers: {
      ...req.headers,
      "Cookie": cookies.toString(),
    },
    body: req.body,
  });

  if (!res.ok) {
    throw new Error(`queryUserInfo HTTP ${res.status}: ${await res.text()}`);
  }

  const json = await res.json() as { code: number; data?: UserInfo; message?: string };
  if (json.code !== 200 || !json.data) {
    throw new Error(`queryUserInfo failed: code=${json.code}, msg=${json.message ?? "unknown"}`);
  }

  return json.data;
}

/**
 * 查询用户配置。
 */
export async function queryUserConfig(
  ctx: SignatureContext,
  cookies: CookieJar,
  fetchImpl: typeof fetch = fetch,
): Promise<UserConfig> {
  const req = signRequest("/eai/user/queryUserConfig", {}, ctx);
  const res = await fetchImpl(req.url, {
    method: req.method,
    headers: {
      ...req.headers,
      "Cookie": cookies.toString(),
    },
    body: req.body,
  });

  if (!res.ok) {
    throw new Error(`queryUserConfig HTTP ${res.status}: ${await res.text()}`);
  }

  const json = await res.json() as { code: number; data?: UserConfig; message?: string };
  if (json.code !== 200 || !json.data) {
    throw new Error(`queryUserConfig failed: code=${json.code}, msg=${json.message ?? "unknown"}`);
  }

  return json.data;
}

/**
 * 查询用户租户信息。
 */
export async function queryUserTenantInfo(
  ctx: SignatureContext,
  cookies: CookieJar,
  fetchImpl: typeof fetch = fetch,
): Promise<UserTenantInfo> {
  const req = signRequest("/eai/user/queryUserTenantInfo", {}, ctx);
  const res = await fetchImpl(req.url, {
    method: req.method,
    headers: {
      ...req.headers,
      "Cookie": cookies.toString(),
    },
    body: req.body,
  });

  if (!res.ok) {
    throw new Error(`queryUserTenantInfo HTTP ${res.status}: ${await res.text()}`);
  }

  const json = await res.json() as { code: number; data?: UserTenantInfo; message?: string };
  if (json.code !== 200 || !json.data) {
    throw new Error(
      `queryUserTenantInfo failed: code=${json.code}, msg=${json.message ?? "unknown"}`,
    );
  }

  return json.data;
}
