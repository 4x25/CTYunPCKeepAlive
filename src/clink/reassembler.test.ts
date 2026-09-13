/**
 * 字节流重组器单测：验证跨帧拆分、单帧多消息、边界情况。
 */
import { assertEquals } from "@std/assert";
import { ClinkReassembler } from "./reassembler.ts";
import { encodeClinkHeader, encodeMiniHeader } from "./frame.ts";

Deno.test("单帧单消息：完整 16B 头 + payload", () => {
  const r = new ClinkReassembler();
  const header = encodeClinkHeader({ type: 101, reserved: 0, length: 3, sessionId: 42n });
  const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const frame = new Uint8Array(19);
  frame.set(header, 0);
  frame.set(payload, 16);

  const msgs = r.feed(frame);
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0]!.type, 101);
  assertEquals(msgs[0]!.sessionId, 42n);
  assertEquals(msgs[0]!.payload, payload);
});

Deno.test("单帧多消息：首条完整头 + 第二条 mini 头", () => {
  const r = new ClinkReassembler();
  // 第一条：type=100, payload 2B
  const h1 = encodeClinkHeader({ type: 100, reserved: 0, length: 2, sessionId: 1n });
  const p1 = new Uint8Array([0x01, 0x02]);
  // 第二条：type=200, payload 3B（mini 头）
  const h2 = encodeMiniHeader(200, 3);
  const p2 = new Uint8Array([0xa0, 0xb0, 0xc0]);

  const frame = new Uint8Array(16 + 2 + 6 + 3);
  frame.set(h1, 0);
  frame.set(p1, 16);
  frame.set(h2, 18);
  frame.set(p2, 24);

  const msgs = r.feed(frame);
  assertEquals(msgs.length, 2);
  assertEquals(msgs[0]!.type, 100);
  assertEquals(msgs[0]!.sessionId, 1n);
  assertEquals(msgs[0]!.payload, p1);
  assertEquals(msgs[1]!.type, 200);
  assertEquals(msgs[1]!.sessionId, undefined, "mini 头不含 sessionId");
  assertEquals(msgs[1]!.payload, p2);
});

Deno.test("跨帧拆分：头部被拆成两个 frame", () => {
  const r = new ClinkReassembler();
  const header = encodeClinkHeader({ type: 50, reserved: 0, length: 4, sessionId: 99n });
  const payload = new Uint8Array([0x11, 0x22, 0x33, 0x44]);

  // 第一个 frame：头的前 10 字节
  const msgs1 = r.feed(header.subarray(0, 10));
  assertEquals(msgs1.length, 0, "头未完整，不应产出消息");

  // 第二个 frame：头的后 6 字节 + 全部 payload
  const frame2 = new Uint8Array(6 + 4);
  frame2.set(header.subarray(10, 16), 0);
  frame2.set(payload, 6);
  const msgs2 = r.feed(frame2);
  assertEquals(msgs2.length, 1);
  assertEquals(msgs2[0]!.type, 50);
  assertEquals(msgs2[0]!.sessionId, 99n);
  assertEquals(msgs2[0]!.payload, payload);
});

Deno.test("跨帧拆分：payload 被拆成三个 frame（模拟 194+4+4）", () => {
  const r = new ClinkReassembler();
  const header = encodeClinkHeader({ type: 104, reserved: 0, length: 202, sessionId: 1n });
  const payload = new Uint8Array(202).fill(0xcc);

  // frame 1: 完整头 + 前 194 字节 payload
  const f1 = new Uint8Array(16 + 194);
  f1.set(header, 0);
  f1.set(payload.subarray(0, 194), 16);
  const m1 = r.feed(f1);
  assertEquals(m1.length, 0, "payload 未完整");

  // frame 2: 4 字节
  const m2 = r.feed(payload.subarray(194, 198));
  assertEquals(m2.length, 0);

  // frame 3: 最后 4 字节
  const m3 = r.feed(payload.subarray(198, 202));
  assertEquals(m3.length, 1);
  assertEquals(m3[0]!.type, 104);
  assertEquals(m3[0]!.payload.length, 202);
  assertEquals(m3[0]!.payload.every((b) => b === 0xcc), true);
});

Deno.test("payload 长度为 0 的消息", () => {
  const r = new ClinkReassembler();
  const header = encodeClinkHeader({ type: 999, reserved: 0, length: 0, sessionId: 7n });
  const msgs = r.feed(header);
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0]!.type, 999);
  assertEquals(msgs[0]!.payload.length, 0);
});

Deno.test("reset 清空缓冲，下一条重新从完整头开始", () => {
  const r = new ClinkReassembler();
  // 喂一半头
  r.feed(new Uint8Array(10).fill(0xff));
  r.reset();

  // 现在应该能正常解析完整头
  const header = encodeClinkHeader({ type: 1, reserved: 0, length: 1, sessionId: 0n });
  const payload = new Uint8Array([0x42]);
  const frame = new Uint8Array(17);
  frame.set(header, 0);
  frame.set(payload, 16);
  const msgs = r.feed(frame);
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0]!.type, 1);
});
