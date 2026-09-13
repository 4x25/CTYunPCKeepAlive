/**
 * 账号密码登录与退出。
 *
 * 依据 `docs/ctyun-account-auth-api.md` §5–§7。
 *
 * 两个关键点：
 * - `challengeCode` 只活 60 秒，取到后必须紧接着 `login`，不得缓存复用。
 * - `code === 0` **不等于**登录完成。必须再走 §6.3 的条件状态机；只有落到
 *   最终分支才算真正登录成功。
 */
import { sha256Hex } from "./crypto.ts";
import type { AuthContext, CtyunClient } from "./envelope.ts";
import { CtyunApiError } from "./envelope.ts";

export interface ChallengeData {
  challengeCode: string;
  challengeId: string;
  effectiveSeconds: number;
}

/** 登录响应中与后续流程相关的字段。其余字段透传但不在此声明。 */
export interface LoginData {
  userId: number;
  tenantId: number;
  secretKey: string;
  timestamp: number;
  userAccount: string;
  userName: string;
  userEid: string;
  adminUser: boolean;
  bondedDevice: boolean;
  needSmsValidate: boolean;
  needUpdatePassword: boolean;
  needBindVirtualMfa: unknown | null;
  twoFaValidateType: number | null;
  mfaTicket: unknown | null;
  mobilephone?: string;
  email?: string;
  [extra: string]: unknown;
}

/** 需人工处理的分支。工具只识别并上报，不做验证码识别或自动填码。 */
export type InterventionKind =
  | "captcha"
  | "device-binding"
  | "virtual-mfa"
  | "sms-validate"
  | "email-validate"
  | "force-password-change";

/** 登录需要人工介入。触发后账号进入「需人工处理」态，全部自动任务挂起。 */
export class LoginInterventionRequired extends Error {
  constructor(readonly kind: InterventionKind, message: string) {
    super(message);
    this.name = "LoginInterventionRequired";
  }
}

/** bundle 枚举的登录错误码。不是本次抓包的响应样本，但分类依据可靠。 */
export const LOGIN_ERROR = {
  INVALID_PASSWORD: 51010,
  AUTH_LOCKED: 51020,
  INVALID_CAPTCHA: 51030,
  EXPIRE_CAPTCHA: 51031,
  NEED_CAPTCHA: 51040,
  ERROR_CAPTCHA: 51085,
  NO_PERMISSIONS: 40010,
  UNBINDING: 30060,
} as const;

const CAPTCHA_CODES: readonly number[] = [
  LOGIN_ERROR.INVALID_CAPTCHA,
  LOGIN_ERROR.EXPIRE_CAPTCHA,
  LOGIN_ERROR.NEED_CAPTCHA,
  LOGIN_ERROR.ERROR_CAPTCHA,
];

export function isCaptchaCode(code: number): boolean {
  return CAPTCHA_CODES.includes(code);
}

/** 获取密码哈希用的挑战值。有效期本次实测 60 秒。 */
export async function genChallengeData(client: CtyunClient): Promise<ChallengeData> {
  return await client.request<ChallengeData>({
    path: "/api/auth/client/genChallengeData",
    encoding: "json",
    body: {},
  });
}

/**
 * 计算登录用的两个密码字段。
 *
 * - `password = SHA256(明文 + challengeCode)`
 * - `sha256Password = SHA256(SHA256(明文) + challengeCode)`
 *
 * 都是小写十六进制，不是 Base64。
 *
 * 注意这与 IAM 链的 `SHA256(明文)` 是**两套不同算法**，不可混用。
 */
export function derivePasswordFields(
  plainPassword: string,
  challengeCode: string,
): { password: string; sha256Password: string } {
  return {
    password: sha256Hex(plainPassword + challengeCode),
    sha256Password: sha256Hex(sha256Hex(plainPassword) + challengeCode),
  };
}

export interface LoginOptions {
  account: string;
  password: string;
  /** 服务端要求图形验证码时附加。工具本身不识别验证码。 */
  captchaCode?: string;
}

/**
 * 执行一次完整登录：取挑战值 → 计算密码字段 → 提交。
 *
 * 返回的 {@link AuthContext} 已算好 `offsetTime`，可直接用于后续签名。
 */
export async function login(
  client: CtyunClient,
  opts: LoginOptions,
): Promise<{ data: LoginData; auth: AuthContext }> {
  const challenge = await genChallengeData(client);
  const { password, sha256Password } = derivePasswordFields(opts.password, challenge.challengeCode);
  const d = client.device;

  const payload: Record<string, string> = {
    // 普通账号流程会去掉 `#admin` 后缀
    userAccount: opts.account.trim().replace(/#admin$/, ""),
    password,
    sha256Password,
    challengeId: challenge.challengeId,
    deviceCode: d.deviceCode,
    deviceName: d.deviceName,
    deviceType: d.deviceType,
    deviceModel: d.deviceModel,
    appVersion: d.appVersion,
    sysVersion: d.sysVersion,
    clientVersion: d.clientVersion,
  };
  if (opts.captchaCode) payload["captchaCode"] = opts.captchaCode;

  const loginAt = Date.now();
  const data = await client.request<LoginData>({
    path: "/api/auth/client/login",
    encoding: "form",
    body: payload,
  });

  assertLoginComplete(data);

  return {
    data,
    auth: {
      userId: data.userId,
      tenantId: data.tenantId,
      secretKey: data.secretKey,
      offsetTime: loginAt - data.timestamp,
    },
  };
}

/**
 * §6.3 的条件认证状态机。
 *
 * 顺序不能改 —— 线上实现按此优先级分支。工具只识别并抛出，把处置交给用户：
 * 不做验证码识别，也不自动填二次验证码。
 */
export function assertLoginComplete(data: LoginData): void {
  if (data.bondedDevice === false) {
    throw new LoginInterventionRequired(
      "device-binding",
      "当前设备未绑定，需要在官方客户端完成设备绑定",
    );
  }
  if (data.twoFaValidateType === 5) {
    throw new LoginInterventionRequired("virtual-mfa", "账号已开启虚拟 MFA，需要输入动态验证码");
  }
  if (data.needSmsValidate === true) {
    // twoFaValidateType === 4 表示走邮箱，其余走短信
    const viaEmail = data.twoFaValidateType === 4;
    throw new LoginInterventionRequired(
      viaEmail ? "email-validate" : "sms-validate",
      viaEmail ? "账号需要邮箱二次验证" : "账号需要短信二次验证",
    );
  }
  if (data.needUpdatePassword === true) {
    throw new LoginInterventionRequired("force-password-change", "账号被要求强制修改密码");
  }
}

/** 把登录异常翻译成需人工处理分支；不属于该类则原样返回 `undefined`。 */
export function classifyIntervention(err: unknown): InterventionKind | undefined {
  if (err instanceof LoginInterventionRequired) return err.kind;
  if (err instanceof CtyunApiError && isCaptchaCode(err.code)) return "captcha";
  return undefined;
}

/**
 * 注销服务端登录态。
 *
 * 该请求无请求体，但必须携带 `CTG-USERID` / `CTG-TENANTID` / `CTG-SIGNATURESTR`。
 * 调用方应分别记录「服务端退出成功」与「本地登录态已清除」—— 后者无论前者
 * 成功与否都要执行。
 */
export async function logout(client: CtyunClient, auth: AuthContext): Promise<boolean> {
  const ok = await client.request<boolean>({
    path: "/api/auth/client/logout",
    encoding: "none",
    auth,
  });
  return ok === true;
}
