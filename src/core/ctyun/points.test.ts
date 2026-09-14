/**
 * 积分中心单测。
 *
 * 重点覆盖文档里明确写死、写错就会算错钱的几处规则。
 */
import { assertEquals } from "@std/assert";
import {
  formatProgress,
  POINT_TYPE_GENERAL,
  rewardPoints,
  summarizePoints,
  taskStatusText,
  type PointsTaskItem,
  type UserPointsItem,
} from "./points.ts";

function pointsItem(over: Partial<UserPointsItem> = {}): UserPointsItem {
  return {
    pointType: POINT_TYPE_GENERAL,
    pointTypeName: "通用积分",
    points: 100,
    pretakePoints: 0,
    willOutDate: null,
    outDateTime: null,
    exchangeUrl: null,
    ...over,
  };
}

Deno.test("summarizePoints 只汇总 pointType=1 且 willOutDate=null", () => {
  const s = summarizePoints([
    pointsItem({ points: 100 }),
    pointsItem({ points: 50 }),
    // 待过期条目：展示用，不计入余额
    pointsItem({ points: 999, willOutDate: 123456 }),
    // 云智手机积分：不属于通用积分
    pointsItem({ pointType: 500, pointTypeName: "云智手机通用积分", points: 888 }),
  ]);
  assertEquals(s.generalPoints, 150);
  assertEquals(s.items.length, 4, "原始条目仍保留供展示");
});

Deno.test("summarizePoints 不依赖数组顺序，也不取首项", () => {
  // 把待过期条目放在第一个 —— 取首项的实现会算错
  const s = summarizePoints([
    pointsItem({ points: 999, willOutDate: 1 }),
    pointsItem({ points: 7 }),
  ]);
  assertEquals(s.generalPoints, 7);
});

Deno.test("summarizePoints 空数组为 0", () => {
  assertEquals(summarizePoints([]).generalPoints, 0);
});

function task(over: Partial<PointsTaskItem> = {}): PointsTaskItem {
  return {
    taskInstId: null,
    taskDefId: 1002,
    taskDefName: "登录AI云电脑",
    taskCalendarType: 5,
    eventType: 1,
    taskDesc: "",
    taskSort: 1,
    tenantId: null,
    userId: 1,
    points: '{"1":100}',
    totalProgress: 1,
    currentProgress: 0,
    status: 0,
    expireDate: 0,
    receiveDate: null,
    createDate: null,
    updateDate: 0,
    pointsList: [{ type: POINT_TYPE_GENERAL, typeDesc: "通用积分", value: 100 }],
    ...over,
  };
}

Deno.test("formatProgress：totalProgress=1 显示次数", () => {
  assertEquals(formatProgress({ currentProgress: 1, totalProgress: 1 }).text, "1 / 1 次");
  assertEquals(formatProgress({ currentProgress: 0, totalProgress: 1 }).text, "0 / 1 次");
});

Deno.test("formatProgress：totalProgress=3600 换算成分钟", () => {
  assertEquals(formatProgress({ currentProgress: 3600, totalProgress: 3600 }).text, "60 / 60 分钟");
  assertEquals(formatProgress({ currentProgress: 1440, totalProgress: 3600 }).text, "24 / 60 分钟");
});

Deno.test("formatProgress：未知单位按裸比例展示，不猜单位", () => {
  // 文档明确要求这个用例
  assertEquals(formatProgress({ currentProgress: 3, totalProgress: 5 }).text, "3 / 5");
});

Deno.test("formatProgress：非法 totalProgress 返回破折号且不比比例", () => {
  assertEquals(formatProgress({ currentProgress: 0, totalProgress: 0 }).text, "—");
  assertEquals(formatProgress({ currentProgress: 1, totalProgress: NaN }).text, "—");
});

Deno.test("formatProgress：比例被限制在 0–1", () => {
  assertEquals(formatProgress({ currentProgress: 999, totalProgress: 100 }).ratio, 1);
  assertEquals(formatProgress({ currentProgress: -5, totalProgress: 100 }).ratio, 0);
});

Deno.test("rewardPoints 从 pointsList 取 type=1，不解析 points 字符串", () => {
  assertEquals(rewardPoints(task()), 100);
  // points 字符串是坏 JSON 也不影响
  assertEquals(rewardPoints(task({ points: "not-json" })), 100);
  // 没有 type=1 时返回 undefined（UI 显示「—」）
  assertEquals(rewardPoints(task({ pointsList: [] })), undefined);
});

Deno.test("taskStatusText：status=0 有进度时显示「进行中」", () => {
  assertEquals(taskStatusText(task({ status: 0, totalProgress: 3600, currentProgress: 1440 })), "进行中");
  assertEquals(taskStatusText(task({ status: 0, totalProgress: 1, currentProgress: 0 })), "未完成");
  // totalProgress=1 即使有进度也不叫「进行中」
  assertEquals(taskStatusText(task({ status: 0, totalProgress: 1, currentProgress: 1 })), "未完成");
});

Deno.test("taskStatusText 覆盖全部已知状态并容忍未知值", () => {
  assertEquals(taskStatusText(task({ status: 1 })), "待领取");
  assertEquals(taskStatusText(task({ status: 2 })), "已完成");
  assertEquals(taskStatusText(task({ status: 3 })), "已失效");
  assertEquals(taskStatusText(task({ status: 99 })), "未知");
});
