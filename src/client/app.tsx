/**
 * 客户端：SSE 订阅 + 状态渲染 + 交互。
 *
 * - 使用 `hono/jsx/dom` 做增量更新（按 key 复用 DOM，不整体替换）
 * - 倒计时纯本地 `setInterval` 计算，不占 SSE 带宽
 * - 日志走独立的环形缓冲，不触发整页重渲染
 */
import { render, useState, useEffect } from "jsr:@hono/hono/jsx/dom";

// ── 类型（与服务端 state.ts 保持一致）──────────────────────────
type AccountState = "normal" | "logging-in" | "login-failed" | "intervention-required";
type KeepaliveState = "idle" | "running" | "success" | "failed";

interface DeviceSnapshot {
  objId: string;
  name: string;
  osName?: string;
  isRunning: boolean;
  isForbidden: boolean;
  needLineUp: boolean;
  autoKeepalive: boolean;
  intervalMinutes: number;
  nextKeepaliveAt: number | null;
  keepaliveState: KeepaliveState;
  lastKeepaliveAt?: number;
  lastKeepaliveDuration?: number;
  lastKeepaliveError?: string;
}

interface AccountSnapshot {
  account: string;
  alias?: string;
  state: AccountState;
  error?: string;
  interventionKind?: string;
  devices: DeviceSnapshot[];
}

interface GlobalState {
  accounts: AccountSnapshot[];
}

interface LogEntry {
  timestamp?: number;
  ts?: number;
  level: string;
  module: string;
  object?: string;
  message: string;
}

// ── 应用状态 ────────────────────────────────────────────────
let appState: GlobalState = { accounts: [] };
const logBuffer: LogEntry[] = [];
const MAX_LOGS = 500;
let serverRev = 0;
let subscribers: Array<() => void> = [];

/** 版本号驱动重渲染。顶层组件订阅它，每次状态替换后自增。 */
let stateVersion = 0;

function notify() {
  stateVersion++;
  for (const fn of subscribers) fn();
}

/** 供调试与测试：当前是否已挂载订阅者。 */
export function subscriberCount(): number {
  return subscribers.length;
}

// ── SSE ────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource("/api/stream");

  const handle = (e: MessageEvent) => {
    const payload = JSON.parse(e.data) as { rev: number; type: string; data: unknown };

    if (serverRev !== 0 && payload.rev !== serverRev + 1) {
      console.warn(`SSE rev 跳变：${serverRev} → ${payload.rev}（事件可能丢失）`);
    }
    serverRev = payload.rev;

    if (payload.type === "snapshot") {
      appState = payload.data as GlobalState;
      notify();
    } else if (payload.type === "log") {
      logBuffer.push(payload.data as LogEntry);
      if (logBuffer.length > MAX_LOGS) logBuffer.shift();
    }
  };

  es.addEventListener("snapshot", handle);
  es.addEventListener("log", handle);

  es.addEventListener("error", () => {
    console.warn("SSE 断开，5 秒后重连");
    es.close();
    setTimeout(connectSSE, 5000);
  });
}

// ── 订阅 hook ────────────────────────────────────────────────
/**
 * 订阅服务端状态。
 *
 * 用自增的本地计数驱动 `useState` —— 直接传 `appState` 会因为对象引用
 * 相同而被跳过更新，传 `stateVersion` 又可能在同一批次里被合并。
 */
function useAppState(): GlobalState {
  const [, rerender] = useState(0);
  useEffect(() => {
    let n = 0;
    const fn = () => rerender(++n);
    subscribers.push(fn);
    return () => {
      subscribers = subscribers.filter((x) => x !== fn);
    };
  }, []);
  return appState;
}

// ── 工具 ────────────────────────────────────────────────────
/** 遮蔽账号：保留前 3 后 4。tab 与其 hover 是唯一显示完整账号的地方。 */
function maskAccount(account: string): string {
  if (account.includes("@")) {
    const [user = "", domain = ""] = account.split("@", 2);
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return account.length > 7 ? `${account.slice(0, 3)}****${account.slice(-4)}` : account;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const LEVEL_STYLE: Record<string, string> = {
  DEBUG: "text-base-content/40",
  INFO: "text-info",
  WARN: "text-warning",
  ERROR: "text-error",
};

// ── 倒计时（本地每秒计算，只更新自己的文本节点）────────────────
function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span class="tabular-nums text-sm">{formatCountdown(at - now)}</span>;
}

// ── 主应用 ────────────────────────────────────────────────────
function App() {
  const s = useAppState();
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"keepalive" | "logs">("keepalive");
  const [adding, setAdding] = useState(false);

  // 选中账号失效时回退到第一个
  const activeAccount = s.accounts.find((a) => a.account === selected) ?? s.accounts[0] ?? null;

  return (
    <div class="min-h-screen">
      <header class="border-b border-base-content/10 px-4 py-3 flex items-center gap-3">
        <h1 class="text-lg font-semibold">天翼云电脑保活</h1>
        <div class="flex-1" />
        <a
          class="btn btn-ghost btn-sm"
          href="https://github.com/4x25/CTYunPCKeepAlive"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </header>

      {s.accounts.length === 0
        ? <EmptyState onAdd={() => setAdding(true)} />
        : (
          <>
            <AccountTabs
              accounts={s.accounts}
              active={activeAccount?.account ?? null}
              onSelect={setSelected}
              onAdd={() => setAdding(true)}
            />
            {activeAccount && (
              <main class="p-4">
                <div role="tablist" class="tabs tabs-border mb-4">
                  <button
                    role="tab"
                    class={`tab ${tab === "keepalive" ? "tab-active" : ""}`}
                    onclick={() => setTab("keepalive")}
                  >
                    保活
                  </button>
                  <button
                    role="tab"
                    class={`tab ${tab === "logs" ? "tab-active" : ""}`}
                    onclick={() => setTab("logs")}
                  >
                    日志
                  </button>
                </div>
                {tab === "keepalive"
                  ? <KeepalivePanel account={activeAccount} />
                  : <LogPanel />}
              </main>
            )}
          </>
        )}

      {adding && <AddAccountDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

// ── 零账号空状态 ────────────────────────────────────────────
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div class="flex flex-col items-center justify-center py-32 gap-4">
      <p class="text-base-content/60">还没有添加任何账号</p>
      <button class="btn btn-primary" onclick={onAdd}>添加账号</button>
    </div>
  );
}

// ── 账号 tab 条 ────────────────────────────────────────────
function AccountTabs(
  { accounts, active, onSelect, onAdd }: {
    accounts: AccountSnapshot[];
    active: string | null;
    onSelect: (a: string) => void;
    onAdd: () => void;
  },
) {
  return (
    <nav class="flex items-center gap-1 px-4 py-2 border-b border-base-content/10 overflow-x-auto">
      {accounts.map((a) => {
        // 有别名只显示别名；无别名显示完整账号
        const label = a.alias || a.account;
        const hoverText = a.alias ? `${a.account}\n${a.alias}` : a.account;
        return (
          <button
            key={a.account}
            title={hoverText}
            onclick={() => onSelect(a.account)}
            class={`btn btn-sm gap-2 shrink-0 ${
              active === a.account ? "btn-primary" : "btn-ghost"
            }`}
          >
            <span class={`inline-block w-2 h-2 rounded-full ${STATE_DOT[a.state]}`} />
            <span>{label}</span>
          </button>
        );
      })}
      <button class="btn btn-sm btn-ghost shrink-0" onclick={onAdd} title="添加账号">＋</button>
    </nav>
  );
}

const STATE_DOT: Record<AccountState, string> = {
  "normal": "bg-success",
  "logging-in": "bg-base-content/30",
  "login-failed": "bg-error",
  "intervention-required": "bg-warning",
};

const STATE_TEXT: Record<AccountState, string> = {
  "normal": "正常",
  "logging-in": "登录中",
  "login-failed": "登录失败",
  "intervention-required": "需人工处理",
};

// ── 保活面板 ────────────────────────────────────────────────
function KeepalivePanel({ account }: { account: AccountSnapshot }) {
  const [refreshing, setRefreshing] = useState(false);

  // 登录失败 / 需人工处理横幅
  const banner = account.state !== "normal" && account.state !== "logging-in"
    ? (
      <div
        class={`alert mb-4 ${
          account.state === "login-failed" ? "alert-error" : "alert-warning"
        }`}
      >
        <div>
          <div class="font-medium">{STATE_TEXT[account.state]}</div>
          <div class="text-sm opacity-80">
            {account.error ?? account.interventionKind ?? "该账号下所有自动任务已挂起"}
          </div>
        </div>
      </div>
    )
    : null;

  if (!refreshing && account.devices.length === 0) {
    return (
      <div>
        {banner}
        <div class="text-center py-16 text-base-content/60">该账号下没有云电脑</div>
      </div>
    );
  }

  return (
    <div>
      {banner}
      <div class="flex items-center gap-2 mb-3">
        <span class="text-sm text-base-content/60">
          共 {account.devices.length} 台设备
        </span>
        <div class="flex-1" />
        <button
          class="btn btn-sm btn-ghost"
          disabled={refreshing}
          onclick={async () => {
            setRefreshing(true);
            await api.refreshDevices(account.account).catch(() => {});
            setRefreshing(false);
          }}
        >
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>

      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>设备</th>
              <th>状态</th>
              <th class="w-32">间隔（分钟）</th>
              <th class="w-24">下次保活</th>
              <th class="w-28">操作</th>
              <th class="w-20">自动</th>
            </tr>
          </thead>
          <tbody>
            {account.devices.map((d) => (
              <DeviceRow key={d.objId} account={account.account} device={d} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 设备行 ────────────────────────────────────────────────
function DeviceRow({ account, device }: { account: string; device: DeviceSnapshot }) {
  const [interval, setIntervalValue] = useState(device.intervalMinutes);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setIntervalValue(device.intervalMinutes), [device.intervalMinutes]);

  const disabled = !device.isRunning || device.isForbidden;

  // 状态胶囊
  let statusBadge = <span class="badge badge-ghost badge-sm">未知</span>;
  if (device.isForbidden) statusBadge = <span class="badge badge-ghost badge-sm">不可用</span>;
  else if (!device.isRunning) {
    statusBadge = <span class="badge badge-ghost badge-sm">{device.name ? "已关机" : "已关机"}</span>;
  } else if (device.keepaliveState === "running") {
    statusBadge = <span class="badge badge-info badge-sm">执行中</span>;
  } else if (device.keepaliveState === "failed") {
    statusBadge = <span class="badge badge-error badge-sm" title={device.lastKeepaliveError}>重试</span>;
  } else if (device.keepaliveState === "success") {
    statusBadge = <span class="badge badge-success badge-sm">成功</span>;
  } else if (device.needLineUp) {
    statusBadge = <span class="badge badge-warning badge-sm">需排队</span>;
  } else {
    statusBadge = <span class="badge badge-success badge-sm">运行中</span>;
  }

  async function commitInterval(raw: number) {
    const clamped = Math.max(1, Math.min(59, Math.round(raw)));
    if (clamped !== raw) {
      // 越界：钳制 + 短暂高亮
      setInvalid(true);
      setTimeout(() => setInvalid(false), 1000);
    }
    setIntervalValue(clamped);
    if (clamped !== device.intervalMinutes) {
      await api.updateInterval(account, device.objId, clamped).catch(() => {});
    }
  }

  return (
    <tr class={device.isForbidden ? "opacity-50" : ""}>
      <td>
        <div class="font-medium">{device.name}</div>
        {device.osName && <div class="text-xs text-base-content/50">{device.osName}</div>}
      </td>
      <td>{statusBadge}</td>
      <td>
        <input
          type="number"
          min="1"
          max="59"
          value={interval}
          disabled={disabled}
          class={`input input-xs w-20 tabular-nums ${
            invalid ? "input-error" : "input-bordered"
          }`}
          onInput={(e) => setIntervalValue(Number((e.target as HTMLInputElement).value))}
          onBlur={(e) => commitInterval(Number((e.target as HTMLInputElement).value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </td>
      <td>
        {device.nextKeepaliveAt
          ? <Countdown at={device.nextKeepaliveAt} />
          : <span class="text-base-content/30">—</span>}
      </td>
      <td>
        <button
          class="btn btn-xs"
          disabled={disabled || busy || device.keepaliveState === "running"}
          onclick={async () => {
            setBusy(true);
            await api.manualKeepalive(account, device.objId).catch(() => {});
            setTimeout(() => setBusy(false), 2000);
          }}
        >
          {device.keepaliveState === "running" ? "执行中" : busy ? "✓ 已触发" : "立即保活"}
        </button>
      </td>
      <td>
        <input
          type="checkbox"
          class="toggle toggle-sm toggle-primary"
          checked={device.autoKeepalive}
          disabled={disabled}
          onchange={(e) =>
            api.toggleAuto(account, device.objId, (e.target as HTMLInputElement).checked)
              .catch(() => {})}
        />
      </td>
    </tr>
  );
}

// ── 日志面板 ────────────────────────────────────────────────
function LogPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<string>("ALL");
  const [keyword, setKeyword] = useState("");

  useEffect(() => {
    const t = setInterval(() => setLogs([...logBuffer]), 500);
    return () => clearInterval(t);
  }, []);

  const filtered = logs.filter((l) => {
    if (level !== "ALL" && l.level !== level) return false;
    if (keyword && !l.message.includes(keyword)) return false;
    return true;
  });

  return (
    <div>
      <div class="flex items-center gap-2 mb-3">
        <select
          class="select select-xs select-bordered"
          value={level}
          onchange={(e) => setLevel((e.target as HTMLSelectElement).value)}
        >
          <option value="ALL">全部等级</option>
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>
        <input
          class="input input-xs input-bordered w-48"
          placeholder="关键字"
          value={keyword}
          onInput={(e) => setKeyword((e.target as HTMLInputElement).value)}
        />
        <div class="flex-1" />
        <span class="text-xs text-base-content/50">{filtered.length} 条</span>
      </div>

      <div class="font-mono text-xs max-h-[60vh] overflow-y-auto bg-base-200 rounded p-3 space-y-0.5">
        {filtered.length === 0
          ? <div class="text-base-content/40">暂无日志</div>
          : filtered.map((l, i) => (
            <div key={i} class="flex gap-2">
              <span class="text-base-content/40 shrink-0">
                {new Date(l.timestamp ?? l.ts ?? Date.now()).toTimeString().slice(0, 8)}
              </span>
              <span class={`shrink-0 w-12 ${LEVEL_STYLE[l.level] ?? ""}`}>{l.level}</span>
              <span class="text-base-content/50 shrink-0 w-12">[{l.module}]</span>
              <span class="break-all">{l.message}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

// ── 添加账号对话框 ────────────────────────────────────────────
function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [alias, setAlias] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    if (!account.trim()) return setError("请输入账号");
    if (!password) return setError("请输入密码");

    setBusy(true);
    setError("");
    try {
      await api.addAccount(account.trim(), password, alias.trim());
      onClose();
    } catch (err) {
      // 服务端错误走对话框内的提示，保留已填内容
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="modal modal-open">
      <div class="modal-box">
        <h3 class="font-bold text-lg mb-4">添加账号</h3>
        <form onsubmit={submit} class="space-y-3">
          <fieldset class="fieldset">
            <legend class="fieldset-legend">账号</legend>
            <input
              class={`input w-full ${error && !account.trim() ? "input-error" : ""}`}
              placeholder="手机号或邮箱"
              value={account}
              aria-invalid={!account.trim()}
              onInput={(e) => setAccount((e.target as HTMLInputElement).value)}
            />
          </fieldset>

          <fieldset class="fieldset">
            <legend class="fieldset-legend">密码</legend>
            <input
              type="password"
              class="input w-full"
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            />
          </fieldset>

          <fieldset class="fieldset">
            <legend class="fieldset-legend">别名（可选，最多 12 字）</legend>
            <input
              class="input w-full"
              maxlength={12}
              value={alias}
              onInput={(e) => setAlias((e.target as HTMLInputElement).value)}
            />
          </fieldset>

          {error && <div class="text-error text-sm">{error}</div>}

          <div class="modal-action">
            <button type="button" class="btn" onclick={onClose} disabled={busy}>取消</button>
            <button type="submit" class="btn btn-primary" disabled={busy}>
              {busy ? <span class="loading loading-spinner loading-sm" /> : "登录并添加"}
            </button>
          </div>
        </form>
      </div>
      <div class="modal-backdrop" onclick={onClose}></div>
    </div>
  );
}

// ── API ────────────────────────────────────────────────────
async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json() as { ok: boolean; error?: string };
  if (!json.ok) throw new Error(json.error ?? "请求失败");
}

const api = {
  addAccount: (account: string, password: string, alias: string) =>
    post("/api/accounts/add", { account, password, alias }),
  removeAccount: (account: string) => post("/api/accounts/remove", { account }),
  updateAlias: (account: string, alias: string) =>
    post("/api/accounts/update-alias", { account, alias }),
  refreshDevices: (account: string) => post("/api/devices/refresh", { account }),
  toggleAuto: (account: string, objId: string, enabled: boolean) =>
    post("/api/devices/toggle-auto", { account, objId, enabled }),
  updateInterval: (account: string, objId: string, minutes: number) =>
    post("/api/devices/update-interval", { account, objId, minutes }),
  manualKeepalive: (account: string, objId: string) =>
    post("/api/devices/keepalive", { account, objId }),
};

// ── 启动 ────────────────────────────────────────────────────
render(<App />, document.getElementById("app")!);
connectSSE();
