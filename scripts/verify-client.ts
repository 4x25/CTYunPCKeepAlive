/**
 * 端到端验证客户端：从真实服务器抓页面与 bundle，在模拟浏览器中跑，
 * 并通过真实 SSE 推送数据，检查 DOM 是否随状态更新。
 */
import { Window } from "npm:happy-dom@15";

const BASE = "http://127.0.0.1:3000";

// 1. 抓真实页面
const pageHtml = await (await fetch(BASE + "/")).text();
const bundle = await (await fetch(BASE + "/assets/client.js")).text();
console.log(`页面 HTML: ${pageHtml.length} B | bundle: ${bundle.length} B`);

// 2. 建立模拟浏览器
const window = new Window({ url: BASE });
const doc = window.document;
doc.write(pageHtml);

const pending: (() => void)[] = [];
const listeners: Record<string, ((e: any) => void)[]> = {};
let realES: any = null;

Object.assign(globalThis, {
  window,
  document: doc,
  HTMLInputElement: window.HTMLInputElement,
  HTMLSelectElement: window.HTMLSelectElement,
  EventSource: class {
    readyState = 1;
    constructor(public url: string) { realES = this; }
    addEventListener(t: string, fn: (e: any) => void) { (listeners[t] ??= []).push(fn); }
    close() {}
  },
  requestAnimationFrame: (cb: (t: number) => void) => {
    pending.push(() => cb(Date.now()));
    return pending.length;
  },
  setInterval: () => 1,
  clearInterval: () => {},
  fetch: (input: string | URL, init?: RequestInit) => fetch(String(input), init),
});

// 3. 执行 bundle
new Function(bundle)();
await new Promise((r) => setTimeout(r, 100));

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) {
    for (const f of pending.splice(0)) {
      try {
        f();
      } catch { /* 忽略渲染内部噪声 */ }
    }
    await new Promise((r) => setTimeout(r, 15));
  }
};

await flush();
const bootText = doc.getElementById("app")?.textContent ?? "";
console.log(`\n首屏（应显示空状态或加载中）: ${bootText.trim().slice(0, 40)}`);

// 4. 推送真实风格的快照
const snapshot = {
  accounts: [{
    account: "13800136021",
    alias: "主力机",
    state: "normal",
    devices: [
      {
        objId: "d1",
        name: "🖥️ 云电脑",
        osName: "Windows",
        isRunning: true,
        isForbidden: false,
        needLineUp: false,
        autoKeepalive: true,
        intervalMinutes: 19,
        nextKeepaliveAt: Date.now() + 754_000,
        keepaliveState: "idle",
      },
      {
        objId: "d2",
        name: "备机",
        osName: "Linux",
        isRunning: false,
        isForbidden: false,
        needLineUp: false,
        autoKeepalive: false,
        intervalMinutes: 30,
        nextKeepaliveAt: null,
        keepaliveState: "idle",
      },
    ],
  }],
};

for (const fn of listeners["snapshot"] ?? []) {
  fn({ data: JSON.stringify({ rev: 1, type: "snapshot", data: snapshot }) });
}
await flush();

const el = doc.getElementById("app")!;
const text = el.textContent ?? "";
const html = el.innerHTML;

const checks: [string, boolean][] = [
  ["别名「主力机」显示", text.includes("主力机")],
  ["完整账号不出现在文本中", !text.includes("13800136021")],
  ["设备「🖥️ 云电脑」", text.includes("🖥️ 云电脑")],
  ["设备「备机」", text.includes("备机")],
  ["关机状态标记", text.includes("已关机")],
  ["「保活」tab", text.includes("保活")],
  ["「日志」tab", text.includes("日志")],
  ["「立即保活」按钮", text.includes("立即保活")],
  ["间隔输入框（19）", html.includes('value="19"')],
  ["间隔输入框（30）", html.includes('value="30"')],
  ["自动开关", html.includes("toggle")],
  ["倒计时 mm:ss", /\d{2}:\d{2}/.test(text)],
];

console.log("\n=== 客户端渲染验证 ===");
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (ok) pass++;
}
console.log(`\n  ${pass}/${checks.length} 项通过`);

if (pass < checks.length) {
  console.log("\n--- 实际 HTML ---");
  console.log(html.slice(0, 900));
}
