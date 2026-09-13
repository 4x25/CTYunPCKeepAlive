/**
 * 账号 Actor：管理单个账号的登录态、设备列表、凭据生命周期。
 *
 * 四态状态机：normal / logging-in / login-failed / intervention-required
 */
import { classifyIntervention, login, type LoginData } from "./ctyun/auth.ts";
import type { AuthContext, CtyunClient } from "./ctyun/envelope.ts";
import { listDesktops } from "./ctyun/desktops.ts";
import { establishSession } from "./ctyun/nego.ts";
import type { AccountConfig, DeviceConfig } from "./store.ts";
import { state, StateStore, type AccountSnapshot, type AccountState } from "./state.ts";
import { bus } from "./bus.ts";
import type { Logger } from "./logger.ts";

const AUTH_LIFETIME_MS = 2 * 3600_000; // 2 小时
const AUTH_REFRESH_INTERVAL_MS = 30 * 60_000; // 30 分钟刷新时间戳
const RELOGIN_RATE_LIMIT = 3; // 每小时最多 3 次

export class AccountActor {
  readonly account: string;
  readonly #client: CtyunClient;
  readonly #log: Logger;

  #config: AccountConfig;
  #state: AccountState = "normal";
  #auth?: AuthContext;
  #authExpiredAt?: number;
  #lastAuthRefresh?: number;
  #reloginAttempts: number[] = []; // 最近的重登时间戳

  constructor(config: AccountConfig, client: CtyunClient, log: Logger) {
    this.account = config.account;
    this.#config = config;
    this.#client = client;
    this.#log = log;
  }

  /** 当前配置快照 */
  getConfig(): AccountConfig {
    return structuredClone(this.#config);
  }

  /** 更新配置（不触发重登） */
  updateConfig(config: AccountConfig): void {
    this.#config = config;
  }

  /** 获取登录态（如果凭据有效） */
  getAuth(): AuthContext | undefined {
    if (!this.#auth || !this.#authExpiredAt) return undefined;

    const now = Date.now();
    // 刷新本地时间戳（不实际重登）
    if (now - (this.#lastAuthRefresh ?? 0) > AUTH_REFRESH_INTERVAL_MS) {
      this.#lastAuthRefresh = now;
      this.#log.debug("账号", `凭据时间戳刷新：${this.account}`);
    }

    if (now > this.#authExpiredAt) {
      this.#log.warn("账号", `凭据已过期：${this.account}`);
      return undefined;
    }

    return this.#auth;
  }

  /** 静默重登（带速率限制） */
  async ensureAuth(): Promise<AuthContext> {
    const existing = this.getAuth();
    if (existing) return existing;

    // 检查速率限制
    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    this.#reloginAttempts = this.#reloginAttempts.filter((t) => t > oneHourAgo);

    if (this.#reloginAttempts.length >= RELOGIN_RATE_LIMIT) {
      throw new Error(`重登次数超限（${RELOGIN_RATE_LIMIT} 次/小时）`);
    }

    this.#reloginAttempts.push(now);
    return await this.performLogin();
  }

  /** 执行登录（更新状态） */
  async performLogin(): Promise<AuthContext> {
    this.#setState("logging-in");
    bus.emit("account:login-start", { account: this.account });

    try {
      await establishSession(this.#client);
      const result = await login(this.#client, {
        account: this.#config.account,
        password: this.#config.password,
      });

      this.#auth = result.auth;
      this.#authExpiredAt = Date.now() + AUTH_LIFETIME_MS;
      this.#lastAuthRefresh = Date.now();
      this.#setState("normal");

      bus.emit("account:login-success", {
        account: this.account,
        userId: result.data.userId,
      });
      this.#log.info("账号", `登录成功：${this.account}`);

      return result.auth;
    } catch (err) {
      const kind = classifyIntervention(err);
      if (kind) {
        this.#setState("intervention-required");
        bus.emit("account:intervention-required", { account: this.account, kind });
        this.#log.error("账号", `需人工处理（${kind}）：${this.account}`);
      } else {
        this.#setState("login-failed");
        const msg = err instanceof Error ? err.message : String(err);
        bus.emit("account:login-failed", { account: this.account, error: msg });
        this.#log.error("账号", `登录失败：${this.account}`, err);
      }
      throw err;
    }
  }

  /** 刷新设备列表 */
  async refreshDevices(): Promise<void> {
    const auth = await this.ensureAuth();

    state.updateAccount(this.account, { devicesRefreshing: true });

    try {
      const result = await listDesktops(this.#client, auth);

      const devices = result.desktops.map((entry) => {
        const config = this.#config.devices[entry.objId] ?? {
          autoKeepalive: false,
          intervalMinutes: 19,
        };
        return StateStore.deviceFromEntry(entry, config);
      });

      state.setDevices(this.account, devices);
      this.#log.info("账号", `设备列表已刷新：${this.account}（${devices.length} 台）`);
    } catch (err) {
      this.#log.error("账号", `设备列表刷新失败：${this.account}`, err);
      throw err;
    } finally {
      state.updateAccount(this.account, { devicesRefreshing: false });
    }
  }

  /** 更新设备配置并持久化 */
  updateDeviceConfig(objId: string, config: Partial<DeviceConfig>): void {
    const current = this.#config.devices[objId] ?? {
      autoKeepalive: false,
      intervalMinutes: 19,
    };
    this.#config.devices[objId] = { ...current, ...config };

    state.updateDevice(this.account, objId, config);
    bus.emit("device:updated", { account: this.account, objId });
  }

  #setState(newState: AccountState): void {
    this.#state = newState;
    state.updateAccount(this.account, { state: newState });
  }

  /** 创建账号快照（供首次加载） */
  static createSnapshot(config: AccountConfig): AccountSnapshot {
    return {
      account: config.account,
      alias: config.alias ?? undefined,
      state: "normal",
      devices: [],
    };
  }
}
