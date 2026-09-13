/**
 * 运行时：多账号 + 自动保活 + 配置持久化。
 *
 * 统一入口，管理账号生命周期、调度器、配置同步。
 */
import { AccountActor } from "./account.ts";
import { Scheduler } from "./scheduler.ts";
import { state, type AccountSnapshot } from "./state.ts";
import { bus } from "./bus.ts";
import { loadConfig, saveConfig, type AccountConfig, type Config } from "./store.ts";
import { Logger } from "./logger.ts";
import { CtyunClient } from "./ctyun/envelope.ts";
import { createDeviceContext } from "./ctyun/device.ts";
import { createBrowserFetch } from "./ctyun/http.ts";
import { performKeepalive } from "./keepalive.ts";

const MAX_ACCOUNTS = 10;
const DEFAULT_INTERVAL_MINUTES = 19;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 59;
const JITTER_MAX_MS = 20_000; // 0-20s 随机抖动

export class Runtime {
  readonly #log: Logger;
  readonly #scheduler: Scheduler;
  readonly #accounts = new Map<string, AccountActor>();
  readonly #clients = new Map<string, CtyunClient>();
  #config: Config;
  #autoSaveTimer?: number;

  private constructor(config: Config, log: Logger) {
    this.#config = config;
    this.#log = log;
    this.#scheduler = new Scheduler(log);

    // 监听事件并自动保存配置
    bus.on("device:updated", () => this.#scheduleAutoSave());
  }

  /** 从配置文件启动。传入 logger 时复用它（服务端需要把日志接到 SSE）。 */
  static async start(logger?: Logger): Promise<Runtime> {
    const config = await loadConfig();
    sanitizeConfig(config);
    const log = logger ?? new Logger({ verbose: true });
    const runtime = new Runtime(config, log);

    // 加载所有账号
    for (const accConfig of config.accounts) {
      try {
        await runtime.addAccount(accConfig, { skipSave: true });
      } catch (err) {
        log.error("系统", `加载账号失败：${accConfig.account}`, err);
      }
    }

    log.info("系统", `运行时已启动，共 ${config.accounts.length} 个账号`);
    return runtime;
  }

  /** 添加账号 */
  async addAccount(
    config: AccountConfig,
    opts: { skipSave?: boolean } = {},
  ): Promise<void> {
    // 检查上限
    if (this.#accounts.size >= MAX_ACCOUNTS) {
      throw new Error(`账号数量已达上限（${MAX_ACCOUNTS}）`);
    }

    const { account } = config;

    // 创建客户端和 Actor
    const device = createDeviceContext();
    const client = new CtyunClient(device, createBrowserFetch({ timeoutMs: 15_000 }));
    const actor = new AccountActor(config, client, this.#log);

    this.#clients.set(account, client);
    this.#accounts.set(account, actor);

    // 添加到状态
    const snapshot = AccountActor.createSnapshot(config);
    state.addAccount(snapshot);

    // 持久化
    if (!opts.skipSave) {
      this.#config.accounts.push(config);
      await this.#saveConfig();
    }

    bus.emit("account:added", { account });
    this.#log.info("账号", `账号已添加：${account}`);

    // 立即刷新设备列表
    try {
      await actor.refreshDevices();
      // 启动时补跑超期对象
      this.#catchupDevices(account);
    } catch (err) {
      this.#log.warn("账号", `首次刷新设备失败：${account}`, err);
    }
  }

  /** 删除账号 */
  async removeAccount(account: string): Promise<void> {
    const actor = this.#accounts.get(account);
    if (!actor) return;

    // 取消所有调度
    const snapshot = state.getAccount(account);
    if (snapshot) {
      for (const device of snapshot.devices) {
        this.#scheduler.cancel(account, device.objId);
      }
    }

    // 清理
    this.#accounts.delete(account);
    this.#clients.delete(account);
    state.removeAccount(account);

    // 持久化
    this.#config.accounts = this.#config.accounts.filter((c) => c.account !== account);
    await this.#saveConfig();

    bus.emit("account:removed", { account });
    this.#log.info("账号", `账号已删除：${account}`);
  }

  /** 更新账号别名 */
  async updateAccountAlias(account: string, alias: string): Promise<void> {
    const actor = this.#accounts.get(account);
    if (!actor) throw new Error(`账号不存在：${account}`);

    const config = actor.getConfig();
    config.alias = alias;
    actor.updateConfig(config);

    state.updateAccount(account, { alias: alias || undefined });
    await this.#saveConfig();
    this.#log.info("账号", `别名已更新：${account} -> ${alias || "(无)"}`);
  }

  /** 更新设备自动保活配置 */
  async setAutoKeepalive(account: string, objId: string, enabled: boolean): Promise<void> {
    const actor = this.#accounts.get(account);
    if (!actor) throw new Error(`账号不存在：${account}`);

    const device = state.getDevice(account, objId);
    if (!device) throw new Error(`设备不存在：${objId}`);

    actor.updateDeviceConfig(objId, { autoKeepalive: enabled });

    if (enabled) {
      // 立即执行一次
      await this.#scheduleKeepalive(account, objId, 0);
    } else {
      // 取消调度
      this.#scheduler.cancel(account, objId);
      state.updateDevice(account, objId, { nextKeepaliveAt: null });
    }

    await this.#saveConfig();
  }

  /** 更新设备保活间隔 */
  async setKeepaliveInterval(
    account: string,
    objId: string,
    intervalMinutes: number,
  ): Promise<void> {
    if (
      !Number.isInteger(intervalMinutes) ||
      intervalMinutes < MIN_INTERVAL_MINUTES ||
      intervalMinutes > MAX_INTERVAL_MINUTES
    ) {
      throw new Error(
        `间隔必须是 ${MIN_INTERVAL_MINUTES}-${MAX_INTERVAL_MINUTES} 的整数`,
      );
    }

    const actor = this.#accounts.get(account);
    if (!actor) throw new Error(`账号不存在：${account}`);

    actor.updateDeviceConfig(objId, { intervalMinutes });
    await this.#saveConfig();
  }

  /** 手动触发保活 */
  async triggerKeepalive(account: string, objId: string): Promise<void> {
    await this.#scheduleKeepalive(account, objId, 0);
  }

  /** 刷新设备列表 */
  async refreshDevices(account: string): Promise<void> {
    const actor = this.#accounts.get(account);
    if (!actor) throw new Error(`账号不存在：${account}`);

    await actor.refreshDevices();
  }

  /** 调度保活任务（带抖动） */
  #scheduleKeepalive(account: string, objId: string, delayMinutes: number): Promise<void> {
    const actor = this.#accounts.get(account);
    const client = this.#clients.get(account);
    if (!actor || !client) return Promise.resolve();

    const device = state.getDevice(account, objId);
    if (!device) return Promise.resolve();

    // 防御：非有限或越界的间隔会产生 NaN 的 scheduledAt，
    // 而 `NaN > now` 恒为 false，会让任务无限重排打满 CPU。
    const minutes = Number.isFinite(delayMinutes) && delayMinutes > 0
      ? Math.min(delayMinutes, MAX_INTERVAL_MINUTES)
      : 0;

    // 添加随机抖动
    const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
    const delay = minutes * 60_000 + jitter;
    const scheduledAt = Date.now() + delay;

    const task = {
      id: `${account}:${objId}:${scheduledAt}`,
      account,
      objId,
      scheduledAt,
      priority: delayMinutes === 0 ? 0 : 1, // 手动触发优先级高
      execute: async () => {
        // 关机 / 禁止连接 / 需排队的设备：跳过本轮，且不重试。
        // 需求稿明确「从不代为开机」，反复重试只会刷屏失败日志。
        const fresh = state.getDevice(account, objId);
        if (fresh && (!fresh.isRunning || fresh.isForbidden)) {
          const reason = fresh.isForbidden ? "设备禁止连接" : "设备已关机";
          this.#log.info("调度", `跳过保活：${fresh.name}（${reason}）`);
          state.updateDevice(account, objId, { keepaliveState: "idle" });
          // 仍安排下一次，等设备开机后能自动恢复
          if (fresh.autoKeepalive) {
            await this.#scheduleKeepalive(account, objId, fresh.intervalMinutes);
          }
          return;
        }

        const auth = await actor.ensureAuth();
        state.updateDevice(account, objId, { keepaliveState: "running" });

        try {
          const result = await performKeepalive(client, auth, objId, device.name);
          state.updateDevice(account, objId, {
            keepaliveState: "success",
            lastKeepaliveAt: Date.now(),
            lastKeepaliveDuration: result.duration,
          });

          // 自动保活：调度下一次
          if (device.autoKeepalive) {
            await this.#scheduleKeepalive(account, objId, device.intervalMinutes);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          state.updateDevice(account, objId, {
            keepaliveState: "failed",
            lastKeepaliveAt: Date.now(),
            lastKeepaliveError: msg,
          });

          // 手动触发失败时把错误抛给调用方；自动保活失败仅记录，并由下方重排下一轮
          if (device.autoKeepalive) {
            await this.#scheduleKeepalive(account, objId, device.intervalMinutes);
          }
          throw err;
        }
      },
    };

    state.updateDevice(account, objId, { nextKeepaliveAt: scheduledAt });
    this.#scheduler.schedule(task);
    return Promise.resolve();
  }

  /** 启动时补跑超期对象 */
  #catchupDevices(account: string): void {
    const snapshot = state.getAccount(account);
    if (!snapshot) return;

    const now = Date.now();
    for (const device of snapshot.devices) {
      if (!device.autoKeepalive) continue;

      // 如果上次保活时间 + 间隔 < 现在，说明超期了
      const shouldRunAt = (device.lastKeepaliveAt ?? 0) + device.intervalMinutes * 60_000;
      if (shouldRunAt < now) {
        this.#log.info("调度", `补跑超期设备：${account} / ${device.name}`);
        this.#scheduleKeepalive(account, device.objId, 0);
      }
    }
  }

  /** 延迟保存配置（防抖） */
  #scheduleAutoSave(): void {
    if (this.#autoSaveTimer) clearTimeout(this.#autoSaveTimer);
    this.#autoSaveTimer = setTimeout(() => {
      this.#saveConfig().catch((err) => {
        this.#log.error("系统", "自动保存配置失败", err);
      });
    }, 1000) as unknown as number;
  }

  async #saveConfig(): Promise<void> {
    // 同步当前 Actor 配置到 config
    for (const [account, actor] of this.#accounts) {
      const idx = this.#config.accounts.findIndex((c) => c.account === account);
      if (idx !== -1) {
        this.#config.accounts[idx] = actor.getConfig();
      }
    }

    await saveConfig(this.#config);
  }

  /** 获取状态快照 */
  getState() {
    return state.getSnapshot();
  }

  /** 获取日志记录 */
  getLogs() {
    return this.#log.records();
  }
}

/**
 * 清洗配置中的非法值。
 *
 * 进程崩溃或用户手改都可能留下坏数据；`NaN` / 越界的间隔会让调度器
 * 陷入无限重排，必须在进入调度前修掉。
 */
function sanitizeConfig(config: Config): void {
  for (const account of config.accounts) {
    for (const [objId, device] of Object.entries(account.devices ?? {})) {
      const minutes = device.intervalMinutes;
      if (
        !Number.isInteger(minutes) ||
        minutes < MIN_INTERVAL_MINUTES ||
        minutes > MAX_INTERVAL_MINUTES
      ) {
        device.intervalMinutes = DEFAULT_INTERVAL_MINUTES;
        console.warn(
          `[配置] 设备 ${objId} 的间隔非法（${minutes}），已重置为 ${DEFAULT_INTERVAL_MINUTES}`,
        );
      }
    }
  }
}
