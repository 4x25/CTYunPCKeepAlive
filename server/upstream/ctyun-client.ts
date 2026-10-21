/**
 * 天翼云电脑（desk.ctyun.cn:8810）类型化客户端。
 *
 * 以 docs/research/ctyun-client.mjs 为起点，保持已验证的协议细节：
 *   getServData（校时/加密开关）→ negotiationEncKey（RSA-2048 PKCS#1 v1.5）
 *   → genChallengeData → login → pageDesktop / 积分接口
 *
 * 会话密钥（evalue）/ secretKey / 密码摘要只存在于本对象内存中，不落日志。
 */
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  generateRsaKeyPair,
  md5,
  randomDeviceCode,
  rsaDecryptPkcs1,
  sha256,
} from './crypto'
import { UpstreamError, UpstreamNetworkError } from './errors'

const MAIN_HOST = 'https://desk.ctyun.cn:8810'
const SELFORDER_HOST = 'https://desk.ctyun.cn'
const REGION_HOSTS = [
  'https://gzgz3b-deskmgr.ctyun.cn:8810',
  'https://sxxa4-deskmgr.ctyun.cn:8810',
  'https://gdgz5b-deskmgr.ctyun.cn:8810',
  'https://sh7c-deskmgr.ctyun.cn:8810',
]

const DEVICE_TYPE = '60'
const APP_VERSION = '4.0.1'
const CLIENT_VERSION = '204000100'
const SOFTWARE_CODE = 'web_client'
const APP_MODEL = '2'

/** 登录链路单请求超时（整体预算 28s，见 http() 的 deadline） */
const LOGIN_CALL_TIMEOUT_MS = 7_000
const LOGIN_BUDGET_MS = 28_000
const REQUEST_TIMEOUT_MS = 15_000
/** listDesktopByIds 每批补拉的 objId 数（research §5.2） */
const FETCH_BY_IDS_BATCH = 30
/** pageDesktop 单页拉取数（上游限制 20，传 100 返回 40050） */
const GET_CNT = 20

export interface CtyunLoginProfile {
  userId: number
  tenantId: number
  secretKey: string
  userName: string | null
  userAccount: string
  timestamp: number | null
}

export type CtyunRunState = 'running' | 'starting' | 'stopping' | 'stopped' | 'error'

export interface CtyunDesktop {
  desktopId: string
  desktopName: string
  osType: string
  run: CtyunRunState
  /** 无感保活用的 UUID（backend-design §3.1），不进入前端契约 */
  foreignDesktopId: string | null
  expireDate: number | null
}

interface RawDesktop {
  objId?: string | number
  objType?: number
  desktopId?: string | number
  desktopName?: string
  objName?: string
  osType?: string
  osName?: string
  useStatus?: string | number
  useStatusText?: string
  foreignDesktopId?: string
  expireDate?: number | string | null
}

interface RawPageDesktop {
  sortList?: Array<{ objId?: string | number; objType?: number }>
  desktopList?: RawDesktop[]
  desktopPoolList?: RawDesktop[]
  preemptionDesktopList?: RawDesktop[]
}

interface HttpResult {
  status: number
  json: Record<string, unknown> | null
  text: string
}

interface EncMaterial {
  eid: string
  evalue: string
}

interface RequestOptions {
  headers?: Record<string, string>
  body?: string
  query?: Record<string, string>
  timeoutMs?: number
  retries?: number
  /** 积分中心 iframe 口径：不带协商头，响应明文 JSON */
  plain?: boolean
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function platformName(): string {
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'linux') return 'Linux'
  return process.platform
}

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** run 映射规则（backend-design §5）：判据 useStatusText / useStatus，status 恒 "OK" 不可用 */
export function mapRunState(raw: Pick<RawDesktop, 'useStatus' | 'useStatusText'>): CtyunRunState {
  const text = String(raw.useStatusText ?? '')
  const code = toNumber(raw.useStatus)
  if (text.includes('运行')) return 'running'
  if (text.includes('启动') || text.includes('开机中')) return 'starting'
  if (text.includes('关机中') || text.includes('停止中')) return 'stopping'
  if (text.includes('已关机')) return 'stopped'
  if (text.includes('异常') || text.includes('错误')) return 'error'
  if (code === 15 || code === 25) return 'running'
  if (code === 45) return 'stopped'
  return 'error'
}

function toDesktop(raw: RawDesktop): CtyunDesktop | null {
  const desktopId = raw.desktopId ?? raw.objId
  if (desktopId == null) return null
  return {
    desktopId: String(desktopId),
    desktopName: String(raw.desktopName ?? raw.objName ?? desktopId),
    osType: String(raw.osType ?? raw.osName ?? ''),
    run: mapRunState(raw),
    foreignDesktopId: raw.foreignDesktopId ? String(raw.foreignDesktopId) : null,
    expireDate: toNumber(raw.expireDate),
  }
}

function isHostFailure(error: unknown): boolean {
  return error instanceof UpstreamNetworkError || (error instanceof UpstreamError && error.code === 30020)
}

export class CtyunClient {
  private readonly userAccount: string
  private readonly password: string
  private readonly hosts: string[]
  private readonly selforderHost: string
  private hostIndex = 0
  private base: string
  /** serverTime - clientTime 的修正量（毫秒） */
  private offset = 0
  private counter = 0
  private enc: EncMaterial | null = null
  private auth: CtyunLoginProfile | null = null
  private readonly deviceCode: string
  private deadline = 0

  constructor(options: { userAccount: string; password: string; base?: string }) {
    this.userAccount = options.userAccount
    this.password = options.password
    const configured = options.base ?? process.env.CTYUN_BASE
    this.hosts = configured ? [configured] : [MAIN_HOST, ...REGION_HOSTS]
    this.base = this.hosts[0]
    this.selforderHost = process.env.CTYUN_SELFORDER_BASE || SELFORDER_HOST
    this.deviceCode = randomDeviceCode('web')
  }

  get profile(): CtyunLoginProfile | null {
    return this.auth
  }

  get host(): string {
    return this.base
  }

  getLoginProfile(): CtyunLoginProfile {
    if (!this.auth) throw new UpstreamError(40010, '未登录')
    return this.auth
  }

  private setHost(index: number): void {
    this.hostIndex = index
    this.base = this.hosts[index]
    this.offset = 0
    this.enc = null
    this.auth = null
  }

  private nextRequestMeta(): { requestId: string; timestamp: string } {
    const now = Date.now()
    return { requestId: String(now + ++this.counter), timestamp: String(now - this.offset) }
  }

  private buildHeaders(extra: Record<string, string> = {}, plain = false): Record<string, string> {
    const { requestId, timestamp } = this.nextRequestMeta()
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://pc.ctyun.cn',
      Referer: 'https://pc.ctyun.cn/',
      'CTG-APPMODEL': APP_MODEL,
      'CTG-DEVICECODE': this.deviceCode,
      'CTG-DEVICETYPE': DEVICE_TYPE,
      'CTG-REQUESTID': requestId,
      'CTG-TIMESTAMP': timestamp,
      'CTG-VERSION': CLIENT_VERSION,
      'CTG-SOFTWARECODE': SOFTWARE_CODE,
    }
    if (this.enc && !plain) {
      headers['CTG-REQDATA-ETYPE'] = '2'
      headers['CTG-NEGO-EKEYID'] = this.enc.eid
    }
    if (this.auth) {
      headers['CTG-USERID'] = String(this.auth.userId)
      headers['CTG-TENANTID'] = String(this.auth.tenantId)
      headers['CTG-SIGNATURESTR'] = md5(
        `${DEVICE_TYPE}${requestId}${this.auth.tenantId}${timestamp}${this.auth.userId}${CLIENT_VERSION}${this.auth.secretKey}`,
      ).toUpperCase()
    }
    return { ...headers, ...extra }
  }

  private async http(method: string, apiPath: string, options: RequestOptions = {}): Promise<HttpResult> {
    const url = new URL(apiPath, this.base)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)

    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    const retries = options.retries ?? 1
    let lastError: unknown

    for (let attempt = 0; attempt <= retries; attempt++) {
      const remaining = this.deadline > 0 ? this.deadline - Date.now() : timeoutMs
      if (remaining <= 0) throw new UpstreamNetworkError('登录请求超过 28s 未完成')
      const signal = AbortSignal.timeout(Math.min(timeoutMs, remaining))
      try {
        const res = await fetch(url, {
          method,
          headers: this.buildHeaders(options.headers, options.plain),
          body: options.body,
          signal,
        })
        const text = await res.text()
        let json: Record<string, unknown> | null = null
        try {
          json = text ? (JSON.parse(text) as Record<string, unknown>) : null
        } catch {
          json = null
        }
        return { status: res.status, json, text }
      } catch (error) {
        lastError = error
        if (attempt < retries) await sleep(600 * (attempt + 1))
      }
    }

    const detail = lastError instanceof Error ? lastError.name : 'unknown'
    throw new UpstreamNetworkError(`上游请求失败（${detail}）`)
  }

  /** edata 解密后才是 {code,msg,data} */
  private unwrap<T>(res: HttpResult): T {
    if (res.json && typeof res.json.edata === 'string') {
      if (!this.enc) throw new UpstreamError(40010, '响应已加密但尚未协商会话密钥')
      let envelope: Record<string, unknown>
      try {
        envelope = JSON.parse(aesCbcDecrypt(res.json.edata, this.enc.evalue)) as Record<string, unknown>
      } catch {
        throw new UpstreamError(40010, '响应解密失败，请重新登录')
      }
      if (envelope.code !== 0) {
        throw new UpstreamError(Number(envelope.code) || 40010, String(envelope.msg ?? ''))
      }
      return envelope.data as T
    }
    if (res.json && typeof res.json.code === 'number') {
      if (res.json.code !== 0) throw new UpstreamError(res.json.code, String(res.json.msg ?? ''))
      return res.json.data as T
    }
    if (res.status >= 200 && res.status < 300) return null as T
    throw new UpstreamNetworkError(`上游 HTTP ${res.status}`)
  }

  /** 明文接口（协商前调用）；主 host 网络异常时按区域 host 依次重试 */
  async negotiate(budget?: { deadline: number }): Promise<EncMaterial> {
    if (budget) {
      /* 剩余预算不足以再完成一次协商时直接失败，避免半途而废 */
      if (budget.deadline <= Date.now()) throw new UpstreamNetworkError('登录请求超过整体预算')
      this.deadline = budget.deadline
    } else if (this.deadline <= Date.now()) {
      this.deadline = 0
    }
    let lastError: unknown

    for (let index = this.hostIndex; index < this.hosts.length; index++) {
      if (index !== this.hostIndex) this.setHost(index)
      try {
        await this.negotiateOnCurrentHost()
        return this.enc as EncMaterial
      } catch (error) {
        lastError = error
        if (!isHostFailure(error) || index === this.hosts.length - 1) throw error
      }
    }

    throw lastError instanceof Error ? lastError : new UpstreamNetworkError('会话协商失败')
  }

  private async negotiateOnCurrentHost(): Promise<void> {
    if (this.deadline > 0 && this.deadline <= Date.now()) {
      throw new UpstreamNetworkError('登录请求超过整体预算')
    }
    const serv = await this.http('GET', '/api/cdserv/client/getServData', {
      timeoutMs: LOGIN_CALL_TIMEOUT_MS,
      retries: 0,
    })
    if (serv.json?.code !== 0) {
      throw new UpstreamError(Number(serv.json?.code) || 40010, String(serv.json?.msg ?? ''))
    }
    const servData = isRecord(serv.json?.data) ? serv.json.data : {}
    const serverTimestamp = toNumber(servData.timestamp)
    if (serverTimestamp != null) this.offset = Date.now() - serverTimestamp

    const switches = isRecord(servData.globalSwitches) ? servData.globalSwitches : {}
    const types = Array.isArray(switches.bodyMsgEType) ? switches.bodyMsgEType.map(String) : []
    if (!types.includes('2')) {
      throw new UpstreamError(40050, '服务端未开启 AES_CBC 请求加密')
    }

    const rsa = generateRsaKeyPair(2048)
    const neg = await this.http('POST', '/api/auth/client/negotiationEncKey', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ etype: '2', certType: '2', certData: rsa.spkiBase64 }),
      timeoutMs: LOGIN_CALL_TIMEOUT_MS,
      retries: 0,
    })
    if (neg.json?.code !== 0 || !isRecord(neg.json?.data)) {
      throw new UpstreamError(Number(neg.json?.code) || 40010, String(neg.json?.msg ?? ''))
    }
    const encKey = String(neg.json.data.encKey ?? '')
    const encData = String(neg.json.data.encData ?? '')
    if (!encKey || !encData) throw new UpstreamError(40050, '协商响应缺少 encKey/encData')

    const aesKey = rsaDecryptPkcs1(rsa.privateKey, encKey)
    const material = JSON.parse(aesCbcDecrypt(encData, aesKey)) as Partial<EncMaterial>
    if (!material.eid || !material.evalue) throw new UpstreamError(40050, '协商结果缺少 eid/evalue')
    this.enc = { eid: material.eid, evalue: material.evalue }
  }

  private async genChallenge(): Promise<{ challengeId: string; challengeCode: string } | null> {
    try {
      const data = await this.postJson<Record<string, unknown>>(
        '/api/auth/client/genChallengeData',
        {},
        { timeoutMs: LOGIN_CALL_TIMEOUT_MS, retries: 0 },
      )
      if (data && typeof data.challengeId === 'string' && typeof data.challengeCode === 'string') {
        return { challengeId: data.challengeId, challengeCode: data.challengeCode }
      }
      return null
    } catch {
      /* 上游不支持 challenge 时回退无盐摘要（research 已验证口径） */
      return null
    }
  }

  async login(): Promise<CtyunLoginProfile> {
    if (!this.enc) throw new UpstreamError(40010, '请先协商会话密钥')

    const challenge = await this.genChallenge()
    const salt = challenge?.challengeCode ?? ''
    const plainHash = sha256(this.password)
    const form: Record<string, string> = {
      userAccount: this.userAccount,
      password: salt ? sha256(this.password + salt) : plainHash,
      sha256Password: salt ? sha256(plainHash + salt) : plainHash,
      deviceCode: this.deviceCode,
      deviceName: 'Chrome浏览器',
      deviceType: DEVICE_TYPE,
      deviceModel: platformName(),
      appVersion: APP_VERSION,
      sysVersion: platformName(),
      clientVersion: CLIENT_VERSION,
    }
    if (challenge) form.challengeId = challenge.challengeId

    const body = new URLSearchParams({ eParams: aesCbcEncrypt(JSON.stringify(form), this.enc.evalue) }).toString()
    const res = await this.http('POST', '/api/auth/client/login', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: LOGIN_CALL_TIMEOUT_MS,
      retries: 0,
    })
    const data = this.unwrap<Record<string, unknown>>(res)
    const userId = toNumber(data?.userId)
    const tenantId = toNumber(data?.tenantId)
    const secretKey = typeof data?.secretKey === 'string' ? data.secretKey : ''
    if (userId == null || tenantId == null || !secretKey) {
      throw new UpstreamError(40050, '登录响应缺少 userId/tenantId/secretKey')
    }
    const timestamp = toNumber(data?.timestamp)
    if (timestamp != null) this.offset = Date.now() - timestamp

    this.auth = {
      userId,
      tenantId,
      secretKey,
      userName: typeof data?.userName === 'string' ? data.userName : null,
      userAccount: String(data?.userAccount ?? this.userAccount),
      timestamp,
    }
    /* 预算只属于登录链路；登录成功即清零，避免 28s 后 selforder/保活等非登录请求
       在 http() 里误报「登录请求超过 28s 未完成」（review S2-4） */
    this.deadline = 0
    return this.auth
  }

  private async get(apiPath: string, params: Record<string, string> = {}, options: RequestOptions = {}): Promise<unknown> {
    if (!Object.keys(params).length) {
      return this.unwrap(await this.http('GET', apiPath, options))
    }
    const query = new URLSearchParams(params).toString()
    return this.unwrap(
      await this.http('GET', apiPath, {
        ...options,
        query: { eUrlParams: aesCbcEncrypt(query, this.requireKey()) },
      }),
    )
  }

  private async postJson<T>(apiPath: string, payload: unknown, options: RequestOptions = {}): Promise<T> {
    const body = JSON.stringify({ data: aesCbcEncrypt(JSON.stringify(payload), this.requireKey()) })
    return this.unwrap<T>(
      await this.http('POST', apiPath, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
        body,
      }),
    )
  }

  private requireKey(): string {
    if (!this.enc) throw new UpstreamError(40010, '会话密钥不存在，请重新登录')
    return this.enc.evalue
  }

  /** 30020 / 主 host 网络异常：切下一个区域 host，重新协商 + 登录后重试一次 */
  private async recoverOnNextHost(): Promise<boolean> {
    if (this.hostIndex + 1 >= this.hosts.length) return false
    this.setHost(this.hostIndex + 1)
    /* 预算只属于登录链路；恢复完成后清零，避免后续 selforder/保活调用误报“登录请求超时”（review S2-4） */
    const budget = { deadline: Date.now() + LOGIN_BUDGET_MS }
    await this.negotiate(budget)
    this.deadline = 0
    try {
      await this.login()
    } catch (error) {
      this.deadline = 0
      throw error
    }
    return true
  }

  private async withHostFallback<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (!isHostFailure(error)) throw error
      const recovered = await this.recoverOnNextHost()
      if (!recovered) throw error
      return run()
    }
  }

  /**
   * 云电脑列表：以 sortList 为权威顺序，按 objType 从三类列表取对象合并。
   * getCnt 沿用 research 验证值 20（传 100 上游返回 40050）。
   */
  async pageDesktop(): Promise<RawPageDesktop> {
    this.deadline = 0
    return this.withHostFallback(() =>
      this.postJson<RawPageDesktop>('/api/desktop/client/pageDesktop', {
        getCnt: GET_CNT,
        desktopTypes: ['1', '2001', '2002'],
        sortType: 'createTimeV1',
      }),
    )
  }

  /** sortList 超过 getCnt 时按 30 个一批补拉缺失的普通桌面（research §5.2） */
  private async fetchMissingDesktops(missing: string[]): Promise<RawDesktop[]> {
    const out: RawDesktop[] = []
    for (let offset = 0; offset < missing.length; offset += FETCH_BY_IDS_BATCH) {
      const batch = missing.slice(offset, offset + FETCH_BY_IDS_BATCH)
      const data = await this.withHostFallback(() =>
        this.postJson<{ desktopList?: RawDesktop[] }>('/api/desktop/client/listDesktopByIds', {
          objIds: batch,
        }),
      )
      for (const item of data.desktopList ?? []) {
        const id = item.objId ?? item.desktopId
        if (id != null) out.push(item)
      }
    }
    return out
  }

  async listDesktops(): Promise<CtyunDesktop[]> {
    const data = await this.pageDesktop()
    const byId = new Map<string, RawDesktop>()
    for (const item of data.desktopList ?? []) byId.set(String(item.objId ?? item.desktopId), item)
    for (const item of data.desktopPoolList ?? []) byId.set(String(item.objId ?? item.desktopId), item)
    for (const item of data.preemptionDesktopList ?? []) byId.set(String(item.objId ?? item.desktopId), item)

    const ordered: RawDesktop[] = []
    const missing: string[] = []
    if (data.sortList?.length) {
      for (const sort of data.sortList) {
        const hit = byId.get(String(sort.objId))
        if (hit) ordered.push(hit)
        else if (String(sort.objType ?? '0') === '0') missing.push(String(sort.objId))
      }
      if (missing.length) {
        try {
          const fetched = await this.fetchMissingDesktops(missing)
          for (const item of fetched) byId.set(String(item.objId ?? item.desktopId), item)
          const stillMissing = missing.filter((id) => !byId.has(id))
          if (stillMissing.length) {
            console.warn(`[ctyun] listDesktopByIds 补拉后仍缺少 ${stillMissing.length} 台实例，列表可能不完整`)
          }
          /* 补拉结果并入后，按 sortList 权威顺序重新组装 */
          ordered.length = 0
          for (const sort of data.sortList) {
            const hit = byId.get(String(sort.objId))
            if (hit) ordered.push(hit)
          }
        } catch (error) {
          console.warn(`[ctyun] listDesktopByIds 补拉失败：${error instanceof Error ? error.message : 'unknown'}`)
        }
      }
    } else {
      ordered.push(...(data.desktopList ?? []), ...(data.desktopPoolList ?? []), ...(data.preemptionDesktopList ?? []))
    }

    const seen = new Set<string>()
    const out: CtyunDesktop[] = []
    for (const raw of ordered) {
      const desktop = toDesktop(raw)
      if (!desktop || seen.has(desktop.desktopId)) continue
      seen.add(desktop.desktopId)
      out.push(desktop)
    }
    return out
  }

  /** 积分中心 iframe 口径：不带协商头，响应用明文 JSON */
  private async selforderGet<T>(apiPath: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(apiPath, this.selforderHost)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    const res = await this.http('GET', url.toString(), {
      plain: true,
      headers: {
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cache-Control': 'no-cache',
        'If-Modified-Since': '0',
        Pragma: 'no-cache',
        From: 'App-web',
        'x-lang': 'zh-CN',
        'CTG-APPCHANNEL': '1',
        'CTG-AUTHENTICATE': '1',
        'CTG-DEVICE-MODEL': 'xiaomicc',
        'CTG-DEVICE-MANU': 'Xiaomi',
      },
    })
    return this.unwrap<T>(res)
  }

  async getUserPoints(): Promise<unknown[]> {
    return this.selforderGet<unknown[]>('/selforder/api/marketing/userPoints/getUserPoints')
  }

  async getTaskList(): Promise<unknown[]> {
    return this.selforderGet<unknown[]>('/selforder/api/marketing/userPoints/getTaskList')
  }

  async getUserInfo(): Promise<Record<string, unknown>> {
    return this.selforderGet<Record<string, unknown>>('/selforder/api/auth/client/getUserInfo')
  }

  async logout(): Promise<void> {
    this.deadline = 0
    try {
      await this.http('POST', '/api/auth/client/logout', {
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: 5_000,
        retries: 0,
      })
    } catch {
      /* 退出失败不影响本地状态；密钥不落任何地方 */
    } finally {
      this.auth = null
      this.enc = null
    }
  }
}

export { MAIN_HOST, REGION_HOSTS, SELFORDER_HOST }
