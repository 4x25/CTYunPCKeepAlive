/**
 * 设备列表组装单测：sortList 排序、云手机过滤、补拉、回退。
 */
import { assertEquals } from "@std/assert";
import { aesCbcEncrypt } from "./crypto.ts";
import { CtyunClient } from "./envelope.ts";
import { createDeviceContext } from "./device.ts";
import { listDesktops, type NormalDesktop, toEntry } from "./desktops.ts";

const EVALUE = new TextEncoder().encode("0123456789abcdef");
const AUTH = { userId: 1, tenantId: 1, secretKey: "SK", offsetTime: 0 };

function desktop(objId: string, over: Partial<NormalDesktop> = {}): NormalDesktop {
  return { objId, objName: `PC-${objId}`, objType: 0, useStatus: "25", ...over };
}

/** 按路径分派的 mock，返回加密信封。 */
function setup(routes: Record<string, (body: unknown) => unknown>) {
  const hits: string[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const path = new URL(String(input)).pathname;
    hits.push(path);
    const handler = routes[path];
    if (!handler) return Promise.resolve(new Response("no route", { status: 404 }));
    let logical: unknown = {};
    if (typeof init?.body === "string" && init.body.startsWith("{")) {
      logical = JSON.parse(init.body) as unknown;
    }
    const payload = { code: 0, data: handler(logical) };
    return Promise.resolve(
      new Response(JSON.stringify({ edata: aesCbcEncrypt(EVALUE, JSON.stringify(payload)) })),
    );
  };
  const client = new CtyunClient(createDeviceContext(), fetchImpl);
  client.setNegotiatedKey({ eid: "E", evalue: EVALUE });
  return { client, hits };
}

Deno.test("最终顺序以 sortList 为准，不用 desktopList 数组顺序", async () => {
  const { client } = setup({
    "/api/desktop/client/pageDesktop": () => ({
      // 故意与 sortList 顺序相反
      desktopList: [desktop("c"), desktop("b"), desktop("a")],
      sortList: [
        { objId: "a", objType: 0 },
        { objId: "b", objType: 0 },
        { objId: "c", objType: 0 },
      ],
    }),
  });
  const r = await listDesktops(client, AUTH);
  assertEquals(r.desktops.map((d) => d.objId), ["a", "b", "c"]);
});

Deno.test('云手机按 cloudMobileType === "2002" 过滤，不按 osType', async () => {
  const { client } = setup({
    "/api/desktop/client/pageDesktop": () => ({
      desktopList: [
        desktop("pc", { osType: "Windows", cloudMobileType: null }),
        desktop("phone", { osType: "Android", cloudMobileType: "2002", useStatus: "45" }),
        // osType 是 Android 但 cloudMobileType 不是 2002 → 仍算云电脑
        desktop("weird", { osType: "Android", cloudMobileType: null }),
      ],
      sortList: [
        { objId: "pc", objType: 0 },
        { objId: "phone", objType: 0 },
        { objId: "weird", objType: 0 },
      ],
    }),
  });
  const r = await listDesktops(client, AUTH);
  assertEquals(r.desktops.map((d) => d.objId), ["pc", "weird"]);
  assertEquals(r.cloudMobiles.map((d) => d.objId), ["phone"]);
});

Deno.test("sortList 未超过 getCnt 时不触发补拉", async () => {
  const { client, hits } = setup({
    "/api/desktop/client/pageDesktop": () => ({
      desktopList: [desktop("a")],
      sortList: [{ objId: "a", objType: 0 }],
    }),
  });
  await listDesktops(client, AUTH);
  assertEquals(hits.includes("/api/desktop/client/listDesktopByIds"), false);
});

Deno.test("超过 getCnt 时按 30 项分批补拉，并仍按初始 sortList 组装", async () => {
  const total = 65;
  const ids = Array.from({ length: total }, (_, i) => `d${String(i).padStart(2, "0")}`);
  const batches: number[] = [];

  const { client } = setup({
    "/api/desktop/client/pageDesktop": () => ({
      desktopList: ids.slice(0, 20).map((id) => desktop(id)),
      sortList: ids.map((objId) => ({ objId, objType: 0 })),
    }),
    "/api/desktop/client/listDesktopByIds": (body) => {
      const objIds = body as { data: string } | { objIds: { objId: string }[] };
      // body 已被 mock 解密前拦截，这里直接按顺序补足
      void objIds;
      const start = 20 + batches.reduce((a, b) => a + b, 0);
      const size = Math.min(30, total - start);
      batches.push(size);
      return {
        // 乱序返回，验证最终仍按 sortList 排
        desktopList: ids.slice(start, start + size).map((id) => desktop(id)).reverse(),
      };
    },
  });

  const r = await listDesktops(client, AUTH);
  assertEquals(batches, [30, 15], "45 个缺失项应分成 30 + 15 两批");
  assertEquals(r.desktops.length, total);
  assertEquals(r.desktops.map((d) => d.objId), ids, "顺序必须严格等于初始 sortList");
  assertEquals(r.unresolved, 0);
});

Deno.test("补拉单批失败只跳过该批，允许部分成功", async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `d${i}`);
  let call = 0;
  const fetchImpl: typeof fetch = (input, _init) => {
    const path = new URL(String(input)).pathname;
    let payload: unknown;
    if (path === "/api/desktop/client/pageDesktop") {
      payload = {
        code: 0,
        data: {
          desktopList: ids.slice(0, 20).map((id) => desktop(id)),
          sortList: ids.map((objId) => ({ objId, objType: 0 })),
        },
      };
    } else {
      call++;
      return Promise.resolve(new Response("boom", { status: 500 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ edata: aesCbcEncrypt(EVALUE, JSON.stringify(payload)) })),
    );
  };
  const client = new CtyunClient(createDeviceContext(), fetchImpl);
  client.setNegotiatedKey({ eid: "E", evalue: EVALUE });

  const r = await listDesktops(client, AUTH, { getCnt: 20 });
  assertEquals(call, 1);
  assertEquals(r.desktops.length, 20, "已取得的 20 台不应因补拉失败而失效");
  assertEquals(r.unresolved, 5);
});

Deno.test("pageDesktop 失败才回退 GET /list，且不合并两者结果", async () => {
  const hits: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const path = new URL(String(input)).pathname;
    hits.push(path);
    if (path === "/api/desktop/client/pageDesktop") {
      return Promise.resolve(new Response("down", { status: 503 }));
    }
    const payload = {
      code: 0,
      data: { desktopList: [desktop("legacy")], sortList: [{ objId: "legacy", objType: 0 }] },
    };
    return Promise.resolve(
      new Response(JSON.stringify({ edata: aesCbcEncrypt(EVALUE, JSON.stringify(payload)) })),
    );
  };
  const client = new CtyunClient(createDeviceContext(), fetchImpl);
  client.setNegotiatedKey({ eid: "E", evalue: EVALUE });

  const r = await listDesktops(client, AUTH);
  assertEquals(hits, ["/api/desktop/client/pageDesktop", "/api/desktop/client/list"]);
  assertEquals(r.usedFallback, true);
  assertEquals(r.desktops.map((d) => d.objId), ["legacy"]);
});

Deno.test("桌面池 / 抢占式条目跳过而非编造默认值", async () => {
  const { client } = setup({
    "/api/desktop/client/pageDesktop": () => ({
      desktopList: [desktop("normal")],
      desktopPoolList: [{ objId: "pool1" }],
      preemptionDesktopList: [{ objId: "pre1" }],
      sortList: [
        { objId: "pool1", objType: 1 },
        { objId: "normal", objType: 0 },
        { objId: "pre1", objType: 2 },
      ],
    }),
  });
  const r = await listDesktops(client, AUTH);
  assertEquals(r.desktops.map((d) => d.objId), ["normal"]);
  assertEquals(r.unresolved, 0, "非普通设备是主动跳过，不计入未解析");
});

Deno.test("toEntry 字段派生", () => {
  assertEquals(toEntry(desktop("a", { objName: "", desktopName: "回退名" })).name, "回退名");
  assertEquals(toEntry(desktop("a", { objName: "", desktopName: "" })).name, "(未命名)");
  assertEquals(toEntry(desktop("a", { useStatus: "25" })).isRunning, true);
  assertEquals(toEntry(desktop("a", { useStatus: "45" })).isRunning, false);
  // status:"OK" 不是开关机状态，不应影响判定
  assertEquals(toEntry(desktop("a", { useStatus: "45", status: "OK" })).isRunning, false);
  assertEquals(toEntry(desktop("a", { forbiddenConnect: true })).isForbidden, true);
  assertEquals(toEntry(desktop("a", { needLineUp: true })).needLineUp, true);
});
