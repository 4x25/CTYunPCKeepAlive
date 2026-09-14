/**
 * 积分任务时间窗。
 *
 * 依据需求稿 §4「时间窗设置」：
 * - 默认 09:00–11:30，分钟精度
 * - 每天随机一个开始时间，按日重算
 * - 结束早于开始 = 跨天（次日），界面加「跨天 · 次日 HH:mm」提示
 * - 起止相同、或窗口不足 10 分钟 → 回退，提示「窗口至少 10 分钟」
 * - 窗口**只约束开始**：1 小时任务可以跑出窗口
 * - 错过窗口当日跳过，不做深夜补偿
 * - 手动执行忽略窗口
 * - 本地时区；时钟变化时重算
 */

/** 窗口最短长度（分钟）。 */
export const MIN_WINDOW_MINUTES = 10;

/** 分钟数（0–1439）→ `HH:mm`。 */
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** `HH:mm` → 分钟数；非法返回 undefined。 */
export function parseMinutes(text: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

export interface TimeWindow {
  /** 窗口开始，分钟数。 */
  startMinutes: number;
  /** 窗口结束，分钟数。 */
  endMinutes: number;
}

export interface ValidatedWindow extends TimeWindow {
  /** 是否跨天（结束 ≤ 开始，即到次日）。 */
  crossDay: boolean;
  /** 窗口长度（分钟）。跨天时按 24 小时补算。 */
  lengthMinutes: number;
}

export type WindowValidation =
  | { ok: true; window: ValidatedWindow }
  | { ok: false; reason: string };

/**
 * 校验并归一化时间窗。
 *
 * 起止相同视为非法（长度 0），窗口不足 10 分钟同样拒绝 ——
 * 需求稿要求此时回退到上一个合法值并提示。
 */
export function validateWindow(startMinutes: number, endMinutes: number): WindowValidation {
  if (
    !Number.isInteger(startMinutes) || startMinutes < 0 || startMinutes > 1439 ||
    !Number.isInteger(endMinutes) || endMinutes < 0 || endMinutes > 1439
  ) {
    return { ok: false, reason: "时间格式不正确" };
  }

  if (startMinutes === endMinutes) {
    return { ok: false, reason: "窗口至少 10 分钟" };
  }

  const crossDay = endMinutes < startMinutes;
  const lengthMinutes = crossDay
    ? 1440 - startMinutes + endMinutes
    : endMinutes - startMinutes;

  if (lengthMinutes < MIN_WINDOW_MINUTES) {
    return { ok: false, reason: "窗口至少 10 分钟" };
  }

  return { ok: true, window: { startMinutes, endMinutes, crossDay, lengthMinutes } };
}

/**
 * 确定性伪随机（同一账号 + 同一日期 → 同一分钟）。
 *
 * 需求稿要求「每天随机一个开始时间」。这里用日期做种子的哈希而不是
 * `Math.random()`，好处是进程重启后当天的开始时间不变 —— 否则每次
 * 重启都会换一个时间，窗口形同虚设。
 */
export function dailyStartOffset(seed: string, windowLengthMinutes: number): number {
  if (windowLengthMinutes <= 0) return 0;

  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 无符号化后取模
  return (h >>> 0) % windowLengthMinutes;
}

/** 本地时区的日期键 `YYYY-MM-DD`。 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface WindowPlan {
  /** 当日计划开始时间（分钟数）。 */
  startMinutes: number;
  /** 结束时间（分钟数）。 */
  endMinutes: number;
  crossDay: boolean;
}

/**
 * 计算某一日的实际执行时间。
 *
 * @param account 用于播种，保证同一账号当日结果稳定
 * @param now 当前时间
 * @param window 已校验的窗口
 */
export function planForDay(
  account: string,
  now: Date,
  window: ValidatedWindow,
): WindowPlan {
  const offset = dailyStartOffset(`${account}:${localDateKey(now)}`, window.lengthMinutes);
  const startMinutes = (window.startMinutes + offset) % 1440;
  const endMinutes = (startMinutes + window.lengthMinutes) % 1440;

  return {
    startMinutes,
    endMinutes,
    crossDay: endMinutes <= startMinutes,
  };
}

/**
 * 判断当前是否在窗口内（含开始时刻，不含结束时刻）。
 *
 * 跨天窗口要正确处理 `[start, 1440) ∪ [0, end)`。
 */
export function isWithinWindow(nowMinutes: number, window: ValidatedWindow): boolean {
  if (!window.crossDay) {
    return nowMinutes >= window.startMinutes && nowMinutes < window.endMinutes;
  }
  return nowMinutes >= window.startMinutes || nowMinutes < window.endMinutes;
}

/**
 * 当天是否还能执行。
 *
 * 需求稿：错过窗口就当日跳过，不做深夜补偿。因此仅当当前时间
 * 尚未超过窗口结束（且跨天语义正确）时才允许排期。
 */
export function canStillRunToday(nowMinutes: number, plan: WindowPlan): boolean {
  if (!plan.crossDay) {
    return nowMinutes < plan.endMinutes;
  }
  // 跨天窗口在当日只判断「未到次日结束时刻」
  return nowMinutes < plan.endMinutes || nowMinutes >= plan.startMinutes;
}

/** 窗口的人类可读描述，跨天时按需求稿加提示。 */
export function describeWindow(window: ValidatedWindow): string {
  const base = `${formatMinutes(window.startMinutes)}–${formatMinutes(window.endMinutes)}`;
  return window.crossDay ? `${base}（跨天 · 次日 ${formatMinutes(window.endMinutes)}）` : base;
}
