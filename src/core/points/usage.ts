/**
 * 积分任务 1003「使用 1 小时」。
 *
 * 依据需求稿 §4 与 `docs/ctyun-clink-websocket-handshake.md`。
 *
 * 关键约束：
 * - **只补剩余时长**：先读进度，`ceil(remaining / 60) × 60 + 60`
 *   （按分钟向上取整再留 60 秒余量 —— 上游没证明过服务端怎么算）
 * - 每 5 分钟重读进度，**接口值永远覆盖本地**
 * - 必须应答 `SET_ACK` → `ACK_SYNC`，并持续排空消息
 * - 被踢（会话冲突 `auth_code=7`）**不重连不回收**；网络掉线重连 3 次
 *   （5/15/45 秒退避），每次重新竞速连接信息并重读进度
 * - 与周期保活互斥（由调度层保证）
 */

export interface UsageProgress {
  /** 已获得的秒数。 */
  currentProgress: number;
  /** 目标秒数（3600）。 */
  totalProgress: number;
}

/** 1 小时任务的目标秒数。 */
export const USAGE_TARGET_SECONDS = 3600;

/** 进度重读间隔（毫秒）。 */
export const PROGRESS_POLL_INTERVAL_MS = 5 * 60_000;

/** 网络掉线重连退避（毫秒）。 */
export const RECONNECT_BACKOFF_MS = [5_000, 15_000, 45_000];

/**
 * 计算本轮需要保持的时长。
 *
 * 公式来自需求稿：`ceil(remaining / 60) × 60 + 60`。
 * 剩余不足 1 分钟时也至少保持 60 秒，避免「已达标但服务端还没记账」。
 */
export function computeHoldSeconds(currentProgress: number, totalProgress: number): number {
  const remaining = Math.max(0, totalProgress - currentProgress);
  if (remaining === 0) return 0;
  // 按分钟向上取整，再留 60 秒余量
  return Math.ceil(remaining / 60) * 60 + 60;
}

/** 是否已达标。 */
export function isComplete(progress: UsageProgress): boolean {
  return progress.currentProgress >= progress.totalProgress;
}

/** 任务 1003 会话被踢。**不重连、不回收**。 */
export class SessionKickedError extends Error {
  constructor(message = "会话被其他客户端占用") {
    super(message);
    this.name = "SessionKickedError";
  }
}

export interface UsageHolderOptions {
  /** 读当前进度。 */
  readProgress: () => Promise<UsageProgress>;
  /** 建立一次保持型连接，返回可等待其结束的句柄。 */
  openHold: () => Promise<{ waitClosed: () => Promise<void>; close: () => void }>;
  /** 注入用。 */
  sleep?: (ms: number) => Promise<void>;
  /** 注入用，便于测试。 */
  now?: () => number;
  /** 进度变化的回调（UI 用）。 */
  onProgress?: (p: UsageProgress) => void;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface UsageHoldResult {
  /** 最终进度。 */
  progress: UsageProgress;
  /** 是否达成目标。 */
  completed: boolean;
  /** 本次实际保持的总秒数。 */
  heldSeconds: number;
  /** 是否因被踢而中止。 */
  kicked: boolean;
}

/**
 * 保持连接直到累计进度达标。
 *
 * 流程：读进度 → 算剩余 → 保持 → 每 5 分钟重读 → 达标即结束。
 * 网络掉线按退避重连，每次重连后**重新读进度**（服务端才是权威）。
 */
export async function holdForUsage(
  opts: UsageHolderOptions,
): Promise<UsageHoldResult> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const log = opts.log;

  const startedAt = now();
  let progress = await opts.readProgress();
  opts.onProgress?.(progress);

  // 达标就直接返回 —— 不重复占用连接
  if (isComplete(progress)) {
    return { progress, completed: true, heldSeconds: 0, kicked: false };
  }

  const holdSeconds = computeHoldSeconds(progress.currentProgress, progress.totalProgress);
  log?.info(
    `需补 ${Math.round((progress.totalProgress - progress.currentProgress) / 60)} 分钟，` +
      `本轮保持 ${holdSeconds} 秒`,
  );

  let reconnectAttempt = 0;
  let heldMillis = 0;

  while (heldMillis < holdSeconds * 1000) {
    let handle: { waitClosed: () => Promise<void>; close: () => void };
    try {
      handle = await opts.openHold();
      reconnectAttempt = 0; // 连上就重置退避
    } catch (err) {
      // 被踢：不重连
      if (err instanceof SessionKickedError) {
        log?.warn("会话被占用，停止 1 小时任务（不重连）");
        return { progress, completed: false, heldSeconds: Math.round(heldMillis / 1000), kicked: true };
      }

      // 网络类失败：退避重试，最多 3 次
      const backoff = RECONNECT_BACKOFF_MS[reconnectAttempt];
      if (backoff === undefined) {
        log?.error("重连次数已用尽，1 小时任务中断");
        return { progress, completed: false, heldSeconds: Math.round(heldMillis / 1000), kicked: false };
      }
      reconnectAttempt++;
      log?.warn(`连接失败，${backoff / 1000} 秒后重试（第 ${reconnectAttempt} 次）`);
      await sleep(backoff);
      continue;
    }

    const connectAt = now();

    // 每 5 分钟重读一次进度（接口值覆盖本地）
    const checkProgress = async () => {
      try {
        const fresh = await opts.readProgress();
        progress = fresh;
        opts.onProgress?.(fresh);

        if (isComplete(fresh)) {
          handle.close();
        }
      } catch (err) {
        // 读进度失败只记 WARN，不影响保持
        log?.warn(`读取进度失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const progressTimer = setInterval(() => {
      void checkProgress();
    }, PROGRESS_POLL_INTERVAL_MS);

    try {
      await handle.waitClosed();
    } finally {
      clearInterval(progressTimer);
    }

    heldMillis += now() - connectAt;

    if (isComplete(progress)) break;

    // 连接断开但未达标：若是被踢则不再继续
    if (heldMillis < holdSeconds * 1000) {
      log?.warn("连接提前断开，准备重连");
      const backoff = RECONNECT_BACKOFF_MS[reconnectAttempt] ?? RECONNECT_BACKOFF_MS.at(-1)!;
      reconnectAttempt++;
      await sleep(backoff);
    }
  }

  // 收尾重读，让结果反映服务端的最终判定
  try {
    progress = await opts.readProgress();
    opts.onProgress?.(progress);
  } catch {
    // 忽略：用已知的最后一次进度
  }

  const heldSeconds = Math.round((now() - startedAt) / 1000);
  const completed = isComplete(progress);
  log?.info(completed ? `1 小时任务达标（累计 ${progress.currentProgress} 秒）` : "1 小时任务未达标");

  return { progress, completed, heldSeconds, kicked: false };
}
