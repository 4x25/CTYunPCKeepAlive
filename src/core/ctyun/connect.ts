/**
 * 云电脑连接信息获取。
 *
 * 依据 `docs/ctyun-clink-websocket-handshake.md` §3。
 *
 * 两个接口竞速：
 * - `queryConnectData`（推荐）
 * - `connect`（备用）
 *
 * 失败时优先尝试前两个 `connectUrl`，`connectMaster === 1` 时只用第一个。
 */
import type { AuthContext, CtyunClient } from "./envelope.ts";

export interface ConnectData {
  /** WebSocket URL 列表，按优先级排列。 */
  connectUrls: string[];
  /** 连接 token。 */
  token: string;
  /** 162 字节 SPKI DER 公钥（Base64）。 */
  publicKey: string;
  /** 是否主节点（1=主，其余=备）。 */
  connectMaster: number;
}

interface QueryConnectDataResponse {
  connectUrl?: string[];
  token?: string;
  publicKey?: string;
  connectMaster?: number;
}

interface ConnectResponse {
  connectUrl?: string;
  token?: string;
  publicKey?: string;
}

/**
 * 获取连接信息（推荐接口）。
 *
 * POST /api/desktop/client/queryConnectData
 */
export async function queryConnectData(
  client: CtyunClient,
  auth: AuthContext,
  desktopId: string,
): Promise<ConnectData | null> {
  try {
    const data = await client.request<QueryConnectDataResponse>({
      path: "/api/desktop/client/queryConnectData",
      encoding: "json",
      auth,
      body: { desktopId },
    });

    if (!data.connectUrl || !data.token || !data.publicKey) {
      return null;
    }

    return {
      connectUrls: data.connectUrl,
      token: data.token,
      publicKey: data.publicKey,
      connectMaster: data.connectMaster ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * 获取连接信息（备用接口）。
 *
 * POST /api/desktop/client/connect
 */
export async function connect(
  client: CtyunClient,
  auth: AuthContext,
  desktopId: string,
): Promise<ConnectData | null> {
  try {
    const data = await client.request<ConnectResponse>({
      path: "/api/desktop/client/connect",
      encoding: "json",
      auth,
      body: { desktopId },
    });

    if (!data.connectUrl || !data.token || !data.publicKey) {
      return null;
    }

    return {
      connectUrls: [data.connectUrl],
      token: data.token,
      publicKey: data.publicKey,
      connectMaster: 1, // 单 URL 视为主节点
    };
  } catch {
    return null;
  }
}

/**
 * 竞速获取连接信息。
 *
 * 两个接口并发，任一成功即返回；全部失败返回 null。
 */
export async function getConnectData(
  client: CtyunClient,
  auth: AuthContext,
  desktopId: string,
): Promise<ConnectData | null> {
  const results = await Promise.allSettled([
    queryConnectData(client, auth, desktopId),
    connect(client, auth, desktopId),
  ]);

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      return result.value;
    }
  }

  return null;
}
