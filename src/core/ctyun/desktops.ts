/**
 * 设备列表：AI 云电脑与 AI 云手机。
 *
 * 依据 `docs/ctyun-ai-device-list-api.md`。
 *
 * 核心结论：两个页面标签共用**一次** `pageDesktop`，前端再按 `cloudMobileType`
 * 分类。最终顺序以 `sortList` 为准，不能直接用 `desktopList` 的数组顺序。
 */
import type { AuthContext, CtyunClient } from "./envelope.ts";

/** 云手机判定值。这是页面唯一的分类条件，`osType`/`prodType`/`vmType` 只能交叉验证。 */
export const CLOUD_MOBILE_TYPE = "2002";

/** `useStatus` 已确认的取值。`status:"OK"` 不是开关机状态。 */
export const USE_STATUS = { RUNNING: "25", POWERED_OFF: "45" } as const;

export const OBJ_TYPE = { NORMAL: 0, POOL: 1, PREEMPTION: 2 } as const;

export interface SortItem {
  objId: string;
  objType: number;
  objValue?: string;
  desktopTypes?: string[];
}

/**
 * 普通设备。只声明工具实际消费的字段，其余透传。
 *
 * 大量字段在抓包样本中为 null，因此一律可选 —— 不要对 `cpuCore`、`expireDate`
 * 之类强制断言类型。
 */
export interface NormalDesktop {
  objId: string;
  objName?: string;
  objType: number;
  desktopId?: string;
  desktopCode?: string;
  desktopName?: string;
  cloudMobileType?: string | null;
  osName?: string;
  osType?: string;
  useStatus?: string;
  useStatusText?: string;
  useStatusColor?: string;
  needLineUp?: boolean;
  forbiddenConnect?: boolean;
  connectUrl?: string[];
  connectMaster?: number;
  backupurl?: string[];
  [extra: string]: unknown;
}

export interface PageDesktopData {
  desktopList?: NormalDesktop[];
  desktopPoolList?: unknown[];
  preemptionDesktopList?: unknown[];
  sortList?: SortItem[];
  timestamp?: number;
}

/** 归一化后的列表项，供上层与 UI 使用。 */
export interface DesktopEntry {
  objId: string;
  objType: number;
  /** 显示名：`objName`，为空时回退 `desktopName`。 */
  name: string;
  isCloudMobile: boolean;
  isRunning: boolean;
  isForbidden: boolean;
  needLineUp: boolean;
  useStatus: string | undefined;
  useStatusText: string | undefined;
  osName: string | undefined;
  raw: NormalDesktop;
}

const DEFAULT_GET_CNT = 20;
const BACKFILL_BATCH = 30;

export interface ListDesktopsResult {
  /** 按 `sortList` 排序、已剔除云手机的云电脑列表。 */
  desktops: DesktopEntry[];
  /** 被过滤掉的云手机，仅用于诊断。 */
  cloudMobiles: DesktopEntry[];
  /** 补拉后仍未解析的 objId 数量（部分成功是允许的）。 */
  unresolved: number;
  /** 是否走了 `GET /list` 回退。 */
  usedFallback: boolean;
}

/**
 * 拉取并组装完整设备列表。
 *
 * 流程：`pageDesktop` →（失败则 `GET /list` 回退）→ 超过首批数量时按 30 项
 * 分批 `listDesktopByIds` 补拉 → 严格按最初的 `sortList` 重新组装。
 *
 * 补拉批次失败不会使已取得的设备失效，缺项跳过即可。
 */
export async function listDesktops(
  client: CtyunClient,
  auth: AuthContext,
  opts: { getCnt?: number; signal?: AbortSignal } = {},
): Promise<ListDesktopsResult> {
  const getCnt = opts.getCnt ?? DEFAULT_GET_CNT;
  let usedFallback = false;
  let data: PageDesktopData;

  try {
    data = await client.request<PageDesktopData>({
      path: "/api/desktop/client/pageDesktop",
      encoding: "json",
      body: { getCnt, desktopTypes: ["1", "2001", "2002"], sortType: "createTimeV1" },
      auth,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    // 主接口失败才回退旧接口，不能同时请求两个；两者结果也不合并
    usedFallback = true;
    data = await client.request<PageDesktopData>({
      path: "/api/desktop/client/list",
      method: "GET",
      encoding: "none",
      auth,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  const sortList = data.sortList ?? [];
  const byId = new Map<string, NormalDesktop>();
  indexDesktops(data.desktopList ?? [], byId);

  // 仅当 sortList 超过首批数量时才补拉，且只补 objType=0 且尚未出现的普通设备
  if (sortList.length > getCnt) {
    const missing = sortList.filter((s) => s.objType === OBJ_TYPE.NORMAL && !byId.has(s.objId));
    for (let i = 0; i < missing.length; i += BACKFILL_BATCH) {
      const batch = missing.slice(i, i + BACKFILL_BATCH);
      try {
        const more = await client.request<PageDesktopData>({
          path: "/api/desktop/client/listDesktopByIds",
          encoding: "json",
          body: { objIds: batch },
          auth,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        // 补拉响应自身的 sortList 不替换初始 sortList
        indexDesktops(more.desktopList ?? [], byId);
      } catch {
        // 单批失败只跳过该批，继续其余批次
      }
    }
  }

  const desktops: DesktopEntry[] = [];
  const cloudMobiles: DesktopEntry[] = [];
  let unresolved = 0;

  for (const item of sortList) {
    // 桌面池 / 抢占式对象本次无非空样本，结构未验证，先跳过而非编造默认值
    if (item.objType !== OBJ_TYPE.NORMAL) continue;
    const raw = byId.get(item.objId);
    if (!raw) {
      unresolved++;
      continue;
    }
    const entry = toEntry(raw);
    (entry.isCloudMobile ? cloudMobiles : desktops).push(entry);
  }

  return { desktops, cloudMobiles, unresolved, usedFallback };
}

/** 普通设备按 `objId` 建索引；`objId` 为空时回退 `desktopId`。 */
function indexDesktops(list: NormalDesktop[], into: Map<string, NormalDesktop>): void {
  for (const d of list) {
    const key = d.objId || d.desktopId;
    if (key) into.set(key, d);
  }
}

export function toEntry(raw: NormalDesktop): DesktopEntry {
  return {
    objId: raw.objId,
    objType: raw.objType,
    name: raw.objName || raw.desktopName || "(未命名)",
    isCloudMobile: raw.cloudMobileType === CLOUD_MOBILE_TYPE,
    isRunning: raw.useStatus === USE_STATUS.RUNNING,
    isForbidden: raw.forbiddenConnect === true,
    needLineUp: raw.needLineUp === true,
    useStatus: raw.useStatus,
    useStatusText: raw.useStatusText,
    osName: raw.osName,
    raw,
  };
}
