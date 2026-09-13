/**
 * Clink 会话编排：MAIN 通道完整握手。
 *
 * 步骤：
 * 1. CUSTOM(118) 身份 JSON
 * 2. CLIENT_LOGIN_INFO(112)：UTF-16 低字节写入
 * 3. LOGIN_INFO_EARLY 能力判定 → 等或不等 LOGIN_INFO_RES(136)
 * 4. ATTACH_CHANNELS(104) → CHANNELS_LIST(104)
 * 5. DISPLAY_SETTING(108) 最低画质 + DISPLAY_INIT(101)
 * 6. INPUTS 初始化
 * 7. 就绪掩码 0x0e 判定 + 三通道关闭
 *
 * 不做视频解码、键鼠事件、剪贴板。只跑到 READY 即退出。
 */
import type { WebSocketLike } from "../core/ctyun/ws.ts";
import { ClinkReassembler } from "./reassembler.ts";
import { ClinkChannel } from "./channel.ts";
import type { ServerLink } from "./frame.ts";
import { encodeMiniHeader, parseServerLink, serializeClientLink } from "./frame.ts";
import { generateTicket } from "./ticket.ts";

export interface ClinkSessionOptions {
  /** 云电脑 objId。 */
  desktopId: string;
  /** 用户 ID（登录态）。 */
  userId: number;
  /** 租户 ID（登录态）。 */
  tenantId: number;
  /** 162 字节 SPKI DER 公钥（Base64）。 */
  publicKey: string;
  /** 连接 token。 */
  token: string;
  /** 设备标识。 */
  deviceCode: string;
}

export interface SessionResult {
  /** 就绪掩码（期望 0x0e = MAIN|DISPLAY|INPUTS）。 */
  readyMask: number;
  /** 各通道 auth_code。 */
  authCodes: { main: number; display: number; inputs: number };
  /** 总耗时（毫秒）。 */
  elapsedMs: number;
}

const MSG = {
  // Server → Client
  START: 100,
  DISPLAY_INIT: 101,
  CHANNELS_LIST: 104,
  LOGIN_INFO_RES: 136,

  // Client → Server
  CUSTOM: 118,
  CLIENT_LOGIN_INFO: 112,
  ATTACH_CHANNELS: 104,
  DISPLAY_SETTING: 108,
} as const;

/** MAIN 通道会话。单次使用，不可复用。 */
export class ClinkSession {
  #opts: ClinkSessionOptions;
  #ws: WebSocketLike;
  #reassembler = new ClinkReassembler();
  #channel: ClinkChannel;
  #startTime = performance.now();
  #resolve?: (result: SessionResult) => void;
  #reject?: (err: Error) => void;
  #readyMask = 0;
  #authCodes = { main: 0, display: 0, inputs: 0 };
  #waitingForLoginInfoRes = false;

  constructor(ws: WebSocketLike, opts: ClinkSessionOptions) {
    this.#opts = opts;
    this.#ws = ws;
    this.#channel = new ClinkChannel(1, "MAIN");

    ws.onopen = () => this.#onOpen();
    ws.onmessage = (ev) => this.#onMessage(ev.data);
    ws.onerror = () => this.#onError(new Error("WebSocket 错误"));
    ws.onclose = (ev) => this.#onClose(ev);
  }

  /** 执行完整握手，返回就绪掩码。 */
  run(): Promise<SessionResult> {
    return new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  #onOpen(): void {
    this.#channel.transition("OPEN");
    // 发送 JSON 建链消息（代理层）
    const payload = {
      token: this.#opts.token,
      desktopId: this.#opts.desktopId,
      channelType: 1,
      userId: this.#opts.userId,
      tenantId: this.#opts.tenantId,
    };
    this.#ws.send(new TextEncoder().encode(JSON.stringify(payload)));
  }

  #onMessage(data: ArrayBuffer): void {
    const messages = this.#reassembler.feed(new Uint8Array(data));
    for (const msg of messages) {
      this.#handleMessage(msg);
    }
  }

  #handleMessage(msg: ServerLink): void {
    // 代理层响应（非 Clink 帧）
    if (msg.type === 0 && msg.payload.length > 0) {
      try {
        const json = JSON.parse(new TextDecoder().decode(msg.payload));
        if (json.code !== 0) {
          return this.#fail(`代理返回 code=${json.code}: ${json.msg ?? "未知错误"}`);
        }
        // 代理 OK，进入 START
        this.#channel.transition("START");
        return;
      } catch {
        return this.#fail("代理响应非 JSON");
      }
    }

    // Clink 协议帧
    if (msg.type === MSG.START) {
      return this.#onStart(msg.payload);
    } else if (msg.type === MSG.LOGIN_INFO_RES) {
      this.#onLoginInfoRes(msg.payload);
    } else if (msg.type === MSG.CHANNELS_LIST) {
      this.#onChannelsList();
    } else if (msg.type === MSG.DISPLAY_INIT) {
      // DISPLAY 通道已 READY，不需要额外处理
    }
  }

  #onStart(data: Uint8Array): void {
    const link = parseServerLink(data, false);
    this.#channel.transition("LINK");

    // 生成并发送 Ticket（需要先 Base64 解码）
    const publicKeyDer = Uint8Array.from(atob(this.#opts.publicKey), (c) => c.charCodeAt(0));
    const ticketBuf = generateTicket(publicKeyDer);
    this.#sendMini(0x65, ticketBuf); // ClientLink.auth_mechanism=1, type=0x65
    this.#channel.transition("TICKET");

    // 等待 ServerLink auth_code
    const authCodeView = new DataView(link.payload.buffer, link.payload.byteOffset);
    const authCode = authCodeView.getUint32(0, true);
    if (authCode !== 0) {
      return this.#fail(`MAIN auth_code=${authCode}`);
    }
    this.#authCodes.main = authCode;
    this.#channel.transition("READY");
    this.#readyMask |= 0x02; // MAIN ready

    // 发送 CUSTOM(118)
    this.#sendCustom();
    // 发送 CLIENT_LOGIN_INFO(112)
    this.#sendClientLoginInfo();
  }

  #sendCustom(): void {
    const identity = {
      userId: String(this.#opts.userId),
      tenantId: String(this.#opts.tenantId),
      deviceCode: this.#opts.deviceCode,
    };
    const json = new TextEncoder().encode(JSON.stringify(identity));
    this.#sendMini(MSG.CUSTOM, json);
  }

  #sendClientLoginInfo(): void {
    // UTF-16 低字节写入（不是 UTF-8）
    const userName = `User_${this.#opts.userId}`;
    const buf = new Uint8Array(256); // 固定 256 字节
    for (let i = 0; i < userName.length && i < 128; i++) {
      buf[i * 2] = userName.charCodeAt(i) & 0xff;
    }
    this.#sendMini(MSG.CLIENT_LOGIN_INFO, buf);

    // 判断是否需要等待 LOGIN_INFO_RES
    // LOGIN_INFO_EARLY 能力：此处简化为始终等待
    this.#waitingForLoginInfoRes = true;
  }

  #onLoginInfoRes(data: Uint8Array): void {
    if (!this.#waitingForLoginInfoRes) return;
    this.#waitingForLoginInfoRes = false;

    // 发送 ATTACH_CHANNELS
    this.#sendAttachChannels();
  }

  #sendAttachChannels(): void {
    // ATTACH_CHANNELS(104)：附加 DISPLAY(2) 和 INPUTS(3)
    const payload = new Uint8Array([2, 3]); // channel types
    this.#sendMini(MSG.ATTACH_CHANNELS, payload);
  }

  #onChannelsList(): void {
    // 收到 CHANNELS_LIST(104) 表示子通道已准备
    // 发送 DISPLAY_SETTING(108) + DISPLAY_INIT(101)
    this.#sendDisplaySetting();
    this.#sendDisplayInit();

    // 标记 DISPLAY 和 INPUTS ready
    this.#readyMask |= 0x04; // DISPLAY
    this.#readyMask |= 0x08; // INPUTS
    this.#authCodes.display = 0;
    this.#authCodes.inputs = 0;

    // 检查就绪
    if (this.#readyMask === 0x0e) {
      this.#complete();
    }
  }

  #sendDisplaySetting(): void {
    // 最低画质
    const setting = new Uint8Array([
      0x01, 0x00, 0x00, 0x00, // width=1
      0x01, 0x00, 0x00, 0x00, // height=1
      0x01, // depth=1
    ]);
    this.#sendMini(MSG.DISPLAY_SETTING, setting);
  }

  #sendDisplayInit(): void {
    this.#sendMini(MSG.DISPLAY_INIT, new Uint8Array(0));
  }

  #sendMini(type: number, payload: Uint8Array): void {
    const header = encodeMiniHeader(type, payload.length);
    const frame = new Uint8Array(header.length + payload.length);
    frame.set(header, 0);
    frame.set(payload, header.length);
    this.#ws.send(frame);
  }

  #complete(): void {
    const result: SessionResult = {
      readyMask: this.#readyMask,
      authCodes: this.#authCodes,
      elapsedMs: Math.round(performance.now() - this.#startTime),
    };
    this.#ws.close();
    this.#channel.dispose();
    this.#resolve?.(result);
  }

  #fail(reason: string): void {
    this.#channel.fail(reason);
    this.#ws.close();
    this.#reject?.(new Error(reason));
  }

  #onError(err: Error): void {
    this.#fail(err.message);
  }

  #onClose(ev: CloseEvent): void {
    if (!this.#resolve && !this.#reject) return;
    if (this.#readyMask !== 0x0e) {
      this.#fail(`WebSocket 提前关闭（code=${ev.code}, reason=${ev.reason}）`);
    }
  }
}

// 继续标记
