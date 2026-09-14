/**
 * 云智助手用户与租户初始化。
 *
 * 依据 `docs/ctyun-eaichat-account-auth-api.md` §5.3.1。
 *
 * 三个接口都是 **GET**，走 `Web-Signature` 签名 + Cookie。
 * 文档明确：IAM 登录响应里的 `tenantId` **不会**被云智助手直接复制使用，
 * 平台会重新查询自己的用户、配置和租户数据。
 */
import type { SignatureContext } from "./sign.ts";
import { signRequest } from "./sign.ts";

const USER_INFO_PATH = "/ai/portal/v1/user/queryUserInfo";
const USER_CONFIG_PATH = "/ai/portal/v1/user/queryUserConfig";
const USER_TENANT_PATH = "/ai/portal/v2/user/queryUserTenantInfo";

export interface UserProfile {
  [key: string]: unknown;
}

export interface UserConfig {
  /** 当前租户 ID 字符串，优先用于 `x-eai-tenant-id`。 */
  currentTenantIdStr?: string;
  [key: string]: unknown;
}

export interface TenantItem {
  tenantId: number;
  tenantIdStr: string;
  [key: string]: unknown;
}

export interface EaiTransport {
  fetch: typeof fetch;
  /** 生成 `Cookie` 头值；无 Cookie 时返回空串。 */
  cookieHeader: (url: string) => string;
}

/**
 * 查询云智助手用户资料。
 *
 * `?syncIam=true` 分支不用于普通启动，因此这里不带参数。
 */
export async function queryUserInfo(
  ctx: SignatureContext,
  t: EaiTransport,
): Promise<UserProfile> {
  return await getJson(USER_INFO_PATH, ctx, t, "queryUserInfo");
}

/** 查询用户配置，用于取 `currentTenantIdStr`。 */
export async function queryUserConfig(
  ctx: SignatureContext,
  t: EaiTransport,
): Promise<UserConfig> {
  return await getJson(USER_CONFIG_PATH, ctx, t, "queryUserConfig");
}

/**
 * 查询账号可用的租户列表。
 *
 * 响应形状是 `{ resultCode, data: { data: TenantItem[] } }` —— 两层 `data`。
 */
export async function queryUserTenantInfo(
  ctx: SignatureContext,
  t: EaiTransport,
): Promise<TenantItem[]> {
  const body = await getRaw(USER_TENANT_PATH, ctx, t, "queryUserTenantInfo");
  const outer = body.data;
  if (outer && typeof outer === "object" && Array.isArray((outer as { data?: unknown }).data)) {
    return (outer as { data: TenantItem[] }).data;
  }
  if (Array.isArray(outer)) return outer as TenantItem[];
  return [];
}

/**
 * 选择当前租户。
 *
 * 优先级按文档：`currentTenantIdStr` 命中列表 > 列表首项。
 * 文档要求以**宽松相等**比较 `tenantIdStr`，匹配不到时回退首项。
 * 列表为空时返回 `null`，且**不回退**使用 IAM 登录响应的 `tenantId`。
 */
export function pickCurrentTenant(
  tenants: TenantItem[],
  currentTenantIdStr?: string,
): TenantItem | null {
  if (tenants.length === 0) return null;
  if (currentTenantIdStr) {
    // 宽松相等：服务端下发的可能是数字或字符串
    const hit = tenants.find((t) => t.tenantIdStr == currentTenantIdStr);
    if (hit) return hit;
  }
  return tenants[0]!;
}

/** 执行一次带签名的 GET 并解出 `data`。 */
async function getJson<T>(
  path: string,
  ctx: SignatureContext,
  t: EaiTransport,
  label: string,
): Promise<T> {
  const body = await getRaw(path, ctx, t, label);
  return body.data as T;
}

/** 执行一次带签名的 GET，返回完整响应体。 */
async function getRaw(
  path: string,
  ctx: SignatureContext,
  t: EaiTransport,
  label: string,
): Promise<{ resultCode?: number; resultMsg?: string; data?: unknown }> {
  const req = signRequest(ctx, { path, method: "GET" });

  const headers = new Headers(req.headers);
  const cookie = t.cookieHeader(req.url);
  if (cookie) headers.set("Cookie", cookie);

  const res = await t.fetch(req.url, { method: "GET", headers });
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}`);
  }

  const body = await res.json() as { resultCode?: number; resultMsg?: string; data?: unknown };

  // 云智助手用 resultCode，不是云电脑链的 code
  if (body.resultCode !== 0) {
    throw new Error(`${label} 失败：${body.resultMsg ?? `resultCode=${body.resultCode}`}`);
  }

  return body;
}
