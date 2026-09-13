/**
 * Clink 单通道状态机。
 *
 * 状态转换：CONNECTING → OPEN → START → LINK → TICKET → READY
 *
 * 超时硬编码 15 秒（上游定时器回调为空，必须自实现）。
 */

export type ChannelState = "CONNECTING" | "OPEN" | "START" | "LINK" | "TICKET" | "READY" | "FAILED";

export interface ChannelStats {
  state: ChannelState;
  authCode?: number;
  errorMessage?: string;
  elapsedMs: number;
}

export class ClinkChannel {
  #state: ChannelState = "CONNECTING";
  #authCode: number | undefined;
  #errorMessage: string | undefined;
  #startTime = performance.now();
  #timeoutId: number | undefined;
  #onStateChange?: (stats: ChannelStats) => void;

  constructor(
    readonly type: number,
    readonly name: string,
    timeoutMs = 15_000,
  ) {
    this.#timeoutId = setTimeout(() => this.#timeout(), timeoutMs) as unknown as number;
  }

  get state(): ChannelState {
    return this.#state;
  }

  get authCode(): number | undefined {
    return this.#authCode;
  }

  get stats(): ChannelStats {
    const stats: ChannelStats = {
      state: this.#state,
      elapsedMs: Math.round(performance.now() - this.#startTime),
    };
    if (this.#authCode !== undefined) stats.authCode = this.#authCode;
    if (this.#errorMessage !== undefined) stats.errorMessage = this.#errorMessage;
    return stats;
  }

  onStateChange(cb: (stats: ChannelStats) => void): void {
    this.#onStateChange = cb;
  }

  transition(newState: ChannelState, authCode?: number, errorMessage?: string): void {
    if (this.#state === "FAILED" || this.#state === "READY") return;
    this.#state = newState;
    this.#authCode = authCode;
    this.#errorMessage = errorMessage;
    this.#onStateChange?.(this.stats);
    if (newState === "READY" || newState === "FAILED") {
      this.#clearTimeout();
    }
  }

  fail(reason: string): void {
    this.transition("FAILED", undefined, reason);
  }

  #timeout(): void {
    if (this.#state !== "READY" && this.#state !== "FAILED") {
      this.fail(`超时（停在 ${this.#state}）`);
    }
  }

  #clearTimeout(): void {
    if (this.#timeoutId !== undefined) {
      clearTimeout(this.#timeoutId);
      this.#timeoutId = undefined;
    }
  }

  dispose(): void {
    this.#clearTimeout();
  }
}
