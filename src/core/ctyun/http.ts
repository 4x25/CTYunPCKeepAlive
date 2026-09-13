/**
 * fetch 封装。
 *
 * 相比浏览器端，后端最大的优势就是这里：`Origin` / `Referer` / `User-Agent`
 * 都能自由设置，可以精确复刻官方 Web 客户端的请求指纹。
 */
import { DEFAULT_USER_AGENT, PAGE_ORIGIN } from "./device.ts";

export interface BrowserFetchOptions {
  userAgent?: string;
  origin?: string;
  referer?: string;
  /** 单次请求超时（毫秒）。默认 15 秒。 */
  timeoutMs?: number;
  /** 注入用，便于单测。 */
  baseFetch?: typeof fetch;
}

/** 请求超时。与业务失败区分开，供上层归入「网络类」可重试错误。 */
export class RequestTimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`请求超时（${timeoutMs}ms）`);
    this.name = "RequestTimeoutError";
  }
}

/**
 * 产出一个带浏览器身份头与超时的 fetch。
 *
 * 本链不带 Cookie —— 认证完全依赖 CTG 头与加密 body。云智助手链另有
 * 独立的 CookieJar，两者不共享。
 */
export function createBrowserFetch(opts: BrowserFetchOptions = {}): typeof fetch {
  const ua = opts.userAgent ?? DEFAULT_USER_AGENT;
  const origin = opts.origin ?? PAGE_ORIGIN;
  const referer = opts.referer ?? `${PAGE_ORIGIN}/`;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const base = opts.baseFetch ?? fetch;

  return async function browserFetch(input, init) {
    const headers = new Headers(init?.headers);
    if (!headers.has("User-Agent")) headers.set("User-Agent", ua);
    if (!headers.has("Origin")) headers.set("Origin", origin);
    if (!headers.has("Referer")) headers.set("Referer", referer);
    if (!headers.has("Accept-Language")) headers.set("Accept-Language", "zh-CN,zh;q=0.9");

    const timer = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timer]) : timer;

    try {
      return await base(input, { ...init, headers, signal });
    } catch (err) {
      if (timer.aborted) {
        const url = typeof input === "string" ? input : String((input as Request).url ?? input);
        throw new RequestTimeoutError(url, timeoutMs);
      }
      throw err;
    }
  };
}
