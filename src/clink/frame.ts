/**
 * Clink 协议帧格式。
 *
 * 依据 `docs/ctyun-clink-protocol.md` §2。
 *
 * 全部字段 little-endian。有两种帧头：
 * - ClinkHeader（16 字节）：完整头，带 session_id
 * - mini header（6 字节）：只有 type + reserved + length
 *
 * 线上实现在单个 WebSocket frame 内可能包含多条 Clink 消息，也可能
 * 把一条 Clink 消息拆到多个 WS frame。重组逻辑见 reassembler.ts。
 */

/** 完整 Clink 帧头（16 字节，little-endian）。 */
export interface ClinkHeader {
  /** 消息类型（u16） */
  type: number;
  /** 保留字段（u16），通常为 0 */
  reserved: number;
  /** payload 长度（u32） */
  length: number;
  /** 会话 ID（u64），login 之前为 0 */
  sessionId: bigint;
}

/** 解析 16 字节完整头。调用方保证 buf.length >= 16。 */
export function parseClinkHeader(buf: Uint8Array): ClinkHeader {
  const view = new DataView(buf.buffer, buf.byteOffset, 16);
  return {
    type: view.getUint16(0, true),
    reserved: view.getUint16(2, true),
    length: view.getUint32(4, true),
    sessionId: view.getBigUint64(8, true),
  };
}

/** 编码完整头为 16 字节。 */
export function encodeClinkHeader(h: ClinkHeader): Uint8Array {
  const buf = new Uint8Array(16);
  const view = new DataView(buf.buffer);
  view.setUint16(0, h.type, true);
  view.setUint16(2, h.reserved, true);
  view.setUint32(4, h.length, true);
  view.setBigUint64(8, h.sessionId, true);
  return buf;
}

/** 解析 mini header（6 字节）：type(u16) + length(u32)。 */
export function parseMiniHeader(buf: Uint8Array): Pick<ClinkHeader, "type" | "length"> {
  const view = new DataView(buf.buffer, buf.byteOffset, 6);
  return {
    type: view.getUint16(0, true),
    length: view.getUint32(2, true),
  };
}

/** 编码 mini header 为 6 字节：type(2B) + size(4B)。 */
export function encodeMiniHeader(type: number, length: number): Uint8Array {
  const buf = new Uint8Array(6);
  const view = new DataView(buf.buffer, buf.byteOffset, 6);
  view.setUint16(0, type, true);
  view.setUint32(2, length, true);
  return buf;
}

/**
 * 客户端→服务端消息（ClientLink）。
 *
 * 文档 §3：首条用完整 16B 头（sessionId=0），后续用 mini 6B 头。
 */
export interface ClientLink {
  type: number;
  payload: Uint8Array;
}

/**
 * 服务端→客户端消息（ServerLink）。
 *
 * 文档 §4：首条带完整头（含 sessionId），后续带 mini 头。
 */
export interface ServerLink {
  type: number;
  sessionId?: bigint;
  payload: Uint8Array;
}

/** 序列化客户端消息。首条用完整头，后续用 mini 头。 */
export function serializeClientLink(msg: ClientLink, isFirst: boolean): Uint8Array {
  if (isFirst) {
    const header = encodeClinkHeader({
      type: msg.type,
      reserved: 0,
      length: msg.payload.length,
      sessionId: 0n,
    });
    const result = new Uint8Array(16 + msg.payload.length);
    result.set(header, 0);
    result.set(msg.payload, 16);
    return result;
  } else {
    const header = encodeMiniHeader(msg.type, msg.payload.length);
    const result = new Uint8Array(6 + msg.payload.length);
    result.set(header, 0);
    result.set(msg.payload, 6);
    return result;
  }
}
