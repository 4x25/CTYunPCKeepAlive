/**
 * IAM 登录链路。
 *
 * 依据 `docs/ctyun-eaichat-api.md` §4。
 *
 * 这是云智助手的认证体系，与云电脑链完全分离：
 * - 密码算法不同：IAM 用 `SHA256(明文)`，云电脑用 `SHA256(明文 + challengeCode)`
 * - 需要 Cookie：IAM 写入的会话 Cookie 必须带到后续的 `ticketAuthorize`
 * - RSA 加密 `clientKey`：用 sysinfo 拿到的公钥（PKCS#1 v1.5，与 Clink 的 OAEP 不同）
 * - 最终产物是内存 `sk`，用于云智助手 API 的 `Web-Signature` 签名
 */
import { createPublicKey, publicEncrypt } from "node:crypto";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { sha256Hex } from "../crypto.ts";
import type { CookieJar } from "../cookiejar.ts";
import { createCookieFetch } from "../cookiejar.ts";

const SYSINFO_KEY = Buffer.from("chinatelecom@cnn", "utf8");
const NO_IV = Buffer.alloc(0);

export interface IamLoginOptions {
  account: string;
  password: string;
  ssopk: string;
  ssopkid: string;
}

export interface IamSession {
  /** 内存签名密钥，用于后续云智助手 API 的 `Web-Signature`。 */
  sk: string;
  /** 用户 ID（可能与云电脑链的 userId 不同）。 */
  userId: string;
  /** 租户 ID 字符串（云智助手 API 用这个，不是数字）。 */
  tenantIdStr: string;
}

/**
 * 完整 IAM 登录流程。
 *
 * ① IAM login → 拿到 returnUrl（含一次性 ticket）
 * ② 访问 returnUrl → 跳转回 eaichat，服务端写入会话 Cookie
 * ③ 生成随机 clientKey 并用 ssopk 加密
 * ④ ticketAuthorize（带 Cookie + 加密 clientKey）→ 拿到加密的 sk
 * ⑤ 用 clientKey 解密 sk → 得到内存签名密钥
 * ⑥ 初始化用户/租户信息
 */
export async function iamLogin(
  jar: CookieJar,
  baseFetch: typeof fetch,
  opts: IamLoginOptions,
): Promise<IamSession> {
  const cookieFetch = createCookieFetch(jar, baseFetch);

  // ① IAM login
  const ticket = await iamLoginStep(cookieFetch, opts.account, opts.password);

  // ② 访问 returnUrl（服务端写入 Cookie）
  await cookieFetch(ticket.returnUrl, { redirect: "manual" });

  // ③④⑤ ticketAuthorize + 解密 sk
  const clientKey = randomClientKey();
  const encryptedClientKey = rsaPkcs1v15Encrypt(opts.ssopk, clientKey);
  const sk = await ticketAuthorize(cookieFetch, {
    ticket: ticket.ticket,
    ssopkid: opts.ssopkid,
    clientKey: encryptedClientKey,
    decryptionKey: clientKey,
  });

  // ⑥ 初始化（拿 userId / tenantIdStr）
  const userInfo = await queryUserInfo(cookieFetch);

  return {
    sk,
    userId: userInfo.userId,
    tenantIdStr: userInfo.tenantIdStr,
  };
}

interface IamLoginResponse {
  returnCode: string;
  returnMessage: string;
  returnUrl: string;
}

async function iamLoginStep(
  fetch: typeof globalThis.fetch,
  account: string,
  password: string,
): Promise<{ returnUrl: string; ticket: string }> {
  const url = "https://desk.ctyun.cn/iam/login";
  const body = new URLSearchParams({
    account,
    password: sha256Hex(password), // 注意：与云电脑链算法不同
    platform: "pc",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "Origin": "https://eaichat.ctyun.cn",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`IAM login HTTP ${res.status}`);
  }

  const data = await res.json() as IamLoginResponse;
  if (data.returnCode !== "0") {
    throw new Error(`IAM login failed: ${data.returnMessage} (${data.returnCode})`);
  }

  // returnUrl 形如 https://eaichat.ctyun.cn/sso/login/v2/iam/auth?ticket=xxxxx
  const ticketParam = new URL(data.returnUrl).searchParams.get("ticket");
  if (!ticketParam) {
    throw new Error("IAM login returnUrl 缺少 ticket 参数");
  }

  return { returnUrl: data.returnUrl, ticket: ticketParam };
}

interface TicketAuthorizeResponse {
  resultCode: string;
  resultMessage: string;
  loginInfo: string; // Base64 + AES-ECB 加密的 JSON，含 sk
}

async function ticketAuthorize(
  fetch: typeof globalThis.fetch,
  opts: {
    ticket: string;
    ssopkid: string;
    clientKey: string; // RSA 加密后的 Base64
    decryptionKey: string; // 解密 sk 用的明文 clientKey
  },
): Promise<string> {
  const url = "https://eaichat.ctyun.cn/sso/login/v2/iam/ticketAuthorize";
  const body = {
    ticket: opts.ticket,
    ssopkid: opts.ssopkid,
    clientKey: opts.clientKey,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Origin": "https://eaichat.ctyun.cn",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`ticketAuthorize HTTP ${res.status}`);
  }

  const data = await res.json() as TicketAuthorizeResponse;
  if (data.resultCode !== "0") {
    throw new Error(`ticketAuthorize failed: ${data.resultMessage} (${data.resultCode})`);
  }

  // loginInfo 是 Base64 字符串，内容是 AES-ECB 加密的 JSON
  const decrypted = aesEcbDecrypt(data.loginInfo, opts.decryptionKey);
  const parsed = JSON.parse(decrypted) as { sk: string };
  return parsed.sk;
}

interface UserInfoResponse {
  resultCode: string;
  resultMessage: string;
  userId: string;
  tenantIdStr: string;
}

async function queryUserInfo(fetch: typeof globalThis.fetch): Promise<{
  userId: string;
  tenantIdStr: string;
}> {
  const url = "https://eaichat.ctyun.cn/api/v1/user/queryUserInfo";
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Origin": "https://eaichat.ctyun.cn",
    },
  });

  if (!res.ok) {
    throw new Error(`queryUserInfo HTTP ${res.status}`);
  }

  const data = await res.json() as UserInfoResponse;
  if (data.resultCode !== "0") {
    throw new Error(`queryUserInfo failed: ${data.resultMessage} (${data.resultCode})`);
  }

  return {
    userId: data.userId,
    tenantIdStr: data.tenantIdStr,
  };
}

/** 生成 16 字节随机 clientKey（AES-128）。 */
function randomClientKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** RSA-PKCS#1 v1.5 加密（与 Clink 的 OAEP 不同）。 */
function rsaPkcs1v15Encrypt(publicKeyPem: string, plain: string): string {
  const key = createPublicKey({ key: publicKeyPem, format: "pem" });
  const encrypted = publicEncrypt(
    { key, padding: 1 }, // 1 = RSA_PKCS1_PADDING
    Buffer.from(plain, "utf8"),
  );
  return encrypted.toString("base64");
}

/** AES-ECB 解密（用 clientKey 解 sk）。 */
function aesEcbDecrypt(cipherBase64: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const decipher = createDecipheriv("aes-128-ecb", key, NO_IV);
  let plain = decipher.update(cipherBase64, "base64", "utf8");
  plain += decipher.final("utf8");
  return plain;
}
