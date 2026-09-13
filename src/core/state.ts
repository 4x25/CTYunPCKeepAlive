/**
 * 全局状态快照。
 *
 * 记录所有账号和设备的当前状态，供 UI 渲染和事件总线推送。
 */
import type { DesktopEntry } from "./ctyun/desktops.ts";

export type AccountState = "normal" | "logging-in" | "login-failed" | "intervention-required";

export interface AccountSnapshot {
  account: string;
  alias?: string | undefined;
  state: AccountState;
  /** 登录失败时的错误信息 */
  error?: string | undefined;
  /** 需人工处理的类型 */
  interventionKind?: string | undefined;
  /** 凭据过期时间（毫秒时间戳） */
  authExpiredAt?: number | undefined;
  /** 用户 ID（登录成功后） */
  userId?: number | undefined;
  /** 租户 ID（登录成功后） */
  tenantId?: number | undefined;
  /** 设备列表最后刷新时间 */
  devicesRefreshedAt?: number | undefined;
  /** 设备列表是否正在刷新 */
  devicesRefreshing?: boolean | undefined;
  /** 设备列表 */
  devices: DeviceSnapshot[];
}

export interface DeviceSnapshot {
  objId: string;
  name: string;
  osName?: string | undefined;
  isRunning: boolean;
  isForbidden: boolean;
  needLineUp: boolean;
  /** 自动保活开关 */
  autoKeepalive: boolean;
  /** 保活间隔（分钟） */
  intervalMinutes: number;
  /** 下次保活时间（毫秒时间戳，null 表示未调度） */
  nextKeepaliveAt: number | null;
  /** 保活状态 */
  keepaliveState: "idle" | "running" | "success" | "failed";
  /** 最后保活时间 */
  lastKeepaliveAt?: number | undefined;
  /** 最后保活耗时（毫秒） */
  lastKeepaliveDuration?: number | undefined;
  /** 最后保活错误 */
  lastKeepaliveError?: string | undefined;
}

export interface GlobalState {
  accounts: AccountSnapshot[];
  /** 单调递增的版本号,每次状态变更 +1 */
  revision: number;
}

export class StateStore {
  private state: GlobalState = {
    accounts: [],
    revision: 0,
  };

  getSnapshot(): GlobalState {
    return structuredClone(this.state);
  }

  updateAccount(account: string, updates: Partial<AccountSnapshot>): void {
    const idx = this.state.accounts.findIndex((a) => a.account === account);
    if (idx === -1) return;

    this.state.accounts[idx] = { ...this.state.accounts[idx]!, ...updates };
    this.state.revision++;
  }

  updateDevice(
    account: string,
    objId: string,
    updates: Partial<DeviceSnapshot>,
  ): void {
    const acc = this.state.accounts.find((a) => a.account === account);
    if (!acc) return;

    const idx = acc.devices.findIndex((d) => d.objId === objId);
    if (idx === -1) return;

    acc.devices[idx] = { ...acc.devices[idx]!, ...updates };
    this.state.revision++;
  }

  addAccount(snapshot: AccountSnapshot): void {
    this.state.accounts.push(snapshot);
    this.state.revision++;
  }

  removeAccount(account: string): void {
    this.state.accounts = this.state.accounts.filter((a) => a.account !== account);
    this.state.revision++;
  }

  setDevices(account: string, devices: DeviceSnapshot[]): void {
    const acc = this.state.accounts.find((a) => a.account === account);
    if (!acc) return;

    acc.devices = devices;
    acc.devicesRefreshedAt = Date.now();
    this.state.revision++;
  }

  getAccount(account: string): AccountSnapshot | undefined {
    return this.state.accounts.find((a) => a.account === account);
  }

  getDevice(account: string, objId: string): DeviceSnapshot | undefined {
    const acc = this.getAccount(account);
    return acc?.devices.find((d) => d.objId === objId);
  }

  /** 从 DesktopEntry 创建初始设备快照 */
  static deviceFromEntry(
    entry: DesktopEntry,
    config: { autoKeepalive: boolean; intervalMinutes: number },
  ): DeviceSnapshot {
    return {
      objId: entry.objId,
      name: entry.name,
      osName: entry.osName,
      isRunning: entry.isRunning,
      isForbidden: entry.isForbidden,
      needLineUp: entry.needLineUp,
      autoKeepalive: config.autoKeepalive,
      intervalMinutes: config.intervalMinutes,
      nextKeepaliveAt: null,
      keepaliveState: "idle",
    };
  }
}

export const state = new StateStore();
