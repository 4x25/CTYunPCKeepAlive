/**
 * M1 保活 CLI。
 *
 * 用法：`deno task keepalive -- <account> <objName>`
 *
 * 从 .env 读取账号密码，按 objName 匹配设备。
 */
import { createDeviceContext } from "../core/ctyun/device.ts";
import { CtyunClient } from "../core/ctyun/envelope.ts";
import { createBrowserFetch } from "../core/ctyun/http.ts";
import { establishSession } from "../core/ctyun/nego.ts";
import { login } from "../core/ctyun/auth.ts";
import { listDesktops } from "../core/ctyun/desktops.ts";
import { keepalive } from "../core/keepalive.ts";
import { Logger, maskAccount } from "../core/logger.ts";

const log = new Logger({ verbose: true });

async function main(): Promise<number> {
  const args = Deno.args;
  if (args.length < 2) {
    console.error("用法: deno task keepalive -- <account> <objName>");
    return 2;
  }

  const account = args[0]!;
  const targetName = args[1]!;

  const password = Deno.env.get("CTYUNPC_PASSWORD");
  if (!password) {
    log.error("系统", "缺少 CTYUNPC_PASSWORD，请检查 .env");
    return 2;
  }

  const device = createDeviceContext();
  const client = new CtyunClient(device, createBrowserFetch({ timeoutMs: 15_000 }));

  log.info("账号", `开始保活：${maskAccount(account)}`);

  // 登录
  try {
    await establishSession(client);
    const { auth } = await login(client, { account, password });
    log.info("账号", "登录成功");

    // 获取设备列表
    const desktops = await listDesktops(client, auth);
    const target = desktops.desktops.find((d) =>
      d.name === targetName
    );

    if (!target) {
      log.error("保活", `未找到设备：${targetName}`);
      log.info("保活", `可用设备：${desktops.desktops.map((d) => d.name).join(", ")}`);
      return 1;
    }

    log.info("保活", `目标设备：${target.name} (${target.objId})`);
    log.info("保活", `状态：${target.useStatusText ?? target.useStatus}`);

    if (!target.isRunning) {
      log.warn("保活", "设备未运行，保活可能失败");
    }

    // 执行保活
    const result = await keepalive(client, auth, {
      desktopId: target.objId,
      desktopName: target.name,
      userId: auth.userId,
      tenantId: auth.tenantId,
      deviceCode: device.deviceCode,
    });

    if (result.success) {
      log.info(
        "保活",
        `✓ 保活成功（耗时 ${result.elapsedMs}ms，就绪掩码 0x${result.readyMask?.toString(16)}）`,
      );
      return 0;
    } else {
      log.error("保活", `✗ 保活失败（耗时 ${result.elapsedMs}ms）：${result.error}`);
      return 1;
    }
  } catch (err) {
    log.error("系统", `异常：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) Deno.exit(await main());
