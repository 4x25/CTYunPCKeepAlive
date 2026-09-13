/**
 * 登录状态机与密码派生单测。
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  assertLoginComplete,
  classifyIntervention,
  derivePasswordFields,
  isCaptchaCode,
  LOGIN_ERROR,
  type LoginData,
  LoginInterventionRequired,
} from "./auth.ts";
import { sha256Hex } from "./crypto.ts";
import { CtyunApiError } from "./envelope.ts";

function loginData(over: Partial<LoginData> = {}): LoginData {
  return {
    userId: 1,
    tenantId: 1,
    secretKey: "SK",
    timestamp: 0,
    userAccount: "a",
    userName: "n",
    userEid: "e",
    adminUser: false,
    bondedDevice: true,
    needSmsValidate: false,
    needUpdatePassword: false,
    needBindVirtualMfa: null,
    twoFaValidateType: null,
    mfaTicket: null,
    ...over,
  };
}

Deno.test("derivePasswordFields 复现文档的两个字段", () => {
  const plain = "p@ssw0rd";
  const challenge = "CHALLENGE";
  const got = derivePasswordFields(plain, challenge);

  assertEquals(got.password, sha256Hex(plain + challenge));
  assertEquals(got.sha256Password, sha256Hex(sha256Hex(plain) + challenge));
  // 两者必须不同 —— 混用会直接导致登录失败
  assertEquals(got.password === got.sha256Password, false);
  assertEquals(got.password.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(got.password), true, "必须是小写 hex，不是 Base64");
});

Deno.test("云电脑链与 IAM 链的密码算法不可混用", () => {
  const plain = "secret";
  const deskPassword = derivePasswordFields(plain, "C").password;
  const iamPassword = sha256Hex(plain); // IAM 链：SHA256(明文)，不掺挑战值
  assertEquals(deskPassword === iamPassword, false);
});

Deno.test("assertLoginComplete：正常账号直接通过", () => {
  assertLoginComplete(loginData());
});

Deno.test("assertLoginComplete 按文档优先级分支", () => {
  const cases: [Partial<LoginData>, string][] = [
    [{ bondedDevice: false }, "device-binding"],
    [{ twoFaValidateType: 5 }, "virtual-mfa"],
    [{ needSmsValidate: true }, "sms-validate"],
    [{ needSmsValidate: true, twoFaValidateType: 4 }, "email-validate"],
    [{ needUpdatePassword: true }, "force-password-change"],
  ];
  for (const [over, kind] of cases) {
    const err = assertThrows(
      () => assertLoginComplete(loginData(over)),
      LoginInterventionRequired,
    );
    assertEquals(err.kind, kind);
  }
});

Deno.test("设备绑定优先于其余分支", () => {
  const err = assertThrows(
    () =>
      assertLoginComplete(
        loginData({ bondedDevice: false, twoFaValidateType: 5, needUpdatePassword: true }),
      ),
    LoginInterventionRequired,
  );
  assertEquals(err.kind, "device-binding");
});

Deno.test("验证码类错误码识别", () => {
  for (const c of [51030, 51031, 51040, 51085]) assertEquals(isCaptchaCode(c), true);
  for (const c of [51010, 51020, 40010, 0]) assertEquals(isCaptchaCode(c), false);
});

Deno.test("classifyIntervention 区分需人工处理与普通失败", () => {
  assertEquals(
    classifyIntervention(new CtyunApiError(LOGIN_ERROR.NEED_CAPTCHA, "需要验证码", "/login")),
    "captcha",
  );
  assertEquals(
    classifyIntervention(new LoginInterventionRequired("virtual-mfa", "x")),
    "virtual-mfa",
  );
  // 密码错误不是「需人工处理」，而是「登录失败」态
  assertEquals(
    classifyIntervention(new CtyunApiError(LOGIN_ERROR.INVALID_PASSWORD, "密码错误", "/login")),
    undefined,
  );
  assertEquals(classifyIntervention(new Error("network")), undefined);
});
