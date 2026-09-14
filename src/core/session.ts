/**
 * 云智助手（IAM 链）会话管理。
 *
 * 只负责 IAM 链：云电脑链的凭据由调用方传入，避免同一账号重复登录。
 *
 * IAM 链的建立分两步：
 * ① `eaiSysInfo` 拿 SSO 公钥（`ssopk` / `ssopkid`）
 * ② `iamLogin` 完成 IAM 登录 → 票据 → `ticketAuthorize` → 得到内存 `sk`
 *
 * `sk` 只驻留内存，绝不持久化；Cookie 由共享的 `CookieJar` 维护
 * （IAM 与 eaichat 必须共用同一个 jar）。
 */
import type { CookieJar } from "./ctyun/cookiejar.ts";
import type { IamSession } from "./ctyun/eai/iam.ts";
import { iamLogin } from "./ctyun/eai/iam.ts";
import { getEaiSysInfo } from "./ctyun/eai/sysinfo.ts";
import type { Logger } from "./logger.ts";

/** IAM 会话有效期，与云电脑链一致（2 小时）。 */
const IAM_SESSION_LIFETIME_MS = 2 * 3600_000;

/** 每小时最多重试次数，避免连续失败打爆接口。 */
const RELOGIN_RATE_LIMIT = 3;

export interface EaiSessionOptions {
  account: string;
  password: string;
  cookieJar: CookieJar;
  /**
   * IAM 设备代码（`iam:<32 位随机>`）。
   *
   * 必须由调用方持久化后传入 —— 每次重新生成会被服务端视为新设备，
   * 反复触发设备校验。
   */
  deviceCode: string;
  /**
   * Web 设备/访问标识（`pubweb_` + UUID v4）。
   *
   * 同样必须持久化复用；它参与每个云智助手请求的 `x-eai-xuid` 头。
   */
  xuid: string;
  /** 注入用，便于单测。 */
  baseFetch?: typeof fetch;
}

export class EaiSessionManager {
  readonly #opts: EaiSessionOptions;
  readonly #log: Logger;
  readonly #baseFetch: typeof fetch;

  #session: IamSession | undefined;
  #expiredAt: number | undefined;
  #reloginAttempts: number[] = [];

  constructor(opts: EaiSessionOptions, log: Logger) {
    this.#opts = opts;
    this.#log = log;
    this.#baseFetch = opts.baseFetch ?? fetch;
  }

  /**
   * 获取有效的 IAM 会话。
   *
   * 缓存有效期内直接返回；否则重新建立（含失败重试上限）。
   */
  async getSession(): Promise<IamSession> {
    const now = Date.now();
    if (this.#session && this.#expiredAt !== undefined && now < this.#expiredAt) {
      return this.#session;
    }

    this.#checkRateLimit();
    const session = await this.#establish();
    this.#session = session;
    this.#expiredAt = Date.now() + IAM_SESSION_LIFETIME_MS;
    return session;
  }

  /** 清除缓存的会话，强制下次重新建立。 */
  clear(): void {
    this.#session = undefined;
    this.#expiredAt = undefined;
  }

  /** 会话是否仍然有效（不触发网络请求）。 */
  get isFresh(): boolean {
    return this.#session !== undefined &&
      this.#expiredAt !== undefined &&
      Date.now() < this.#expiredAt;
  }

  async #establish(): Promise<IamSession> {
    const { account, password, cookieJar, deviceCode, xuid } = this.#opts;

    // ① SSO 公钥
    const sysInfo = await getEaiSysInfo(this.#baseFetch);

    // ② IAM 登录全流程
    const session = await iamLogin(cookieJar, this.#baseFetch, {
      account,
      password,
      ssopk: sysInfo.sso.ssopk,
      ssopkid: sysInfo.sso.ssopkid,
      deviceCode,
      xuid,
    });

    this.#log.info("账号", `云智助手会话已建立：${account}`);
    return session;
  }

  #checkRateLimit(): void {
    const oneHourAgo = Date.now() - 3600_000;
    this.#reloginAttempts = this.#reloginAttempts.filter((t) => t > oneHourAgo);

    if (this.#reloginAttempts.length >= RELOGIN_RATE_LIMIT) {
      throw new Error(`云智助手重登次数超限（${RELOGIN_RATE_LIMIT} 次/小时）`);
    }
    this.#reloginAttempts.push(Date.now());
  }
}
