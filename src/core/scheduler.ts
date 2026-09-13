/**
 * 全局调度器：时间轮 + 优先级队列 + 并发控制。
 *
 * - 全局并发 2，单账号并发 1
 * - 队列容量 50
 * - 睡眠/唤醒漂移检测
 * - 离线检测暂停出队
 */
import { bus } from "./bus.ts";
import { classifyError, formatErrorForUser } from "./errors.ts";
import type { Logger } from "./logger.ts";

export interface ScheduledTask {
  id: string;
  account: string;
  objId: string;
  scheduledAt: number;
  /** 优先级，数字越小越优先 */
  priority: number;
  execute: () => Promise<void>;
}

interface TaskResult {
  success: boolean;
  duration: number;
  error?: string;
}

const MAX_CONCURRENT = 2;
const QUEUE_CAPACITY = 50;
const CLOCK_DRIFT_THRESHOLD = 60_000; // 60 秒
const OFFLINE_CHECK_INTERVAL = 10_000; // 10 秒检测一次
const OFFLINE_RESUME_DELAY = 5_000; // 恢复后延迟 5 秒

export class Scheduler {
  readonly #log: Logger;
  readonly #queue: ScheduledTask[] = [];
  readonly #running = new Map<string, Promise<TaskResult>>();
  readonly #accountLocks = new Set<string>();
  #lastClockCheck = Date.now();
  #isPaused = false;
  #timerId?: number;

  constructor(log: Logger) {
    this.#log = log;
    this.#startClockMonitor();
    this.#startOfflineMonitor();
    this.#startQueuePoller();
  }

  /** 调度任务（带去重） */
  schedule(task: ScheduledTask): boolean {
    // 检查容量
    if (this.#queue.length >= QUEUE_CAPACITY) {
      this.#log.warn("调度", `队列已满（${QUEUE_CAPACITY}），丢弃任务：${task.id}`);
      return false;
    }

    // 去重：同一 account + objId 只保留最近的一次
    const existing = this.#queue.findIndex(
      (t) => t.account === task.account && t.objId === task.objId,
    );
    if (existing !== -1) {
      this.#queue.splice(existing, 1);
    }

    // 插入并按优先级排序（优先级相同按时间）
    this.#queue.push(task);
    this.#queue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.scheduledAt - b.scheduledAt;
    });

    this.#tryDequeue();
    return true;
  }

  /** 取消任务 */
  cancel(account: string, objId: string): boolean {
    const idx = this.#queue.findIndex((t) => t.account === account && t.objId === objId);
    if (idx !== -1) {
      this.#queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  /** 尝试出队并执行 */
  #tryDequeue(): void {
    if (this.#isPaused) {
      return;
    }

    // 全局并发限制
    if (this.#running.size >= MAX_CONCURRENT) {
      return;
    }

    const now = Date.now();
    for (let i = 0; i < this.#queue.length; i++) {
      const task = this.#queue[i]!;

      // 未到执行时间
      if (task.scheduledAt > now) {
        continue;
      }

      // 账号锁（单账号并发 1）
      if (this.#accountLocks.has(task.account)) {
        continue;
      }

      // 出队并执行
      this.#queue.splice(i, 1);
      this.#execute(task);
      break;
    }
  }

  async #execute(task: ScheduledTask): Promise<void> {
    const { account, objId, id } = task;
    this.#accountLocks.add(account);

    const start = Date.now();
    this.#log.info("调度", `开始任务：${id}`);
    bus.emit("device:keepalive-start", { account, objId });

    const promise = task
      .execute()
      .then(() => {
        const duration = Date.now() - start;
        this.#log.info("调度", `任务成功：${id}（${duration}ms）`);
        bus.emit("device:keepalive-success", { account, objId, duration });
        return { success: true, duration };
      })
      .catch((err) => {
        const duration = Date.now() - start;
        const classification = classifyError(err);
        const userMsg = formatErrorForUser(classification);

        this.#log.error("调度", `任务失败：${id}（${userMsg}）`, err);
        bus.emit("device:keepalive-failed", { account, objId, error: userMsg });

        return { success: false, duration, error: userMsg };
      })
      .finally(() => {
        this.#running.delete(id);
        this.#accountLocks.delete(account);
        this.#tryDequeue();
      });

    this.#running.set(id, promise);
  }

  /** 墙钟漂移检测（睡眠/唤醒） */
  #startClockMonitor(): void {
    setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.#lastClockCheck;

      if (Math.abs(elapsed - 10_000) > CLOCK_DRIFT_THRESHOLD) {
        this.#log.warn(
          "调度",
          `检测到时钟漂移（${elapsed}ms），可能是系统休眠/唤醒，重新计算调度`,
        );
        this.#onClockDrift();
      }

      this.#lastClockCheck = now;
    }, 10_000);
  }

  #onClockDrift(): void {
    // 将所有过期任务的时间重置为「立即执行」，但每个对象只补跑一次
    const now = Date.now();
    const seen = new Set<string>();

    for (const task of this.#queue) {
      const key = `${task.account}:${task.objId}`;
      if (task.scheduledAt < now && !seen.has(key)) {
        task.scheduledAt = now;
        seen.add(key);
      }
    }

    this.#tryDequeue();
  }

  /** 离线检测（暂停出队） */
  #startOfflineMonitor(): void {
    setInterval(() => {
      this.#checkOnline().catch((err) => {
        this.#log.error("调度", "离线检测失败", err);
      });
    }, OFFLINE_CHECK_INTERVAL);
  }

  /** 队列轮询（每秒检查一次是否有待执行任务）。降噪：只在有任务执行时才有 INFO 输出 */
  #startQueuePoller(): void {
    setInterval(() => {
      this.#tryDequeue();
    }, 1000);
  }

  async #checkOnline(): Promise<void> {
    try {
      // 简单的联通性检测：访问天翼云 ping 接口
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      await fetch("https://pc.ctyun.cn/api/cdserv/client/getServData", {
        method: "HEAD",
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // 从离线恢复
      if (this.#isPaused) {
        this.#log.info("调度", `网络已恢复，${OFFLINE_RESUME_DELAY / 1000}秒后恢复调度`);
        this.#isPaused = false;
        setTimeout(() => this.#tryDequeue(), OFFLINE_RESUME_DELAY);
      }
    } catch {
      // 进入离线状态
      if (!this.#isPaused) {
        this.#log.warn("调度", "网络不可达，暂停调度");
        this.#isPaused = true;
      }
    }
  }

  /** 获取当前队列快照 */
  getQueueSnapshot(): Array<{ account: string; objId: string; scheduledAt: number }> {
    return this.#queue.map((t) => ({
      account: t.account,
      objId: t.objId,
      scheduledAt: t.scheduledAt,
    }));
  }

  /** 获取运行中任务数 */
  getRunningCount(): number {
    return this.#running.size;
  }
}
