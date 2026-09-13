import { unsafeWindow } from "$";
import dayjs from "dayjs";
import { memoize } from "lodash-es";
import nativeFunctions, { clearTimeout, setTimeout } from "./nativeFunctions";
import useLog from "../hooks/useLog";
import { ICTYun } from "../types/ctyun";
import useSettings from "../hooks/useSettings";

export const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function hookWindow(win = window) {
  // 移除遥测
  win.localStorage.setItem("ctct.disabled", "1");
  // 设置云电脑纵向列表展示
  win.localStorage.setItem("currentDirection", "1");
  win.Object.defineProperty(win, "innerWidth", {
    value: screen.width,
    writable: false,
    configurable: false,
  });
  win.Object.defineProperty(win, "innerHeight", {
    value: screen.height,
    writable: false,
    configurable: false,
  });
  win.ctct = win.ctct || {};
  Object.assign(win.ctct, {
    identify: () => {},
    init: () => {},
    track: () => {},
  });

  const originalPushState = win.history.pushState;
  const originalReplaceState = win.history.replaceState;

  win.history.pushState = function (...args) {
    const event = new CustomEvent("pushstate", { detail: { args } });
    win.dispatchEvent(event);
    return originalPushState.apply(this, args);
  };
  win.history.replaceState = function (...args) {
    const event = new CustomEvent("replacestate", { detail: { args } });
    win.dispatchEvent(event);
    return originalReplaceState.apply(this, args);
  };

  (
    ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] as const
  ).forEach((name) => {
    if (
      win[name].toString() !== nativeFunctions[name].toString() ||
      win[name].name !== nativeFunctions[name].name
    ) {
      try {
        Object.defineProperty(win, name, {
          value: nativeFunctions[name].bind(win),
          writable: false,
          configurable: false,
          enumerable: true,
        });
        useLog.getState().addLog(`[Success] ${name} 已恢复为原生版本并锁定`);
      } catch (e) {
        useLog
          .getState()
          .addLog(
            `[Error] 无法恢复 ${name}，可能是 configurable 被网页设为了 false`,
            (e as Error).message,
          );
      }
    }
  });
}

export interface IDesktopInfo {
  nickName: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  clientStrategy: number;
  clinkLvsInHost: string;
  clipBoardIn: boolean;
  clipBoardOut: boolean;
  desktopId: string;
  dragFileIn: boolean;
  dragFileOut: boolean;
  host: string;
  internalIp: string;
  internalPort: number;
  osName: string;
  osType: number;
  port: number;
  tenantMemberAccount: string;
  token: string;
}

function _keepalive(
  desktopInfo: IDesktopInfo,
  options: {
    /** 连接上后停留多久断开，@default 8000 (8s) */
    delay?: number;
  } = {},
): Promise<void> {
  const { delay = 8 * 1000 } = options;
  let instanceCTYun: ICTYun;
  return new Promise(async (resolve, reject) => {
    try {
      const config = {
        uri: `wss://${desktopInfo.clinkLvsInHost}/clinkProxy/${desktopInfo.desktopId}`,
        servername: `${desktopInfo.host}:${desktopInfo.port}`,
        host: desktopInfo.internalIp,
        port: desktopInfo.internalPort,
        cert: desktopInfo.clientCert,
        ca: desktopInfo.caCert,
        ssl: true,
        key: desktopInfo.clientKey,
        screen: {
          w: (unsafeWindow || window).innerWidth,
          h: (unsafeWindow || window).innerHeight,
        },
        desktopId: desktopInfo.desktopId,
        token: desktopInfo.token,
        deviceType: 60,
        deviceCode:
          localStorage.getItem("web_device_code") ||
          localStorage.getItem("web_phone_device_code"),
        osType: desktopInfo.osType,
        osName: desktopInfo.osName,
        userAccount: desktopInfo.tenantMemberAccount,
        clipBoardIn: desktopInfo.clipBoardIn,
        clipBoardOut: desktopInfo.clipBoardOut,
        dragFileIn: desktopInfo.dragFileIn,
        dragFileOut: desktopInfo.dragFileOut,
        clientStrategy: desktopInfo.clientStrategy,
        oqs: 0,
        flowChartConfig: 2,
        picUpperFrameRatio: 15,
        picQulity: 4,
        videoQulity: 3,
        subjpegQuality: 90,
        videoFrameRatio: 25,
      };
      useLog
        .getState()
        .addLog(`[1/6] 开始续命云电脑：【${desktopInfo.nickName}】`);
      instanceCTYun = (unsafeWindow || window).__APP__.clink;
      useLog.getState().addLog("[2/6] 已创建云电脑实例");

      const timer = setTimeout(
        () => {
          useLog.getState().addLog("[TIMEOUT] 完犊子，续命失败超时了！");
          instanceCTYun.stop();
          instanceCTYun.exit();
          reject(new Error("TIMEOUT"));
        },
        delay + 30 * 1000,
      );

      useLog.getState().addLog("[3/6] 云电脑前序停止");
      instanceCTYun.stop();
      useLog.getState().addLog("[4/6] 云电脑连接中...");
      instanceCTYun.run(config);
      await new Promise((resolve) => setTimeout(resolve, delay));
      useLog.getState().addLog("[5/6] 云电脑实例续命完成，开始清理实例");
      instanceCTYun.stop();
      instanceCTYun.exit();
      clearTimeout(timer);
      useLog.getState().addLog("[6/6] 云电脑续命流程结束");
      resolve();
    } catch (error) {
      useLog
        .getState()
        .addLog(`[ERROR] 云电脑续命流程异常：${(error as Error).message}`);
      reject(error);
    } finally {
      keepalive.cache.delete(desktopInfo.desktopId);
    }
  });
}

export const keepalive = memoize(
  _keepalive,
  (desktopInfo) => desktopInfo.desktopId,
);

export function doMission4(onLog = useLog.getState().addLog) {
  return new Promise<void>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("src", "https://eaichat.ctyun.cn/chat/#/aichat");
    iframe.setAttribute(
      "style",
      "position: fixed; top: 100vh; display: block; width: 1920px; height: 1080px;",
    );
    iframe.onload = async () => {
      iframe.onload = null;
      try {
        onLog("【AI任务】页面已加载，等待3秒后填写提问");
        await wait(3 * 1000);
        const location = iframe.contentWindow?.location;
        const document = iframe.contentWindow?.document;
        if (
          !location ||
          location.origin !== "https://eaichat.ctyun.cn" ||
          location.hash.startsWith("#/login")
        ) {
          useSettings.getState().setAutoMission4(false);
          throw new Error("未检测到登录信息");
        }
        const input = document?.querySelector<HTMLElement>(
          '.input-box[contenteditable="true"]',
        );
        if (!input) {
          throw new Error("未找到提问输入框");
        }
        const question = `${dayjs().format("YYYY年MM月DD日")}新闻`;
        input.innerText = question;
        onLog(`【AI任务】[2/3] 已填写提问：${question}，等待3秒后发送`);
        await wait(3 * 1000);
        const sendButton = document?.querySelector<HTMLElement>(
          ".iconfont-v3.icon-v3-fasong",
        );
        if (!sendButton) {
          throw new Error("未找到发送按钮");
        }
        sendButton.click();
        onLog("【AI任务】[3/3] 已点击发送按钮，等待3秒后清理页面");
        await wait(3 * 1000);
        onLog("【AI任务】提问发送流程完成");
        resolve();
      } catch (error) {
        onLog(`【AI任务】失败：${(error as Error).message}`);
        reject(error);
      } finally {
        iframe.remove();
        onLog("【AI任务】页面已清理");
      }
    };
    onLog("【AI任务】[1/3] 打开 https://eaichat.ctyun.cn/chat/#/aichat");
    document.body.appendChild(iframe);
  });
}
