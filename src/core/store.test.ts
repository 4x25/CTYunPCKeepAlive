/**
 * 配置持久化单测。
 */
import { assertEquals } from "@std/assert";
import { DEFAULT_POINTS_CONFIG } from "./store.ts";
import { validateWindow } from "./points/window.ts";

Deno.test("默认积分时间窗是 09:00–11:30", () => {
  assertEquals(DEFAULT_POINTS_CONFIG.windowStartMinutes, 540);
  assertEquals(DEFAULT_POINTS_CONFIG.windowEndMinutes, 690);
  assertEquals(DEFAULT_POINTS_CONFIG.autoTasks, []);
});

Deno.test("默认时间窗通过校验", () => {
  const r = validateWindow(
    DEFAULT_POINTS_CONFIG.windowStartMinutes,
    DEFAULT_POINTS_CONFIG.windowEndMinutes,
  );
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.window.crossDay, false);
    assertEquals(r.window.lengthMinutes, 150);
  }
});
