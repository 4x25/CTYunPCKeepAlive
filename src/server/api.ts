/**
 * API 接口：处理前端发来的命令。
 *
 * 全部命令都是 POST，body 是 JSON。响应统一格式：
 * - 成功：`{ ok: true, data?: any }`
 * - 失败：`{ ok: false, error: string }`
 */
import type { Context } from "@hono/hono";
import { Runtime } from "../core/runtime.ts";
import type { AccountConfig } from "../core/store.ts";

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// 全局 Runtime 实例
let runtime: Runtime | null = null;

export function setRuntime(r: Runtime) {
  runtime = r;
}

/** 添加账号 */
export async function addAccount(c: Context): Promise<Response> {
  if (!runtime) return c.json<ApiResponse>({ ok: false, error: "Runtime 未初始化" });

  try {
    const body = await c.req.json() as { account: string; password: string; alias?: string };
    const { account, password, alias } = body;

    if (!account || !password) {
      return c.json<ApiResponse>({ ok: false, error: "账号和密码不能为空" });
    }

    const config: AccountConfig = {
      account: account.trim(),
      password,
      alias: alias?.trim() || "",
      devices: {},
    };

    await runtime.addAccount(config);
    return c.json<ApiResponse>({ ok: true });
  } catch (err) {
    return c.json<ApiResponse>({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 删除账号 */
export async function removeAccount(c: Context): Promise<Response> {
  if (!runtime) return c.json<ApiResponse>({ ok: false, error: "Runtime 未初始化" });

  try {
    const body = await c.req.json() as { account: string };
    const { account } = body;

    if (!account) {
      return c.json<ApiResponse>({ ok: false, error: "账号不能为空" });
    }

    await runtime.removeAccount(account);
    return c.json<ApiResponse>({ ok: true });
  } catch (err) {
    return c.json<ApiResponse>({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 更新账号别名 */
export async function updateAccountAlias(c: Context): Promise<Response> {
  if (!runtime) return c.json<ApiResponse>({ ok: false, error: "Runtime 未初始化" });

  try {
    const body = await c.req.json() as { account: string; alias: string };
    const { account, alias } = body;

    if (!account) {
      return c.json<ApiResponse>({ ok: false, error: "账号不能为空" });
    }

    await runtime.updateAccountAlias(account, alias.trim());
    return c.json<ApiResponse>({ ok: true });
  } catch (err) {
    return c.json<ApiResponse>({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 刷新设备列表 */
export async function refreshDevices(c: Context): Promise<Response> {
  if (!runtime) return c.json<ApiResponse>({ ok: false, error: "Runtime 未初始化" });

  try {
    const body = await c.req.json() as { account: string };
    const { account } = body;

    if (!account) {
      return c.json<ApiResponse>({ ok: false, error: "账号不能为空" });
    }

    await runtime.refreshDevices(account);
    return c.json<ApiResponse>({ ok: true });
  } catch (err) {
    return c.json<ApiResponse>({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 切换设备自动保活 */
export async function toggleAutoKeepalive(c: Context): Promise<Response> {
  if (!runtime) return c.json<ApiResponse>({ ok: false, error: "Runtime 未初始化" });

  try {
    const body = await c.req.json() as {
      account: string;
      objId: string;
      enabled: boolean;
    };
    const { account, objId, enabled } = body;

    if (!account || !objId) {
      return c.json<ApiResponse>({ ok: false, error: "账号和设备 ID 不能为空" });
    }

    await runtime.setAutoKeepalive(account, objId, enabled);
    return c.json<ApiResponse>({ ok: true });
  } catch (err) {
    return c.json<ApiResponse>({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 更新保活间隔 */
export async function updateKeepaliveInterval(c: Context): Promise<Response> {
  if (!runtime) return c.json<ApiResponse>({ ok: false, error: "Runtime 未初始化" });

  try {
    const body = await c.req.json() as {
      account: string;
      objId: string;
      minutes: number;
    };
    const { account, objId, minutes } = body;

    if (!account || !objId) {
      return c.json<ApiResponse>({ ok: false, error: "账号和设备 ID 不能为空" });
    }

    // 必须显式校验：undefined / NaN / 越界都要拒绝，不能靠客户端钳制
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 59) {
      return c.json<ApiResponse>({ ok: false, error: "间隔必须是 1-59 的整数" });
    }

    await runtime.setKeepaliveInterval(account, objId, minutes);
    return c.json<ApiResponse>({ ok: true });
  } catch (err) {
    return c.json<ApiResponse>({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 手动保活 */
export async function manualKeepalive(c: Context): Promise<Response> {
  if (!runtime) return c.json<ApiResponse>({ ok: false, error: "Runtime 未初始化" });

  try {
    const body = await c.req.json() as { account: string; objId: string };
    const { account, objId } = body;

    if (!account || !objId) {
      return c.json<ApiResponse>({ ok: false, error: "账号和设备 ID 不能为空" });
    }

    await runtime.triggerKeepalive(account, objId);
    return c.json<ApiResponse>({ ok: true });
  } catch (err) {
    return c.json<ApiResponse>({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
