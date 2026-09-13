/**
 * Clink 字节流重组器。
 *
 * 依据 `docs/ctyun-clink-protocol.md` §2.3。
 *
 * WebSocket 的 message 事件给的是单个 frame 的 ArrayBuffer，但：
 * 1. 单个 WS frame 可能包含多条完整 Clink 消息
 * 2. 一条 Clink 消息可能被拆到多个 WS frame
 *
 * 文档实测出现过「194 字节 + 4 字节 + 4 字节」的拆分。本重组器维护跨
 * frame 的不完整帧缓冲，按字节流重组出完整 ServerLink。
 */

import { parseClinkHeader, parseMiniHeader, type ServerLink } from "./frame.ts";

/** 重组器状态：等待头 / 等待 payload。 */
type State =
  | { phase: "header"; headerBuf: Uint8Array; headerExpect: number }
  | { phase: "payload"; type: number; sessionId: bigint | undefined; remain: number; chunks: Uint8Array[] };

export class ClinkReassembler {
  private state: State = { phase: "header", headerBuf: new Uint8Array(0), headerExpect: 16 };
  private receivedFirst = false;

  /** 喂入一个 WS frame 的全部字节，返回重组出的零或多条 ServerLink。 */
  feed(chunk: Uint8Array): ServerLink[] {
    const messages: ServerLink[] = [];
    let offset = 0;

    while (offset < chunk.length) {
      if (this.state.phase === "header") {
        // 收集头部字节
        const need = this.state.headerExpect - this.state.headerBuf.length;
        const take = Math.min(need, chunk.length - offset);
        const newBuf = new Uint8Array(this.state.headerBuf.length + take);
        newBuf.set(this.state.headerBuf, 0);
        newBuf.set(chunk.subarray(offset, offset + take), this.state.headerBuf.length);
        offset += take;

        if (newBuf.length === this.state.headerExpect) {
          // 头部已完整
          let type: number, length: number, sessionId: bigint | undefined;
          if (this.state.headerExpect === 16) {
            const h = parseClinkHeader(newBuf);
            type = h.type;
            length = h.length;
            sessionId = h.sessionId;
            this.receivedFirst = true;
          } else {
            const h = parseMiniHeader(newBuf);
            type = h.type;
            length = h.length;
            sessionId = undefined;
          }

          if (length === 0) {
            // payload 为空，直接产出
            messages.push({ type, ...(sessionId !== undefined && { sessionId }), payload: new Uint8Array(0) });
            // 下一条消息的头长度
            this.state = {
              phase: "header",
              headerBuf: new Uint8Array(0),
              headerExpect: this.receivedFirst ? 6 : 16,
            };
          } else {
            this.state = { phase: "payload", type, sessionId, remain: length, chunks: [] };
          }
        } else {
          this.state.headerBuf = newBuf;
        }
      } else {
        // 收集 payload 字节
        const take = Math.min(this.state.remain, chunk.length - offset);
        this.state.chunks.push(chunk.subarray(offset, offset + take));
        this.state.remain -= take;
        offset += take;

        if (this.state.remain === 0) {
          // payload 已完整
          const totalLen = this.state.chunks.reduce((sum, c) => sum + c.length, 0);
          const payload = new Uint8Array(totalLen);
          let pos = 0;
          for (const c of this.state.chunks) {
            payload.set(c, pos);
            pos += c.length;
          }
          messages.push({ type: this.state.type, ...(this.state.sessionId !== undefined && { sessionId: this.state.sessionId }), payload });
          this.state = {
            phase: "header",
            headerBuf: new Uint8Array(0),
            headerExpect: this.receivedFirst ? 6 : 16,
          };
        }
      }
    }

    return messages;
  }

  /** 重置状态，用于新连接。 */
  reset(): void {
    this.state = { phase: "header", headerBuf: new Uint8Array(0), headerExpect: 16 };
    this.receivedFirst = false;
  }
}
