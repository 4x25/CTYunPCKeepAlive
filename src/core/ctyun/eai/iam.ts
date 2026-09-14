/**
 * IAM 登录链路（云智助手认证）。
 *
 * 依据 `docs/ctyun-eaichat-account-auth-api.md` §4–§5.3。
 *
 * 与云电脑链完全分离的三处差异：
 * - 密码算法：IAM 用 `SHA256(明文)`；云电脑链用 `SHA256(明文 + challengeCode)`
 * - 需要 Cookie：IAM 写入的会话必须带到 `ticketAuthorize`
 * - RSA 填充：`clientKey` 用 RSAES-PKCS#1 v1.5；Clink Ticket 用 OAEP/SHA-1
 *
 * 最终产物是**仅驻留内存**的 `sk`，用于后续云智助手 API 的 `Web-Signature`。
 */
import { aesEcbDecryptBytes, randomId, rsaPkcs1v15Encrypt, sha256Hex } from "../crypto.ts";
import type { CookieJar } from "../cookiejar.ts";
import { createCookieFetch } from "../cookiejar.ts";

const IAM_LOGIN_URL = "https://desk.ctyun.cn/cloudB/dy/iam/api/auth/iam/login";
const TICKET_AUTHORIZE_URL = "https://eaichat.ctyun.cn/sso/login/v2/iam/ticketAuthorize";
const CAS_LOGIN_URL = "https://desk.ctyun.cn/cloudB/dy/iam/api/auth/iam/cas/login";
const USER_INFO_URL = "https://eaichat.ctyun.cn/ai/portal/v1/user/queryUserInfo";
const USER_TENANT_URL = "https://eaichat.ctyun.cn/ai/portal/v2/user/queryUserTenantInfo";

/** `clientId` 固定值。 */
const CLIENT_ID = "eaiapp";
/** `redirectUri` 固定值。 */
const REDIRECT_URI = "https://eaichat.ctyun.cn:443/chat/#/aichat";
/**
 * CAS 的 `service` 参数。
 *
 * **必须是不带 hash 的干净 URL** —— URL 片段不会发给服务端，
 * 带上 `#/aichat` 会让 CAS 认不出服务并退回 IAM 首页（实测如此）。
 */
export const CAS_SERVICE = "https://eaichat.ctyun.cn/chat/";
/** IAM 设备名固定值，不是真实主机名。 */
const IAM_DEVICE_NAME = "iam:web";

/** 可打印 ASCII 范围 `32..126`，共 95 个字符。文档要求照抄。 */
const PRINTABLE_ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));

export interface IamLoginOptions {
  account: string;
  password: string;
  /** `eaiSysInfo` 解密得到的 SSO 公钥。 */
  ssopk: string;
  /** SSO 公钥标识，提交为 `clientKeyId`。 */
  ssopkid: string;
  /**
   * IAM 设备代码，形如 `iam:<32 位随机>`。
   *
   * 必须长期持久化复用，否则服务端会视为新设备并反复触发设备校验。
   */
  deviceCode: string;
  /**
   * Web 设备/访问标识（`pubweb_` + UUID v4）。
   *
   * 同样必须长期持久化复用；它参与每个云智助手请求的 `x-eai-xuid` 头。
   */
  xuid: string;
}

export interface IamSession {
  /** 内存签名密钥，用于云智助手 API 的 `Web-Signature`。绝不持久化。 */
  sk: string;
  /** 用户 ID（字符串，云智助手侧）。 */
  userId: string;
  /** 租户 ID 字符串，放 `x-eai-tenant-id` 头。 */
  tenantIdStr: string;
  /** 租户数字 ID，放对话请求体 `tenantId`。与 `tenantIdStr` 用途不同。 */
  tenantId?: number;
  /**
   * Web 设备/访问标识（`pubweb_` + UUID v4）。
   *
   * 由调用方持久化后传入 —— 它参与每个请求的 `x-eai-xuid` 头，
   * 每次重新生成会被服务端视为新客户端。
   */
  xuid: string;
}

/** 会话可直接作为签名上下文使用（字段是子集）。 */
export type { SignatureContext } from "./sign.ts";

/** 生成新的 IAM 设备代码。调用方负责持久化。 */
export function newIamDeviceCode(): string {
  return `iam:${randomId(32)}`;
}

/**
 * 生成 16 字符本地客户端密钥。
 *
 * 文档明确：逐字符从可打印 ASCII `32..126` 中选取，用的是 `Math.random()`
 * 而非密码学随机源。这是**兼容既有客户端所必需**的行为，不是安全缺陷 ——
 * 该密钥只作为 `ticketAuthorize` 的本地对称密钥。
 */
export function randomClientKey(): string {
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += PRINTABLE_ASCII[Math.floor(Math.random() * PRINTABLE_ASCII.length)];
  }
  return out;
}

/** 把裸 Base64 公钥补成标准 PEM；已是 PEM 则原样返回。 */
export function wrapAsPublicKeyPem(key: string): string {
  const trimmed = key.trim();
  if (trimmed.includes("BEGIN")) return trimmed;

  const body = trimmed.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

/** IAM 登录响应。只声明本流程消费的字段。 */
interface IamLoginResponse {
  code: number;
  msg?: string;
  data?: {
    returnUrl: string;
    userId: number;
    tenantId: number;
    userAccount?: string;
    needUpdatePassword?: boolean;
    needSmsValidate?: boolean;
  };
}

/**
 * 从 `returnUrl` 中取出一次性票据。
 *
 * 文档实测票据在 `#` 之后的 hash 查询串里（`...#/login?ticket=xxx`），
 * 不是普通 query，因此两处都要找。
 */
export function extractTicket(returnUrl: string): string | undefined {
  const hashIndex = returnUrl.indexOf("#");
  if (hashIndex !== -1) {
    const hashPart = returnUrl.slice(hashIndex + 1);
    const qIndex = hashPart.indexOf("?");
    if (qIndex !== -1) {
      const t = new URLSearchParams(hashPart.slice(qIndex + 1)).get("ticket");
      if (t) return t;
    }
  }
  try {
    const t = new URL(returnUrl).searchParams.get("ticket");
    if (t) return t;
  } catch {
    // 非法 URL，落到下面的手工解析
  }
  return /[?&]ticket=([^&#]+)/.exec(returnUrl)?.[1];
}

/** `ticketAuthorize` 响应。`data.sessionKey` 是加密的会话密钥。 */
interface TicketAuthorizeResponse {
  success?: boolean;
  resultCode?: number;
  resultMsg?: string;
  data?: { sessionKey?: string };
}

/**
 * 用本地 `clientKey` 解出内存签名密钥 `sk`。
 *
 * 链路：`sessionKey` 先 Base64 解码 → 用 `clientKey` 的 UTF-8 字节
 * （16 字节，即 AES-128）做 AES-ECB/PKCS#7 解密 → UTF-8 字符串即 `sk`。
 */
export function deriveSk(sessionKeyBase64: string, clientKey: string): string {
  return aesEcbDecryptBytes(new TextEncoder().encode(clientKey), fromBase64(sessionKeyBase64));
}

/**
 * 完整 IAM 登录流程。
 *
 * ① IAM login → `returnUrl`（含一次性票据）
 * ② `ticketAuthorize` 用票据换 `sessionKey`，同时解出内存 `sk`
 * ③ 查询用户与租户信息，补齐 `userId` / `tenantIdStr`
 *
 * `clientKey` 每次登录新生成，只用于本次解密，不持久化。
 */
export async function iamLogin(
  jar: CookieJar,
  baseFetch: typeof fetch,
  opts: IamLoginOptions,
): Promise<IamSession> {
  const cookieFetch = createCookieFetch(jar, baseFetch);

  // ① IAM 账号密码登录（会写入会话 Cookie，供后续 CAS 使用）
  const login = await iamPasswordLogin(cookieFetch, opts);

  // ② 走 CAS 换一次性票据
  const ticket = await fetchCasTicket(cookieFetch, login.returnUrl);

  // ③ 票据换会话
  const clientKey = randomClientKey();
  const encryptedClientKey = rsaPkcs1v15Encrypt(
    wrapAsPublicKeyPem(opts.ssopk),
    new TextEncoder().encode(clientKey),
  );
  const sk = await ticketAuthorize(cookieFetch, {
    ticket,
    clientKey,
    encryptedClientKeyHex: toHex(encryptedClientKey),
    clientKeyId: opts.ssopkid,
  });

  // ④ 用户与租户信息
  const tenant = await queryUserTenant(cookieFetch);

  return {
    sk,
    userId: String(login.userId),
    tenantIdStr: tenant.tenantIdStr,
    xuid: opts.xuid,
    ...(tenant.tenantId !== undefined && { tenantId: tenant.tenantId }),
  };
}

async function iamPasswordLogin(
  fetchImpl: typeof fetch,
  opts: IamLoginOptions,
): Promise<{ returnUrl: string | null; userId: number; tenantId: number }> {
  const res = await fetchImpl(IAM_LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://eaichat.ctyun.cn",
    },
    body: JSON.stringify({
      // 密码是 SHA256(明文) 的小写十六进制 —— 与云电脑链不同，不掺挑战值
      userAccount: opts.account.trim(),
      password: sha256Hex(opts.password.trim()),
      deviceCode: opts.deviceCode,
      deviceName: IAM_DEVICE_NAME,
    }),
  });

  if (!res.ok) {
    throw new Error(`IAM login HTTP ${res.status}`);
  }

  const body = await res.json() as IamLoginResponse;
  if (body.code !== 0 || !body.data) {
    throw new Error(`IAM login 失败：${body.msg ?? `code=${body.code}`}`);
  }

  // `needUpdatePassword` 为真时无法继续票据流程，需回官方页面处理
  if (body.data.needUpdatePassword === true) {
    throw new Error("IAM 要求强制修改密码，需用户到官方页面处理");
  }

  return {
    returnUrl: body.data.returnUrl ?? null,
    userId: body.data.userId,
    tenantId: body.data.tenantId,
  };
}

/**
 * 用已登录的会话走 CAS 换一次性票据。
 *
 * 实测：`/iam/login` 在部分账号上 `returnUrl` 为 `null`，票据不是登录响应
 * 直接给的，而是访问 CAS 时由服务端 302 下发在 `Location` 里。
 * `service` 必须是不带 hash 的干净 URL，否则 CAS 认不出服务并退回 IAM 首页。
 */
async function fetchCasTicket(
  fetchImpl: typeof fetch,
  returnUrl: string | null,
): Promise<string> {
  const service = returnUrl && !returnUrl.includes("#")
    ? returnUrl
    : CAS_SERVICE;

  const url = `${CAS_LOGIN_URL}?service=${encodeURIComponent(service)}`;
  const res = await fetchImpl(url, { redirect: "manual" });

  const location = res.headers.get("location") ?? "";
  const ticket = extractTicket(location);
  if (ticket) return ticket;

  // 某些部署会把票据放在正文里
  if (res.status === 200) {
    const text = await res.text();
    const m = /ticket=([^&"'\s<]+)/.exec(text);
    if (m) return m[1]!;
  }

  throw new Error(
    `CAS 未下发票据（HTTP ${res.status}，Location ${location.slice(0, 80) || "(空)"}）`,
  );
}

async function ticketAuthorize(
  fetchImpl: typeof fetch,
  opts: {
    ticket: string;
    clientKey: string;
    encryptedClientKeyHex: string;
    clientKeyId: string;
  },
): Promise<string> {
  const form = new URLSearchParams({
    loginType: "iamTicket",
    clientId: CLIENT_ID,
    iamTicket: opts.ticket,
    redirectUri: REDIRECT_URI,
    clientKey: opts.encryptedClientKeyHex,
    clientKeyId: opts.clientKeyId,
  });

  const res = await fetchImpl(TICKET_AUTHORIZE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://eaichat.ctyun.cn",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    throw new Error(`ticketAuthorize HTTP ${res.status}`);
  }

  const body = await res.json() as TicketAuthorizeResponse;
  if (body.resultCode !== 0 || !body.data?.sessionKey) {
    throw new Error(`ticketAuthorize 失败：${body.resultMsg ?? `resultCode=${body.resultCode}`}`);
  }

  return deriveSk(body.data.sessionKey, opts.clientKey);
}

/** 租户列表响应。 */
interface UserTenantResponse {
  resultCode?: number;
  data?: {
    data?: Array<{ tenantId: number; tenantIdStr: string }>;
  };
}

/**
 * 取当前租户。
 *
 * 优先级按文档 §5.3.1：URL 参数 > `currentTenantIdStr` > 本地存储 > 列表首项。
 * 这里只实现服务端能拿到的那条：列表首项。后续接入 `queryUserConfig`
 * 后可补上 `currentTenantIdStr` 分支。
 */
async function queryUserTenant(
  fetchImpl: typeof fetch,
): Promise<{ tenantIdStr: string; tenantId?: number }> {
  const res = await fetchImpl(USER_TENANT_URL, {
    headers: {
      "Accept": "application/json",
      "Origin": "https://eaichat.ctyun.cn",
    },
  });

  if (!res.ok) {
    throw new Error(`queryUserTenantInfo HTTP ${res.status}`);
  }

  const body = await res.json() as UserTenantResponse;
  const list = body.data?.data ?? [];
  const first = list[0];

  // 租户列表为空时文档要求 `currentTenant = null`，不能回退用 IAM 的 tenantId
  if (!first) {
    throw new Error("云智助手账号下没有可用租户");
  }

  return { tenantIdStr: first.tenantIdStr, tenantId: first.tenantId };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
