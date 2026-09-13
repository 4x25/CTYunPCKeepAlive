/**
 * WebSocket 窄接口，用于 Clink 连接。
 *
 * 只暴露建链 + 收发 ArrayBuffer，保留用于单测注入假 transport。
 *
 * **协议必须传数组**：`new WebSocket(url, { protocols: ["binary"], headers })`。
 * 传字符串会抛 `'protocols' … can not be converted to sequence`。
 *
 * `User-Agent` 是**追加**不是覆盖（实发 `Deno/2.9.6, Mozilla/...`），
 * `Origin` 是干净覆盖。
 */

export interface WebSocketOptions {
  protocols?: string[];
  headers?: Record<string, string>;
}

export interface WebSocketLike {
  readonly readyState: number;
  readonly url: string;
  binaryType: "arraybuffer";

  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent<ArrayBuffer>) => void) | null;
  onerror: ((ev: Event | ErrorEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;

  send(data: ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** 创建内置 WebSocket 实例（优先方案）。 */
export function connect(url: string, options: WebSocketOptions = {}): WebSocketLike {
  const ws = new WebSocket(url, options as { protocols?: string[]; headers?: Record<string, string> });
  ws.binaryType = "arraybuffer";
  return ws as WebSocketLike;
}
