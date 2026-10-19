import { useEffect, useRef, useState } from 'hono/jsx'
import type { Account, LogLevel, PcInstance, PointTask } from '../lib/types'
import type { LogEntry } from '../lib/types'
import {
  MAX_ACCOUNTS,
  TASK_TOTAL,
  demoPcs,
  demoUid,
  nextSeq,
  seedAccounts,
  seedPointTasks,
  seedSyslogs,
} from '../lib/mock-data'
import { maskOf, nowHm, nowStr } from '../lib/utils'
import AccountTabBar from '../components/AccountTabBar'
import AccountErrorPanel from '../components/AccountErrorPanel'
import EmptyAccountPanel from '../components/EmptyAccountPanel'
import SubTabs, { type TabKey } from '../components/SubTabs'
import KeepAlivePanel from '../components/KeepAlivePanel'
import PointsPanel from '../components/PointsPanel'
import LogPanel from '../components/LogPanel'
import ModalLayer from '../components/ModalLayer'
import AddAccountForm, { type AddFormValues } from '../components/AddAccountForm'
import DeleteConfirm from '../components/DeleteConfirm'
import type { ToastItem } from '../components/ToastStack'

type Dlg = { kind: 'add'; edit: number } | { kind: 'del'; index: number } | null

/* 页面级状态快照的轻量深拷贝：日志条目等叶子对象只读不原地改，浅拷即可 */
const cloneAccounts = (prev: Account[]): Account[] =>
  prev.map((a) => ({ ...a, pcs: a.pcs.map((p) => ({ ...p })), logs: [...a.logs], banner: a.banner ? { ...a.banner } : null }))

/** 天翼云保活助手 · 交互原型（数据为演示 mock，行为对齐交互稿） */
export default function KeepAliveApp() {
  const [accounts, setAccounts] = useState<Account[]>(seedAccounts)
  const [syslogs, setSyslogs] = useState<LogEntry[]>(seedSyslogs)
  const [tasks, setTasks] = useState<PointTask[]>(seedPointTasks)
  /* 初始态从 SSR 已勾选的 radio 读回：水合前用户就能用纯 CSS 切 Tab，水合不翻回 */
  const [active, setActive] = useState(() => {
    if (typeof document === 'undefined') return 0
    const i = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="acct-tabs"]')).findIndex((r) => r.checked)
    return i >= 0 ? i : 0
  })
  const [tab, setTab] = useState<TabKey>(() => {
    if (typeof document === 'undefined') return 'keepalive'
    const checked = document.querySelector<HTMLInputElement>('input[name^="sub-tabs-"]:checked')
    const label = checked?.getAttribute('aria-label')
    return label === '积分任务' ? 'points' : label === '运行日志' ? 'log' : 'keepalive'
  })
  const [dlg, setDlg] = useState<Dlg>(null)
  const [addBusy, setAddBusy] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshedAt, setRefreshedAt] = useState('14:32')

  /* 日志筛选 */
  const [lv, setLv] = useState('ALL')
  const [mod, setMod] = useState('ALL')
  const [kw, setKw] = useState('')
  const [includeSys, setIncludeSys] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [clearArmed, setClearArmed] = useState(false)

  /* 供定时器 / 延时回调读到最新值 */
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const activeRef = useRef(active)
  activeRef.current = active
  const refreshingRef = useRef(false)
  const lastRefreshRef = useRef(Date.now())
  const clearArmedAtRef = useRef(0)
  const toastIdRef = useRef(0)

  /* ── 日志：所有操作都往这里写一条 ─────────────────────────────
     idx 省略 = 记到当前账号；显式传 null = 无账号归属（删除账号这类事件） */
  const addLog = (level: LogLevel, module: string, msg: string, idx?: number | null) => {
    const entry: LogEntry = { seq: nextSeq(), t: nowStr(), lv: level, mod: module, msg }
    if (idx === null) {
      setSyslogs((prev) => [entry, ...prev])
      return
    }
    const i = idx ?? activeRef.current
    setAccounts((prev) => {
      const next = cloneAccounts(prev)
      next[i]?.logs.unshift(entry)
      return next
    })
  }

  /* ── Toast：服务端报错的唯一出口，6 秒自动消失 ─────────────── */
  const pushToast = (msg: string, code?: string) => {
    const id = ++toastIdRef.current
    setToasts((prev) => [...prev, { id, msg, code }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000)
  }
  const dismissToast = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id))

  /* ── 弹窗开关：上一次的服务端报错不带进这一次 ──────────────── */
  const [session, setSession] = useState(0)
  const openDlg = (next: Exclude<Dlg, null>) => {
    setToasts([])
    setAddBusy(false)
    setSession((s) => s + 1) /* 递增 key，重置表单内部状态 */
    setDlg(next)
  }
  /* 仅标记关闭：动画与焦点归还交给常驻 dialog 自己完成 */
  const closeDlg = () => {
    setDlg(null)
  }
  /* 关闭动画期间保留内容配置（表单不随 open 态消失，跟随弹窗一起淡出） */
  const contentRef = useRef<Dlg>(null)
  if (dlg) contentRef.current = dlg
  const openAdd = (idx: number | null) => openDlg({ kind: 'add', edit: idx ?? -1 })
  const openDel = (idx: number) => {
    if (!accountsRef.current[idx]) return
    openDlg({ kind: 'del', index: idx })
  }

  /* ── 功能页签：记住上次停留的 Tab ─────────────────────────── */
  const changeTab = (t: TabKey) => {
    setTab(t)
  }

  /* ── 每秒推进倒计时与 1 小时连接计时（所有账号的内容全部挂载，倒计时全量推进） ── */
  useEffect(() => {
    const id = setInterval(() => {
      setAccounts((prev) => {
        let touched = false
        const next = prev.map((a) => {
          let pcs: PcInstance[] | null = null
          a.pcs.forEach((p, j) => {
            /* 积分任务「连接满 1 小时」占用某台实例，与保活列表同源 */
            if (p.link != null) {
              pcs ||= a.pcs.map((x) => ({ ...x }))
              const rest = p.link - 1
              pcs[j].link = rest <= 0 ? TASK_TOTAL : rest
            } else if (p.auto && p.run === 'running' && p.left != null) {
              pcs ||= a.pcs.map((x) => ({ ...x }))
              const rest = p.left - 1
              pcs[j].left = rest <= 0 ? a.interval * 60 : rest
              /* 会话冲突的实例：到点仍然会试，但演示里保持失败态，不抢回连接 */
              if (rest <= 0 && !p.conflict) pcs[j].last = nowStr() + ' 成功'
            }
          })
          if (!pcs) return a
          touched = true
          return { ...a, pcs }
        })
        return touched ? next : prev
      })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  /* ── 刷新列表：手动点击与「可视刷新」共用同一套节流逻辑 ────── */
  const doRefresh = () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    setTimeout(() => {
      refreshingRef.current = false
      lastRefreshRef.current = Date.now()
      setRefreshing(false)
      setRefreshedAt(nowHm())
    }, 1000)
  }
  /* 可视刷新：重新拿到焦点且距上次成功刷新超过 60 秒，自动刷一次 */
  useEffect(() => {
    const maybeVisibleRefresh = () => {
      if (document.hidden || !document.hasFocus()) return
      if (Date.now() - lastRefreshRef.current < 60000) return
      doRefresh()
    }
    document.addEventListener('visibilitychange', maybeVisibleRefresh)
    window.addEventListener('focus', maybeVisibleRefresh)
    return () => {
      document.removeEventListener('visibilitychange', maybeVisibleRefresh)
      window.removeEventListener('focus', maybeVisibleRefresh)
    }
  }, [])

  /* ── 保活执行：按钮「执行中」→ 成功胶囊 2 秒 → 回落。手动点击与「打开开关立即执行一次」共用 ── */
  const runKeepalive = (ai: number, pcIndex: number) => {
    setAccounts((prev) => {
      const next = cloneAccounts(prev)
      const p = next[ai]?.pcs[pcIndex]
      if (p) p.busy = true
      return next
    })
    setTimeout(() => {
      let ok = false
      let name = ''
      let auto = false
      let left: number | null = null
      setAccounts((prev) => {
        const next = cloneAccounts(prev)
        const a = next[ai]
        const p = a?.pcs[pcIndex]
        if (a && p) {
          p.busy = false
          p.justOk = true
          p.last = nowStr() + ' 成功'
          p.conflict = false /* 手动成功一次就说明会话拿回来了 */
          if (p.auto) p.left = a.interval * 60
          name = p.name
          auto = p.auto
          left = p.left
          ok = true
        }
        return next
      })
      if (!ok) return
      addLog('DEBUG', '保活', `${name} 界面状态已同步 · 自动保活：${auto ? '开启' : '关闭'} · 下次倒计时：${left == null ? '未安排' : left + ' 秒'}`, ai)
      addLog('INFO', '保活', `${name} 保活成功 · 耗时 ${400 + Math.floor(Math.random() * 400)}ms`, ai)
      setTimeout(() => {
        setAccounts((prev) => {
          const next = cloneAccounts(prev)
          const p = next[ai]?.pcs[pcIndex]
          if (p) p.justOk = false
          return next
        })
      }, 2000)
    }, 1100)
  }

  /* ── 自动开关：切换即落库；打开 = 立即执行一次，再开始按间隔计时 ── */
  const onToggleAuto = (ai: number, pcIndex: number, on: boolean) => {
    let name = ''
    let interval = 19
    let canRun = false
    setAccounts((prev) => {
      const next = cloneAccounts(prev)
      const a = next[ai]
      const p = a?.pcs[pcIndex]
      if (a && p) {
        p.auto = on
        if (on && p.run === 'running') p.left = a.interval * 60
        name = p.name
        interval = a.interval
        canRun = on && p.link == null && p.run === 'running'
      }
      return next
    })
    if (!name) return
    addLog(
      'INFO',
      '保活',
      `${on ? '已开启' : '已关闭'} ${name} 的自动保活` +
        (on ? `（立即执行一次，随后每 ${interval} 分钟一轮；期间你在其它设备上连这台会被挤掉）` : '（该实例不再产生任何连接）'),
      ai,
    )
    if (canRun) runKeepalive(ai, pcIndex)
  }

  /* ── 保活间隔：校验已在面板内完成（1–59），这里按新间隔重排该账号所有计划 ── */
  const onIntervalCommit = (ai: number, v: number) => {
    setAccounts((prev) => {
      const next = cloneAccounts(prev)
      const a = next[ai]
      if (!a) return prev
      a.interval = v
      a.pcs.forEach((p) => {
        if (p.auto && p.link == null && p.run === 'running') p.left = v * 60
      })
      return next
    })
  }

  /* ── 警示条按钮：登录失败 → 预填修正态；需人工处理 → 重试登录 ── */
  const onBannerAction = (ai: number, act: 'relogin' | 'retry') => {
    if (act === 'relogin') {
      openAdd(ai)
      return
    }
    const mask = accountsRef.current[ai]?.mask ?? ''
    setAccounts((prev) => {
      const next = cloneAccounts(prev)
      const a = next[ai]
      if (a) {
        a.dot = 'load'
        a.banner = { tone: 'idle', act: null, text: '正在重试登录…（这一步只在你点击后发生，工具不会自己反复重登）', btn: null }
      }
      return next
    })
    addLog('INFO', '账号', `${mask} 人工确认后重试登录`, ai)
    setTimeout(() => {
      setAccounts((prev) => {
        const next = cloneAccounts(prev)
        const acc = next[ai]
        if (acc) {
          acc.dot = 'ok'
          acc.banner = null
          acc.emptyText = null
          if (!acc.pcs.length) acc.pcs = demoPcs()
        }
        return next
      })
      addLog('INFO', '账号', `${mask} 重试登录成功 · 已恢复该账号的自动任务排程 · 实例自动开关保持你上次设置的状态`, ai)
    }, 1400)
  }

  /* ── 新增账号 / 修正凭据：先登录、后落库；落库前按 userId 去重 ── */
  const submitAdd = (v: AddFormValues) => {
    const edit = dlg?.kind === 'add' ? dlg.edit : -1
    /* 已添加过的账号不在这里拦——照常走登录，拿到 userId 后在落库前去重 */
    if (edit < 0 && accountsRef.current.length >= MAX_ACCOUNTS) {
      pushToast(`最多 ${MAX_ACCOUNTS} 个账号，避免并发请求过密`)
      return
    }
    setAddBusy(true)
    setTimeout(() => {
      setAddBusy(false)
      const cur = accountsRef.current
      const old = edit >= 0 ? cur[edit] : undefined
      if (edit >= 0 && !old) {
        closeDlg()
        return
      }
      /* 演示失败分支：修正态里密码一个字符都没改，服务端仍然返回 51010 */
      if (old && v.pw === old.pw && v.acct === old.full) {
        pushToast('账号或密码不正确，请检查后重新提交', 'code=51010')
        addLog('ERROR', '账号', `${maskOf(v.acct)} 重新登录失败：账号或密码不正确（code=51010），该账号自动任务仍然挂起`, edit)
        return
      }
      const mask = maskOf(v.acct)
      const uid = demoUid(v.acct) /* 真实实现里这个值来自登录响应的 userId */
      /* 去重结果在提交前算好：旧记录里与新 userId 相同的（除被替换者外）将被移除 */
      const removedPairs = cur.map((a, i) => ({ a, i })).filter(({ a, i }) => a.uid === uid && i !== edit)
      const base = edit >= 0 ? edit : cur.length
      const newActive = base - removedPairs.filter(({ i }) => i < base).length

      let msg: string
      if (old) {
        msg =
          (v.acct === old.full
            ? `账号 ${mask} 的凭据已更正并登录成功：仍然按「先删原账号、再加新账号」执行`
            : `账号 ${old.mask} 已替换为 ${mask}`) +
          `（保活间隔 ${old.interval} 分钟、积分时间窗口与各实例自动开关按位置继承；原账号的日志已清除）`
      } else {
        msg = `新增账号 ${mask} 登录成功 · 密码已明文写入配置文件 · 该账号所有实例的自动保活开关默认关闭，需逐台打开`
      }

      setAccounts((prev) => {
        let next = cloneAccounts(prev)
        if (edit >= 0) {
          const t = next[edit]
          if (t) {
            /* 留空就是留空：Tab 名回落到完整账号，不再塞掩码进去 */
            t.full = v.acct
            t.pw = v.pw
            t.alias = v.alias
            t.mask = mask
            t.uid = uid
            t.dot = 'ok'
            t.banner = null
            t.emptyText = null
            t.logs = [] /* 旧日志属于被删掉的那个账号，一并清除 */
            if (!t.pcs.length) t.pcs = demoPcs()
          }
        } else {
          next.push({ alias: v.alias, mask, full: v.acct, pw: v.pw, uid, dot: 'ok', interval: 19, banner: null, pcs: demoPcs(), logs: [] })
        }
        /* 落库前的最后一步：同一 userId 只留这一条 */
        next = next.filter((a, i) => i === (edit >= 0 ? edit : next.length - 1) || a.uid !== uid)
        return next
      })
      setActive(newActive)
      addLog('INFO', '账号', msg, newActive)
      /* 旧 Tab 连它的日志一起消失，所以这类记录只能落进系统日志；userId 的值本身不进日志 */
      removedPairs.forEach(({ a: gone }) =>
        addLog(
          'INFO',
          '账号',
          `本次添加的 ${mask} 与已有账号 ${gone.alias ? gone.alias + ' ' + gone.mask : gone.mask} 是同一个天翼云账号（登录返回的 userId 相同）· 已按「只保留最后一次添加的账号信息」删除旧的那条 · 它的配置（含 password）、保活间隔、积分时间窗口与日志一并移除`,
          null,
        ),
      )
      closeDlg()
    }, 1200)
  }

  /* ── 删除账号 ─────────────────────────────────────────────── */
  const confirmDelete = () => {
    if (dlg?.kind !== 'del') return
    const idx = dlg.index
    const a = accountsRef.current[idx]
    if (!a) {
      closeDlg()
      return
    }
    setAccounts((prev) => prev.filter((_, i) => i !== idx))
    const newLen = accountsRef.current.length - 1
    setActive((cur) => (cur >= newLen ? Math.max(0, newLen - 1) : cur))
    /* 账号连带它的日志一起消失，所以这条记录只能落在「无账号归属」里 */
    addLog(
      'INFO',
      '账号',
      `已删除账号 ${a.mask} · 配置文件中该条（含 password）已整条移除并覆盖写盘 · 已取消该账号的全部排队与进行中任务 · 该账号的日志已随之删除`,
      null,
    )
    closeDlg()
  }

  /* ── 积分任务：手动执行 ────────────────────────────────────── */
  const onRunTask = (i: number) => {
    const name = tasks[i]?.name ?? '积分任务'
    setTasks((prev) => prev.map((t, j) => (j === i ? { ...t, busy: true } : t)))
    setTimeout(() => {
      setTasks((prev) => prev.map((t, j) => (j === i ? { ...t, busy: false, status: 'done' } : t)))
      addLog('INFO', '积分', `「${name}」手动执行完成（status=2）· 本次奖励 100 通用积分 · 该任务今日不再自动执行`)
    }, 1100)
  }
  const onToggleTask = (i: number, on: boolean) => {
    setTasks((prev) => prev.map((t, j) => (j === i ? { ...t, auto: on } : t)))
  }

  /* ── 日志：导出 / 两步确认清空（每个账号的面板各自挂载，按各自归属过滤） ── */
  const a = accounts[active]
  const kwl = kw.trim().toLowerCase()
  const logsFor = (acc: Account) => {
    const merged = includeSys ? [...acc.logs, ...syslogs] : [...acc.logs]
    merged.sort((x, y) => y.seq - x.seq)
    return {
      rows: merged.filter(
        (r) => (lv === 'ALL' || r.lv === lv) && (mod === 'ALL' || r.mod === mod) && (!kwl || (r.msg + ' ' + r.mod).toLowerCase().includes(kwl)),
      ),
      total: acc.logs.length + (includeSys ? syslogs.length : 0),
    }
  }

  const onExport = () => {
    if (!a) return
    addLog('INFO', '系统', `已导出当前筛选结果 ${logsFor(a).rows.length} 条为 .log 文件 · 导出内容不含密码，可直接贴到 issue`)
  }
  const onClearLogs = () => {
    const ai = activeRef.current
    const acc = accountsRef.current[ai]
    if (!acc) return
    /* 清空按两步二次确认，不再多开一个弹窗 */
    if (Date.now() - clearArmedAtRef.current > 4000) {
      clearArmedAtRef.current = Date.now()
      setClearArmed(true)
      setTimeout(() => {
        if (Date.now() - clearArmedAtRef.current >= 4000) {
          clearArmedAtRef.current = 0
          setClearArmed(false)
        }
      }, 4200)
      return
    }
    clearArmedAtRef.current = 0
    setClearArmed(false)
    setAccounts((prev) => {
      const next = cloneAccounts(prev)
      if (next[ai]) next[ai].logs = []
      return next
    })
    addLog('INFO', '系统', `已清空 ${acc.mask} 的界面日志 · 磁盘上的日志文件不受影响`, ai)
  }

  /* 「连接满 1 小时」的接口累计值：total - 剩余，与被占用实例的倒计时同源 */
  let linkDone: number | null = null
  accounts.forEach((acc) => acc.pcs.forEach((p) => {
    if (p.link != null) linkDone = TASK_TOTAL - p.link
  }))

  /* 每个账号各自的内容：报错账号给错误面板，其余给功能页签 + 三个面板（全部挂载） */
  const renderContent = (acc: Account, accIdx: number) => {
    if (acc.banner) return <AccountErrorPanel banner={acc.banner} onAction={(act) => onBannerAction(accIdx, act)} />
    const { rows, total } = logsFor(acc)
    return (
      <SubTabs
        tab={tab}
        onChange={changeTab}
        name={`sub-tabs-${acc.uid}`}
        panels={{
          keepalive: (
            <KeepAlivePanel
              account={acc}
              refreshing={refreshing}
              refreshedAt={refreshedAt}
              onIntervalCommit={(v) => onIntervalCommit(accIdx, v)}
              onRefresh={doRefresh}
              onManualKeepalive={(pi) => runKeepalive(accIdx, pi)}
              onToggleAuto={(pi, on) => onToggleAuto(accIdx, pi, on)}
            />
          ),
          points: <PointsPanel tasks={tasks} linkDone={linkDone} onRunTask={onRunTask} onToggleTask={onToggleTask} />,
          log: (
            <LogPanel
              rows={rows}
              total={total}
              accountLabel={(acc.alias ? acc.alias + ' ' : '') + acc.mask}
              lv={lv}
              mod={mod}
              kw={kw}
              includeSys={includeSys}
              autoScroll={autoScroll}
              clearArmed={clearArmed}
              onLv={setLv}
              onMod={setMod}
              onKw={setKw}
              onIncludeSys={setIncludeSys}
              onAutoScroll={setAutoScroll}
              onExport={onExport}
              onClear={onClearLogs}
            />
          ),
        }}
      />
    )
  }

  /* 零账号时的空态：整幅提示（与报错账号同形态，不展示功能页签） */
  const emptyState = <EmptyAccountPanel onAdd={() => openAdd(null)} />

  /* 两个常驻 dialog 的内容配置：关闭动画期间保留（表单随弹窗一起淡出） */
  const addCfg = contentRef.current?.kind === 'add' ? contentRef.current : null
  const delCfg = contentRef.current?.kind === 'del' ? contentRef.current : null
  const delAccount = delCfg ? accounts[delCfg.index] : undefined

  return (
    <main class="flex h-dvh w-full flex-col px-4 py-4 md:px-8 md:py-6">
      {/* 所有账号的内容全部挂载，显隐由 :checked + .tab-content 纯 CSS 驱动（水合前可切） */}
      <AccountTabBar accounts={accounts} active={active} renderContent={renderContent} onSelect={setActive} onDelete={openDel} onAdd={() => openAdd(null)} />
      {!a && emptyState}

      {/* 弹窗层：两个常驻 dialog，open 态驱动；Toast 只在添加弹窗（报错均来自它） */}
      <ModalLayer open={dlg?.kind === 'add'} labelledBy="dlg-add-t" onRequestClose={closeDlg} toasts={toasts} onDismissToast={dismissToast}>
        {addCfg && (
          <AddAccountForm
            key={String(session)}
            edit={addCfg.edit >= 0 ? (accounts[addCfg.edit] ?? null) : null}
            busy={addBusy}
            onSubmit={submitAdd}
            onClose={closeDlg}
          />
        )}
      </ModalLayer>
      <ModalLayer open={dlg?.kind === 'del'} labelledBy="dlg-del-t" onRequestClose={closeDlg} focusClose>
        {delAccount && (
          <DeleteConfirm
            /* 没填别名时只写掩码，不重复写两遍 */
            label={delAccount.alias ? delAccount.alias + ' ' + delAccount.mask : delAccount.mask}
            onConfirm={confirmDelete}
            onClose={closeDlg}
          />
        )}
      </ModalLayer>
    </main>
  )
}
