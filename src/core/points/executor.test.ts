/**
 * 任务执行器单测。
 *
 * 覆盖执行顺序、已完成跳过、未知任务容错与失败不中断。
 */
import { assertEquals } from "@std/assert";
import {
  AI_CHAT_PROMPT,
  executePointsTasks,
  SUPPORTED_EVENT_TYPES,
  TASK_IDS,
  type TaskContext,
} from "./executor.ts";
import { CookieJar } from "../ctyun/cookiejar.ts";
import { CtyunClient } from "../ctyun/envelope.ts";
import { createDeviceContext } from "../ctyun/device.ts";
import { aesCbcEncrypt } from "../ctyun/crypto.ts";
import { Logger } from "../logger.ts";
import type { PointsTaskItem } from "../ctyun/points.ts";

const EVALUE = new TextEncoder().encode("0123456789abcdef");
const AUTH = { userId: 1, tenantId: 1, secretKey: "SK", offsetTime: 0 };
const log = new Logger({ verbose: false });

const mocks = {
  loginCalls: 0,
  keepaliveCalls: 0,
  chatPrompts: [] as string[],
  keepaliveFails: false,
  chatEmpty: false,
};

function resetMocks() {
  mocks.loginCalls = 0;
  mocks.keepaliveCalls = 0;
  mocks.chatPrompts = [];
  mocks.keepaliveFails = false;
  mocks.chatEmpty = false;
}

/**
 * 造一个客户端：积分任务列表接口返回 `tasks`，其余接口返回成功信封。
 */
function makeClient(tasks: PointsTaskItem[]): CtyunClient {
  const fetchImpl: typeof fetch = (input) => {
    const path = new URL(String(input)).pathname;
    // 积分中心走普通 JSON（无 edata 包装）
    if (path.includes("/selforder/")) {
      return Promise.resolve(new Response(JSON.stringify({ code: 0, data: tasks })));
    }
    const payload = { code: 0, data: {} };
    return Promise.resolve(
      new Response(JSON.stringify({ edata: aesCbcEncrypt(EVALUE, JSON.stringify(payload)) })),
    );
  };
  const client = new CtyunClient(createDeviceContext({ deviceCode: "d" }), fetchImpl);
  client.setNegotiatedKey({ eid: "E", evalue: EVALUE });
  return client;
}

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
    pointsList: [{ type: 1, typeDesc: "通用积分", value: 100 }],
    ...over,
  };
}

/**
 * 注：`executePointsTasks` 通过模块导入调用 `performKeepalive` 与 `chat`，
 * 这里不 mock 模块，而是给一个「所有下游调用都会失败」的客户端 —— 用来
 * 验证编排逻辑（顺序、跳过、容错）本身，下游协议行为已由各自单测覆盖。
 */
function makeCtx(client: CtyunClient): TaskContext {
  return {
    client,
    desktopAuth: AUTH,
    iamSession: { sk: "SK", userId: "1", tenantIdStr: "1", xuid: "pubweb_test" },
    cookieJar: new CookieJar(),
    desktopId: "obj1",
    desktopName: "测试机",
    eaiTransport: {
      fetch: () => Promise.resolve(new Response("down", { status: 500 })),
      cookieHeader: () => "",
    },
    log,
    // 不真等 3–8 秒
    sleep: () => Promise.resolve(),
  };
}

Deno.test("已完成的任务被跳过，不发起请求", async () => {
  resetMocks();
  const ctx = makeCtx(makeClient([
    task({ taskDefId: TASK_IDS.LOGIN, eventType: 1, status: 2, taskSort: 1 }),
    task({ taskDefId: TASK_IDS.AI_CHAT, eventType: 3, status: 2, taskSort: 4 }),
    task({ taskDefId: TASK_IDS.USAGE, eventType: 2, status: 2, taskSort: 3 }),
  ]));

  const summary = await executePointsTasks(ctx);

  assertEquals(summary.results.length, 3);
  for (const r of summary.results) {
    assertEquals(r.success, true);
    assertEquals(r.skipped, "今日已完成");
    assertEquals(r.elapsedMs, 0);
  }
  assertEquals(summary.allSuccess, true);
});

Deno.test("未知 eventType 只跳过并说明，不报错", async () => {
  resetMocks();
  const ctx = makeCtx(makeClient([
    task({ taskDefId: 9999, eventType: 99, taskDefName: "未知任务", taskSort: 9 }),
  ]));

  const summary = await executePointsTasks(ctx);
  const r = summary.results.find((x) => x.taskDefId === 9999);

  assertEquals(r?.success, true, "未知任务不应让整体失败");
  assertEquals(r?.skipped?.includes("eventType=99"), true);
});

Deno.test("接口未返回的任务被安全跳过", async () => {
  resetMocks();
  const ctx = makeCtx(makeClient([]));

  const summary = await executePointsTasks(ctx);
  assertEquals(summary.results.length, 3, "三个任务位都会产出结果");
  for (const r of summary.results) {
    assertEquals(r.success, true);
    assertEquals(r.skipped, "接口未返回该任务");
  }
});

Deno.test("登录任务失败时不进入 AI 对话（顺序依赖）", async () => {
  resetMocks();
  const client = makeClient([
    task({ taskDefId: TASK_IDS.LOGIN, eventType: 1, taskSort: 1 }),
    task({ taskDefId: TASK_IDS.AI_CHAT, eventType: 3, taskSort: 4 }),
  ]);

  // 让登录检查（pageDesktop）抛错
  const origRequest = client.request.bind(client);
  client.request = (opts: Parameters<typeof origRequest>[0]) => {
    if (opts.path === "/api/desktop/client/pageDesktop") {
      return Promise.reject(new Error("模拟登录检查失败"));
    }
    return origRequest(opts);
  };

  const summary = await executePointsTasks(makeCtx(client));

  const login = summary.results.find((r) => r.taskDefId === TASK_IDS.LOGIN);
  assertEquals(login?.success, false);
  assertEquals(login?.error, "模拟登录检查失败");

  // AI 对话不应被尝试
  const chatResult = summary.results.find((r) => r.taskDefId === TASK_IDS.AI_CHAT);
  assertEquals(chatResult, undefined, "登录失败后不应执行 AI 对话");
  assertEquals(summary.allSuccess, false);
});

Deno.test("支持的 eventType 集合与文档一致", () => {
  assertEquals(SUPPORTED_EVENT_TYPES.has(1), true, "1 = 登录");
  assertEquals(SUPPORTED_EVENT_TYPES.has(2), true, "2 = 使用时长");
  assertEquals(SUPPORTED_EVENT_TYPES.has(3), true, "3 = AI 对话");
  assertEquals(SUPPORTED_EVENT_TYPES.has(0), false);
  assertEquals(SUPPORTED_EVENT_TYPES.has(4), false);
});

Deno.test("固定提示词是内置的，不来自用户输入", () => {
  assertEquals(typeof AI_CHAT_PROMPT, "string");
  assertEquals(AI_CHAT_PROMPT.length > 0, true);
});
