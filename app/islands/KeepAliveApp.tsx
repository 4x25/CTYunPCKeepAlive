import dayjs from 'dayjs/esm'
import { useEffect, useRef, useState } from 'hono/jsx'
import { ErrorCode } from '../../shared/constants'
import type {
  Account,
  LogEntry,
  LogFilters,
  LogLevel,
  LogModule,
  LogQuery,
  LogView,
  StateSnapshot,
  ToastItem,
  Dlg,
} from '../lib/types'
import { api, isApiError, isTimeout } from '../lib/api'
import { accountFileSlug, accountLabel } from '../lib/derive'
import { clockOffsetOf, hasStoppedCountdown, hasTransitionalRun, isKeepaliveCountedRun, nowWithOffset, projectCountdowns } from '../lib/time'
import AccountTabBar from '../components/AccountTabBar'
import AccountErrorPanel from '../components/AccountErrorPanel'
import EmptyAccountPanel from '../components/EmptyAccountPanel'
import SubTabs, { type TabKey } from '../components/SubTabs'
import KeepAlivePanel from '../components/KeepAlivePanel'
import PointsPanel from '../components/PointsPanel'
import LogPanel from '../components/LogPanel'
import ModalLayer from '../components/ModalLayer'
import ToastStack from '../components/ToastStack'
import AddAccountForm, { type AddFormValues } from '../components/AddAccountForm'
import DeleteConfirm from '../components/DeleteConfirm'

const EMPTY_LOG_VIEW: LogView = { rows: [], total: 0, loading: true }

/** 日志单次拉取条数（api.md §4.13 默认 200）与本地缓存上限（frontend-design §6.1） */
const LOG_PAGE_SIZE = 200
const LOG_ROWS_MAX = 1_000
/** 日志增量轮询间隔：仅「激活账号 + 页面可见」时运行 */
const LOG_POLL_MS = 5_000
/**
 * 增量 total 是客户端「旧 total + 新增条数」累加出来的（服务端只回新增条数），
 * 服务端 ring 轮转（每账号 2000 条）与 limit 截断都会让它缓慢偏离真实值。
 * 每 N 次增量做一次全量校准，把 total 拉回服务端口径。
 */
const LOG_INCREMENTAL_FULL_EVERY = 12
/** 每账号独立的筛选初值（新建账号的 Tab 默认看到全部） */
const DEFAULT_LOG_FILTERS: LogFilters = { lv: 'ALL', mod: 'ALL', kw: '', includeSys: false }

/** 增量合并：按 seq 去重、倒序排列、裁剪到上限 */
function mergeLogRows(base: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  if (!incoming.length) return base
  const seen = new Set(base.map((row) => row.seq))
  const fresh = incoming.filter((row) => !seen.has(row.seq))
  if (!fresh.length) return base
  return [...fresh, ...base].sort((a, b) => b.seq - a.seq).slice(0, LOG_ROWS_MAX)
}

/** 删除墓碑 TTL：挡住删除前发出、删除后才到的旧快照，10s 后自动解除 */
const TOMBSTONE_TTL_MS = 10_000

const withoutKey = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...record }
  delete next[key]
  return next
}

/* 资源键：同一 userId 下 desktopId/taskDefId 可能重名，键一律带账号 */
const desktopKey = (userId: number, desktopId: string) => `${userId}:${desktopId}`
const taskKey = (userId: number, taskDefId: number) => `${userId}:${taskDefId}`

/* 在途写操作的「操作敏感字段」占位键（frontend-design §2.3） */
const desktopHold = (userId: number, desktopId: string) => `pc:${desktopKey(userId, desktopId)}`
const accountHold = (userId: number) => `account:${userId}`
const taskAutoHold = (userId: number, taskDefId: number) => `task-auto:${taskKey(userId, taskDefId)}`
const taskRunHold = (userId: number, taskDefId: number) => `task-run:${taskKey(userId, taskDefId)}`

interface PendingFetch {
  minRevision?: number
  silent: boolean
  /** 快照 revision 不足时的重拉次数（最多 2 次，避免死循环） */
  attempt: number
}

/**
 * 天翼云保活助手：唯一 island，状态编排 + 组件装配。
 * 数据来源统一经 app/lib/api.ts（VITE_USE_MOCK=1 时走 api-mock）。
 */
export default function KeepAliveApp() {
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [maxAccounts, setMaxAccounts] = useState(0)
  const [refreshedAt, setRefreshedAt] = useState('')
  const [activeUid, setActiveUid] = useState<number | null>(null)
  const [tab, setTab] = useState<TabKey>('keepalive')
  const [dlg, setDlg] = useState<Dlg>(null)
  const [addBusy, setAddBusy] = useState(false)
  const [delBusy, setDelBusy] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [session, setSession] = useState(0)

  /* 前端短态：手动保活 / 任务执行 / 开关在途，挂在 island，不进服务端模型 */
  const [refreshing, setRefreshing] = useState(false)
  const [refreshingPoints, setRefreshingPoints] = useState(false)
  const [justOkPc, setJustOkPc] = useState<Record<string, boolean>>({})
  /* busyDesktop / busyTask 是同一资源的唯一在途标记：手动保活与自动开关共用前者，任务执行与任务开关共用后者 */
  const [busyDesktop, setBusyDesktop] = useState<Record<string, boolean>>({})
  const [busyTask, setBusyTask] = useState<Record<string, boolean>>({})

  /* 日志：每账号一份视图缓存 + 一份筛选状态，唯一数据源是 4.13 */
  const [logViews, setLogViews] = useState<Record<number, LogView>>({})
  /* 进程纪元编号：快照 bootId 变化时 +1，触发日志页签按新纪元全量重拉 */
  const [logEpoch, setLogEpoch] = useState(0)
  const [logFilters, setLogFilters] = useState<Record<number, LogFilters>>({})
  const [autoScroll, setAutoScroll] = useState(true)
  const [clearArmed, setClearArmed] = useState<Record<number, boolean>>({})

  /* 供定时器 / 延时回调读到最新值 */
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const activeUidRef = useRef(activeUid)
  activeUidRef.current = activeUid
  const tabRef = useRef(tab)
  tabRef.current = tab
  const logFiltersRef = useRef<Record<number, LogFilters>>(logFilters)
  logFiltersRef.current = logFilters
  const logViewsRef = useRef<Record<number, LogView>>(logViews)
  logViewsRef.current = logViews

  const revisionRef = useRef(0)
  const loadedRef = useRef(false)
  const clockOffsetRef = useRef(0)
  const snapshotInFlightRef = useRef(false)
  const pendingFetchRef = useRef<PendingFetch | null>(null)
  const lastStateAtRef = useRef(0)
  const refreshingRef = useRef(false)
  const pointsRefreshingRef = useRef(false)
  const clearArmedAtRef = useRef<Record<number, number>>({})
  const toastIdRef = useRef(0)
  const zeroSinceRef = useRef<number | null>(null)
  /** 浏览器页签刚从后台切回：日志页签需要全量校准 total */
  const wasHiddenRef = useRef(false)
  /* 日志请求竞态：每次请求领一个 ticket，只有最新 ticket 的响应能落地（按账号维度） */
  const logSeqRef = useRef(0)
  const logTicketRef = useRef<Map<number, number>>(new Map())
  /** 全量加载在途的账号 → 在途 ticket：5s 轮询让路，旧请求的 finally 不得清掉新请求的标记 */
  const logBusyRef = useRef<Map<number, number>>(new Map())
  /** 已连续失败且已提示过的账号：轮询失败只在第一跳 Toast，避免 5s 刷屏 */
  const logFetchErrorRef = useRef<Set<number>>(new Set())
  /** 各账号视图当前对应的筛选指纹：指纹一致才走增量，筛选变了必须全量重拉 */
  const logSignatureRef = useRef<Map<number, string>>(new Map())
  /** 服务端进程纪元：bootId 变化 = 后端已重启，必须重置 revision 水位与日志缓存 */
  const bootIdRef = useRef<string | null>(null)
  /** 各账号已连续执行的增量次数：达到上限改用全量校准 total */
  const logIncrementalRef = useRef<Map<number, number>>(new Map())

  /* 乱序/并发防护：在途写操作占位、已删除账号墓碑、在途互斥集合 */
  const inFlightRef = useRef<Set<string>>(new Set())
  /** userId → 墓碑到期时间戳（TTL 10s，见 TOMBSTONE_TTL_MS） */
  const tombstonesRef = useRef<Map<number, number>>(new Map())
  /* 手动保活的同步 ref 闸门：React 状态尚未刷新时也能挡住极快双击 */
  const manualKeepaliveRef = useRef<Set<string>>(new Set())
  const busyDesktopRef = useRef<Set<string>>(new Set())
  const busyTaskRef = useRef<Set<string>>(new Set())
  /** 同账号设置写操作串行队列：Enter + blur 等重复提交也不会并发或互相回滚 */
  const settingsQueueRef = useRef<Map<number, Promise<unknown>>>(new Map())

  const isTombstoned = (userId: number): boolean => {
    const expiresAt = tombstonesRef.current.get(userId)
    if (expiresAt == null) return false
    if (Date.now() >= expiresAt) {
      tombstonesRef.current.delete(userId)
      return false
    }
    return true
  }
  const addTombstone = (userId: number) => {
    tombstonesRef.current.set(userId, Date.now() + TOMBSTONE_TTL_MS)
  }
  const clearTombstone = (userId: number) => {
    tombstonesRef.current.delete(userId)
  }

  /** 同账号设置写操作（interval / pointsWindow）互斥：拿不到占位就不发请求 */
  function acquireAccountHold(userId: number): boolean {
    const hold = accountHold(userId)
    if (inFlightRef.current.has(hold)) return false
    inFlightRef.current.add(hold)
    return true
  }
  function releaseAccountHold(userId: number) {
    inFlightRef.current.delete(accountHold(userId))
  }

  /**
   * 同一账号的 interval / pointsWindow 提交串行化：
   * 前一个请求（含超时）结束后才发下一个，避免 Enter + blur 触发两个并发写。
   */
  function queueAccountSettings<T>(userId: number, run: () => Promise<T>): Promise<T> {
    const previous = settingsQueueRef.current.get(userId) ?? Promise.resolve()
    const next = previous.then(run, run)
    settingsQueueRef.current.set(userId, next)
    const cleanup = () => {
      if (settingsQueueRef.current.get(userId) === next) settingsQueueRef.current.delete(userId)
    }
    void next.then(cleanup, cleanup)
    return next
  }

  /* ── Toast：服务端报错的唯一出口，6 秒自动消失 ───────────── */
  function pushToast(msg: string, code?: string) {
    const id = ++toastIdRef.current
    setToasts((prev) => [...prev, { id, msg, code }])
    setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== id)), 6000)
  }
  const dismissToast = (id: number) => setToasts((prev) => prev.filter((item) => item.id !== id))

  function toastError(error: unknown) {
    if (isApiError(error)) {
      pushToast(isTimeout(error) ? `${error.message}，已自动刷新状态` : error.message, `code=${error.code}`)
    } else {
      pushToast('网络异常，请稍后重试')
    }
  }

  /* 写操作失败一律追加一次 4.1 校正（banner/dot/列表以服务端为准） */
  function handleError(error: unknown) {
    toastError(error)
    void fetchState(undefined, true)
  }

  /**
   * 写操作响应落地：把 revision 水位抬到响应值，挡住更旧的快照。
   * `epoch` 是发起请求时的 bootId：后端重启后旧纪元的响应不得抬高新纪元水位，
   * 否则新进程的 revision 永远追不上，页面会再次冻结。
   */
  function noteRevision(revision: number, epoch: string | null) {
    if (epoch !== bootIdRef.current) return
    if (revision > revisionRef.current) revisionRef.current = revision
  }

  /** 写操作后的 4.1 校正：旧纪元的 revision 不能当作新纪元的最小水位 */
  function fetchAfterWrite(revision: number, epoch: string | null) {
    void fetchState(epoch === bootIdRef.current ? revision : undefined, true)
  }

  /* ── 日志拉取（唯一数据源 4.13；每账号独立视图 + 独立筛选） ── */

  const filtersOf = (userId: number): LogFilters => logFiltersRef.current[userId] ?? DEFAULT_LOG_FILTERS

  /** 每账号筛选的指纹：lv/mod/kw/includeSys 任一变化即视为"新口径"，必须全量重拉 */
  const signatureOf = (filters: LogFilters): string =>
    `${filters.lv}\u0000${filters.mod}\u0000${filters.kw.trim()}\u0000${filters.includeSys}`

  function buildLogQuery(userId: number, filters: LogFilters, limit: number, sinceSeq?: number): LogQuery {
    const query: LogQuery = { userId, limit, includeSys: filters.includeSys }
    if (filters.lv !== 'ALL') query.lv = filters.lv as LogLevel
    if (filters.mod !== 'ALL') query.mod = filters.mod as LogModule
    const kw = filters.kw.trim()
    if (kw) query.kw = kw
    if (sinceSeq !== undefined) query.sinceSeq = sinceSeq
    return query
  }

  /**
   * 拉某账号的日志：
   * - `full` 按当前筛选重拉（total 以服务端为准，保留旧行避免"闪烁成空"）；
   * - `incremental` 用 sinceSeq 只取新增（total 以"旧 total + 服务端新增条数"累加）。
   * `quiet` 供轮询/校准使用：失败只在第一跳提示，避免 5s 刷屏。
   */
  async function loadAccountLogs(userId: number, mode: 'full' | 'incremental' = 'full', quiet = false) {
    if (!accountsRef.current.some((account) => account.userId === userId)) return
    const base = logViewsRef.current[userId]
    /* 增量必须有基线：首次进入由全量请求建立 total */
    if (mode === 'incremental' && !base) return

    const filters = filtersOf(userId)
    const sinceSeq = mode === 'incremental' ? base?.rows[0]?.seq : undefined
    const ticket = ++logSeqRef.current
    logTicketRef.current.set(userId, ticket)
    /* 增量一旦发起就作废在途全量（ticket 已被取代），忙标记随之释放 */
    if (mode === 'incremental') logBusyRef.current.delete(userId)

    if (mode === 'full') {
      /* 全量即校准：增量计数清零，下一次轮询重新从增量开始 */
      logIncrementalRef.current.set(userId, 0)
      logBusyRef.current.set(userId, ticket)
      setLogViews((prev) => {
        const current = prev[userId]
        if (!current) return { ...prev, [userId]: { rows: [], total: 0, loading: true } }
        return { ...prev, [userId]: { ...current, loading: true } }
      })
    }

    try {
      const result = await api.queryLogs(buildLogQuery(userId, filters, LOG_PAGE_SIZE, sinceSeq))
      /* 过期响应（筛选已变 / 账号已刷新）直接丢弃 */
      if (logTicketRef.current.get(userId) !== ticket) return
      logFetchErrorRef.current.delete(userId)
      setLogViews((prev) => {
        const current = prev[userId]
        if (mode === 'full' || !current) {
          return { ...prev, [userId]: { rows: result.rows, total: result.total, loading: false } }
        }
        const rows = mergeLogRows(current.rows, result.rows)
        /* result.total 是服务端口径的新增条数（含被 limit 截断的部分），比 rows.length 更接近真实 total */
        return { ...prev, [userId]: { rows, total: current.total + result.total, loading: false } }
      })
      /* 筛选指纹只在全量成功写入视图后才登记：失败/被新请求取代时保持 mismatch，下次仍全量重拉 */
      if (mode === 'full') logSignatureRef.current.set(userId, signatureOf(filters))
    } catch (error) {
      if (logTicketRef.current.get(userId) !== ticket) return
      setLogViews((prev) => {
        const current = prev[userId]
        if (!current) return prev
        return { ...prev, [userId]: { ...current, loading: false } }
      })
      if (!quiet && mode === 'full') {
        toastError(error)
      } else if (!logFetchErrorRef.current.has(userId)) {
        /* 轮询/校准失败只在连续失败的第一跳提示一次 */
        logFetchErrorRef.current.add(userId)
        toastError(error)
      }
    } finally {
      /* 只有仍是当前 ticket 的全量请求才能清 busy：旧请求的 finally 不能把新请求的忙标记删掉 */
      if (mode === 'full' && logTicketRef.current.get(userId) === ticket) logBusyRef.current.delete(userId)
    }
  }

  /**
   * 筛选变化：作废旧口径的在途响应 + 清掉筛选指纹，下一次拉取按全量走。
   * 只删指纹不换 ticket 的话，旧筛选的慢响应仍可能落到新口径的视图里。
   */
  function updateLogFilters(userId: number, patch: Partial<LogFilters>) {
    logTicketRef.current.set(userId, ++logSeqRef.current)
    logSignatureRef.current.delete(userId)
    logIncrementalRef.current.set(userId, 0)
    setLogFilters((prev) => ({ ...prev, [userId]: { ...(prev[userId] ?? DEFAULT_LOG_FILTERS), ...patch } }))
  }

  /**
   * 账号新增/修正/删除后让日志缓存失效：
   * 清掉受影响 userId 的视图 + 领新 ticket（在途响应写不回来）；
   * 当前在日志页签时立即重拉（显式传入重拉账号，避免等 accounts 状态落地）。
   */
  function invalidateLogViews(userIds: number[], reloadAccount?: Account | null) {
    for (const userId of userIds) {
      logTicketRef.current.set(userId, ++logSeqRef.current)
      logSignatureRef.current.delete(userId)
      logFetchErrorRef.current.delete(userId)
      logIncrementalRef.current.delete(userId)
    }
    setLogViews((prev) => {
      const next = { ...prev }
      for (const userId of userIds) delete next[userId]
      return next
    })
    if (tab !== 'log') return
    /* undefined = 未指定重拉账号，回落到当前激活账号；null = 明确不重拉（如删掉唯一账号） */
    const account =
      reloadAccount === undefined
        ? (accountsRef.current.find((item) => item.userId === activeUidRef.current) ?? null)
        : reloadAccount
    if (account) void loadAccountLogs(account.userId, 'full')
  }

  /* ── 快照应用（revision 乱序防护 + 在途敏感字段暂不应用） ── */
  function mergeHeldAccount(account: Account): Account {
    const prev = accountsRef.current.find((item) => item.userId === account.userId)
    if (!prev) return account

    let next = account
    if (inFlightRef.current.has(accountHold(account.userId))) {
      /* 在途操作（设置写 / 重试登录）：banner、dot 冻结为本地态，避免快照冲回 */
      next = { ...next, interval: prev.interval, dot: prev.dot, banner: prev.banner }
    }

    if (next.pcs.some((pc) => inFlightRef.current.has(desktopHold(account.userId, pc.desktopId)))) {
      next = {
        ...next,
        pcs: next.pcs.map((pc) => {
          if (!inFlightRef.current.has(desktopHold(account.userId, pc.desktopId))) return pc
          const old = prev.pcs.find((item) => item.desktopId === pc.desktopId)
          return old ? { ...pc, auto: old.auto, left: old.left } : pc
        }),
      }
    }

    if (
      next.tasks.some(
        (task) =>
          inFlightRef.current.has(taskAutoHold(account.userId, task.taskDefId)) ||
          inFlightRef.current.has(taskRunHold(account.userId, task.taskDefId)),
      )
    ) {
      next = {
        ...next,
        tasks: next.tasks.map((task) => {
          const old = prev.tasks.find((item) => item.taskDefId === task.taskDefId)
          if (!old) return task
          let merged = task
          if (inFlightRef.current.has(taskAutoHold(account.userId, task.taskDefId))) {
            merged = { ...merged, auto: old.auto }
          }
          if (inFlightRef.current.has(taskRunHold(account.userId, task.taskDefId))) {
            merged = { ...merged, status: old.status, busy: old.busy }
          }
          return merged
        }),
      }
    }

    return next
  }

  /**
   * 服务端已重启（bootId 变化）：新进程的 `revision` 与日志 `seq` 都从 0 重新计数。
   * 先清掉旧纪元的本地水位 / 日志缓存 / 墓碑 / 筛选指纹，再应用新快照；
   * 日志页签由 logEpoch 触发一次全量重拉（旧 sinceSeq 不再参与增量）。
   */
  function resetForNewBoot(nextBootId: string) {
    bootIdRef.current = nextBootId
    revisionRef.current = 0
    tombstonesRef.current.clear()
    logBusyRef.current.clear()
    logFetchErrorRef.current.clear()
    logSignatureRef.current.clear()
    logIncrementalRef.current.clear()
    /* 在途日志响应：清空 ticket，旧纪元的响应一律丢弃（新请求会领到更大的 ticket） */
    logTicketRef.current.clear()
    logViewsRef.current = {}
    setLogViews({})
    setLogEpoch((epoch) => epoch + 1)
    /* 旧纪元写入携带的 minRevision 在新纪元里没有意义，别让它卡住快照应用 */
    if (pendingFetchRef.current) pendingFetchRef.current = { ...pendingFetchRef.current, minRevision: undefined }
  }

  /** 快照是否来自新进程纪元（bootId 变化） */
  function isNewBoot(snapshot: StateSnapshot): boolean {
    return bootIdRef.current !== null && bootIdRef.current !== snapshot.bootId
  }

  function applySnapshot(snapshot: StateSnapshot): boolean {
    /* 纪元切换：先归零水位，否则新进程的 revision 永远小于旧进程的水位 → 永久冻结 */
    if (bootIdRef.current === null) bootIdRef.current = snapshot.bootId
    else if (bootIdRef.current !== snapshot.bootId) resetForNewBoot(snapshot.bootId)

    /* 只读已写入的 revision 水位：旧快照一律丢弃（新纪元上方已归零） */
    if (snapshot.revision < revisionRef.current) return false
    revisionRef.current = snapshot.revision

    /* 墓碑 TTL 清扫：到期后自动解除，避免 map 无限增长 */
    const now = Date.now()
    for (const [userId, expiresAt] of tombstonesRef.current) {
      if (now >= expiresAt) tombstonesRef.current.delete(userId)
    }

    clockOffsetRef.current = clockOffsetOf(snapshot.serverTime)

    const nextAccounts = snapshot.accounts
      .filter((account) => !isTombstoned(account.userId))
      .map(mergeHeldAccount)

    setAccounts(nextAccounts)
    setMaxAccounts(snapshot.maxAccounts)
    setRefreshedAt(snapshot.refreshedAt)
    setActiveUid((prev) =>
      prev != null && nextAccounts.some((account) => account.userId === prev)
        ? prev
        : (nextAccounts[0]?.userId ?? null),
    )
    loadedRef.current = true
    setLoadError(null)
    setReady(true)
    return true
  }

  /**
   * 拉全量快照；minRevision 用于写操作后的乱序防护（快照 revision 不足则重拉）。
   * 在途时不丢弃请求：记录 pending，当前请求结束后补一次。
   */
  async function fetchState(minRevision?: number, silent = false, attempt = 0) {
    if (snapshotInFlightRef.current) {
      const pending = pendingFetchRef.current
      pendingFetchRef.current = {
        minRevision: Math.max(pending?.minRevision ?? 0, minRevision ?? 0) || undefined,
        silent: pending ? pending.silent && silent : silent,
        attempt: Math.max(pending?.attempt ?? 0, attempt),
      }
      return
    }

    snapshotInFlightRef.current = true
    try {
      const snapshot = await api.getState()
      /* 新纪元优先：旧纪元的 minRevision 不能拦下新进程的快照，否则 bootId 永远更新不了 */
      const epochChanged = isNewBoot(snapshot)
      if (!epochChanged && minRevision !== undefined && snapshot.revision < minRevision) {
        if (attempt < 2) {
          pendingFetchRef.current = { minRevision, silent: true, attempt: attempt + 1 }
        }
        return
      }
      if (applySnapshot(snapshot)) lastStateAtRef.current = Date.now()
    } catch (error) {
      if (loadedRef.current) {
        if (!silent) toastError(error)
      } else {
        setLoadError(isApiError(error) ? error.message : '网络异常，请稍后重试')
      }
    } finally {
      snapshotInFlightRef.current = false
      const pending = pendingFetchRef.current
      pendingFetchRef.current = null
      if (pending) void fetchState(pending.minRevision, pending.silent, pending.attempt)
    }
  }

  /** 可视刷新 / 切 Tab 的节流入口 */
  function maybeFetchState(minGapMs: number) {
    if (Date.now() - lastStateAtRef.current < minGapMs) return
    void fetchState(undefined, true)
  }

  /* ── 首屏 / 可见性 / 过渡态 ───────────────────────────────── */
  useEffect(() => {
    void fetchState()
  }, [])

  useEffect(() => {
    const maybeVisibleRefresh = () => {
      if (document.hidden) {
        wasHiddenRef.current = true
        return
      }
      if (!document.hasFocus()) return
      /* 从浏览器后台切回：日志页签做一次全量校准，把 total 拉回服务端口径 */
      if (wasHiddenRef.current) {
        wasHiddenRef.current = false
        const userId = activeUidRef.current
        if (tabRef.current === 'log' && userId != null) {
          logTicketRef.current.set(userId, ++logSeqRef.current)
          logSignatureRef.current.delete(userId)
          logIncrementalRef.current.set(userId, 0)
          void loadAccountLogs(userId, 'full', true)
        }
      }
      maybeFetchState(15_000)
    }
    document.addEventListener('visibilitychange', maybeVisibleRefresh)
    window.addEventListener('focus', maybeVisibleRefresh)
    return () => {
      document.removeEventListener('visibilitychange', maybeVisibleRefresh)
      window.removeEventListener('focus', maybeVisibleRefresh)
    }
  }, [])

  /* 每秒推进倒计时：left 减到 0 停住；停 3s 未校正则主动拉一次 /state */
  useEffect(() => {
    const tick = setInterval(() => {
      setAccounts((prev) => projectCountdowns(prev))
    }, 1000)
    const check = setInterval(() => {
      if (!hasStoppedCountdown(accountsRef.current)) {
        zeroSinceRef.current = null
        return
      }
      if (zeroSinceRef.current == null) {
        zeroSinceRef.current = Date.now()
        return
      }
      if (Date.now() - zeroSinceRef.current >= 3000) {
        zeroSinceRef.current = null
        void fetchState(undefined, true)
      }
    }, 1000)
    return () => {
      clearInterval(tick)
      clearInterval(check)
    }
  }, [])

  /* 过渡态加速收敛：快照含 starting/stopping 时 5s 轮询 */
  const transitional = hasTransitionalRun(accounts)
  useEffect(() => {
    if (!transitional) return
    const id = setInterval(() => {
      void fetchState(undefined, true)
    }, 5000)
    return () => clearInterval(id)
  }, [transitional])

  /* 日志：切页签 / 切账号 / 筛选变化 → 激活账号拉一次（关键字 300ms debounce）
     - 切回日志页签 → changeTab 已清掉指纹，这里走全量校准；
     - 停留在日志页签内切账号 → 口径没变走增量补课，口径变了全量重拉。 */
  const activeFilters = activeUid == null ? DEFAULT_LOG_FILTERS : (logFilters[activeUid] ?? DEFAULT_LOG_FILTERS)
  const activeFilterSignature = signatureOf(activeFilters)

  useEffect(() => {
    if (!ready || tab !== 'log' || activeUid == null) return
    const userId = activeUid
    const signature = activeFilterSignature
    const delay = activeFilters.kw.trim() ? 300 : 0
    const id = setTimeout(() => {
      const view = logViewsRef.current[userId]
      const mode = view && logSignatureRef.current.get(userId) === signature ? 'incremental' : 'full'
      /* 指纹不入库：由 loadAccountLogs 在全量成功落地后再登记（失败下次仍全量） */
      void loadAccountLogs(userId, mode)
    }, delay)
    return () => clearTimeout(id)
  }, [ready, tab, activeUid, activeFilterSignature, logEpoch])

  /* 日志增量轮询：只对「激活账号 + 页面可见」运行（frontend-design §6.1）
     - 口径还没成功落地（全量失败 / 筛选刚变）→ 继续全量重试；
     - 常规走增量；
     - 每 LOG_INCREMENTAL_FULL_EVERY 次增量做一次全量校准，避免 total 长跑漂移。 */
  useEffect(() => {
    if (!ready || tab !== 'log' || activeUid == null) return
    const userId = activeUid
    const id = setInterval(() => {
      if (document.hidden) return
      if (logBusyRef.current.has(userId)) return
      if (logSignatureRef.current.get(userId) !== signatureOf(filtersOf(userId))) {
        void loadAccountLogs(userId, 'full', true)
        return
      }
      const ticks = (logIncrementalRef.current.get(userId) ?? 0) + 1
      if (ticks > LOG_INCREMENTAL_FULL_EVERY) {
        void loadAccountLogs(userId, 'full', true)
        return
      }
      logIncrementalRef.current.set(userId, ticks)
      void loadAccountLogs(userId, 'incremental', true)
    }, LOG_POLL_MS)
    return () => clearInterval(id)
  }, [ready, tab, activeUid])

  /* 删除目标已从快照消失（典型：删除超时但后端其实已删）时关闭弹窗，避免留下空白弹窗 */
  useEffect(() => {
    if (delBusy || dlg?.kind !== 'del') return
    if (!accounts.some((account) => account.userId === dlg.uid)) setDlg(null)
  }, [accounts, dlg, delBusy])

  /* ── 弹窗 ─────────────────────────────────────────────────── */
  const contentRef = useRef<Dlg>(null)
  if (dlg) contentRef.current = dlg

  function openDlg(next: Exclude<Dlg, null>) {
    setToasts([])
    setAddBusy(false)
    setDelBusy(false)
    setSession((value) => value + 1)
    setDlg(next)
  }
  function closeDlg() {
    setDlg(null)
  }
  const openAdd = (editUid: number | null) => openDlg({ kind: 'add', editUid })
  const openDel = (userId: number) => {
    if (accountsRef.current.some((account) => account.userId === userId)) openDlg({ kind: 'del', uid: userId })
  }

  /* ── 数据局部 patch ───────────────────────────────────────── */
  function patchAccount(userId: number, patch: (account: Account) => Account) {
    setAccounts((prev) => prev.map((account) => (account.userId === userId ? patch(account) : account)))
  }
  function patchPc(userId: number, desktopId: string, patch: (pc: Account['pcs'][number]) => Account['pcs'][number]) {
    patchAccount(userId, (account) => ({
      ...account,
      pcs: account.pcs.map((pc) => (pc.desktopId === desktopId ? patch(pc) : pc)),
    }))
  }
  function patchTask(userId: number, taskDefId: number, patch: (task: Account['tasks'][number]) => Account['tasks'][number]) {
    patchAccount(userId, (account) => ({
      ...account,
      tasks: account.tasks.map((task) => (task.taskDefId === taskDefId ? patch(task) : task)),
    }))
  }

  /* ── 账号操作（同步执行，最长 35s busy） ──────────────────── */
  async function submitAdd(values: AddFormValues) {
    const current = contentRef.current
    if (current?.kind !== 'add') return
    const editUid = current.editUid
    if (editUid == null && accountsRef.current.length >= maxAccounts) {
      pushToast(`最多 ${maxAccounts} 个账号，避免并发请求过密`, `code=${ErrorCode.AccountLimit}`)
      return
    }

    setAddBusy(true)
    try {
      if (editUid == null) {
        const epoch = bootIdRef.current
        const result = await api.createAccount({
          userAccount: values.acct,
          password: values.pw,
          alias: values.alias,
        })
        noteRevision(result.revision, epoch)
        clearTombstone(result.account.userId)
        setAccounts((prev) => [...prev.filter((account) => account.userId !== result.account.userId), result.account])
        setActiveUid(result.account.userId)
        closeDlg()
        invalidateLogViews([result.account.userId], result.account)
        if (result.replacedAlias) pushToast(`已按「只保留最后一次添加的账号信息」顶替原账号「${result.replacedAlias}」`)
        result.warnings.forEach((warning) => pushToast(warning))
        fetchAfterWrite(result.revision, epoch)
      } else {
        const epoch = bootIdRef.current
        const result = await api.updateCredentials(editUid, {
          userAccount: values.acct,
          password: values.pw,
          alias: values.alias,
        })
        noteRevision(result.revision, epoch)
        clearTombstone(editUid)
        clearTombstone(result.account.userId)
        const nextUid = result.account.userId
        setAccounts((prev) => {
          const index = prev.findIndex((account) => account.userId === editUid)
          const rest = prev.filter((account) => account.userId !== editUid && account.userId !== nextUid)
          /* 与后端顺序一致：同 userId 原位替换；换出不同 userId 时落列表尾部 */
          if (nextUid === editUid) rest.splice(Math.min(Math.max(index, 0), rest.length), 0, result.account)
          else rest.push(result.account)
          return rest
        })
        setActiveUid(nextUid)
        closeDlg()
        invalidateLogViews([editUid, nextUid], result.account)
        result.warnings.forEach((warning) => pushToast(warning))
        fetchAfterWrite(result.revision, epoch)
      }
    } catch (error) {
      /* 失败：弹窗保持打开、原状态不变；随后 4.1 校正 */
      handleError(error)
    } finally {
      setAddBusy(false)
    }
  }

  async function confirmDelete() {
    const current = contentRef.current
    if (current?.kind !== 'del') return
    const userId = current.uid
    const list = accountsRef.current
    const index = list.findIndex((account) => account.userId === userId)
    if (index < 0) {
      closeDlg()
      return
    }

    setDelBusy(true)
    /* 删除响应没有 revision：本地墓碑挡住删除前发出、删除后才到的旧快照 */
    addTombstone(userId)
    try {
      await api.deleteAccount(userId)
      setAccounts((prev) => prev.filter((account) => account.userId !== userId))
      const neighbor = list[index + 1] ?? list[index - 1]
      setActiveUid(neighbor?.userId ?? null)
      closeDlg()
      invalidateLogViews([userId], neighbor ?? null)
      void fetchState(undefined, true)
    } catch (error) {
      /* 超时 = 结果未知：撤掉墓碑让 4.1 校正带回真实状态；
         若账号已不在快照，上面的 effect 会关闭删除弹窗 */
      clearTombstone(userId)
      handleError(error)
    } finally {
      setDelBusy(false)
    }
  }

  async function onBannerAction(userId: number, act: 'relogin' | 'retry') {
    if (act === 'relogin') {
      openAdd(userId)
      return
    }
    /* 拿不到占位说明已有在途操作：不再重复触发 */
    if (!acquireAccountHold(userId)) return
    patchAccount(userId, (account) => ({
      ...account,
      dot: 'load',
      banner: {
        tone: 'idle',
        act: null,
        text: '正在重试登录…（这一步只在你点击后发生，工具不会自己反复重登）',
        btn: null,
      },
    }))
    try {
      const epoch = bootIdRef.current
      const result = await api.relogin(userId)
      noteRevision(result.revision, epoch)
      setAccounts((prev) => prev.map((account) => (account.userId === userId ? result.account : account)))
      fetchAfterWrite(result.revision, epoch)
    } catch (error) {
      handleError(error)
    } finally {
      releaseAccountHold(userId)
    }
  }

  /* ── 保活操作 ─────────────────────────────────────────────── */
  async function onManualKeepalive(userId: number, desktopId: string) {
    const key = desktopKey(userId, desktopId)
    /* ref 闸门挡住极快双击；busyDesktop 与自动开关共享同一 desktopId 互斥位 */
    if (manualKeepaliveRef.current.has(key) || busyDesktopRef.current.has(key)) return
    manualKeepaliveRef.current.add(key)
    busyDesktopRef.current.add(key)
    setBusyDesktop((prev) => ({ ...prev, [key]: true }))
    try {
      const epoch = bootIdRef.current
      const result = await api.keepalive(userId, desktopId)
      noteRevision(result.revision, epoch)
      /* 成功与失败都要落 lastAt/lastMsg（模型 §2.2 的「最近一次保活」包含失败） */
      patchPc(userId, desktopId, (pc) => ({ ...pc, lastAt: result.lastAt, lastMsg: result.lastMsg, left: result.left }))
      /* 同步执行：code=0 也可能 ok=false（上游业务拒绝），不展示成功短态、只 Toast 固定文案 */
      if (!result.ok) {
        pushToast(result.lastMsg || '保活失败，请稍后重试')
        fetchAfterWrite(result.revision, epoch)
        return
      }
      setJustOkPc((prev) => ({ ...prev, [key]: true }))
      setTimeout(() => setJustOkPc((prev) => withoutKey(prev, key)), 2000)
      fetchAfterWrite(result.revision, epoch)
    } catch (error) {
      /* 超时与非超时错误一律校正一次 4.1：「最近」及时更新（后端失败分支同样写了 lastAt/lastMsg）。
         与 handleError 同义（toast + silent 4.1），此处显式展开，避免重复刷新。 */
      toastError(error)
      void fetchState(undefined, true)
    } finally {
      manualKeepaliveRef.current.delete(key)
      busyDesktopRef.current.delete(key)
      setBusyDesktop((prev) => withoutKey(prev, key))
    }
  }

  async function onToggleAuto(userId: number, desktopId: string, on: boolean) {
    const key = desktopKey(userId, desktopId)
    if (busyDesktopRef.current.has(key)) return
    const account = accountsRef.current.find((item) => item.userId === userId)
    const pc = account?.pcs.find((item) => item.desktopId === desktopId)
    if (!pc) return
    const previous = { auto: pc.auto, left: pc.left }
    const hold = desktopHold(userId, desktopId)

    busyDesktopRef.current.add(key)
    setBusyDesktop((prev) => ({ ...prev, [key]: true }))
    inFlightRef.current.add(hold)

    /* 乐观切换；打开开关的立即保活由后端执行，前端不再调 4.8 */
    patchPc(userId, desktopId, (item) => ({
      ...item,
      auto: on,
      left: on && isKeepaliveCountedRun(item.run) ? (item.left ?? (account?.interval ?? 19) * 60) : null,
    }))
    try {
      const epoch = bootIdRef.current
      const result = await api.setDesktopAuto(userId, desktopId, on)
      noteRevision(result.revision, epoch)
      patchPc(userId, desktopId, (item) => ({ ...item, auto: result.auto, left: result.left }))
      fetchAfterWrite(result.revision, epoch)
    } catch (error) {
      /* 超时 = 结果未知：不回滚乐观态，等快照说话 */
      if (!isTimeout(error)) patchPc(userId, desktopId, (item) => ({ ...item, ...previous }))
      handleError(error)
    } finally {
      inFlightRef.current.delete(hold)
      busyDesktopRef.current.delete(key)
      setBusyDesktop((prev) => withoutKey(prev, key))
    }
  }

  async function onIntervalCommit(userId: number, minutes: number): Promise<boolean> {
    return queueAccountSettings(userId, async () => {
      /* 与 pointsWindow 提交共用 accountHold：同账号同时只允许一个设置写操作 */
      if (!acquireAccountHold(userId)) return false
      try {
        const epoch = bootIdRef.current
        const result = await api.updateSettings(userId, { interval: minutes })
        noteRevision(result.revision, epoch)
        patchAccount(userId, () => result.account)
        fetchAfterWrite(result.revision, epoch)
        return true
      } catch (error) {
        handleError(error)
        /* 超时结果未知：保留输入草稿，等 4.1 校正；仅确定失败才回滚 */
        return isTimeout(error)
      } finally {
        releaseAccountHold(userId)
      }
    })
  }

  async function onRefreshDesktops(userId: number) {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    try {
      const result = await api.listDesktops(userId)
      patchAccount(userId, (account) => ({ ...account, pcs: result.pcs }))
      setRefreshedAt(result.refreshedAt)
      void fetchState(undefined, true)
    } catch (error) {
      handleError(error)
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }

  /* ── 积分任务 ─────────────────────────────────────────────── */
  async function onRefreshPoints(userId: number) {
    if (pointsRefreshingRef.current) return
    pointsRefreshingRef.current = true
    setRefreshingPoints(true)
    try {
      const result = await api.getPoints(userId)
      patchAccount(userId, (account) => ({ ...account, points: result.points, tasks: result.tasks }))
      /* 4.10 响应没有 revision：追加一次 4.1，防止更旧的快照覆盖 points/tasks */
      void fetchState(undefined, true)
    } catch (error) {
      handleError(error)
    } finally {
      pointsRefreshingRef.current = false
      setRefreshingPoints(false)
    }
  }

  /**
   * 任务受理后的静默复查：不占用「刷新任务」的 busy，也不弹 Toast。
   * 后端执行一轮约 10–20s（对话 3–5s + 5s/15s 两次复查），按节奏跟两次即可。
   */
  function schedulePointsFollowUp(userId: number) {
    const tick = async () => {
      if (!accountsRef.current.some((account) => account.userId === userId)) return
      try {
        const result = await api.getPoints(userId)
        patchAccount(userId, (account) => ({ ...account, points: result.points, tasks: result.tasks }))
        void fetchState(undefined, true)
      } catch {
        /* 复查失败不打扰用户：可视刷新/切页签还有兜底 */
      }
    }
    setTimeout(() => void tick(), 10_000)
    setTimeout(() => void tick(), 26_000)
  }

  async function onRunTask(userId: number, taskDefId: number) {
    const key = taskKey(userId, taskDefId)
    /* 与任务自动开关共用 busyTask：同一 taskDefId 只允许一个在途写操作 */
    if (busyTaskRef.current.has(key)) return
    busyTaskRef.current.add(key)
    setBusyTask((prev) => ({ ...prev, [key]: true }))
    const hold = taskRunHold(userId, taskDefId)
    inFlightRef.current.add(hold)
    let accepted = false
    try {
      const epoch = bootIdRef.current
      const acceptedResult = await api.runTask(userId, taskDefId)
      accepted = true
      noteRevision(acceptedResult.revision, epoch)
      /* 受理即成功：随后的 4.10 复查失败属于「状态还没回来」，不弹错误 Toast、不回滚，
         只做一次静默的 4.1 校正；执行结果交给 10s/26s 跟进与可视刷新 */
      try {
        const result = await api.getPoints(userId)
        patchAccount(userId, (account) => ({ ...account, points: result.points, tasks: result.tasks }))
      } catch {
        /* 静默：后续跟进与可视刷新兜底 */
      }
      void fetchState(undefined, true)
    } catch (error) {
      handleError(error)
    } finally {
      if (accepted) schedulePointsFollowUp(userId)
      inFlightRef.current.delete(hold)
      busyTaskRef.current.delete(key)
      setBusyTask((prev) => withoutKey(prev, key))
    }
  }

  async function onToggleTask(userId: number, taskDefId: number, on: boolean) {
    const key = taskKey(userId, taskDefId)
    if (busyTaskRef.current.has(key)) return
    const account = accountsRef.current.find((item) => item.userId === userId)
    const previous = account?.tasks.find((task) => task.taskDefId === taskDefId)?.auto ?? false
    const hold = taskAutoHold(userId, taskDefId)

    busyTaskRef.current.add(key)
    setBusyTask((prev) => ({ ...prev, [key]: true }))
    inFlightRef.current.add(hold)
    patchTask(userId, taskDefId, (task) => ({ ...task, auto: on }))
    try {
      const epoch = bootIdRef.current
      const result = await api.setTaskAuto(userId, taskDefId, on)
      noteRevision(result.revision, epoch)
      patchTask(userId, taskDefId, (task) => ({ ...task, auto: result.auto }))
      fetchAfterWrite(result.revision, epoch)
    } catch (error) {
      if (!isTimeout(error)) patchTask(userId, taskDefId, (task) => ({ ...task, auto: previous }))
      handleError(error)
    } finally {
      inFlightRef.current.delete(hold)
      busyTaskRef.current.delete(key)
      setBusyTask((prev) => withoutKey(prev, key))
    }
  }

  async function onWindowCommit(userId: number, winStart: string, winEnd: string): Promise<boolean> {
    return queueAccountSettings(userId, async () => {
      /* 与 interval 提交共用 accountHold：同账号同时只允许一个设置写操作 */
      if (!acquireAccountHold(userId)) return false
      try {
        const epoch = bootIdRef.current
        const result = await api.updateSettings(userId, { pointsWindow: { winStart, winEnd } })
        noteRevision(result.revision, epoch)
        patchAccount(userId, () => result.account)
        fetchAfterWrite(result.revision, epoch)
        return true
      } catch (error) {
        handleError(error)
        /* 超时结果未知：保留输入草稿，等 4.1 校正；仅确定失败才回滚 */
        return isTimeout(error)
      } finally {
        releaseAccountHold(userId)
      }
    })
  }

  /* ── 日志：清空 / 导出 ───────────────────────────────────── */
  function resetClearArmed(userId: number) {
    delete clearArmedAtRef.current[userId]
    setClearArmed((prev) => {
      if (!prev[userId]) return prev
      const next = { ...prev }
      delete next[userId]
      return next
    })
  }

  async function onClearLogs(userId: number) {
    const armedAt = clearArmedAtRef.current[userId]
    if (armedAt == null || Date.now() - armedAt > 4000) {
      clearArmedAtRef.current[userId] = Date.now()
      setClearArmed((prev) => ({ ...prev, [userId]: true }))
      setTimeout(() => {
        const at = clearArmedAtRef.current[userId]
        if (at != null && Date.now() - at >= 4000) resetClearArmed(userId)
      }, 4200)
      return
    }

    resetClearArmed(userId)
    try {
      await api.clearLogs(userId)
      /* 清空后强制全量：旧行必须消失；开「包含系统日志」时还能看到后端写的那条清空记录 */
      logSignatureRef.current.delete(userId)
      await loadAccountLogs(userId, 'full')
      void fetchState(undefined, true)
    } catch (error) {
      handleError(error)
    }
  }

  async function onExport() {
    const userId = activeUidRef.current
    if (userId == null) return
    const account = accountsRef.current.find((item) => item.userId === userId)
    if (!account) return

    try {
      /* 一次拉满 1000 条（接口上限），超出则明确提示截断（frontend-design §6.3） */
      const result = await api.queryLogs(buildLogQuery(userId, filtersOf(userId), 1_000))
      if (result.total > result.rows.length) {
        pushToast(`导出已截断：仅包含最近 ${result.rows.length} 条，共 ${result.total} 条`)
      }
      const text = result.rows.map((row) => `${row.t} [${row.lv}] [${row.mod}] ${row.msg}`).join('\n') + '\n'
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `keepalive-logs-${accountFileSlug(account)}-${dayjs(nowWithOffset(clockOffsetRef.current)).format('YYYYMMDD-HHmmss')}.log`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      handleError(error)
    }
  }

  /* ── 页面装配 ─────────────────────────────────────────────── */
  const activeIndex = Math.max(
    0,
    accounts.findIndex((account) => account.userId === activeUid),
  )
  const activeAccount = accounts[activeIndex]

  const changeTab = (next: TabKey) => {
    /* 切回日志页签做一次全量校准：total 归服务端口径，同时作废旧口径的在途响应 */
    const userId = activeUidRef.current
    if (next === 'log' && tab !== 'log' && userId != null) {
      logTicketRef.current.set(userId, ++logSeqRef.current)
      logSignatureRef.current.delete(userId)
      logIncrementalRef.current.set(userId, 0)
    }
    setTab(next)
    maybeFetchState(5000)
  }
  const selectAccount = (userId: number) => {
    if (!accounts.some((account) => account.userId === userId)) return
    if (tab === 'log' && userId !== activeUidRef.current) {
      /* 切到另一个账号的日志页签同样做全量校准，并作废该账号旧口径的在途响应 */
      logTicketRef.current.set(userId, ++logSeqRef.current)
      logSignatureRef.current.delete(userId)
      logIncrementalRef.current.set(userId, 0)
    }
    setActiveUid(userId)
    maybeFetchState(5000)
  }

  const renderContent = (account: Account) => {
    if (account.banner) {
      return (
        <AccountErrorPanel
          banner={account.banner}
          onAction={(act) => {
            void onBannerAction(account.userId, act)
          }}
        />
      )
    }
    const view = logViews[account.userId] ?? EMPTY_LOG_VIEW
    const filters = logFilters[account.userId] ?? DEFAULT_LOG_FILTERS
    return (
      <SubTabs
        tab={tab}
        onChange={changeTab}
        name={`sub-tabs-${account.userId}`}
        panels={{
          keepalive: (
            <KeepAlivePanel
              account={account}
              refreshing={refreshing}
              refreshedAt={refreshedAt}
              justOkPc={justOkPc}
              busyDesktop={busyDesktop}
              onIntervalCommit={(minutes) => onIntervalCommit(account.userId, minutes)}
              onRefresh={() => {
                void onRefreshDesktops(account.userId)
              }}
              onManualKeepalive={(desktopId) => {
                void onManualKeepalive(account.userId, desktopId)
              }}
              onToggleAuto={(desktopId, on) => {
                void onToggleAuto(account.userId, desktopId, on)
              }}
            />
          ),
          points: (
            <PointsPanel
              account={account}
              refreshing={refreshingPoints}
              busyTask={busyTask}
              onRunTask={(taskDefId) => {
                void onRunTask(account.userId, taskDefId)
              }}
              onToggleTask={(taskDefId, on) => {
                void onToggleTask(account.userId, taskDefId, on)
              }}
              onWindowCommit={(winStart, winEnd) => onWindowCommit(account.userId, winStart, winEnd)}
              onRefresh={() => {
                void onRefreshPoints(account.userId)
              }}
            />
          ),
          log: (
            <LogPanel
              rows={view.rows}
              total={view.total}
              loading={view.loading}
              accountLabel={accountLabel(account)}
              lv={filters.lv}
              mod={filters.mod}
              kw={filters.kw}
              includeSys={filters.includeSys}
              autoScroll={autoScroll}
              clearArmed={!!clearArmed[account.userId]}
              onLv={(value) => updateLogFilters(account.userId, { lv: value })}
              onMod={(value) => updateLogFilters(account.userId, { mod: value })}
              onKw={(value) => updateLogFilters(account.userId, { kw: value })}
              onIncludeSys={(on) => updateLogFilters(account.userId, { includeSys: on })}
              onAutoScroll={setAutoScroll}
              onExport={() => {
                void onExport()
              }}
              onClear={() => {
                void onClearLogs(account.userId)
              }}
            />
          ),
        }}
      />
    )
  }

  if (!ready) {
    return (
      <main class="flex h-dvh w-full items-center justify-center px-4 py-4 md:px-8 md:py-6">
        {loadError ? (
          <div role="alert" class="alert alert-soft alert-error alert-vertical max-w-md justify-items-center">
            <p class="text-sm leading-relaxed">加载失败：{loadError}</p>
            <button
              type="button"
              class="btn btn-sm"
              onClick={() => {
                setLoadError(null)
                void fetchState()
              }}
            >
              重试
            </button>
          </div>
        ) : (
          <div class="flex items-center gap-2 text-sm text-base-content/60" role="status">
            <span class="loading loading-spinner loading-sm" aria-hidden="true" />
            正在加载…
          </div>
        )}
      </main>
    )
  }

  const addCfg = contentRef.current?.kind === 'add' ? contentRef.current : null
  const delCfg = contentRef.current?.kind === 'del' ? contentRef.current : null
  const editAccount = addCfg?.editUid != null ? (accounts.find((account) => account.userId === addCfg.editUid) ?? null) : null
  const delAccount = delCfg ? accounts.find((account) => account.userId === delCfg.uid) : undefined

  return (
    <main class="flex h-dvh w-full flex-col px-4 py-4 md:px-8 md:py-6">
      {/* 所有账号的内容全部挂载，显隐由 :checked + .tab-content 纯 CSS 驱动 */}
      <AccountTabBar
        accounts={accounts}
        active={activeIndex}
        maxAccounts={maxAccounts}
        renderContent={renderContent}
        onSelect={selectAccount}
        onDelete={openDel}
        onAdd={() => openAdd(null)}
      />
      {!activeAccount && <EmptyAccountPanel onAdd={() => openAdd(null)} />}

      {/* 弹窗层：两个常驻 dialog，open 态驱动；Toast 只在添加弹窗（报错均来自它） */}
      <ModalLayer
        open={dlg?.kind === 'add'}
        labelledBy="dlg-add-t"
        locked={addBusy}
        onRequestClose={() => {
          /* 同步登录在途时不允许关闭，避免状态悬空（frontend-design §5.3） */
          if (!addBusy) closeDlg()
        }}
        toasts={toasts}
        onDismissToast={dismissToast}
      >
        {addCfg && (
          <AddAccountForm
            key={String(session)}
            edit={editAccount}
            busy={addBusy}
            onSubmit={(values) => {
              void submitAdd(values)
            }}
            onClose={closeDlg}
          />
        )}
      </ModalLayer>
      <ModalLayer
        open={dlg?.kind === 'del'}
        labelledBy="dlg-del-t"
        locked={delBusy}
        onRequestClose={() => {
          if (!delBusy) closeDlg()
        }}
        focusClose
        toasts={toasts}
        onDismissToast={dismissToast}
      >
        {delAccount && (
          <DeleteConfirm
            label={accountLabel(delAccount)}
            busy={delBusy}
            onConfirm={() => {
              void confirmDelete()
            }}
            onClose={closeDlg}
          />
        )}
      </ModalLayer>

      {/* 无弹窗时的 Toast 出口；弹窗打开时由 ModalLayer 在 top layer 内渲染，避免被遮罩压住 */}
      {!dlg && <ToastStack toasts={toasts} onDismiss={dismissToast} />}
    </main>
  )
}
