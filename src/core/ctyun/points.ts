/**
 * 积分查询：getUserPoints / getTaskList。
 *
 * 这两个接口**不走** Web-Signature 签名，而是走 CTG 系列头 + edata 加密。
 */
import type { AuthContext, CtyunClient } from "./envelope.ts";

export interface PointsInfo {
  /** 当前积分。 */
  points: number;
  /** 今日获得。 */
  todayPoints?: number;
  /** 累计获得。 */
  totalPoints?: number;
  [key: string]: unknown;
}

export interface Task {
  /** 任务 ID。 */
  taskId: string;
  /** 任务名称。 */
  taskName: string;
  /** 任务类型（1002=登录, 1004=对话, 1003=使用时长）。 */
  taskType: string;
  /** 奖励积分。 */
  rewardPoints: number;
  /** 是否已完成。 */
  completed: boolean;
  /** 完成进度（如 "1/3"）。 */
  progress?: string;
  [key: string]: unknown;
}

/**
 * 查询用户积分。
 */
export async function getUserPoints(
  client: CtyunClient,
  auth: AuthContext,
): Promise<PointsInfo> {
  const data = await client.request<PointsInfo>({
    path: "/api/integral/client/getUserPoints",
    method: "POST",
    encoding: "json",
    body: {},
    auth,
  });
  return data;
}

/**
 * 查询任务列表。
 */
export async function getTaskList(
  client: CtyunClient,
  auth: AuthContext,
): Promise<Task[]> {
  const data = await client.request<{ taskList?: Task[] }>({
    path: "/api/integral/client/getTaskList",
    method: "POST",
    encoding: "json",
    body: {},
    auth,
  });
  return data.taskList ?? [];
}
