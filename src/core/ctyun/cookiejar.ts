/**
 * 按账号隔离的 CookieJar。
 *
 * 云电脑链（`desk.ctyun.cn:8810`）**不使用 Cookie**，认证完全依赖 CTG 头与
 * 加密 body；云智助手链则需要 Cookie，且 IAM（`desk.ctyun.cn`）与
 * `eaichat.ctyun.cn` **必须共用同一个 jar** —— `ticketAuthorize` 依赖
 * IAM 留下的会话。
 *
 * 浏览器里 10 个账号共用一个 jar，无法并行；这里每账号一个实例，
 * 这也是搬到后端的核心收益之一。
 */

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** 毫秒时间戳；undefined 表示会话 Cookie（进程内有效）。 */
  expires?: number;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
}

/** RFC 6265 的域名匹配：`domainAttr` 命中则 host 视为该域及其子域。 */
function domainMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const d = domain.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  return h === d || h.endsWith("." + d);
}

/** RFC 6265 的路径匹配。 */
function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  // 除非 cookiePath 以 / 结尾，否则路径边界必须是 /
  return cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/";
}

export class CookieJar {
  #cookies: Cookie[] = [];

  /**
   * 解析 `Set-Cookie` 响应头并存入。
   *
   * 注意一个响应可能有多个 `Set-Cookie`，`headers.getSetCookie()` 才能拿到全部
   * （`headers.get()` 会把它们用逗号连起来，而 Expires 里本身含逗号）。
   */
  storeFromResponse(url: string, headers: Headers): void {
    const list = headers.getSetCookie?.() ?? [];
    for (const raw of list) {
      const parsed = parseSetCookie(raw, new URL(url).hostname);
      if (parsed) this.#upsert(parsed);
    }
  }

  /** 手动设置一个 Cookie（`clientKey`、`skcache` 这类本地状态用它）。 */
  set(name: string, value: string, domain: string, path = "/"): void {
    this.#upsert({
      name,
      value,
      domain,
      path,
      secure: false,
      httpOnly: false,
      hostOnly: true,
    });
  }

  /** 生成请求用的 `Cookie` 头值；无匹配时返回空串。 */
  headerFor(url: string): string {
    const u = new URL(url);
    const now = Date.now();
    const out: string[] = [];

    for (const c of this.#cookies) {
      if (c.expires !== undefined && c.expires <= now) continue;
      if (c.secure && u.protocol !== "https:") continue;
      if (c.hostOnly ? u.hostname !== c.domain : !domainMatches(u.hostname, c.domain)) continue;
      if (!pathMatches(u.pathname || "/", c.path)) continue;
      out.push(`${c.name}=${c.value}`);
    }
    return out.join("; ");
  }

  /** 全部 Cookie 快照（调试用，值不应落日志）。 */
  snapshot(): ReadonlyArray<Cookie> {
    const now = Date.now();
    return this.#cookies.filter((c) => c.expires === undefined || c.expires > now);
  }

  clear(): void {
    this.#cookies = [];
  }

  #upsert(next: Cookie): void {
    const idx = this.#cookies.findIndex(
      (c) => c.name === next.name && c.domain === next.domain && c.path === next.path,
    );
    if (idx === -1) this.#cookies.push(next);
    else this.#cookies[idx] = next;
  }
}

/** 解析单个 `Set-Cookie`。无法解析时返回 undefined。 */
export function parseSetCookie(raw: string, hostname: string): Cookie | undefined {
  const parts = raw.split(";");
  const first = parts.shift()?.trim() ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0) return undefined;

  const cookie: Cookie = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
    // 未指定 Domain 时是 host-only Cookie
    domain: hostname,
    path: "/",
    secure: false,
    httpOnly: false,
    hostOnly: true,
  };

  for (const attr of parts) {
    const [k, ...rest] = attr.split("=");
    const key = k?.trim().toLowerCase() ?? "";
    const val = rest.join("=").trim();

    switch (key) {
      case "domain":
        if (val) {
          cookie.domain = val.replace(/^\./, "").toLowerCase();
          cookie.hostOnly = false;
        }
        break;
      case "path":
        if (val.startsWith("/")) cookie.path = val;
        break;
      case "expires": {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) cookie.expires = t;
        break;
      }
      case "max-age": {
        const secs = Number(val);
        if (Number.isFinite(secs)) {
          cookie.expires = Date.now() + secs * 1000;
        }
        break;
      }
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      default:
        break;
    }
  }

  return cookie;
}

/**
 * 带 Cookie 的 fetch。
 *
 * 云智助手链必须带 Cookie（`ticketAuthorize` 依赖 IAM 会话），
 * 与不带 Cookie 的云电脑链刻意分开。
 */
export function createCookieFetch(jar: CookieJar, baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    const headers = new Headers(init?.headers);
    const cookie = jar.headerFor(url);
    if (cookie) headers.set("Cookie", cookie);

    const res = await baseFetch(url, { ...init, headers });
    jar.storeFromResponse(url, res.headers);
    return res;
  };
}
