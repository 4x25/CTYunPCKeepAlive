/**
 * 配置文件持久化（backend-design §7.1）：
 *   ~/.ctyun-pc-keep-alive/config.json
 *
 * - 整条增删改后原子覆盖写盘（同目录 tmp + rename）
 * - 文件权限 0600，目录 0700
 * - 只持久化凭据、间隔、时间窗口、实例/任务 auto 开关与 Tab 顺序
 * - 会话密钥 / JWT / 运行期展示数据一律不落盘
 */
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

export const CONFIG_DIR = path.join(os.homedir(), '.ctyun-pc-keep-alive')
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
export const LOG_DIR = path.join(CONFIG_DIR, 'log')

const PointsWindowSchema = z.object({
  winStart: z.string(),
  winEnd: z.string(),
})

const DesktopSwitchSchema = z.object({
  desktopId: z.string(),
  auto: z.boolean(),
})

const TaskSwitchSchema = z.object({
  taskDefId: z.number().int(),
  auto: z.boolean(),
})

const PersistedAccountSchema = z.object({
  userId: z.number().int().positive(),
  userAccount: z.string().min(1),
  password: z.string().min(1),
  alias: z.string().default(''),
  interval: z.number().int().min(1).max(59),
  pointsWindow: PointsWindowSchema,
  desktops: z.array(DesktopSwitchSchema).default([]),
  tasks: z.array(TaskSwitchSchema).default([]),
})

const PersistedConfigSchema = z.object({
  version: z.number().int(),
  accounts: z.array(PersistedAccountSchema),
})

export type PersistedAccount = z.infer<typeof PersistedAccountSchema>
export type PersistedConfig = z.infer<typeof PersistedConfigSchema>

export interface LoadConfigResult {
  config: PersistedConfig
  /** 载入异常（已脱敏，可写系统日志）；正常为 null */
  error: string | null
}

function emptyConfig(): PersistedConfig {
  return { version: 1, accounts: [] }
}

/** 同一 userId 只保留最后一次出现（历史手工编辑容错），顺序按最后一次出现的位置 */
function dedupeAccounts(accounts: PersistedAccount[]): PersistedAccount[] {
  const lastIndex = new Map<number, number>()
  accounts.forEach((account, index) => lastIndex.set(account.userId, index))
  return accounts.filter((account, index) => lastIndex.get(account.userId) === index)
}

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 })
  /* 目录可能由旧版本/手工创建：权限收紧失败不阻断，写入时仍强制文件 0600 */
  await chmod(CONFIG_DIR, 0o700).catch(() => undefined)
  await chmod(LOG_DIR, 0o700).catch(() => undefined)
}

export async function loadConfig(): Promise<LoadConfigResult> {
  await ensureConfigDir()
  let text: string
  try {
    text = await readFile(CONFIG_PATH, 'utf8')
    /* 旧文件权限可能是 0644：载入即收紧到 0600 */
    await chmod(CONFIG_PATH, 0o600).catch(() => undefined)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { config: emptyConfig(), error: null }
    return { config: emptyConfig(), error: '配置文件读取失败' }
  }

  try {
    const raw = JSON.parse(text) as unknown
    const parsed = PersistedConfigSchema.safeParse(raw)
    if (!parsed.success) {
      await backupCorruptConfig(text)
      return { config: emptyConfig(), error: '配置文件格式不正确，已备份并重置为空配置' }
    }
    if (parsed.data.version !== 1) {
      await backupCorruptConfig(text)
      return { config: emptyConfig(), error: `配置文件版本 ${parsed.data.version} 不受支持，已备份并重置为空配置` }
    }
    return { config: { ...parsed.data, accounts: dedupeAccounts(parsed.data.accounts) }, error: null }
  } catch {
    await backupCorruptConfig(text)
    return { config: emptyConfig(), error: '配置文件不是合法 JSON，已备份并重置为空配置' }
  }
}

/** 损坏备份保留的最近份数 */
const BAD_BACKUP_KEEP = 2

async function backupCorruptConfig(text: string): Promise<void> {
  try {
    const target = `${CONFIG_PATH}.bad-${Date.now()}`
    await writeFile(target, text, { mode: 0o600 })
    /* 只保留最近 BAD_BACKUP_KEEP 份 .bad-* 备份 */
    const entries = await readdir(CONFIG_DIR)
    const badFiles = entries.filter((name) => name.startsWith('config.json.bad-')).sort()
    for (const name of badFiles.slice(0, Math.max(0, badFiles.length - BAD_BACKUP_KEEP))) {
      await unlink(path.join(CONFIG_DIR, name)).catch(() => undefined)
    }
  } catch {
    /* 备份失败不阻断启动 */
  }
}

let writeQueue: Promise<void> = Promise.resolve()

/** 串行原子写：tmp 文件 0600 → rename（避免并发写互相覆盖/半文件） */
async function writeConfigAtomic(config: PersistedConfig): Promise<void> {
  await ensureConfigDir()
  const tmp = path.join(CONFIG_DIR, `.config.json.${process.pid}.${Date.now()}.tmp`)
  const body = `${JSON.stringify(config, null, 2)}\n`
  await writeFile(tmp, body, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, CONFIG_PATH)
  await chmod(CONFIG_PATH, 0o600)
}

export function saveConfig(config: PersistedConfig): Promise<void> {
  const run = writeQueue.then(() => writeConfigAtomic(config))
  /* 失败不能把队列打断：下一个写操作仍应执行 */
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function saveEmptyConfig(): Promise<void> {
  await saveConfig(emptyConfig())
}
