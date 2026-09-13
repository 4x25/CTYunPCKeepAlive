/**
 * 报文密钥协商：`getServData` → `negotiationEncKey`。
 *
 * 依据 `docs/ctyun-account-auth-api.md` §4。
 *
 * 这两个接口发生在通用 AES 建立之前，因此**本身不是** `data`/`edata` 包装。
 *
 * 产物 `eid` / `evalue` / 临时 RSA 私钥只存在于内存，绝不持久化。协商失败时
 * 不得回退复用旧 `evalue` —— 应回到初始化错误处理。
 */
import { aesCbcDecrypt, generateNegotiationKeyPair, rsaPkcs1v15Decrypt } from "./crypto.ts";
import type { ApiEnvelope, CtyunClient, NegotiatedKey } from "./envelope.ts";
import { CtyunApiError } from "./envelope.ts";

export interface ServData {
  globalSwitches?: { bodyMsgEType?: string[] };
  serverNodeId?: string;
}

/** 发现服务端支持的报文加密类型。Web 客户端固定选 `"2"`（AES-CBC）。 */
export async function getServData(client: CtyunClient): Promise<ServData> {
  const path = "/api/cdserv/client/getServData";
  const res = await fetchPlain(client, path, { method: "GET" });
  const env = JSON.parse(res) as ApiEnvelope<ServData>;
  if (env.code !== 0) {
    throw new CtyunApiError(env.code, env.msg ?? "getServData 失败", path);
  }
  return env.data ?? {};
}

interface NegotiationResponse {
  encKey: string;
  encData: string;
}

/**
 * 协商本次进程使用的 AES 密钥。
 *
 * 解密链路（每一步的编码都不能省）：
 * 1. Base64 解 `encKey` → RSAES-PKCS#1 v1.5 私钥解密 → UTF-8 字符串 = 中间 AES key
 * 2. 该字符串的 UTF-8 字节作 key，AES-CBC 零 IV 解 Base64 `encData`
 * 3. 明文 JSON 含 `eid` / `evalue`
 * 4. 后续业务报文用 `evalue` 的 UTF-8 字节作 AES key
 *
 * 注意第 1 步是 PKCS#1 v1.5：虽然密钥按 RSA-OAEP 参数生成，线上实现却把私钥
 * 交给 JSEncrypt 兼容实现按 PKCS#1 块格式解密。不要因为参数名就调 OAEP。
 */
export async function negotiateEncKey(client: CtyunClient): Promise<NegotiatedKey> {
  const path = "/api/auth/client/negotiationEncKey";
  const keyPair = generateNegotiationKeyPair();

  const raw = await fetchPlain(client, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      etype: "2",
      certType: "2",
      certData: keyPair.publicKeySpkiBase64,
    }),
  });

  const env = JSON.parse(raw) as ApiEnvelope<NegotiationResponse>;
  if (env.code !== 0 || !env.data) {
    throw new CtyunApiError(env.code, env.msg ?? "密钥协商失败", path);
  }

  const intermediate = rsaPkcs1v15Decrypt(keyPair.privateKey, env.data.encKey);
  const intermediateKey = new TextEncoder().encode(new TextDecoder().decode(intermediate));

  const negotiated = JSON.parse(aesCbcDecrypt(intermediateKey, env.data.encData)) as {
    eid: string;
    evalue: string;
  };

  if (!negotiated.eid || !negotiated.evalue) {
    throw new CtyunApiError(-1, "密钥协商响应缺少 eid/evalue", path);
  }

  return {
    eid: negotiated.eid,
    evalue: new TextEncoder().encode(negotiated.evalue),
  };
}

/** 完整协商流程，成功后写入 client。 */
export async function establishSession(client: CtyunClient): Promise<NegotiatedKey> {
  await getServData(client);
  const key = await negotiateEncKey(client);
  client.setNegotiatedKey(key);
  return key;
}

/** 明文接口请求：带 CTG 基础头但无 `CTG-NEGO-EKEYID` / 签名。 */
async function fetchPlain(
  client: CtyunClient,
  path: string,
  init: RequestInit,
): Promise<string> {
  const d = client.device;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json, text/plain, */*");
  headers.set("CTG-APPMODEL", d.appModel);
  headers.set("CTG-DEVICECODE", d.deviceCode);
  headers.set("CTG-DEVICETYPE", d.deviceType);
  headers.set("CTG-REQUESTID", client.nextRequestId());
  headers.set("CTG-SOFTWARECODE", d.softwareCode);
  headers.set("CTG-TIMESTAMP", String(Date.now()));
  headers.set("CTG-VERSION", d.clientVersion);

  const res = await client.fetchForPlain(client.origin + path, { ...init, headers });
  if (!res.ok) throw new CtyunApiError(-1, `HTTP ${res.status} ${res.statusText}`, path);
  return await res.text();
}
