/**
 * 脱敏单测。
 *
 * 这些用例的作用是「防回归」：任何时候有人往日志里塞了新的响应对象，
 * 只要字段名在清单里，值就不会漏出去。
 */
import { assert, assertEquals } from "@std/assert";
import { Logger, maskAccount, maskCredential, maskPhone, redact } from "./logger.ts";

Deno.test("maskPhone / maskAccount / maskCredential", () => {
  assertEquals(maskPhone("13800136021"), "138****6021");
  assertEquals(maskPhone("123"), "***");
  assertEquals(maskAccount("13800136021"), "138****6021");
  assertEquals(maskAccount("alice@example.com"), "al***@example.com");
  assertEquals(maskCredential("abcdefghijklmnop"), "abcdef…mnop");
  assertEquals(maskCredential("short"), "<redacted>");
});

Deno.test("redact 覆盖登录响应的敏感字段", () => {
  const loginResponse = {
    code: 0,
    data: {
      userId: 12345,
      tenantId: 67,
      secretKey: "REAL-SECRET",
      // 实测：userName 可能直接就是手机号，不能当作安全字段
      userName: "15335579252",
      userAccount: "yzm_20250505_9vn8z1",
      tenantName: "云电脑租户",
      commonLoginReqHeader: "n2ehsGTLLd57xO0KQGxPG...",
      adminUser: false,
      mobilephone: "13800136021",
      realNameStatus: 3,
    },
  };
  const out = redact(loginResponse) as typeof loginResponse;
  for (
    const k of [
      "userId",
      "tenantId",
      "secretKey",
      "userName",
      "userAccount",
      "tenantName",
      "commonLoginReqHeader",
      "mobilephone",
    ]
  ) {
    assertEquals(
      (out.data as unknown as Record<string, unknown>)[k],
      "<redacted>",
      `${k} 必须脱敏`,
    );
  }
  // 非敏感字段保持原样，否则日志就没用了
  assertEquals(out.data.adminUser, false);
  assertEquals(out.data.realNameStatus, 3);
  assertEquals(out.code, 0);
});

Deno.test("整个登录响应序列化后不含任何原始账号片段", () => {
  const serialized = JSON.stringify(
    redact({
      userName: "15335579252",
      userAccount: "yzm_20250505_9vn8z1",
      email: "somebody@qq.com",
      mobilephone: "15335579252",
      secretKey: "0123456789abcdef0123456789abcdef",
    }),
  );
  for (const secret of ["15335579252", "yzm_20250505", "somebody@qq.com", "0123456789abcdef"]) {
    assert(!serialized.includes(secret), `日志中泄露了 ${secret.slice(0, 4)}…`);
  }
});

Deno.test("redact 覆盖设备列表与 Clink 连接资料", () => {
  const out = redact({
    objId: "OBJ-1",
    objName: "我的云电脑",
    desktopId: "D-1",
    desktopCode: "CODE-1",
    foreignDesktopId: "F-1",
    clientCert: "-----BEGIN CERT-----",
    clientKey: "-----BEGIN KEY-----",
    caCert: "ca",
    token: "TOKEN",
    internalIp: "10.0.0.1",
    internalPort: "9000",
    useStatusText: "运行中",
  }) as Record<string, unknown>;

  for (
    const k of [
      "objId",
      "desktopId",
      "desktopCode",
      "foreignDesktopId",
      "clientCert",
      "clientKey",
      "caCert",
      "token",
      "internalIp",
      "internalPort",
    ]
  ) {
    assertEquals(out[k], "<redacted>", `${k} 必须脱敏`);
  }
  // objName 是日志中允许用来指代桌面的字段
  assertEquals(out["objName"], "我的云电脑");
  assertEquals(out["useStatusText"], "运行中");
});

Deno.test("redact 覆盖协商密钥与云智助手会话", () => {
  const out = redact({
    eid: "E",
    evalue: "V",
    encKey: "K",
    encData: "D",
    sessionKey: "S",
    iamTicket: "T",
    conversation_id: "C",
    verify_id: "VI",
    "x-eai-xuid": "X",
  }) as Record<string, unknown>;
  for (const k of Object.keys(out)) assertEquals(out[k], "<redacted>", `${k} 必须脱敏`);
});

Deno.test("verbose 模式只暴露类型与长度，不暴露值", () => {
  const out = redact({ secretKey: "abcdef", userId: 42, backupurl: ["a", "b"] }, true) as Record<
    string,
    unknown
  >;
  assertEquals(out["secretKey"], "<redacted string(6)>");
  assertEquals(out["userId"], "<redacted number>");
  assertEquals(out["backupurl"], "<redacted array(2)>");
});

Deno.test("redact 递归进数组与嵌套对象", () => {
  const out = redact({
    list: [{ objId: "a", objName: "n" }, { objId: "b", objName: "m" }],
    nested: { deep: { secretKey: "s" } },
  }) as { list: Record<string, unknown>[]; nested: { deep: Record<string, unknown> } };
  assertEquals(out.list[0]!["objId"], "<redacted>");
  assertEquals(out.list[1]!["objId"], "<redacted>");
  assertEquals(out.list[0]!["objName"], "n");
  assertEquals(out.nested.deep["secretKey"], "<redacted>");
});

Deno.test("redact 处理循环引用与超深结构而不爆栈", () => {
  const a: Record<string, unknown> = { name: "a" };
  a["self"] = a;
  assertEquals((redact(a) as Record<string, unknown>)["self"], "<circular>");

  let deep: Record<string, unknown> = { end: 1 };
  for (let i = 0; i < 20; i++) deep = { next: deep };
  assert(JSON.stringify(redact(deep)).includes("<depth-limit>"));
});

Deno.test("Logger 环形缓冲按容量淘汰最旧记录", () => {
  const log = new Logger({ capacity: 3, sink: () => {} });
  for (const m of ["a", "b", "c", "d"]) log.info("系统", m);
  assertEquals(log.records().map((r) => r.message), ["b", "c", "d"]);
});

Deno.test("Logger 落盘前对 detail 脱敏", () => {
  const seen: unknown[] = [];
  const log = new Logger({ verbose: false, sink: (r) => seen.push(r.detail) });
  log.info("账号", "登录成功", { secretKey: "REAL", adminUser: false });
  assertEquals(seen[0], { secretKey: "<redacted>", adminUser: false });
});
