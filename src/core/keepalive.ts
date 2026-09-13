/**
 * 四步保活管线（临时占位，M1 实现）。
 *
 * M2 只需要接口签名，实际实现在 M1 补齐。
 */
import type { AuthContext, CtyunClient } from "./ctyun/envelope.ts";

export interface KeepaliveResult {
  duration: number;
  step: string;
}

/**
 * 执行一次完整保活。
 *
 * ① queryConnectData ‖ connect 竞速
 * ② connectUrl 前两地址轮询
 * ③ Clink 三通道握手（MAIN/DISPLAY/INPUTS）
 * ④ 就绪掩码 0x0e 判定
 *
 * 45s 硬上限，失败必须从 ① 重来。
 */
export async function performKeepalive(
  client: CtyunClient,
  auth: AuthContext,
  objId: string,
  objName: string,
): Promise<KeepaliveResult> {
  const start = performance.now();

  // TODO M1: 实现四步管线
  // 临时占位：模拟成功
  await new Promise((resolve) => setTimeout(resolve, 100));

  const duration = Math.round(performance.now() - start);
  return { duration, step: "completed" };
}
