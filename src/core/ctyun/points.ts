/**
 * 积分中心查询：余额与任务列表。
 *
 * 依据 `docs/ctyun-points-center-api.md`。
 *
 * 注意这组接口与云电脑链**不同**：
 * - Origin 是 `https://desk.ctyun.cn`（不带 `:8810`）
 * - 响应是**普通 JSON**，没有 `edata` 包装
 * - 任务列表同时承载「任务定义」与「当前周期实例投影」，实例字段可为 null
 */
import type { AuthContext, CtyunClient } from "./envelope.ts";

/** 通用积分的 `pointType`。只有它展示在页面上。 */
export const POINT_TYPE_GENERAL = 1;

/** 任务状态码。 */
export const TASK_STATUS = {
  /** 未完成。若 `totalProgress > 1` 且已有进度，UI 显示为「进行中」。 */
  TODO: 0,
  /** 待领取。上游没有可用的领取端点，不自动处理。 */
  UNCLAIMED: 1,
  /** 已完成。 */
  DONE: 2,
  /** 已失效。 */
  EXPR: 3,
} as const;

/** 单个积分账户条目。 */
export interface UserPointsItem {
  pointType: number;
  pointTypeName: string;
  points: number;
  pretakePoints: number;
  /** 非空表示这是待过期展示数据，**不计入**当前余额。 */
  willOutDate: unknown | null;
  outDateTime: unknown | null;
  exchangeUrl: string | null;
}

export interface PointsSummary {
  /** 通用积分余额（已按规则汇总）。 */
  generalPoints: number;
  /** 原始条目，供 UI 展示其他类型。 */
  items: UserPointsItem[];
}

/** 平台任务项。实例相关字段全部可空，不要断言为 number。 */
export interface PointsTaskItem {
  taskInstId: number | null;
  taskDefId: number;
  taskDefName: string;
  taskCalendarType: number;
  eventType: number;
  taskDesc: string;
  taskSort: number;
  tenantId: number | null;
  userId: number;
  /** 奖励积分的 JSON 字符串，例如 `{"1":100}`。优先用 `pointsList`。 */
  points: string;
  totalProgress: number;
  currentProgress: number;
  status: number;
  expireDate: number;
  receiveDate: number | null;
  createDate: number | null;
  updateDate: number;
  pointsList: Array<{ type: number; typeDesc: string; value: number }>;
  [extra: string]: unknown;
}

/**
 * 汇总通用积分余额。
 *
 * 文档明确的两条规则：
 * - 按 `pointType` 分组，**不能**依赖数组顺序，也不能取同类型的第一项
 * - 只累加 `willOutDate === null` 的条目；待过期条目是展示数据，重复相加会算错
 */
export function summarizePoints(items: UserPointsItem[]): PointsSummary {
  const general = items.filter((i) => i.pointType === POINT_TYPE_GENERAL);
  const countable = general.filter((i) => i.willOutDate === null);
  const generalPoints = countable.reduce((sum, i) => sum + (i.points ?? 0), 0);

  return { generalPoints, items };
}

/**
 * 查询积分余额。
 */
export async function getUserPoints(
  client: CtyunClient,
  auth: AuthContext,
): Promise<PointsSummary> {
  const data = await requestPoints<unknown>(client, auth, "/selforder/api/marketing/userPoints/getUserPoints");

  // 文档：响应 data 是积分账户数组；顺序不可依赖
  return summarizePoints(Array.isArray(data) ? data as UserPointsItem[] : []);
}

/**
 * 查询平台任务与完成状态。
 *
 * 按 `taskSort` 升序返回，与页面呈现一致。
 */
export async function getTaskList(
  client: CtyunClient,
  auth: AuthContext,
): Promise<PointsTaskItem[]> {
  const data = await requestPoints<unknown>(client, auth, "/selforder/api/marketing/userPoints/getTaskList");

  const list = Array.isArray(data) ? data as PointsTaskItem[] : [];
  return [...list].sort((a, b) => a.taskSort - b.taskSort);
}

/**
 * 进度单位推断。
 *
 * 文档只给了两个可确认的 `totalProgress`（`1` 与 `3600`），
 * 其余一律按裸比例展示，**不猜单位**。
 */
export function formatProgress(item: {
  currentProgress: number;
  totalProgress: number;
}): { text: string; ratio: number } {
  const { currentProgress: cur, totalProgress: total } = item;
  if (!Number.isFinite(total) || total <= 0) {
    return { text: "—", ratio: 0 };
  }

  const ratio = Math.min(1, Math.max(0, cur / total));

  if (total === 1) {
    // 次数类任务
    return { text: `${cur} / 1 次`, ratio };
  }
  if (total === 3600) {
    // 秒数转分钟
    return {
      text: `${Math.floor(cur / 60)} / 60 分钟`,
      ratio,
    };
  }
  // 未知单位：不编造，按裸比例展示
  return { text: `${cur} / ${total}`, ratio };
}

/**
 * 奖励积分。
 *
 * 文档要求用结构化的 `pointsList` 取 `type=1` 的值，
 * **不要**手工解析 `points` JSON 字符串。
 */
export function rewardPoints(item: PointsTaskItem): number | undefined {
  return item.pointsList?.find((p) => p.type === POINT_TYPE_GENERAL)?.value;
}

/**
 * 任务状态文案。
 *
 * `status=0` 且已有进度时显示「进行中」，其余还原样展示。
 */
export function taskStatusText(item: PointsTaskItem): string {
  switch (item.status) {
    case TASK_STATUS.TODO:
      return item.totalProgress > 1 && item.currentProgress > 0 ? "进行中" : "未完成";
    case TASK_STATUS.UNCLAIMED:
      return "待领取";
    case TASK_STATUS.DONE:
      return "已完成";
    case TASK_STATUS.EXPR:
      return "已失效";
    default:
      return "未知";
  }
}

/**
 * 请求积分中心接口。
 *
 * 该组接口不走 `edata` 加密，需要单独发一个不带 `:8810` 端口的请求。
 * 认证仍用同一套 CTG 头与签名。
 */
async function requestPoints<T>(
  client: CtyunClient,
  auth: AuthContext,
  path: string,
): Promise<T> {
  const requestId = client.nextRequestId();
  const timestamp = String(Date.now() - auth.offsetTime);
  const headers = client.buildHeaders({ requestId, timestamp, eid: "", auth });

  // 积分中心的 Origin 不带端口
  const url = `https://desk.ctyun.cn${path}`;

  const res = await client.fetchForPlain(url, {
    method: "GET",
    headers: {
      ...headers,
      "From": "App-web",
      "x-lang": "zh-CN",
      // 该组接口没有加密 body，也不该带密钥协商头
      "CTG-REQDATA-ETYPE": "",
      "CTG-NEGO-EKEYID": "",
    },
  });

  if (!res.ok) {
    throw new Error(`积分接口 HTTP ${res.status}：${path}`);
  }

  const body = await res.json() as { code: number; data?: T; msg?: string };
  if (body.code !== 0) {
    throw new Error(`积分接口失败：${body.msg ?? `code=${body.code}`}`);
  }

  return body.data as T;
}
