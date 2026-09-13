/**
 * 列出账号下的所有设备。
 *
 * 用法：`deno task list-devices`
 *
 * 从 .env 读取凭据，登录后显示所有设备的 objId、名称和状态。
 */
import { createDeviceContext } from "../core/ctyun/device.ts";
import { CtyunClient } from "../core/ctyun/envelope.ts";
import { createBrowserFetch } from "../core/ctyun/http.ts";
import { establishSession } from "../core/ctyun/nego.ts";
import { login } from "../core/ctyun/auth.ts";
import { listDesktops } from "../core/ctyun/desktops.ts";

async function main(): Promise<number> {
  const account = Deno.env.get("CTYUNPC_USERNAME");
  const password = Deno.env.get("CTYUNPC_PASSWORD");
  if (!account || !password) {
    console.error("需要设置 CTYUNPC_USERNAME 和 CTYUNPC_PASSWORD");
    return 2;
  }

  const device = createDeviceContext();
  const client = new CtyunClient(device, createBrowserFetch({ timeoutMs: 15_000 }));

  await establishSession(client);
  const { auth } = await login(client, { account, password });
  const result = await listDesktops(client, auth);

  console.log(`\n账号 ${account} 的设备列表：\n`);
  for (const [i, d] of result.desktops.entries()) {
    console.log(`[${i + 1}] ${d.name}`);
    console.log(`    objId: ${d.objId}`);
    console.log(`    状态: ${d.useStatusText ?? d.useStatus}`);
    console.log(`    系统: ${d.osName ?? "未知"}`);
    if (d.isForbidden) console.log(`    ⚠️  禁止连接`);
    if (d.needLineUp) console.log(`    ⚠️  需要排队`);
    console.log();
  }

  if (result.desktops.length === 0) {
    console.log("  (无设备)\n");
  }

  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
