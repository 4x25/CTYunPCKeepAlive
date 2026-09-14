/**
 * M4 云智助手链路探针。
 *
 * 验证整条 IAM 链能否在真实账号上跑通：
 * ① `eaiSysInfo` 解密拿 SSO 公钥
 * ② IAM 登录 → 票据 → `ticketAuthorize` → 内存 `sk`
 * ③ 用户/租户初始化
 * ④ 积分任务列表（云电脑链）
 * ⑤ AI 对话一次
 *
 * 用法：`deno task probe:eai`
 *
 * 不打印任何敏感值。
 */
import { CookieJar } from "../core/ctyun/cookiejar.ts";
import { getEaiSysInfo } from "../core/ctyun/eai/sysinfo.ts";
import { iamLogin, newIamDeviceCode } from "../core/ctyun/eai/iam.ts";
import { newXuid } from "../core/ctyun/eai/sign.ts";
import { queryUserConfig, queryUserInfo, queryUserTenantInfo, pickCurrentTenant } from "../core/ctyun/eai/user.ts";
import { chat } from "../core/ctyun/eai/chat.ts";
import { Logger, maskAccount } from "../core/logger.ts";

const log = new Logger({ verbose: false });

async function main(): Promise<number> {
  const account = Deno.env.get("CTYUNPC_USERNAME");
  const password = Deno.env.get("CTYUNPC_PASSWORD");
  if (!account || !password) {
    console.error("缺少 CTYUNPC_USERNAME / CTYUNPC_PASSWORD");
    return 2;
  }

  const jar = new CookieJar();
  // 探针每次新建设备码；正式运行必须持久化复用
  const deviceCode = newIamDeviceCode();
  const xuid = newXuid();

  log.info("系统", `开始探测云智助手链路：${maskAccount(account)}`);

  // ① eaiSysInfo
  let ssopk: string, ssopkid: string;
  try {
    const sysInfo = await getEaiSysInfo();
    ssopk = sysInfo.sso.ssopk;
    ssopkid = sysInfo.sso.ssopkid;
    log.info("系统", `SSO 配置获取成功（ssopk ${ssopk.length} 字符，ssopkid ${ssopkid.length} 字符）`);
  } catch (err) {
    log.error("系统", `eaiSysInfo 失败：${describe(err)}`);
    return 1;
  }

  // ② IAM 登录
  let session: Awaited<ReturnType<typeof iamLogin>>;
  try {
    session = await iamLogin(jar, fetch, { account, password, ssopk, ssopkid, deviceCode, xuid });
    log.info(
      "账号",
      `IAM 登录成功（userId 长度 ${session.userId.length}，sk 长度 ${session.sk.length}，` +
        `tenantIdStr=${session.tenantIdStr}）`,
    );
  } catch (err) {
    log.error("账号", `IAM 登录失败：${describe(err)}`);
    return 1;
  }

  const transport = {
    fetch,
    cookieHeader: (url: string) => jar.headerFor(url),
  };

  // ③ 用户/租户初始化
  try {
    const profile = await queryUserInfo(session, transport);
    log.info("系统", `queryUserInfo 成功（字段数 ${Object.keys(profile).length}）`);

    const config = await queryUserConfig(session, transport);
    log.info("系统", `queryUserConfig 成功（currentTenantIdStr=${config.currentTenantIdStr ?? "(空)"}）`);

    const tenants = await queryUserTenantInfo(session, transport);
    const current = pickCurrentTenant(tenants, config.currentTenantIdStr);
    log.info("系统", `租户列表 ${tenants.length} 个，当前选中 tenantIdStr=${current?.tenantIdStr ?? "(无)"}`);
  } catch (err) {
    log.warn("系统", `用户/租户初始化失败：${describe(err)}`);
  }

  // ④ AI 对话
  try {
    const t0 = performance.now();
    const result = await chat(session, transport, { prompt: "今天有什么新闻" });
    log.info(
      "积分",
      `AI 对话成功（耗时 ${Math.round(performance.now() - t0)}ms，` +
        `回答 ${result.content.length} 字符，模型 ${result.modelUsed}）`,
    );
    log.debug("积分", "回答前 50 字符", result.content.slice(0, 50));
  } catch (err) {
    log.error("积分", `AI 对话失败：${describe(err)}`);
    return 1;
  }

  log.info("系统", "M4 云智助手链路门禁全部通过");
  return 0;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

if (import.meta.main) Deno.exit(await main());
