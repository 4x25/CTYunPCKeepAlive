/**
 * 事件总线：用于状态变更通知。
 *
 * 简单的发布-订阅模式，支持通配符 `*` 订阅（SSE 层用它捕获所有变更）。
 */
import type { LogRecord } from "./logger.ts";

export type EventType =
  | "account:added"
  | "account:removed"
  | "account:login-start"
  | "account:login-success"
  | "account:login-failed"
  | "account:intervention-required"
  | "device:updated"
  | "device:keepalive-start"
  | "device:keepalive-success"
  | "device:keepalive-failed"
  | "log:entry"
  | "state:snapshot";

export type EventPayload = {
  "account:added": { account: string };
  "account:removed": { account: string };
  "account:login-start": { account: string };
  "account:login-success": { account: string; userId: number };
  "account:login-failed": { account: string; error: string };
  "account:intervention-required": { account: string; kind: string };
  "device:updated": { account: string; objId: string };
  "device:keepalive-start": { account: string; objId: string };
  "device:keepalive-success": { account: string; objId: string; duration: number };
  "device:keepalive-failed": { account: string; objId: string; error: string };
  "log:entry": LogRecord;
  "state:snapshot": Record<string, unknown>;
};

type Listener<T extends EventType> = (payload: EventPayload[T]) => void;
type WildcardListener = (payload: unknown) => void;

class EventBus {
  private listeners = new Map<EventType, Set<Listener<EventType>>>();
  private wildcardListeners = new Set<WildcardListener>();

  on<T extends EventType>(type: T, listener: Listener<T>): () => void;
  on(type: "*", listener: WildcardListener): () => void;
  on<T extends EventType | "*">(
    type: T,
    listener: T extends "*" ? WildcardListener : Listener<EventType>,
  ): () => void {
    if (type === "*") {
      this.wildcardListeners.add(listener as WildcardListener);
      return () => this.wildcardListeners.delete(listener as WildcardListener);
    }

    if (!this.listeners.has(type as EventType)) {
      this.listeners.set(type as EventType, new Set());
    }
    this.listeners.get(type as EventType)!.add(listener as Listener<EventType>);

    return () => this.off(type as EventType, listener as Listener<EventType>);
  }

  off<T extends EventType>(type: T, listener: Listener<T>): void {
    this.listeners.get(type)?.delete(listener as Listener<EventType>);
  }

  emit<T extends EventType>(type: T, payload: EventPayload[T]): void {
    // 触发具体事件的监听器
    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`事件处理器异常 [${type}]:`, err);
        }
      }
    }

    // 触发通配符监听器
    for (const handler of this.wildcardListeners) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`通配符事件处理器异常 [${type}]:`, err);
      }
    }
  }
}

export const bus = new EventBus();
