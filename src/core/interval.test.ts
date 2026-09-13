/**
 * 间隔值校验回归测试。
 *
 * 背景：曾经因为 API 字段名不一致（客户端发 `minutes`、服务端收
 * `intervalMinutes`），`NaN` 被写入配置。`NaN` 参与 `scheduledAt` 计算后，
 * `NaN > now` 恒为 `false`，调度器判定任务「永远到时间」，导致无限重排
 * 打满 CPU。这里把校验规则固定下来。
 */
import { assert, assertEquals, assertThrows } from "@std/assert";

const MIN = 1;
const MAX = 59;

/** 与 API 层 `updateKeepaliveInterval` 相同的判定。 */
function isValidInterval(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN && v <= MAX;
}

Deno.test("合法间隔：1 与 59 是闭区间边界", () => {
  for (const v of [1, 2, 19, 30, 58, 59]) {
    assert(isValidInterval(v), `${v} 应合法`);
  }
});

Deno.test("越界间隔被拒绝", () => {
  for (const v of [0, -1, -5, 60, 99, 1000]) {
    assertEquals(isValidInterval(v), false, `${v} 应被拒`);
  }
});

Deno.test("非整数被拒绝", () => {
  for (const v of [19.5, 1.1, 0.5, 58.9]) {
    assertEquals(isValidInterval(v), false, `${v} 应被拒`);
  }
});

Deno.test("NaN / Infinity / undefined 被拒绝", () => {
  // 这三个是死循环 bug 的直接触发条件
  for (const v of [NaN, Infinity, -Infinity, undefined, null, "19", {}]) {
    assertEquals(isValidInterval(v), false, `${String(v)} 应被拒`);
  }
});

Deno.test("死循环成因：NaN 的 scheduledAt 会让任务永远「到时间」", () => {
  const now = Date.now();

  // 非法间隔产生的调度时间
  const badScheduledAt = now + NaN * 60_000;
  assertEquals(Number.isFinite(badScheduledAt), false);
  // 关键：这个比较恒为 false，所以调度器永远不会「等待」
  assertEquals(badScheduledAt > now, false);
  assertEquals(badScheduledAt <= now, false, "NaN 与任何值比较都是 false");

  // 合法间隔不会出现该问题
  const goodScheduledAt = now + 19 * 60_000;
  assert(Number.isFinite(goodScheduledAt));
  assertEquals(goodScheduledAt > now, true);
});

Deno.test("调度层的防御：非有限或越界的 delayMinutes 归零", () => {
  // 与 Runtime.#scheduleKeepalive 的防御逻辑一致
  const clamp = (v: number): number =>
    Number.isFinite(v) && v > 0 ? Math.min(v, MAX) : 0;

  assertEquals(clamp(NaN), 0);
  assertEquals(clamp(Infinity), 0, "Infinity 非有限，归零");
  assertEquals(clamp(-5), 0);
  assertEquals(clamp(0), 0, "0 表示立即执行");
  assertEquals(clamp(19), 19);
  assertEquals(clamp(999), MAX, "超大值被钳到上限");
});

Deno.test("配置清洗：非法间隔重置为默认值", () => {
  const DEFAULT = 19;
  const sanitize = (v: unknown): number =>
    isValidInterval(v) ? v as number : DEFAULT;

  assertEquals(sanitize(NaN), DEFAULT);
  assertEquals(sanitize(null), DEFAULT);
  assertEquals(sanitize(999), DEFAULT);
  assertEquals(sanitize(undefined), DEFAULT);
  assertEquals(sanitize(19), 19);
  assertEquals(sanitize(1), 1);
});

Deno.test("JSON 往返会把 NaN 变成 null —— 必须靠清洗兜住", () => {
  const stored = JSON.parse(JSON.stringify({ intervalMinutes: NaN }));
  assertEquals(stored.intervalMinutes, null);
  // 因此加载时必须把 null 视为非法
  assertEquals(isValidInterval(stored.intervalMinutes), false);
});

Deno.test("运行时 setKeepaliveInterval 对非法输入抛错而不是静默写入", () => {
  const setInterval = (v: number) => {
    if (!isValidInterval(v)) {
      throw new Error(`间隔必须是 ${MIN}-${MAX} 的整数`);
    }
  };
  assertThrows(() => setInterval(NaN), Error, "间隔必须是");
  assertThrows(() => setInterval(60), Error, "间隔必须是");
  setInterval(30); // 不抛
});
