/**
 * 配置文件持久化。
 *
 * - 原子写：临时文件 + rename
 * - 平台 appdata 路径
 * - 明文密码（需求稿明确：能读到这个文件的人就能拿到账号）
 */

export interface AccountConfig {
  /** 登录账号（手机号或邮箱） */
  account: string;
  /** 明文密码 */
  password: string;
  /** 用户自定义别名（可选） */
  alias?: string;
  /**
   * Web 设备代码（`web_` + 32 位随机）。
   *
   * 必须在首次登录后持久化并长期复用 —— 每次重新生成会被服务端视为
   * 新客户端，反复触发设备绑定校验。
   */
  deviceCode?: string;
  /** IAM 设备代码（`iam:` + 32 位随机）。同样必须长期复用。 */
  eaiDeviceCode?: string;
  /** 云智助手 Web 标识（`pubweb_` + UUID v4）。参与每个请求的 `x-eai-xuid`。 */
  eaiXuid?: string;
  /** 设备保活配置，key 是 objId */
  devices: Record<string, DeviceConfig>;
}

export interface DeviceConfig {
  /** 是否开启自动保活 */
  autoKeepalive: boolean;
  /** 保活间隔（分钟），1-59 */
  intervalMinutes: number;
}

/** 积分任务设置（每账号一份）。 */
export interface PointsConfig {
  /** 时间窗开始（分钟数，0–1439）。 */
  windowStartMinutes: number;
  /** 时间窗结束（分钟数，0–1439）。 */
  windowEndMinutes: number;
  /** 已开启自动执行的任务定义 ID。 */
  autoTasks: number[];
  /** 1 小时任务使用的设备 objId；未指定时取第一台运行中的设备。 */
  usageObjId?: string;
}

/** 时间窗默认值：09:00–11:30。 */
export const DEFAULT_POINTS_CONFIG: PointsConfig = {
  windowStartMinutes: 9 * 60,
  windowEndMinutes: 11 * 60 + 30,
  autoTasks: [],
};

export interface Config {
  version: 1;
  accounts: AccountConfig[];
  /** 积分设置，key 是账号。 */
  points?: Record<string, PointsConfig>;
}

const DEFAULT_CONFIG: Config = {
  version: 1,
  accounts: [],
};

/** 平台相关的配置目录 */
function getConfigDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) throw new Error("无法确定用户主目录");

  switch (Deno.build.os) {
    case "windows":
      return `${Deno.env.get("APPDATA") ?? `${home}\\AppData\\Roaming`}\\CTYunPCKeepAlive`;
    case "darwin":
      return `${home}/Library/Application Support/CTYunPCKeepAlive`;
    default: // linux
      return `${Deno.env.get("XDG_CONFIG_HOME") ?? `${home}/.config`}/ctyun-pc-keepalive`;
  }
}

function getConfigPath(): string {
  return `${getConfigDir()}/config.json`;
}

/** 原子写：先写临时文件，成功后 rename */
async function atomicWrite(path: string, content: string): Promise<void> {
  const dir = path.substring(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });

  const tmp = `${path}.tmp.${Date.now()}`;
  await Deno.writeTextFile(tmp, content);
  await Deno.rename(tmp, path);
}

/** 加载配置，文件不存在时返回默认值 */
export async function loadConfig(): Promise<Config> {
  try {
    const text = await Deno.readTextFile(getConfigPath());
    const config = JSON.parse(text) as Config;
    if (config.version !== 1) {
      throw new Error(`不支持的配置版本：${config.version}`);
    }
    return config;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return DEFAULT_CONFIG;
    }
    throw err;
  }
}

/** 保存配置（原子写） */
export async function saveConfig(config: Config): Promise<void> {
  const text = JSON.stringify(config, null, 2);
  await atomicWrite(getConfigPath(), text);
}

/** 供外部获取配置路径（用于导出/导入提示） */
export function getConfigPathForDisplay(): string {
  return getConfigPath();
}
