/**
 * M0 登录探针。
 *
 * 目的：用真实账号证伪两条最高风险假设 ——
 *   R2 自生成的 `CTG-*` 头会不会被服务端拒绝
 *   三重加密链（RSA-PKCS1v15 → AES-CBC → 业务 JSON）能不能跑通
 *
 * 用法：`deno task probe`（凭据从 .env 的 CTYUNPC_USERNAME / CTYUNPC_PASSWORD 读取）
 *
 * 本脚本不打印任何敏感值。
 */
import { createDeviceContext } from "../core/ctyun/device.ts";
import { CtyunApiError, CtyunClient } from "../core/ctyun/envelope.ts";
import { createBrowserFetch } from "../core/ctyun/http.ts";
import { establishSession } from "../core/ctyun/nego.ts";
import { classifyIntervention, login, logout } from "../core/ctyun/auth.ts";
import { listDesktops } from "../core/ctyun/desktops.ts";
import { Logger, maskAccount } from "../core/logger.ts";

const log = new Logger({ verbose: true });

async function main(): Promise<number> {
  const account = Deno.env.get("CTYUNPC_USERNAME");
  const password = Deno.env.get("CTYUNPC_PASSWORD");
  if (!account || !password) {
    log.error("系统", "缺少 CTYUNPC_USERNAME / CTYUNPC_PASSWORD，请检查 .env");
    return 2;
  }

  const device = createDeviceContext();
  const client = new CtyunClient(device, createBrowserFetch({ timeoutMs: 15_000 }));

  log.info("账号", `开始探测：${maskAccount(account)}`);

  // ── ① 密钥协商 ────────────────────────────────────────────────
  const t0 = performance.now();
  try {
    const key = await establishSession(client);
    log.info(
      "系统",
      `密钥协商成功（eid 长度 ${key.eid.length}，evalue ${key.evalue.length} 字节）`,
    );
  } catch (err) {
    log.error("系统", `密钥协商失败：${describe(err)}`);
    return 1;
  }

  // ── ② 登录 ───────────────────────────────────────────────────
  let auth;
  try {
    const result = await login(client, { account, password });
    auth = result.auth;
    log.info(
      "账号",
      `登录成功（耗时 ${
        Math.round(performance.now() - t0)
      }ms，时间偏移 ${result.auth.offsetTime}ms）`,
    );
    log.debug("账号", "登录响应结构", result.data);
  } catch (err) {
    const kind = classifyIntervention(err);
    if (kind) {
      log.error("账号", `需人工处理（${kind}）：${describe(err)}`);
      return 1;
    }
    log.error("账号", `登录失败：${describe(err)}`);
    return 1;
  }

  // ── ③ 带签名的登录态接口 ──────────────────────────────────────
  try {
    const result = await listDesktops(client, auth);
    log.info(
      "保活",
      `设备列表成功：云电脑 ${result.desktops.length} 台，云手机 ${result.cloudMobiles.length} 台` +
        (result.usedFallback ? "（走了 /list 回退）" : "") +
        (result.unresolved > 0 ? `，未解析 ${result.unresolved} 项` : ""),
    );
    for (const [i, d] of result.desktops.entries()) {
      log.info(
        "保活",
        `  [${i + 1}] ${d.name} · ${d.osName ?? "?"} · ${d.useStatusText ?? d.useStatus ?? "?"}` +
          (d.isForbidden ? " · 禁止连接" : "") +
          (d.needLineUp ? " · 需排队" : ""),
      );
    }
    if (result.desktops.length === 0) {
      log.warn("保活", "账号下没有云电脑，M1 的 Clink 联调需要至少一台运行中的设备");
    }
  } catch (err) {
    log.error("保活", `设备列表失败：${describe(err)}`);
    return 1;
  }

  // ── ④ 退出 ───────────────────────────────────────────────────
  try {
    const ok = await logout(client, auth);
    log.info("账号", ok ? "服务端退出成功" : "服务端退出返回非 true");
  } catch (err) {
    log.warn("账号", `服务端退出失败（本地登录态仍应清除）：${describe(err)}`);
  } finally {
    client.setNegotiatedKey(undefined);
  }

  log.info("系统", "M0 门禁全部通过");
  return 0;
}

function describe(err: unknown): string {
  if (err instanceof CtyunApiError) return `${err.message} (code=${err.code}, path=${err.path})`;
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

if (import.meta.main) Deno.exit(await main());
