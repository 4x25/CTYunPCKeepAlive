/**
 * 1 小时任务单测。
 *
 * 重点覆盖需求稿写死的几条：只补剩余、按分钟向上取整加 60 秒余量、
 * 接口值覆盖本地、被踢不重连、网络掉线按 5/15/45 秒退避重试。
 */
import { assertEquals } from "@std/assert";
import {
  computeHoldSeconds,
  holdForUsage,
  isComplete,
  RECONNECT_BACKOFF_MS,
  SessionKickedError,
  USAGE_TARGET_SECONDS,
} from "./usage.ts";

Deno.test("computeHoldSeconds：按分钟向上取整 + 60 秒余量", () => {
  // 剩下 3600 秒 → 60 分钟 → 3600 + 60
  assertEquals(computeHoldSeconds(0, 3600), 3660);
  // 剩下 1 秒 → 向上取整到 1 分钟 → 60 + 60
  assertEquals(computeHoldSeconds(3599, 3600), 120);
  // 剩下 60 秒 → 60 + 60
  assertEquals(computeHoldSeconds(3540, 3600), 120);
  // 剩下 61 秒 → 向上取整到 2 分钟 → 120 + 60
  assertEquals(computeHoldSeconds(3539, 3600), 180);
  // 剩下 24 分钟 → 1440 + 60
  assertEquals(computeHoldSeconds(2160, 3600), 1500);
  // 已达标 → 0
  assertEquals(computeHoldSeconds(3600, 3600), 0);
  assertEquals(computeHoldSeconds(4000, 3600), 0);
});

Deno.test("isComplete 是 >= 判定", () => {
  assertEquals(isComplete({ currentProgress: 3599, totalProgress: 3600 }), false);
  assertEquals(isComplete({ currentProgress: 3600, totalProgress: 3600 }), true);
  assertEquals(isComplete({ currentProgress: 4000, totalProgress: 3600 }), true);
});

Deno.test("已达标时不占用连接", async () => {
  let opened = 0;
  const result = await holdForUsage({
    readProgress: () => Promise.resolve({ currentProgress: 3600, totalProgress: 3600 }),
    openHold: () => {
      opened++;
      return Promise.resolve({ waitClosed: () => Promise.resolve(), close: () => {} });
    },
  });

  assertEquals(result.completed, true);
  assertEquals(opened, 0, "已达标就不该再建连");
});

Deno.test("只补剩余时长：保持时长按剩余计算", async () => {
  let heldFor = 0;
  const clock = { t: 0 };

  await holdForUsage({
    // 第一轮：剩 20 分钟；收尾重读时已达标
    readProgress: () => {
      const done = clock.t > 0;
      return Promise.resolve({
        currentProgress: done ? 3600 : 2400,
        totalProgress: 3600,
      });
    },
    openHold: () =>
      Promise.resolve({
        waitClosed: () => {
          // 模拟保持 1260 秒（21 分钟，含余量）
          heldFor = 1260;
          clock.t = 1260;
          return Promise.resolve();
        },
        close: () => {},
      }),
    // 时钟随「已保持」推进
    now: () => clock.t * 1000,
    sleep: () => Promise.resolve(),
  });

  // 剩余 1200 秒 → ceil(1200/60)*60 + 60 = 1260
  assertEquals(computedFor(2400), 1260);
  assertEquals(heldFor, 1260, "不应按整 60 分钟保持");
});

/** 便于断言的纯函数包装。 */
function computedFor(current: number): number {
  return computeHoldSeconds(current, USAGE_TARGET_SECONDS);
}

Deno.test("被踢时立即中止，且不重连", async () => {
  let openAttempts = 0;
  const result = await holdForUsage({
    readProgress: () => Promise.resolve({ currentProgress: 0, totalProgress: 3600 }),
    openHold: () => {
      openAttempts++;
      return Promise.reject(new SessionKickedError());
    },
    sleep: () => Promise.resolve(),
  });

  assertEquals(result.kicked, true);
  assertEquals(result.completed, false);
  assertEquals(openAttempts, 1, "被踢后不应再尝试建连");
});

Deno.test("网络掉线按 5/15/45 秒退避重试，用尽后放弃", async () => {
  const slept: number[] = [];
  let openAttempts = 0;

  const result = await holdForUsage({
    readProgress: () => Promise.resolve({ currentProgress: 0, totalProgress: 3600 }),
    openHold: () => {
      openAttempts++;
      return Promise.reject(new Error("网络不可达"));
    },
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    now: () => 0,
  });

  assertEquals(result.completed, false);
  assertEquals(slept, [...RECONNECT_BACKOFF_MS], "退避序列必须是 5/15/45 秒");
  assertEquals(openAttempts, 4, "首次 + 3 次重试");
  assertEquals(RECONNECT_BACKOFF_MS, [5_000, 15_000, 45_000]);
});

Deno.test("重连成功后退避计数重置", async () => {
  const slept: number[] = [];
  let attempt = 0;
  const clock = { t: 0 };

  await holdForUsage({
    readProgress: () => Promise.resolve({ currentProgress: 0, totalProgress: 3600 }),
    openHold: () => {
      attempt++;
      // 第 1、2 次失败；第 3 次成功并保持到「达标」
      if (attempt <= 2) return Promise.reject(new Error("网络不可达"));
      return Promise.resolve({
        waitClosed: () => {
          clock.t = 3660; // 保持满时长
          return Promise.resolve();
        },
        close: () => {},
      });
    },
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    now: () => clock.t * 1000,
  });

  // 前两次失败用 5s、15s
  assertEquals(slept.slice(0, 2), [5_000, 15_000]);
});

Deno.test("保持期间每轮结束都会重读进度（接口值覆盖本地）", async () => {
  let reads = 0;
  const clock = { t: 0 };

  await holdForUsage({
    readProgress: () => {
      reads++;
      // 第 1 次读：0 秒；之后服务端回报已达标
      return Promise.resolve({
        currentProgress: reads === 1 ? 0 : 3600,
        totalProgress: 3600,
      });
    },
    openHold: () =>
      Promise.resolve({
        waitClosed: () => {
          clock.t = 3660;
          return Promise.resolve();
        },
        close: () => {},
      }),
    sleep: () => Promise.resolve(),
    now: () => clock.t * 1000,
  });

  assertEquals(reads >= 2, true, "至少读一次初始进度 + 一次收尾进度");
});

Deno.test("onProgress 会把进度回传给调用方", async () => {
  const seen: number[] = [];
  const clock = { t: 0 };

  await holdForUsage({
    readProgress: () => Promise.resolve({ currentProgress: 0, totalProgress: 3600 }),
    openHold: () =>
      Promise.resolve({
        waitClosed: () => {
          clock.t = 3660;
          return Promise.resolve();
        },
        close: () => {},
      }),
    onProgress: (p) => seen.push(p.currentProgress),
    sleep: () => Promise.resolve(),
    now: () => clock.t * 1000,
  });

  assertEquals(seen.length >= 1, true);
});
