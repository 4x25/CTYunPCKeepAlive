/**
 * 保活核心编排：四步管线。
 *
 * ① queryConnectData ‖ connect 竞速
 * ② 前两地址轮询建 WebSocket
 * ③ Clink 握手到就绪掩码 0x0e
 * ④ 立即关闭三通道
 *
 * 硬上限 45 秒。重试必须从 ① 重来。
 */
import type { AuthContext, CtyunClient } from "./ctyun/envelope.ts";
import { getConnectData } from "./ctyun/connect.ts";
import { connect as wsConnect } from "./ctyun/ws.ts";
import { ClinkSession } from "../clink/session.ts";

export interface KeepaliveOptions {
  /** 云电脑 objId。 */
  desktopId: string;
  /** 云电脑名称（仅用于日志）。 */
  desktopName: string;
  /** 用户 ID。 */
  userId: number;
  /** 租户 ID。 */
  tenantId: number;
  /** 设备标识。 */
  deviceCode: string;
}

export interface KeepaliveResult {
  /** 是否成功（就绪掩码达到 0x0e）。 */
  success: boolean;
  /** 总耗时（毫秒）。 */
  elapsedMs: number;
  /** 就绪掩码。 */
  readyMask?: number;
  /** 失败原因。 */
  error?: string;
}

/**
 * 执行一次完整保活。
 *
 * 超时 45 秒。失败不重试（由调度层决定）。
 */
export async function keepalive(
  client: CtyunClient,
  auth: AuthContext,
  opts: KeepaliveOptions,
): Promise<KeepaliveResult> {
  const startTime = performance.now();
  const timeout = 45_000;

  try {
    // ① 获取连接信息（竞速）
    const connectData = await Promise.race([
      getConnectData(client, auth, opts.desktopId),
      sleep(timeout).then(() => null),
    ]);

    if (!connectData) {
      return {
        success: false,
        elapsedMs: elapsed(startTime),
        error: "获取连接信息失败或超时",
      };
    }

    // ② 建立 WebSocket（前两地址轮询）
    const urls = (connectData.connectMaster === 1
      ? [connectData.connectUrls[0]]
      : connectData.connectUrls.slice(0, 2)).filter((u): u is string => u !== undefined);

    let lastError: Error | null = null;
    for (const url of urls) {
      try {
        const ws = wsConnect(url, {
          protocols: ["binary"],
          headers: {
            "Origin": "https://pc.ctyun.cn",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          },
        });

        // ③ Clink 握手
        const session = new ClinkSession(ws, {
          desktopId: opts.desktopId,
          userId: opts.userId,
          tenantId: opts.tenantId,
          publicKey: connectData.publicKey,
          token: connectData.token,
          deviceCode: opts.deviceCode,
        });

        const result = await Promise.race([
          session.run(),
          sleep(timeout - elapsed(startTime)).then(() => {
            throw new Error("Clink 握手超时");
          }),
        ]);

        // ④ 成功
        const baseResult = {
          success: result.readyMask === 0x0e,
          elapsedMs: elapsed(startTime),
          readyMask: result.readyMask,
        };
        if (result.readyMask !== 0x0e) {
          return { ...baseResult, error: `就绪掩码 0x${result.readyMask.toString(16)}` };
        }
        return baseResult;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // 继续尝试下一个 URL
      }
    }

    return {
      success: false,
      elapsedMs: elapsed(startTime),
      error: lastError?.message ?? "所有连接地址失败",
    };
  } catch (err) {
    return {
      success: false,
      elapsedMs: elapsed(startTime),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsed(startTime: number): number {
  return Math.round(performance.now() - startTime);
}
