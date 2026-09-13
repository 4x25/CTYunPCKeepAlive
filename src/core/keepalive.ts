/**
 * 保活编排：把 M1 的四步管线包装成 Runtime 需要的形状。
 *
 * 协议细节全部在 `keepalive-core.ts`，这里只做参数适配与结果转换。
 */
import type { AuthContext, CtyunClient } from "./ctyun/envelope.ts";
import { keepalive as runPipeline, type KeepaliveResult } from "./keepalive-core.ts";

export type { KeepaliveResult };

/** 保活失败。带明确的步骤名，便于上层分类与日志定位。 */
export class KeepaliveError extends Error {
  constructor(
    message: string,
    readonly step: string,
    readonly readyMask?: number,
  ) {
    super(message);
    this.name = "KeepaliveError";
  }
}

/**
 * 执行一次完整保活。
 *
 * 成功返回耗时；失败抛 {@link KeepaliveError}（上层据此分类重试）。
 */
export async function performKeepalive(
  client: CtyunClient,
  auth: AuthContext,
  objId: string,
  objName: string,
): Promise<{ duration: number }> {
  const result = await runPipeline(client, auth, {
    desktopId: objId,
    desktopName: objName,
    userId: auth.userId,
    tenantId: auth.tenantId,
    deviceCode: client.device.deviceCode,
  });

  if (!result.success) {
    throw new KeepaliveError(
      result.error ?? "保活失败",
      classifyStep(result),
      result.readyMask,
    );
  }

  return { duration: result.elapsedMs };
}

/**
 * 从结果推断失败步骤。
 *
 * 就绪掩码能区分「连上了但通道没齐」和「根本没连上」——
 * 前者是协议类问题，后者是连接信息或 WebSocket 层的问题。
 */
function classifyStep(result: KeepaliveResult): string {
  if (result.readyMask === undefined) return "connect-info";
  const missing: string[] = [];
  if (!(result.readyMask & 0x02)) missing.push("MAIN");
  if (!(result.readyMask & 0x04)) missing.push("DISPLAY");
  if (!(result.readyMask & 0x08)) missing.push("INPUTS");
  return missing.length > 0 ? `channels:${missing.join(",")}` : "unknown";
}
