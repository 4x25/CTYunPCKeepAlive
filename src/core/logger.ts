/**
 * 日志与脱敏。
 *
 * 脱敏在**入口**统一做，不靠调用方自觉 —— 调用方可以放心把整个响应对象丢进来。
 * 敏感字段清单来自 `docs/ctyun-*.md` 各文档的「不得写入日志」小节。
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LogModule = "保活" | "积分" | "账号" | "调度" | "系统";

export interface LogRecord {
  ts: number;
  level: LogLevel;
  module: LogModule;
  /** 桌面用 objName 或工具自生成短索引指代，绝不是 objId。 */
  object?: string;
  message: string;
  detail?: unknown;
}

/**
 * 永不输出原值的字段名（小写比较）。命中即替换为 `<redacted>`。
 *
 * 覆盖四条链路：云电脑登录、设备列表、Clink 握手、云智助手与积分中心。
 */
const REDACTED_KEYS = new Set([
  // 凭据与签名
  "password",
  "sha256password",
  "newencpwd1",
  "newencpwd2",
  "secretkey",
  "authdata",
  "challengecode",
  "challengeid",
  "ctg-signaturestr",
  "signature",
  "web-signature",
  "captchacode",
  "smscode",
  "mailcode",
  "mfacode",
  "mfakey",
  "seckey",
  "mfaticket",
  // 报文密钥协商
  "eid",
  "evalue",
  "enckey",
  "encdata",
  "certdata",
  // 设备与身份
  "devicecode",
  "hardwarefeaturecode",
  "eaidevicecode",
  "userid",
  "tenantid",
  "tanentcode",
  "tenantcode",
  "tenantname",
  "tanentname",
  "usereid",
  // 账号与显示名：userName 实测可能就是手机号，不能当作安全字段
  "useraccount",
  "username",
  "desensitizeusername",
  "nickname",
  // 登录响应中的不透明凭据 blob
  "commonloginreqheader",
  "x-eai-xuid",
  "xuid",
  "lxuid",
  // 桌面标识与连接资料
  "objid",
  "desktopid",
  "desktopcode",
  "foreigndesktopid",
  "prodinstid",
  "clientcert",
  "clientkey",
  "cacert",
  "token",
  "session_id",
  "sessionid",
  "sessionkey",
  "skcache",
  "internalip",
  "internalport",
  "backupurl",
  // 云智助手会话
  "iamticket",
  "ticket",
  "conversation_id",
  "message_id",
  "verify_id",
  // 积分中心
  "taskinstid",
  "logid",
  "foreignid",
  "mobilephone",
  "mobilePhone",
  "email",
]);

/** 手机号：保留前 3 后 4，中间四位打码。 */
export function maskPhone(v: string): string {
  return v.length >= 11 ? `${v.slice(0, 3)}****${v.slice(-4)}` : "***";
}

/** 账号：日志/通知/导出中一律脱敏。UI 的 tab 与其 hover 是唯一显示完整账号的地方。 */
export function maskAccount(v: string): string {
  if (v.includes("@")) {
    const [user = "", domain = ""] = v.split("@", 2);
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return maskPhone(v);
}

/** 长凭据：保留首 6 末 4。 */
export function maskCredential(v: string): string {
  return v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : "<redacted>";
}

/**
 * 递归脱敏任意值，供 `detail` 落盘前调用。
 *
 * 命中 {@link REDACTED_KEYS} 的键，verbose 模式下只保留类型与长度信息
 * （接口文档允许记录结构和长度，但不允许记录值）。
 */
export function redact(value: unknown, verbose = false): unknown {
  return redactInner(value, verbose, 0, new WeakSet());
}

function redactInner(
  value: unknown,
  verbose: boolean,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > 8) return "<depth-limit>";
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "<circular>";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, verbose, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      out[k] = verbose ? describe(v) : "<redacted>";
    } else {
      out[k] = redactInner(v, verbose, depth + 1, seen);
    }
  }
  return out;
}

/** 只描述结构与长度，不泄露值。 */
function describe(v: unknown): string {
  if (v === null) return "<null>";
  if (typeof v === "string") return `<redacted string(${v.length})>`;
  if (typeof v === "number") return "<redacted number>";
  if (typeof v === "boolean") return `<bool ${v}>`;
  if (Array.isArray(v)) return `<redacted array(${v.length})>`;
  return "<redacted object>";
}

export interface LoggerOptions {
  verbose?: boolean;
  /** 环形缓冲容量，需求稿 §5 要求 2000。 */
  capacity?: number;
  sink?: (r: LogRecord) => void;
}

/** M0 最小实现：环形缓冲 + 可插拔 sink。落盘与清理在 M2 补齐。 */
export class Logger {
  readonly #buf: LogRecord[] = [];
  readonly #capacity: number;
  readonly #verbose: boolean;
  readonly #sink: (r: LogRecord) => void;

  constructor(opts: LoggerOptions = {}) {
    this.#capacity = opts.capacity ?? 2000;
    this.#verbose = opts.verbose ?? true;
    this.#sink = opts.sink ?? defaultConsoleSink;
  }

  debug(module: LogModule, message: string, detail?: unknown): void {
    this.#push("DEBUG", module, message, detail);
  }
  info(module: LogModule, message: string, detail?: unknown): void {
    this.#push("INFO", module, message, detail);
  }
  warn(module: LogModule, message: string, detail?: unknown): void {
    this.#push("WARN", module, message, detail);
  }
  error(module: LogModule, message: string, detail?: unknown): void {
    this.#push("ERROR", module, message, detail);
  }

  /** 快照，最新在后。 */
  records(): readonly LogRecord[] {
    return this.#buf;
  }

  #push(level: LogLevel, module: LogModule, message: string, detail?: unknown): void {
    const record: LogRecord = { ts: Date.now(), level, module, message };
    if (detail !== undefined) record.detail = redact(detail, this.#verbose);
    this.#buf.push(record);
    if (this.#buf.length > this.#capacity) this.#buf.shift();
    this.#sink(record);
  }
}

function defaultConsoleSink(r: LogRecord): void {
  const t = new Date(r.ts).toTimeString().slice(0, 8);
  const line = `${t} ${r.level.padEnd(5)} [${r.module}] ${r.message}`;
  const extra = r.detail === undefined ? "" : ` ${JSON.stringify(r.detail)}`;
  if (r.level === "ERROR") console.error(line + extra);
  else if (r.level === "WARN") console.warn(line + extra);
  else console.log(line + extra);
}
