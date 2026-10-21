/**
 * 云智助手（eaichat.ctyun.cn）类型化客户端。
 *
 * 以 docs/research/eaichat-client.mjs 为起点：IAM 登录 → CAS ticket →
 * ticketAuthorize（jwt + YL-Ssid）→ queryUserInfo / 无感保活 / AI 对话。
 *
 * JWT 从 CookieJar 的 `YL-Token` 取（服务端渲染顶层 Web 不发 YL-Authorization）；
 * 会话密钥 sk / JWT / cookie 只在内存中，不落日志、不持久化。
 */
import crypto from 'node:crypto'
import { aesEcbDecrypt, md5, randomAlphaNum, randomPrintable, rsaEncryptPkcs1Hex, sha256 } from './crypto'
import { UpstreamError, UpstreamNetworkError } from './errors'

const DESK_BASE = 'https://desk.ctyun.cn'
const DEFAULT_EAI_BASE = 'https://eaichat.ctyun.cn'
const GATEWAY_URL = 'https://gwyilian.ctyun.cn/server/eaiSysInfo'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const EAI_VERSION = '202060405'
const PRODUCT_ID = '5'
const WEB_CLIENT = 'eaiapp'
const GATEWAY_AES_KEY = 'chinatelecom@cnn'

export const EAI_JWT_COOKIE = 'YL-Token'
export const JWT_RENEW_THRESHOLD_MS = 6 * 24 * 60 * 60 * 1000
/** 云智助手登录链路单请求超时 / 独立调用时的整体预算 */
const EAI_LOGIN_CALL_TIMEOUT_MS = 7_000
const EAI_LOGIN_BUDGET_MS = 28_000

interface Cookie {
  name: string
  value: string
  domain: string
  path: string
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

/** CookieJar：上游 Cookie 有 Domain=.ctyun.cn / Path=/ 等约束，不能只存 name=value */
export class CookieJar {
  private cookies: Cookie[]

  constructor(cookies: Cookie[] = []) {
    this.cookies = cookies
  }

  addFromResponse(setCookies: string[], requestUrl: string): void {
    for (const raw of setCookies) {
      const [pair, ...attrs] = raw.split(';')
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const attr = (key: string): string | undefined => {
        const hit = attrs.find((item) => item.trim().toLowerCase().startsWith(`${key}=`))
        return hit ? hit.slice(hit.indexOf('=') + 1).trim() : undefined
      }
      const domain = (attr('domain') || new URL(requestUrl).hostname).replace(/^\./, '').toLowerCase()
      const cookiePath = attr('path') || '/'

      let expired = false
      const maxAge = attr('max-age')
      if (maxAge !== undefined && Number(maxAge) <= 0) expired = true
      const expires = attr('expires')
      if (expires && new Date(expires).getTime() <= Date.now()) expired = true

      this.cookies = this.cookies.filter(
        (item) => !(item.name === name && item.domain === domain && item.path === cookiePath),
      )
      if (!expired) this.cookies.push({ name, value, domain, path: cookiePath })
    }
  }

  headerFor(url: string): string {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return this.cookies
      .filter(
        (cookie) =>
          (host === cookie.domain || host.endsWith(`.${cookie.domain}`)) && parsed.pathname.startsWith(cookie.path),
      )
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
  }

  get(name: string): string | null {
    return this.cookies.find((cookie) => cookie.name === name)?.value ?? null
  }

  clear(): void {
    this.cookies = []
  }

  toJSON(): Cookie[] {
    return this.cookies.map((cookie) => ({ ...cookie }))
  }
}

/**
 * 前端 S({params, sk, data}) 的同构实现：
 * params 按 key 排序拼 k=v；data 先 MD5；再 SHA256(`${payload}&sk&timestamp&random`)。
 */
export function buildSignature(options: {
  params?: Record<string, unknown>
  dataString?: string
  sk: string
}): { sign: string; random: string; timestamp: string } {
  const query = Object.entries(options.params ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&')

  let payload = query
  if (options.dataString !== undefined) {
    const digest = md5(options.dataString)
    payload = payload ? `${payload}&${digest}` : digest
  }

  const timestamp = Date.now().toString()
  const random = randomAlphaNum(8)
  const toSign = `${payload ? `${payload}&` : ''}${options.sk}&${timestamp}&${random}`
  return { sign: sha256(toSign), random, timestamp }
}

export interface EaiChatUserInfo {
  nickName: string | null
  vipType: string | null
  iamUid: string | null
  raw: JsonRecord
}

export interface EaiChatResult {
  conversationId: string | null
  messageId: string | null
  content: string
  reasoning: string
  status: string | null
  auditResult: unknown
  finishReason: string | null
  model: string | null
  events: JsonRecord[]
}

interface RequestOptions {
  method?: string
  params?: Record<string, unknown>
  data?: unknown
  rawBody?: string
  signDataString?: string
  headers?: Record<string, string>
  skipSignature?: boolean
  timeoutMs?: number
}

export class EaiChatClient {
  private readonly userAccount: string
  private readonly password: string
  private readonly eaiBase: string
  private readonly deskBase: string
  private readonly gatewayUrl: string
  private readonly jar = new CookieJar()
  private tenantId: number | null = null
  private sk: string | null = null
  private jwt: string | null = null
  private readonly xuid = `pubweb_${crypto.randomUUID()}`
  private loginAt: number | null = null

  constructor(options: {
    userAccount: string
    password: string
    /** 测试/诊断用；默认 https://eaichat.ctyun.cn */
    base?: string
    deskBase?: string
    gatewayUrl?: string
  }) {
    this.userAccount = options.userAccount
    this.password = options.password
    this.eaiBase = options.base ?? process.env.CTYUN_EAI_BASE ?? DEFAULT_EAI_BASE
    this.deskBase = options.deskBase ?? DESK_BASE
    this.gatewayUrl = options.gatewayUrl ?? GATEWAY_URL
  }

  get isLoggedIn(): boolean {
    return !!this.sk && !!this.jwt
  }

  get token(): string | null {
    return this.jwt
  }

  get tenant(): number | null {
    return this.tenantId
  }

  get loggedInAt(): number | null {
    return this.loginAt
  }

  /** JWT 的 exp（毫秒）；解析失败返回 null */
  jwtExpiresAt(): number | null {
    if (!this.jwt) return null
    try {
      const payload = this.jwt.split('.')[1]
      if (!payload) return null
      const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number }
      return typeof json.exp === 'number' ? json.exp * 1000 : null
    } catch {
      return null
    }
  }

  jwtRemainingMs(): number | null {
    const expiresAt = this.jwtExpiresAt()
    return expiresAt == null ? null : expiresAt - Date.now()
  }

  /** 到期前（默认 <6 天）静默重走登录链路（backend-design §6.2） */
  needsRenewal(thresholdMs = JWT_RENEW_THRESHOLD_MS): boolean {
    const remaining = this.jwtRemainingMs()
    return remaining == null || remaining < thresholdMs
  }

  private async rawFetch(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string; withCredentials?: boolean; timeoutMs?: number } = {},
  ): Promise<Response> {
    const cookie = options.withCredentials === false ? '' : this.jar.headerFor(url)
    const headers: Record<string, string> = { 'user-agent': UA, ...(options.headers ?? {}) }
    if (cookie) headers.cookie = cookie

    let res: Response
    try {
      res = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown'
      throw new UpstreamNetworkError(`云智助手网络请求失败（${name}）`)
    }
    const setCookies = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    this.jar.addFromResponse(setCookies, url)
    return res
  }

  private async api(pathname: string, options: RequestOptions = {}): Promise<JsonRecord> {
    const url = new URL(pathname.startsWith('http') ? pathname : `${this.eaiBase}${pathname}`)
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }

    let body: string | undefined
    let bodyString = options.signDataString
    if (options.rawBody !== undefined) {
      body = options.rawBody
    } else if (options.data !== undefined) {
      body = JSON.stringify(options.data)
      bodyString = body
    }

    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      origin: this.eaiBase,
      referer: `${this.eaiBase}/chat/`,
      'x-eai-mode': 'eai',
      'x-eai-source': 'web-eai',
      'x-eai-version': EAI_VERSION,
      'x-eai-env': 'pubWeb',
      'x-eai-env-code': '',
      'x-eai-gw-code': '',
      'x-eai-xuid': this.xuid,
      'x-user-agent': UA,
      'x-client-trace-id': crypto.randomUUID(),
      'YL-Main-Version': EAI_VERSION,
      'YL-Product-Id': PRODUCT_ID,
      'YL-Authorization': '',
      ...(options.headers ?? {}),
    }
    if (this.tenantId != null) headers['x-eai-tenant-id'] = String(this.tenantId)
    if (body !== undefined) headers['content-type'] = 'application/json'

    if (!options.skipSignature && this.sk) {
      const signature = buildSignature({ params: options.params, dataString: bodyString, sk: this.sk })
      headers['Web-Signature'] = signature.sign
      headers['Web-Random'] = signature.random
      headers['Web-Timestamp'] = signature.timestamp
    }

    const res = await this.rawFetch(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      body,
      timeoutMs: options.timeoutMs,
    })
    const text = await res.text()
    if (res.status === 401) {
      this.jar.clear()
      this.sk = null
      this.jwt = null
      this.tenantId = null
      this.loginAt = null
      throw new UpstreamError(40010, '云智助手会话已过期（HTTP 401）')
    }
    if (!text) return {}
    try {
      return JSON.parse(text) as JsonRecord
    } catch {
      throw new UpstreamNetworkError(`云智助手响应不是 JSON（HTTP ${res.status}）`)
    }
  }

  private async getGateway(timeoutMs?: number): Promise<{ ssopk: string; ssopkid: string }> {
    const res = await this.rawFetch(this.gatewayUrl, {
      headers: { accept: 'application/json, text/plain, */*', origin: this.eaiBase },
      withCredentials: false,
      timeoutMs,
    })
    const json = (await res.json()) as JsonRecord
    if (typeof json.data !== 'string' || !json.data) throw new UpstreamError(40050, '云智助手网关配置为空')
    const plain = aesEcbDecrypt(json.data.replace(/[\r\n]/g, ''), GATEWAY_AES_KEY)
    const gw = JSON.parse(plain) as JsonRecord
    const sso = isRecord(gw.sso) ? gw.sso : {}
    if (typeof sso.ssopk !== 'string' || typeof sso.ssopkid !== 'string') {
      throw new UpstreamError(40050, '云智助手网关配置缺少 sso.ssopk/ssopkid')
    }
    return { ssopk: sso.ssopk, ssopkid: sso.ssopkid }
  }

  async login(): Promise<this> {
    return this.loginWithDeadline()
  }

  /** 带整体预算的登录（budgetDeadline 由 loginSession 传入剩余预算；缺省用本客户端默认预算） */
  async loginWithDeadline(budgetDeadline?: number): Promise<this> {
    if (!this.userAccount || !this.password) throw new UpstreamError(10004, '缺少账号或密码')
    const deadline = budgetDeadline ?? Date.now() + EAI_LOGIN_BUDGET_MS
    const budgeted = async <T>(run: (timeoutMs: number) => Promise<T>, timeoutMs: number): Promise<T> => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new UpstreamNetworkError('云智助手登录超过整体预算')
      return run(remaining < timeoutMs ? remaining : timeoutMs)
    }
    this.jar.clear()
    this.sk = null
    this.jwt = null
    this.tenantId = null
    this.loginAt = null

    const iamPrefix = `${this.deskBase}/cloudB/dy/iam`
    const loginBody = {
      userAccount: this.userAccount,
      password: sha256(this.password),
      deviceCode: `iam:${crypto.randomBytes(16).toString('hex').slice(0, 31)}`,
      deviceName: 'iam:web',
    }
    const loginRes = await budgeted(
      (timeoutMs) =>
        this.rawFetch(`${iamPrefix}/api/auth/iam/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/plain, */*',
            origin: this.deskBase,
            referer: `${iamPrefix}/?consent=false`,
          },
          body: JSON.stringify(loginBody),
          timeoutMs,
        }),
      EAI_LOGIN_CALL_TIMEOUT_MS,
    )
    const loginJson = (await loginRes.json()) as JsonRecord
    const loginCode = Number(loginJson.code)
    if (loginCode !== 0) {
      throw new UpstreamError(
        Number.isFinite(loginCode) ? loginCode : -1,
        `IAM 登录失败（code=${Number.isFinite(loginCode) ? loginCode : 'unknown'}）`,
      )
    }
    const loginData = isRecord(loginJson.data) ? loginJson.data : {}
    if (loginData.needSmsValidate === true) {
      throw new UpstreamError(51090, '该账号要求短信二次验证')
    }
    const tenantId = Number(loginData.tenantId)
    if (!Number.isFinite(tenantId)) throw new UpstreamError(40050, 'IAM 登录响应缺少 tenantId')
    this.tenantId = tenantId

    const casUrl = `${iamPrefix}/api/auth/iam/cas/login?service=${encodeURIComponent(
      `${this.eaiBase}:443/chat/#/aichat`,
    )}&consent=false`
    const casRes = await budgeted(
      (timeoutMs) =>
        this.rawFetch(casUrl, {
          headers: { accept: 'application/json, text/plain, */*', referer: `${iamPrefix}/?consent=false` },
          timeoutMs,
        }),
      EAI_LOGIN_CALL_TIMEOUT_MS,
    )
    const location = casRes.headers.get('location')
    if (!location) throw new UpstreamError(-1, `CAS 未返回 Location（HTTP ${casRes.status}）`)
    const locationUrl = new URL(location, casUrl)
    const ticket =
      locationUrl.searchParams.get('ticket') ??
      new URLSearchParams(locationUrl.hash.split('?')[1] ?? '').get('ticket')
    if (!ticket) throw new UpstreamError(-1, 'CAS Location 中没有 ticket')

    const gateway = await budgeted(
      (timeoutMs) => this.getGateway(timeoutMs),
      EAI_LOGIN_CALL_TIMEOUT_MS,
    )
    const clientKey = randomPrintable(16)
    const clientKeyHex = rsaEncryptPkcs1Hex(gateway.ssopk, clientKey)

    const form = new URLSearchParams()
    form.append('loginType', 'iamTicket')
    form.append('clientId', WEB_CLIENT)
    form.append('iamTicket', ticket)
    form.append('jwtType', '3')
    form.append('redirectUri', `${this.eaiBase}:443/chat/#/aichat`)
    form.append('clientKey', clientKeyHex)
    form.append('clientKeyId', gateway.ssopkid)

    const authRes = await budgeted(
      (timeoutMs) =>
        this.rawFetch(`${this.eaiBase}/sso/login/v2/iam/ticketAuthorize`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            accept: 'application/json, text/plain, */*',
            origin: this.eaiBase,
            referer: `${this.eaiBase}/chat/`,
            'x-eai-mode': 'eai',
            'x-eai-source': 'web-eai',
            'x-eai-version': EAI_VERSION,
            'x-eai-xuid': this.xuid,
            'x-user-agent': UA,
            'x-client-trace-id': crypto.randomUUID(),
            'YL-Main-Version': EAI_VERSION,
            'YL-Product-Id': PRODUCT_ID,
            'YL-Authorization': '',
          },
          body: form.toString(),
          timeoutMs,
        }),
      EAI_LOGIN_CALL_TIMEOUT_MS,
    )
    const authJson = (await authRes.json()) as JsonRecord
    const resultCode = Number(authJson.resultCode)
    if (resultCode !== 0) {
      throw new UpstreamError(Number.isFinite(resultCode) ? resultCode : -1, '云智助手 ticketAuthorize 失败')
    }
    const authData = isRecord(authJson.data) ? authJson.data : {}
    if (typeof authData.sessionKey !== 'string' || !authData.sessionKey) {
      throw new UpstreamError(40050, '云智助手 ticketAuthorize 未返回 sessionKey')
    }
    this.sk = aesEcbDecrypt(authData.sessionKey, clientKey)

    /* 硬约束：JWT 从 CookieJar 的 YL-Token 取；若上游未写 cookie 再回退响应体 */
    this.jwt = this.jar.get(EAI_JWT_COOKIE) ?? (typeof authData.jwt === 'string' ? authData.jwt : null)
    if (!this.jwt) throw new UpstreamError(40050, '云智助手会话缺少 YL-Token')
    this.loginAt = Date.now()
    return this
  }

  async queryUserInfo(): Promise<EaiChatUserInfo> {
    const json = await this.api('/ai/portal/wenc/v1/user/queryUserInfo')
    if (Number(json.resultCode) !== 0) throw new UpstreamError(-1, '云智助手 queryUserInfo 失败')
    const data = isRecord(json.data) ? json.data : {}
    return {
      nickName: typeof data.nickName === 'string' ? data.nickName : null,
      vipType: typeof data.vipType === 'string' ? data.vipType : null,
      iamUid: typeof data.iamUid === 'string' ? data.iamUid : null,
      raw: data,
    }
  }

  /** S4 用：单轮流式对话；本期保留完整实现，不做任务编排 */
  async chat(
    message: string,
    options: { conversationId?: string; model?: string; webSearch?: boolean; thinking?: boolean } = {},
  ): Promise<EaiChatResult> {
    if (!this.sk) throw new UpstreamError(40010, '云智助手未登录')
    if (!message.trim()) throw new UpstreamError(10004, '消息不能为空')

    const data: JsonRecord = {
      key_model: options.model ?? 'TEXT_QWEN_3.7',
      messages: [
        {
          role: 'user',
          content: message,
          verify_id: crypto.randomUUID(),
          ref: { type: 'file', file: [] },
        },
      ],
      stream: true,
      client_retry: true,
      web_search: options.webSearch !== false,
      tenantId: String(this.tenantId),
      enable_thinking: !!options.thinking,
    }
    if (options.conversationId) data.conversation_id = options.conversationId

    const body = JSON.stringify(data)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      origin: this.eaiBase,
      referer: `${this.eaiBase}/chat/`,
      'x-eai-mode': 'eai',
      'x-eai-source': 'web-eai',
      'x-eai-version': EAI_VERSION,
      'x-eai-tenant-id': String(this.tenantId),
      'x-eai-env': 'pubWeb',
      'x-eai-env-code': '',
      'x-eai-gw-code': '',
      'x-eai-xuid': this.xuid,
      'x-user-agent': UA,
      'x-client-trace-id': crypto.randomUUID(),
      'YL-Main-Version': EAI_VERSION,
      'YL-Product-Id': PRODUCT_ID,
      'YL-Authorization': '',
    }
    const signature = buildSignature({ dataString: body, sk: this.sk })
    headers['Web-Signature'] = signature.sign
    headers['Web-Random'] = signature.random
    headers['Web-Timestamp'] = signature.timestamp

    const res = await this.rawFetch(`${this.eaiBase}/ai/portal/wenc/v3/openai/chat/completions`, {
      method: 'POST',
      headers,
      body,
      timeoutMs: 120_000,
    })
    if (res.status === 401) {
      this.jar.clear()
      this.sk = null
      this.jwt = null
      throw new UpstreamError(40010, '云智助手会话已过期（HTTP 401）')
    }
    if (!res.ok) throw new UpstreamNetworkError(`云智助手对话 HTTP ${res.status}`)
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      throw new UpstreamNetworkError(`云智助手对话未返回 SSE（content-type=${contentType}）`)
    }

    const result: EaiChatResult = {
      conversationId: options.conversationId ?? null,
      messageId: null,
      content: '',
      reasoning: '',
      status: null,
      auditResult: null,
      finishReason: null,
      model: null,
      events: [],
    }

    for await (const event of parseSse(res)) {
      if (event.done) break
      const json = event.data
      result.events.push(json)
      if (typeof json.conversation_id === 'string') result.conversationId = json.conversation_id
      if (typeof json.message_id === 'string') result.messageId = json.message_id
      if (typeof json.model === 'string') result.model = json.model
      if (typeof json.status === 'string') result.status = json.status
      if (json.audit_result !== undefined) result.auditResult = json.audit_result
      if (json.error) throw new UpstreamError(-1, '云智助手对话返回错误')

      const choices = Array.isArray(json.choices) ? json.choices : []
      const choice = isRecord(choices[0]) ? choices[0] : {}
      const delta = isRecord(choice.delta) ? choice.delta : {}
      if (typeof delta.content === 'string') result.content += delta.content
      if (typeof delta.reasoning_content === 'string') result.reasoning += delta.reasoning_content
      if (typeof choice.finish_reason === 'string') result.finishReason = choice.finish_reason
      if (json.status === 'fail') throw new UpstreamError(-1, '云智助手模型返回 status=fail')
    }
    return result
  }

  async logout(): Promise<void> {
    try {
      await this.api('/sso/login/v2/iam/logout', { method: 'POST', timeoutMs: 5_000 })
    } catch {
      /* 退出失败不影响本地清理 */
    }
    try {
      const iamPrefix = `${this.deskBase}/cloudB/dy/iam`
      await this.rawFetch(
        `${iamPrefix}/api/auth/iam/cas/logout?service=${encodeURIComponent(
          `${this.eaiBase}:443/chat/#/login`,
        )}`,
        { headers: { accept: 'application/json, text/plain, */*', referer: `${iamPrefix}/?consent=false` }, timeoutMs: 5_000 },
      )
    } catch {
      /* 同上 */
    }
    this.jar.clear()
    this.sk = null
    this.jwt = null
    this.tenantId = null
    this.loginAt = null
  }
}

/* ── SSE 解析（research 同构） ─────────────────────────────── */

export interface SseEvent {
  done: boolean
  event: string
  id: string
  data: JsonRecord
  raw?: string
}

function parseSseBlock(block: string): SseEvent | null {
  const dataLines: string[] = []
  let event = ''
  let id = ''
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') id = value
  }
  if (!dataLines.length) return null
  const raw = dataLines.join('\n')
  if (!raw) return null
  if (raw === '[DONE]') return { done: true, event, id, data: {} }
  try {
    return { done: false, event, id, data: JSON.parse(raw) as JsonRecord, raw }
  } catch {
    throw new UpstreamNetworkError('云智助手 SSE JSON 解析失败')
  }
}

export async function* parseSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) throw new UpstreamNetworkError('云智助手响应没有 body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (value) {
        buffer += decoder.decode(value, { stream: true })
        buffer = buffer.replace(/\r\n/g, '\n')
        let index: number
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const event = parseSseBlock(block)
          if (event) yield event
        }
      }
      if (done) break
    }
    buffer += decoder.decode()
    buffer = buffer.replace(/\r\n/g, '\n').trim()
    if (buffer) {
      const event = parseSseBlock(buffer)
      if (event) yield event
    }
  } finally {
    reader.releaseLock()
  }
}
