import type { Account, LogEntry, PointTask } from './types'

/** 积分任务「连接云电脑满 1 小时」的接口 totalProgress，单位秒 */
export const TASK_TOTAL = 3600

/** 账号数量上限：避免并发请求过密 */
export const MAX_ACCOUNTS = 10

/**
 * 演示用递增序号：新条目永远排在最前，不依赖真实时钟与演示时间的先后。
 * 模块加载时把所有种子日志按时间升序赋 seq，界面渲染按 seq 倒序。
 */
let SEQ = 0
export function nextSeq(): number {
  return ++SEQ
}

type RawLog = Omit<LogEntry, 'seq'>

interface RawAccount extends Omit<Account, 'logs'> {
  logs: RawLog[]
}

/** uid = 登录响应里的 userId：账号去重只认它，不认用户输的那串字符 */
const ACCOUNTS_SEED: RawAccount[] = [
  {
    alias: '主号',
    mask: '138****6021',
    full: '13800006021',
    pw: 'Demo#Pass2026',
    uid: 41288301,
    dot: 'ok',
    interval: 19,
    banner: null,
    pcs: [
      { name: '办公云电脑', id: 'ecd-7f21a9', os: 'Windows', run: 'running', auto: true, left: 372, last: '14:26:03 成功' },
      { name: '剪辑云电脑', id: 'ecd-2b83c4', os: 'Windows', run: 'running', auto: true, left: null, link: 2148, last: '积分任务占用中' },
      { name: '备份云电脑', id: 'ecd-9d0e17', os: 'Windows', run: 'stopped', auto: false, left: null, last: '—' },
      { name: '渲染农场 01', id: 'ecd-31c8a2', os: 'Windows', run: 'running', auto: true, left: 483, last: '14:31:47 成功' },
      { name: '渲染农场 02', id: 'ecd-31c8b7', os: 'Windows', run: 'running', auto: true, left: 1074, last: '14:29:12 成功' },
      { name: '深度学习训练机', id: 'ecd-77aa09', os: 'Windows', run: 'running', auto: false, left: null, last: '13:58:40 成功' },
      { name: '测试环境-支付', id: 'ecd-5e21d4', os: 'Windows', run: 'error', auto: true, left: null, last: '14:18:52 失败 · 连接超时' },
      /* 会话冲突：实例仍是运行中，但会话被其它设备抢走，本轮跳过且不抢回 */
      { name: '测试环境-订单', id: 'ecd-5e21f1', os: 'Windows', run: 'running', auto: true, left: 936, conflict: true, last: '14:36:20 失败 · 可能有其它设备连接了这台云电脑' },
      { name: 'Win11 尝鲜机', id: 'ecd-b209ce', os: 'Windows', run: 'starting', auto: false, left: null, last: '—' },
      { name: '老项目维护机', id: 'ecd-04f17c', os: 'Windows', run: 'stopping', auto: true, left: null, last: '14:10:03 成功' },
      { name: '客服演示机', id: 'ecd-8d42e6', os: 'Windows', run: 'stopped', auto: false, left: null, last: '—' },
      { name: '数据同步节点', id: 'ecd-60b3f8', os: 'Windows', run: 'running', auto: true, left: 58, last: '14:32:01 成功' },
    ],
    /* 日志的「对象」列只写实例名或任务名：objId / desktopId / desktopCode 一律不进日志 */
    logs: [
      { t: '14:36:20', lv: 'WARN', mod: '保活', msg: '测试环境-订单 本轮跳过：握手在 ServerLink 阶段被拒，判定为其它设备正在连接（会话冲突），不抢回连接，下个周期重试' },
      { t: '14:32:08', lv: 'INFO', mod: '保活', msg: '办公云电脑 保活成功 · 耗时 540ms' },
      { t: '14:32:01', lv: 'INFO', mod: '保活', msg: '数据同步节点 保活成功 · 耗时 476ms' },
      { t: '14:31:47', lv: 'INFO', mod: '保活', msg: '渲染农场 01 保活成功 · 耗时 503ms' },
      { t: '14:29:12', lv: 'INFO', mod: '保活', msg: '渲染农场 02 保活成功 · 耗时 498ms' },
      { t: '14:26:55', lv: 'WARN', mod: '调度', msg: '命中账号级限流，本次请求延后 1.2s 入队' },
      { t: '14:18:52', lv: 'ERROR', mod: '保活', msg: '测试环境-支付 保活失败：连接超时（step=ws-display code=ETIMEDOUT），本轮整轮作废，下个周期重试' },
      { t: '14:14:00', lv: 'INFO', mod: '积分', msg: 'taskDefId 1003「使用1小时」开始执行（剪辑云电脑），该实例周期保活本轮起暂停' },
      { t: '14:05:19', lv: 'ERROR', mod: '保活', msg: '测试环境-支付 保活失败：连接超时（step=ws-display code=ETIMEDOUT），本轮整轮作废，下个周期重试' },
      { t: '13:58:40', lv: 'INFO', mod: '保活', msg: '深度学习训练机 手动保活成功 · 耗时 604ms' },
      { t: '11:42:36', lv: 'WARN', mod: '调度', msg: '测试环境-订单 会话被其它设备抢占，本轮跳过并标记会话冲突' },
      { t: '10:05:31', lv: 'WARN', mod: '积分', msg: 'taskDefId 1004「与AI对话1次」检测到 AI 平台会话不可用，已重新走 ticketAuthorize 后继续' },
      { t: '09:41:22', lv: 'INFO', mod: '积分', msg: 'taskDefId 1002「登录AI云电脑」已完成（status=2）· 通用积分 1,280' },
      { t: '09:20:03', lv: 'INFO', mod: '保活', msg: '数据同步节点 保活成功 · 耗时 512ms' },
      { t: '09:00:41', lv: 'INFO', mod: '保活', msg: '渲染农场 01 保活成功 · 耗时 487ms' },
      { t: '09:00:20', lv: 'INFO', mod: '账号', msg: '138****6021 登录成功 · 已恢复 6 条自动保活计划' },
    ],
  },
  {
    alias: '备用号',
    mask: '159****3374',
    full: '15900003374',
    pw: 'Demo#Pass2026',
    uid: 41288712,
    dot: 'ok',
    interval: 19,
    banner: null,
    pcs: [
      { name: '测试机 A', id: 'ecd-4a55b0', os: 'Windows', run: 'error', auto: true, left: null, last: '14:22:10 失败 · 连接超时' },
      { name: '测试机 B', id: 'ecd-6c1802', os: 'Windows', run: 'running', auto: true, left: 540, last: '14:30:55 成功' },
      /* 会话冲突：实例仍是运行中，但会话被其它设备抢走，本轮跳过且不抢回 */
      { name: '测试机 C', id: 'ecd-8e42d1', os: 'Windows', run: 'running', auto: true, left: 1140, conflict: true, last: '14:41:02 失败 · 可能有其它设备连接了这台云电脑' },
    ],
    logs: [
      { t: '14:41:02', lv: 'WARN', mod: '保活', msg: '测试机 C 本轮跳过：握手在 ServerLink 阶段被拒，判定为其它设备正在连接（会话冲突），不抢回连接，下个周期重试' },
      { t: '14:30:55', lv: 'INFO', mod: '保活', msg: '测试机 B 保活成功 · 耗时 612ms' },
      { t: '14:22:10', lv: 'ERROR', mod: '保活', msg: '测试机 A 保活失败：连接超时（step=ws-display code=ETIMEDOUT），本轮整轮作废，下个周期重试' },
      { t: '09:00:20', lv: 'INFO', mod: '账号', msg: '159****3374 登录成功 · 已恢复 3 条自动保活计划' },
    ],
  },
  {
    alias: '测试号',
    mask: '177****8802',
    full: '17700008802',
    pw: 'Demo#Pass2026',
    uid: 41290455,
    dot: 'danger',
    interval: 19,
    banner: { tone: 'danger', act: 'relogin', text: '登录失败：账号或密码不正确（09:14），该账号下所有自动任务已挂起。', btn: '重新登录' },
    emptyText: '登录失败，暂时无法获取云电脑列表',
    pcs: [],
    logs: [
      { t: '09:14:03', lv: 'ERROR', mod: '账号', msg: '177****8802 登录失败：账号或密码不正确（code=51010 INVALID_PASSWORD），该账号自动任务已挂起，等待用户修正凭据' },
    ],
  },
  /* 需人工处理：工具完全停止自动重登，等人去官方客户端过完验证 */
  {
    alias: '验证号',
    mask: '186****5140',
    full: '18600005140',
    pw: 'Demo#Pass2026',
    uid: 41291038,
    dot: 'warn',
    interval: 19,
    banner: { tone: 'warn', act: 'retry', text: '需要你本人处理一次：登录时要求输入图形验证码，工具已停止这个账号的自动重登。请到官方客户端登录一次，完成后回来点「重试登录」。', btn: '重试登录' },
    emptyText: '需人工处理期间不拉取列表——先在官方客户端完成一次验证，再点上方「重试登录」',
    pcs: [],
    logs: [
      { t: '09:12:40', lv: 'ERROR', mod: '账号', msg: '186****5140 登录被要求图形验证码（code=51085），工具不做自动重试，等待人工在官方客户端完成一次验证' },
    ],
  },
]

/** 无账号归属的条目：默认不显示，打开「包含系统日志」才并入 */
const SYSLOGS_SEED: RawLog[] = [
  { t: '09:00:12', lv: 'INFO', mod: '系统', msg: '应用启动 · 载入 4 个账号 · 恢复 6 条自动保活计划' },
  { t: '09:00:05', lv: 'INFO', mod: '系统', msg: '按「日志保留 7 天」清理了 2 个超期日志文件' },
]

/* 与交互稿一致：全部种子日志按时间升序统一赋 seq */
;(function assignSeq() {
  const all: RawLog[] = [...SYSLOGS_SEED]
  ACCOUNTS_SEED.forEach((a) => all.push(...a.logs))
  all.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0))
  all.forEach((r) => {
    ;(r as LogEntry).seq = ++SEQ
  })
})()

export function seedAccounts(): Account[] {
  return structuredClone(ACCOUNTS_SEED) as Account[]
}

export function seedSyslogs(): LogEntry[] {
  return structuredClone(SYSLOGS_SEED) as LogEntry[]
}

export function seedPointTasks(): PointTask[] {
  return [
    {
      name: '登录AI云电脑',
      reward: 100,
      progressText: '1 / 1 次',
      ratio: 1,
      progressTip: '接口进度：currentProgress 1 / totalProgress 1',
      status: 'done',
      doneLabel: '今日已完成，明日 00:00 后重置',
      busy: false,
      auto: true,
    },
    {
      name: '使用1小时',
      reward: 100,
      /* 进度由被占用的实例（link）推导：total - 剩余，与倒计时同源 */
      progressText: null,
      ratio: null,
      progressTip: '接口进度：currentProgress 1452 秒 / totalProgress 3600 秒，官方累计',
      status: 'running',
      doneLabel: '',
      busy: false,
      auto: true,
    },
    {
      name: '与AI对话1次',
      reward: 100,
      progressText: '0 / 1 次',
      ratio: 0,
      progressTip: '接口进度：currentProgress 0 / totalProgress 1',
      status: 'idle',
      doneLabel: '',
      busy: false,
      auto: true,
    },
  ]
}

/* 新账号的实例开关一律默认关闭——这是已确认口径，不是演示取巧 */
export function demoPcs() {
  const rid = () => 'ecd-' + Math.random().toString(16).slice(2, 8)
  return [
    { name: '云电脑 1', id: rid(), os: 'Windows', run: 'running' as const, auto: false, left: null, last: '尚未保活' },
    { name: '云电脑 2', id: rid(), os: 'Windows', run: 'stopped' as const, auto: false, left: null, last: '—' },
  ]
}

/**
 * 演示用的 userId 表：真实实现里这个值只能取登录响应里的 userId，绝不本地推算。
 * 同一个人用手机号或邮箱登录会拿到同一个 userId，这张表把那种情况也演出来。
 */
const UID_BOOK: Record<string, number> = {
  '13800006021': 41288301,
  'demo6021@189.cn': 41288301,
  '15900003374': 41288712,
  '17700008802': 41290455,
  '18600005140': 41291038,
}
let uidSeed = 41300000
export function demoUid(acct: string): number {
  if (!UID_BOOK[acct]) UID_BOOK[acct] = ++uidSeed
  return UID_BOOK[acct]
}
