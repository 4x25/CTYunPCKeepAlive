/**
 * Web 设备上下文。
 *
 * 依据 `docs/ctyun-account-auth-api.md` §3.1.1。
 *
 * 关键：`deviceCode` 必须长期持久化并复用。每次请求重新生成会被服务端视为
 * 不同客户端，导致反复触发设备绑定检查。
 *
 * 我们始终以 Windows Web 客户端身份出现（`osType=15`、Windows UA），
 * 与宿主 OS 无关 —— 接口文档 4.3 明确 `osType` 是客户端 UA 映射，
 * 不是远端桌面属性。这也是 macOS / Linux 支持几乎免费的原因。
 */
import { randomId } from "./crypto.ts";

/** 伪装用的浏览器 UA。`deviceModel` / `sysVersion` 取其第一组圆括号内子串。 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/141.0.0.0 Safari/537.36";

export const PAGE_ORIGIN = "https://pc.ctyun.cn";

/** `osType` 枚举（客户端 UA 映射，非远端桌面系统）。 */
export const OS_TYPE = {
  LINUX: 10,
  LINUX_X86: 11,
  WINDOWS: 15,
  ANDROID: 20,
  IOS: 25,
  MACOS: 30,
} as const;

export interface DeviceContext {
  /** `"web_" + 32 字符随机 ID`，长期持久化。 */
  deviceCode: string;
  deviceName: string;
  deviceModel: string;
  sysVersion: string;
  userAgent: string;
  /** 固定 `"60"`（Web）。注意 Clink 用的是 `"99"`，不要混用。 */
  deviceType: string;
  appVersion: string;
  clientVersion: string;
  appModel: string;
  softwareCode: string;
  osType: number;
}

/** 取 UA 第一组圆括号内的子串；匹配不到时返回 `"0"`。 */
export function uaParenSubstring(ua: string): string {
  return /\(([^)]*)\)/.exec(ua)?.[1] ?? "0";
}

export function newDeviceCode(): string {
  return `web_${randomId(32)}`;
}

/**
 * 构造设备上下文。传入已持久化的 `deviceCode` 以复用；缺省则新建一个，
 * 调用方有责任把它存下来。
 */
export function createDeviceContext(
  init: { deviceCode?: string; deviceName?: string; userAgent?: string } = {},
): DeviceContext {
  const userAgent = init.userAgent ?? DEFAULT_USER_AGENT;
  const model = uaParenSubstring(userAgent);
  return {
    deviceCode: init.deviceCode ?? newDeviceCode(),
    deviceName: init.deviceName ?? "Chrome",
    deviceModel: model,
    sysVersion: model,
    userAgent,
    deviceType: "60",
    appVersion: "4.0.1",
    clientVersion: "204000100",
    appModel: "2",
    softwareCode: "web_client",
    osType: OS_TYPE.WINDOWS,
  };
}
