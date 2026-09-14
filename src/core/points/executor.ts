/**
 * 积分任务执行器：三个任务必须在一个时间窗内全部完成。
 *
 * 顺序固定为 1002 → 1004 → 1003：
 * 1. 登录 AI 云电脑（`eventType=1`）—— 最先执行，顺带验证会话
 * 2. 与 AI 对话 1 次（`eventType=3`）
 * 3. 使用 1 小时（`eventType=2`，复用保活管线并保持三通道）
 *
 * 前两个任务之间插入 3–8 秒随机间隔（文档要求）。
 */
import type { AuthContext, CtyunClient } from "../ctyun/envelope.ts";
import type { CookieJar } from "../ctyun/cookiejar.ts";
import type { IamSession } from "../ctyun/eai/iam.ts";
import { chat, type ChatTransport } from "../ctyun/eai/chat.ts";
import { performKeepalive } from "../keepalive.ts";
import { getTaskList, type PointsTaskItem } from "../ctyun/points.ts";
import type { Logger } from "../logger.ts";

/** 任务定义 ID。 */
export const TASK_IDS = {
  /** 登录 AI 云电脑。 */
  LOGIN: 1002,
  /** 使用 1 小时。 */
  USAGE: 1003,
  /** 与 AI 对话 1 次。 */
  AI_CHAT: 1004,
} as const;

/** 已实现 `eventType` → 动作的映射；其余类型只展示不执行。 */
export const SUPPORTED_EVENT_TYPES = new Set([1, 2, 3]);

/** 已实现的任务定义 ID 集合。 */
export const KNOWN_TASK_IDS = new Set<number>([
  TASK_IDS.LOGIN,
  TASK_IDS.AI_CHAT,
  TASK_IDS.USAGE,
]);

/** 固定提示词。无害、内置，问题与回答都不落盘。 */
export const AI_CHAT_PROMPT = "今天有什么新闻";

export interface TaskContext {
  /** 云电脑链客户端。 */
  client: CtyunClient;
  /** 云电脑链认证上下文。 */
  desktopAuth: AuthContext;
  /** 云智助手会话。 */
  iamSession: IamSession;
  /** Cookie 容器（IAM 与 eaichat 共用）。 */
  cookieJar: CookieJar;
  /** 保活目标。 */
  desktopId: string;
  desktopName: string;
  /** 云智助手传输层。 */
  eaiTransport: ChatTransport;
  log: Logger;
  /** 注入用：任务之间的随机间隔。测试里替换成 no-op 以免真等 3–8 秒。 */
  sleep?: (ms: number) => Promise<void>;
}

export type TaskKind = "login" | "ai-chat" | "usage" | "unknown";

export interface TaskResult {
  /** 任务定义 ID。 */
  taskDefId: number;
  /** 任务名称（来自接口）。 */
  taskName: string;
  kind: TaskKind;
  success: boolean;
  elapsedMs: number;
  error?: string;
  /** 跳过原因（任务已完成、无可用设备等）。 */
  skipped?: string;
}

export interface ExecutionSummary {
  results: TaskResult[];
  totalMs: number;
  allSuccess: boolean;
}

/** 任务完成状态。`2` = DONE。 */
const STATUS_DONE = 2;

/**
 * 读取任务列表并按需执行。
 *
 * 列表是**接口驱动**的：接口返回什么就处理什么。
 * - 已实现 `eventType`（1/2/3）的任务按固定顺序 1002 → 1004 → 1003 执行
 * - 其余任务原样列为「未实现」，不执行也不影响整体成功
 * - 已完成（`status=2`）的任务跳过，不重复请求
 */
export async function executePointsTasks(ctx: TaskContext): Promise<ExecutionSummary> {
  const start = performance.now();
  const results: TaskResult[] = [];

  const tasks = await getTaskList(ctx.client, ctx.desktopAuth);
  const byId = new Map(tasks.map((t) => [t.taskDefId, t]));

  // 三个已实现任务按文档固定顺序执行
  results.push(
    await runOne(ctx, byId.get(TASK_IDS.LOGIN), "login", () => doLoginCheck(ctx)),
  );

  // ② 与 AI 对话（前两个任务之间随机间隔 3–8 秒）
  const wait = ctx.sleep ?? sleep;
  if (results[0]?.success) {
    await wait(3000 + Math.floor(Math.random() * 5000));
    results.push(
      await runOne(ctx, byId.get(TASK_IDS.AI_CHAT), "ai-chat", () => doAiChat(ctx)),
    );
  }

  results.push(
    await runOne(ctx, byId.get(TASK_IDS.USAGE), "usage", () => doUsage(ctx)),
  );

  // 接口返回的其余任务：原样列出，标记为未实现（不执行、不影响结果）
  for (const t of tasks) {
    if (KNOWN_TASK_IDS.has(t.taskDefId)) continue;
    results.push({
      taskDefId: t.taskDefId,
      taskName: t.taskDefName,
      kind: "unknown",
      success: true,
      elapsedMs: 0,
      skipped: SUPPORTED_EVENT_TYPES.has(t.eventType)
        ? "未实现的任务定义"
        : `未实现的任务类型 eventType=${t.eventType}`,
    });
  }

  return {
    results,
    totalMs: Math.round(performance.now() - start),
    allSuccess: results.every((r) => r.success),
  };
}

/** 统一的单任务执行包装：处理已完成跳过、未知类型跳过与异常。 */
async function runOne(
  ctx: TaskContext,
  task: PointsTaskItem | undefined,
  kind: TaskKind,
  fn: () => Promise<void>,
): Promise<TaskResult> {
  const taskDefId = task?.taskDefId ?? 0;
  const taskName = task?.taskDefName ?? `未知任务(${taskDefId})`;
  const start = performance.now();

  if (!task) {
    return {
      taskDefId,
      taskName,
      kind,
      success: true,
      elapsedMs: 0,
      skipped: "接口未返回该任务",
    };
  }

  // 已完成：接口说 status=2 就直接跳过，不重复请求
  if (task.status === STATUS_DONE) {
    return {
      taskDefId,
      taskName,
      kind,
      success: true,
      elapsedMs: 0,
      skipped: "今日已完成",
    };
  }

  // 未实现的 eventType：只展示不执行
  if (!SUPPORTED_EVENT_TYPES.has(task.eventType)) {
    return {
      taskDefId,
      taskName,
      kind,
      success: true,
      elapsedMs: 0,
      skipped: `未实现的任务类型 eventType=${task.eventType}`,
    };
  }

  try {
    await fn();
    ctx.log.info("积分", `任务完成：${taskName}`);
    return {
      taskDefId,
      taskName,
      kind,
      success: true,
      elapsedMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log.error("积分", `任务失败：${taskName}`, err);
    return {
      taskDefId,
      taskName,
      kind,
      success: false,
      elapsedMs: Math.round(performance.now() - start),
      error: msg,
    };
  }
}

/** 任务①：登录检查。一次轻量调用即可。 */
async function doLoginCheck(ctx: TaskContext): Promise<void> {
  await ctx.client.request({
    path: "/api/desktop/client/pageDesktop",
    encoding: "json",
    body: { getCnt: 1, desktopTypes: ["1"] },
    auth: ctx.desktopAuth,
  });
}

/**
 * 任务②：与 AI 对话 1 次。
 *
 * 只要收到首个带 `delta.content` 的事件即算成功；
 * 回答内容不解析、不落盘。
 */
async function doAiChat(ctx: TaskContext): Promise<void> {
  const result = await chat(ctx.iamSession, ctx.eaiTransport, {
    prompt: AI_CHAT_PROMPT,
    ...(ctx.iamSession.tenantId !== undefined && { tenantId: ctx.iamSession.tenantId }),
    timeoutMs: 90_000,
  });

  if (result.content.length === 0) {
    throw new Error("AI 未返回任何内容增量");
  }
}

/** 任务③：使用 1 小时。复用保活管线并保持三通道。 */
async function doUsage(ctx: TaskContext): Promise<void> {
  await performKeepalive(ctx.client, ctx.desktopAuth, ctx.desktopId, ctx.desktopName);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
