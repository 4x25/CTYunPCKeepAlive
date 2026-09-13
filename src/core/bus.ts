/**
 * 事件总线：用于状态变更通知。
 *
 * 简单的发布-订阅模式，支持通配符订阅。
 */

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
  "log:entry": { level: string; module: string; message: string };
  "state:snapshot": Record<string, unknown>;
};

type Listener<T extends EventType> = (payload: EventPayload[T]) => void;

class EventBus {
  private listeners = new Map<EventType, Set<Listener<EventType>>>();

  on<T extends EventType>(type: T, listener: Listener<T>): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener as Listener<EventType>);

    return () => this.off(type, listener);
  }

  off<T extends EventType>(type: T, listener: Listener<T>): void {
    this.listeners.get(type)?.delete(listener as Listener<EventType>);
  }

  emit<T extends EventType>(type: T, payload: EventPayload[T]): void {
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
  }
}

export const bus = new EventBus();
