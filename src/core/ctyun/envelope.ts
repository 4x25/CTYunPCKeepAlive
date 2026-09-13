/**
 * 云电脑链（`desk.ctyun.cn:8810`）的公共请求层。
 *
 * 职责：CTG 请求头、AES 报文封装、登录态签名、时间校正。
 * 只做协议翻译，不含重试、调度或日志决策。
 *
 * 依据：`docs/ctyun-account-auth-api.md` §3。
 */
import { aesCbcDecrypt, aesCbcEncrypt, md5HexUpper } from "./crypto.ts";
import type { DeviceContext } from "./device.ts";

export const API_ORIGIN = "https://desk.ctyun.cn:8810";

/** 业务响应信封。`HTTP 200` 不代表成功，必须再看 `code === 0`。 */
export interface ApiEnvelope<T> {
  code: number;
  data?: T;
  msg?: string;
}

/** 密钥协商产物，仅驻留内存，绝不持久化。 */
export interface NegotiatedKey {
  eid: string;
  /** `evalue` 的 UTF-8 字节，直接作为 AES key。 */
  evalue: Uint8Array;
}

/** 登录成功后用于签名的资料。 */
export interface AuthContext {
  userId: number;
  tenantId: number;
  secretKey: string;
  /** `loginAt - loginResponse.timestamp`，用于校正后续 `CTG-TIMESTAMP`。 */
  offsetTime: number;
  appChannel?: string;
}

/** 业务错误：HTTP 成功但 `code !== 0`。 */
export class CtyunApiError extends Error {
  constructor(readonly code: number, message: string, readonly path: string) {
    super(message);
    this.name = "CtyunApiError";
  }
}

export interface RequestOptions {
  path: string;
  /** 逻辑请求体。会按 `encoding` 加密成线上格式。 */
  body?: unknown;
  /** `json` → `{"data":…}`；`form` → `eParams=…`；`none` → 无请求体。 */
  encoding?: "json" | "form" | "none";
  /** GET 查询参数，会加密为唯一的 `eUrlParams`。 */
  query?: Record<string, string>;
  method?: "GET" | "POST";
  /** 缺省时为登录前请求，不带 `CTG-USERID` / `CTG-TENANTID` / `CTG-SIGNATURESTR`。 */
  auth?: AuthContext;
  signal?: AbortSignal;
}

/**
 * 云电脑链请求客户端。
 *
 * 一个实例对应一个账号 —— `deviceCode`、协商密钥和登录态都不跨账号共享。
 * 本链**不使用 Cookie**（认证依赖 CTG 头 + 加密 body），与云智助手链相反。
 */
export class CtyunClient {
  #requestCounter = 0;

  constructor(
    readonly device: DeviceContext,
    private readonly fetchImpl: typeof fetch = fetch,
    readonly origin: string = API_ORIGIN,
  ) {}

  #key: NegotiatedKey | undefined;

  get negotiatedKey(): NegotiatedKey | undefined {
    return this.#key;
  }

  setNegotiatedKey(key: NegotiatedKey | undefined): void {
    this.#key = key;
  }

  /** `String(Date.now() + ++counter)`，与线上实现一致。 */
  nextRequestId(): string {
    return String(Date.now() + ++this.#requestCounter);
  }

  /**
   * 明文接口通道，供 `getServData` / `negotiationEncKey` 使用 —— 这两个接口
   * 发生在 AES 建立之前，不能走 {@link request}。
   */
  fetchForPlain(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, init);
  }

  /**
   * 发起一次加密业务请求并解出 `data`。
   *
   * 明文接口（`getServData` / `negotiationEncKey`）不走这里，见 `nego.ts`。
   */
  async request<T>(opts: RequestOptions): Promise<T> {
    const key = this.#key;
    if (!key) throw new Error("尚未完成密钥协商，无法发起加密请求");

    const method = opts.method ?? (opts.encoding === "none" ? "POST" : "POST");
    const requestId = this.nextRequestId();
    const timestamp = String(Date.now() - (opts.auth?.offsetTime ?? 0));

    const headers = this.buildHeaders({ requestId, timestamp, eid: key.eid, auth: opts.auth });

    let url = this.origin + opts.path;
    if (opts.query) {
      const qs = new URLSearchParams(opts.query).toString();
      url += `?eUrlParams=${encodeURIComponent(aesCbcEncrypt(key.evalue, qs))}`;
    }

    let body: string | undefined;
    const encoding = opts.encoding ?? "json";
    if (encoding === "json") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ data: aesCbcEncrypt(key.evalue, JSON.stringify(opts.body ?? {})) });
    } else if (encoding === "form") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const enc = aesCbcEncrypt(key.evalue, JSON.stringify(opts.body ?? {}));
      body = `eParams=${encodeURIComponent(enc)}`;
    }

    const res = await this.fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (!res.ok) {
      throw new CtyunApiError(-1, `HTTP ${res.status} ${res.statusText}`, opts.path);
    }

    const raw = await res.text();
    const envelope = this.decodeEnvelope<T>(raw, key);

    if (envelope.code !== 0) {
      throw new CtyunApiError(
        envelope.code,
        envelope.msg ?? `业务失败 code=${envelope.code}`,
        opts.path,
      );
    }
    return envelope.data as T;
  }

  /** 解开 `{"edata":…}`；服务端偶尔返回明文信封，一并容忍。 */
  decodeEnvelope<T>(raw: string, key: NegotiatedKey): ApiEnvelope<T> {
    const outer = JSON.parse(raw) as { edata?: string } & ApiEnvelope<T>;
    if (typeof outer.edata === "string") {
      return JSON.parse(aesCbcDecrypt(key.evalue, outer.edata)) as ApiEnvelope<T>;
    }
    return outer;
  }

  /**
   * 构造 CTG 请求头。
   *
   * 签名用的 `requestId` / `timestamp` **必须与最终发出的同名头完全一致**，
   * 因此两者在同一处生成后传入，不允许各自再取一次 `Date.now()`。
   */
  buildHeaders(
    o: { requestId: string; timestamp: string; eid: string; auth?: AuthContext | undefined },
  ): Record<string, string> {
    const d = this.device;
    const headers: Record<string, string> = {
      "Accept": "application/json, text/plain, */*",
      "CTG-APPMODEL": d.appModel,
      "CTG-DEVICECODE": d.deviceCode,
      "CTG-DEVICETYPE": d.deviceType,
      "CTG-REQUESTID": o.requestId,
      "CTG-SOFTWARECODE": d.softwareCode,
      "CTG-TIMESTAMP": o.timestamp,
      "CTG-VERSION": d.clientVersion,
      "CTG-REQDATA-ETYPE": "2",
      "CTG-NEGO-EKEYID": o.eid,
    };

    if (o.auth) {
      headers["CTG-USERID"] = String(o.auth.userId);
      headers["CTG-TENANTID"] = String(o.auth.tenantId);
      headers["CTG-SIGNATURESTR"] = signature({
        deviceType: d.deviceType,
        requestId: o.requestId,
        tenantId: String(o.auth.tenantId),
        timestamp: o.timestamp,
        userId: String(o.auth.userId),
        version: d.clientVersion,
        secretKey: o.auth.secretKey,
      });
      if (o.auth.appChannel) headers["CTG-APPCHANNEL"] = o.auth.appChannel;
    }
    return headers;
  }
}

/**
 * `CTG-SIGNATURESTR = UPPERCASE(MD5(deviceType + requestId + tenantId +
 * timestamp + userId + version + secretKey))`
 *
 * 七字段直接拼接，不插分隔符。签名不包含 URL、查询串或请求体。
 */
export function signature(p: {
  deviceType: string;
  requestId: string;
  tenantId: string;
  timestamp: string;
  userId: string;
  version: string;
  secretKey: string;
}): string {
  return md5HexUpper(
    p.deviceType + p.requestId + p.tenantId + p.timestamp + p.userId + p.version + p.secretKey,
  );
}
