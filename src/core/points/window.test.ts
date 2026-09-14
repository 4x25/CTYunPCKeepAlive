/**
 * 时间窗单测。
 *
 * 覆盖需求稿 §4 明确写死的边界：跨天、10 分钟下限、错过不补、每日随机且稳定。
 */
import { assertEquals } from "@std/assert";
import {
  canStillRunToday,
  describeWindow,
  formatMinutes,
  isWithinWindow,
  localDateKey,
  parseMinutes,
  planForDay,
  validateWindow,
  MIN_WINDOW_MINUTES,
} from "./window.ts";

Deno.test("formatMinutes / parseMinutes 往返", () => {
  assertEquals(formatMinutes(0), "00:00");
  assertEquals(formatMinutes(570), "09:30");
  assertEquals(formatMinutes(1439), "23:59");
  assertEquals(parseMinutes("09:30"), 570);
  assertEquals(parseMinutes("9:30"), 570);
  assertEquals(parseMinutes("23:59"), 1439);
});

Deno.test("parseMinutes 拒绝非法输入", () => {
  for (const bad of ["24:00", "12:60", "abc", "", "12", "1:2"]) {
    assertEquals(parseMinutes(bad), undefined, `${bad} 应非法`);
  }
});

Deno.test("默认窗口 09:00–11:30 合法且不跨天", () => {
  const r = validateWindow(540, 690);
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.window.lengthMinutes, 150);
    assertEquals(r.window.crossDay, false);
    assertEquals(describeWindow(r.window), "09:00–11:30");
  }
});

Deno.test("结束早于开始判定为跨天", () => {
  const r = validateWindow(1380, 60); // 23:00 → 01:00
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.window.crossDay, true);
    assertEquals(r.window.lengthMinutes, 120);
    assertEquals(describeWindow(r.window), "23:00–01:00（跨天 · 次日 01:00）");
  }
});

Deno.test("起止相同被拒（长度 0）", () => {
  const r = validateWindow(600, 600);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason, "窗口至少 10 分钟");
});

Deno.test("窗口不足 10 分钟被拒", () => {
  for (const [s, e] of [[600, 605], [600, 609], [1436, 5]]) {
    const r = validateWindow(s!, e!);
    assertEquals(r.ok, false, `${s}-${e} 应被拒`);
  }
  // 恰好 10 分钟通过
  assertEquals(validateWindow(600, 610).ok, true);
  assertEquals(validateWindow(1435, 5).ok, true, "23:55→00:05 恰好 10 分钟");
  assertEquals(MIN_WINDOW_MINUTES, 10);
  // 90 分钟跨天窗口合法
  assertEquals(validateWindow(1380, 30).ok, true);
});

Deno.test("跨天窗口的最小长度按 24 小时补算", () => {
  // 23:59 → 00:05 跨天，应为 6 分钟 → 拒绝
  assertEquals(validateWindow(1439, 5).ok, false);
  // 23:50 → 00:05 = 15 分钟 → 通过
  assertEquals(validateWindow(1430, 5).ok, true);
});

Deno.test("非法时间格式被拒", () => {
  assertEquals(validateWindow(-1, 600).ok, false);
  assertEquals(validateWindow(600, 1440).ok, false);
  assertEquals(validateWindow(600.5, 700).ok, false);
});

Deno.test("isWithinWindow：非跨天窗口", () => {
  const r = validateWindow(540, 690);
  if (!r.ok) throw new Error("unreachable");
  const w = r.window;

  assertEquals(isWithinWindow(539, w), false, "开始前一分钟不算");
  assertEquals(isWithinWindow(540, w), true, "开始时刻算在内");
  assertEquals(isWithinWindow(600, w), true);
  assertEquals(isWithinWindow(690, w), false, "结束时刻不算");
});

Deno.test("isWithinWindow：跨天窗口覆盖午夜", () => {
  const r = validateWindow(1380, 60); // 23:00 → 01:00
  if (!r.ok) throw new Error("unreachable");
  const w = r.window;

  assertEquals(isWithinWindow(1379, w), false);
  assertEquals(isWithinWindow(1380, w), true);
  assertEquals(isWithinWindow(1439, w), true, "23:59 在窗口内");
  assertEquals(isWithinWindow(0, w), true, "00:00 在窗口内");
  assertEquals(isWithinWindow(59, w), true);
  assertEquals(isWithinWindow(60, w), false, "01:00 结束");
});

Deno.test("planForDay：开始时间落在窗口长度内，且当日稳定", () => {
  const r = validateWindow(540, 690);
  if (!r.ok) throw new Error("unreachable");

  const now = new Date(2026, 8, 14);
  const a = planForDay("acct", now, r.window);
  const b = planForDay("acct", now, r.window);
  assertEquals(a.startMinutes, b.startMinutes, "同一账号同一天结果必须一致");

  // 开始时间不超出原窗口范围
  assertEquals(a.startMinutes >= 540 && a.startMinutes <= 690, true);
});

Deno.test("planForDay：不同账号/不同日期得到不同开始时间", () => {
  const r = validateWindow(540, 690);
  if (!r.ok) throw new Error("unreachable");

  const day1 = new Date(2026, 8, 14);
  const day2 = new Date(2026, 8, 15);

  const starts = new Set([
    planForDay("acct-a", day1, r.window).startMinutes,
    planForDay("acct-b", day1, r.window).startMinutes,
    planForDay("acct-a", day2, r.window).startMinutes,
  ]);
  assertEquals(starts.size > 1, true, "不应所有组合都撞到同一分钟");
});

Deno.test("planForDay：窗口长度 0 时退化到窗口起点（不崩）", () => {
  const bogus = { startMinutes: 540, endMinutes: 690, crossDay: false, lengthMinutes: 0 };
  const plan = planForDay("a", new Date(2026, 8, 14), bogus);
  assertEquals(plan.startMinutes, 540);
});

Deno.test("canStillRunToday：非跨天窗口过了结束就不能再跑", () => {
  const plan = { startMinutes: 540, endMinutes: 690, crossDay: false };
  assertEquals(canStillRunToday(539, plan), true);
  assertEquals(canStillRunToday(600, plan), true);
  assertEquals(canStillRunToday(690, plan), false, "到达结束时刻即错过");
  assertEquals(canStillRunToday(1200, plan), false, "深夜不补偿");
});

Deno.test("canStillRunToday：跨天窗口在午夜后仍可跑", () => {
  const plan = { startMinutes: 1380, endMinutes: 60, crossDay: true };
  assertEquals(canStillRunToday(1380, plan), true);
  assertEquals(canStillRunToday(30, plan), true, "次日凌晨仍在窗口内");
  assertEquals(canStillRunToday(60, plan), false);
  assertEquals(canStillRunToday(120, plan), false);
});

Deno.test("localDateKey 用本地时区", () => {
  assertEquals(localDateKey(new Date(2026, 0, 5)), "2026-01-05");
  assertEquals(localDateKey(new Date(2026, 11, 31)), "2026-12-31");
});
