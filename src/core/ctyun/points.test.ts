/**
 * 积分查询单测。
 */
import { assertEquals } from "@std/assert";
import { getTaskList, getUserPoints } from "./points.ts";
import { CtyunClient } from "./envelope.ts";
import { createDeviceContext } from "./device.ts";
import { aesCbcEncrypt } from "./crypto.ts";

const EVALUE = new TextEncoder().encode("0123456789abcdef");
const AUTH = { userId: 1, tenantId: 1, secretKey: "SK", offsetTime: 0 };

function setup(handler: (path: string) => unknown) {
  const fetchImpl: typeof fetch = (input) => {
    const path = new URL(String(input)).pathname;
    const payload = { code: 0, data: handler(path) };
    return Promise.resolve(
      new Response(JSON.stringify({ edata: aesCbcEncrypt(EVALUE, JSON.stringify(payload)) })),
    );
  };
  const client = new CtyunClient(createDeviceContext(), fetchImpl);
  client.setNegotiatedKey({ eid: "E", evalue: EVALUE });
  return client;
}

Deno.test("getUserPoints 返回积分信息", async () => {
  const client = setup(() => ({ points: 100, todayPoints: 10 }));
  const result = await getUserPoints(client, AUTH);
  assertEquals(result.points, 100);
  assertEquals(result.todayPoints, 10);
});

Deno.test("getTaskList 返回任务数组", async () => {
  const client = setup(() => ({
    taskList: [
      { taskId: "1", taskName: "登录", taskType: "1002", rewardPoints: 5, completed: true },
      { taskId: "2", taskName: "对话", taskType: "1004", rewardPoints: 10, completed: false },
    ],
  }));
  const result = await getTaskList(client, AUTH);
  assertEquals(result.length, 2);
  assertEquals(result[0]!.taskId, "1");
  assertEquals(result[0]!.completed, true);
  assertEquals(result[1]!.taskId, "2");
  assertEquals(result[1]!.completed, false);
});

Deno.test("getTaskList 空数组时返回空", async () => {
  const client = setup(() => ({}));
  const result = await getTaskList(client, AUTH);
  assertEquals(result, []);
});
