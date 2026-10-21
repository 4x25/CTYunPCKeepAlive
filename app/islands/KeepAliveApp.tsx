import dayjs from 'dayjs/esm'
import { useEffect, useRef, useState } from 'hono/jsx'
import { ErrorCode } from '../../shared/constants'
import type {
  Account,
  LogFilters,
  LogLevel,
  LogModule,
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

  /* 日志：每账号一份视图缓存，唯一数据源是 4.13 */
  const [logViews, setLogViews] = useState<Record<number, LogView>>({})
  const [lv, setLv] = useState('ALL')
  const [mod, setMod] = useState('ALL')
  const [kw, setKw] = useState('')
  const [includeSys, setIncludeSys] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [clearArmed, setClearArmed] = useState<Record<number, boolean>>({})

  /* 供定时器 / 延时回调读到最新值 */
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const activeUidRef = useRef(activeUid)
  activeUidRef.current = activeUid
  const filterRef = useRef<LogFilters>({ lv, mod, kw, includeSys })
  filterRef.current = { lv, mod, kw, includeSys }

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
  const logGenerationRef = useRef(0)

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

  /** 写操作响应落地：把 revision 水位抬到响应值，挡住更旧的快照 */
  function noteRevision(revision: number) {
    if (revision > revisionRef.current) revisionRef.current = revision
  }

  /* ── 日志拉取（仅当前激活账号、数据缺失或显式触发时） ─────── */
  async function loadLogs(list: Account[], filters: LogFilters) {
    if (!list.length) {
      /* 让在途的旧响应失效 */
      logGenerationRef.current += 1
      return
    }
    const generation = ++logGenerationRef.current
    const queries = list.map((account) => {
      const query: Parameters<typeof api.queryLogs>[0] = {
        userId: account.userId,
        includeSys: filters.includeSys,
        limit: 200,
      }
      if (filters.lv !== 'ALL') query.lv = filters.lv as LogLevel
      if (filters.mod !== 'ALL') query.mod = filters.mod as LogModule
      if (filters.kw.trim()) query.kw = filters.kw.trim()
      return { userId: account.userId, promise: api.queryLogs(query) }
    })

    /* 首次/重拉都先进入 loading：面板据此显示 spinner 而不是「还没有日志」 */
    setLogViews((prev) => {
      const next = { ...prev }
      for (const item of queries) {
        next[item.userId] = { ...(prev[item.userId] ?? EMPTY_LOG_VIEW), loading: true }
      }
      return next
    })

    const settled = await Promise.allSettled(queries.map((item) => item.promise))
    /* 过期响应直接丢弃（generation 机制保留） */
    if (generation !== logGenerationRef.current) return

    const updates: Record<number, LogView> = {}
    const failed: number[] = []
    let firstError: unknown
    settled.forEach((outcome, index) => {
      const userId = queries[index].userId
      if (outcome.status === 'fulfilled') {
        updates[userId] = { rows: outcome.value.rows, total: outcome.value.total, loading: false }
      } else {
        failed.push(userId)
        if (firstError === undefined) firstError = outcome.reason
      }
    })
    setLogViews((prev) => {
      const next = { ...prev }
      for (const [userId, view] of Object.entries(updates)) next[Number(userId)] = view
      for (const userId of failed) {
        next[userId] = { ...(prev[userId] ?? EMPTY_LOG_VIEW), loading: false }
      }
      return next
    })
    if (firstError !== undefined) toastError(firstError)
  }

  function loadLogsFor(userId: number) {
    const account = accountsRef.current.find((item) => item.userId === userId)
    if (account) void loadLogs([account], filterRef.current)
  }

  /**
   * 账号新增/修正/删除后让日志缓存失效：
   * 清掉受影响 userId 的视图 + 抬 generation（在途响应写不回来）；
   * 当前在日志页签时立即重拉（显式传入重拉账号，避免等 accounts 状态落地）。
   */
  function invalidateLogViews(userIds: number[], reloadAccount?: Account | null) {
    logGenerationRef.current += 1
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
    if (account) void loadLogs([account], filterRef.current)
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

  function applySnapshot(snapshot: StateSnapshot): boolean {
    /* 只读已写入的 revision 水位：旧快照一律丢弃 */
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
      if (minRevision !== undefined && snapshot.revision < minRevision) {
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
      if (document.hidden || !document.hasFocus()) return
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

  /* 日志：切到日志页签 / 切账号 / 筛选变化时拉当前激活账号（关键字 300ms debounce） */
  useEffect(() => {
    if (!ready || tab !== 'log' || activeUid == null) return
    const delay = kw.trim() ? 300 : 0
    const id = setTimeout(() => loadLogsFor(activeUid), delay)
    return () => clearTimeout(id)
  }, [ready, tab, activeUid, lv, mod, kw, includeSys])

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
        const result = await api.createAccount({
          userAccount: values.acct,
          password: values.pw,
          alias: values.alias,
        })
        noteRevision(result.revision)
        clearTombstone(result.account.userId)
        setAccounts((prev) => [...prev.filter((account) => account.userId !== result.account.userId), result.account])
        setActiveUid(result.account.userId)
        closeDlg()
        invalidateLogViews([result.account.userId], result.account)
        if (result.replacedAlias) pushToast(`已按「只保留最后一次添加的账号信息」顶替原账号「${result.replacedAlias}」`)
        result.warnings.forEach((warning) => pushToast(warning))
        void fetchState(result.revision, true)
      } else {
        const result = await api.updateCredentials(editUid, {
          userAccount: values.acct,
          password: values.pw,
          alias: values.alias,
        })
        noteRevision(result.revision)
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
        void fetchState(result.revision, true)
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
      const result = await api.relogin(userId)
      noteRevision(result.revision)
      setAccounts((prev) => prev.map((account) => (account.userId === userId ? result.account : account)))
      void fetchState(result.revision, true)
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
      const result = await api.keepalive(userId, desktopId)
      noteRevision(result.revision)
      /* 成功与失败都要落 lastAt/lastMsg（模型 §2.2 的「最近一次保活」包含失败） */
      patchPc(userId, desktopId, (pc) => ({ ...pc, lastAt: result.lastAt, lastMsg: result.lastMsg, left: result.left }))
      /* 同步执行：code=0 也可能 ok=false（上游业务拒绝），不展示成功短态、只 Toast 固定文案 */
      if (!result.ok) {
        pushToast(result.lastMsg || '保活失败，请稍后重试')
        void fetchState(result.revision, true)
        return
      }
      setJustOkPc((prev) => ({ ...prev, [key]: true }))
      setTimeout(() => setJustOkPc((prev) => withoutKey(prev, key)), 2000)
      void fetchState(result.revision, true)
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
      const result = await api.setDesktopAuto(userId, desktopId, on)
      noteRevision(result.revision)
      patchPc(userId, desktopId, (item) => ({ ...item, auto: result.auto, left: result.left }))
      void fetchState(result.revision, true)
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
        const result = await api.updateSettings(userId, { interval: minutes })
        noteRevision(result.revision)
        patchAccount(userId, () => result.account)
        void fetchState(result.revision, true)
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

  async function onRunTask(userId: number, taskDefId: number) {
    const key = taskKey(userId, taskDefId)
    /* 与任务自动开关共用 busyTask：同一 taskDefId 只允许一个在途写操作 */
    if (busyTaskRef.current.has(key)) return
    busyTaskRef.current.add(key)
    setBusyTask((prev) => ({ ...prev, [key]: true }))
    const hold = taskRunHold(userId, taskDefId)
    inFlightRef.current.add(hold)
    try {
      const accepted = await api.runTask(userId, taskDefId)
      noteRevision(accepted.revision)
      /* 异步受理：立即复查一次 4.10，后续状态交给可视刷新与日志 */
      const result = await api.getPoints(userId)
      patchAccount(userId, (account) => ({ ...account, points: result.points, tasks: result.tasks }))
      void fetchState(undefined, true)
    } catch (error) {
      handleError(error)
    } finally {
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
      const result = await api.setTaskAuto(userId, taskDefId, on)
      noteRevision(result.revision)
      patchTask(userId, taskDefId, (task) => ({ ...task, auto: result.auto }))
      void fetchState(result.revision, true)
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
        const result = await api.updateSettings(userId, { pointsWindow: { winStart, winEnd } })
        noteRevision(result.revision)
        patchAccount(userId, () => result.account)
        void fetchState(result.revision, true)
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
      loadLogsFor(userId)
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

    const filters = filterRef.current
    const query: Parameters<typeof api.queryLogs>[0] = {
      userId,
      includeSys: filters.includeSys,
      limit: 1000,
    }
    if (filters.lv !== 'ALL') query.lv = filters.lv as LogLevel
    if (filters.mod !== 'ALL') query.mod = filters.mod as LogModule
    if (filters.kw.trim()) query.kw = filters.kw.trim()

    try {
      /* 一次拉满 1000 条（接口上限），超出则明确提示截断 */
      const result = await api.queryLogs(query)
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
    setTab(next)
    maybeFetchState(5000)
  }
  const selectAccount = (userId: number) => {
    if (!accounts.some((account) => account.userId === userId)) return
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
              lv={lv}
              mod={mod}
              kw={kw}
              includeSys={includeSys}
              autoScroll={autoScroll}
              clearArmed={!!clearArmed[account.userId]}
              onLv={setLv}
              onMod={setMod}
              onKw={setKw}
              onIncludeSys={setIncludeSys}
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
