import { randomBytes } from "node:crypto";
import type { IncomingMessage, ReplyJob } from "../shared/contracts.ts";
import type { Credentials } from "./storage.ts";

export const ILINK_BASE = "https://ilinkai.weixin.qq.com";
export function trustedWechatBase(input: string): string {
  const url = new URL(input.includes("://") ? input : `https://${input}`);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.search || url.hash || !["", "/"].includes(url.pathname) ||
      !(url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com"))) {
    throw new Error("Untrusted WeChat API host");
  }
  return url.origin;
}

// Scan JSON tokens before parsing, preserving uint64 IDs and text verbatim.
export function parseIlinkJson<T>(raw: string): T {
  let output = "", index = 0;
  while (index < raw.length) {
    if (raw[index] !== '"') { output += raw[index++]; continue; }
    const start = index++;
    while (index < raw.length) {
      if (raw[index++] === "\\") { index++; continue; }
      if (raw[index - 1] === '"') break;
    }
    const token = raw.slice(start, index);
    output += token;
    let next = index;
    while (/\s/.test(raw[next] ?? "")) next++;
    if (raw[next] !== ":" || !["message_id", "msg_id", "svr_id", "seq"].includes(JSON.parse(token))) continue;
    next++;
    while (/\s/.test(raw[next] ?? "")) next++;
    const integer = /^-?\d+(?=\s*[,}\]])/.exec(raw.slice(next));
    if (!integer) continue;
    output += raw.slice(index, next) + JSON.stringify(integer[0]);
    index = next + integer[0].length;
  }
  return JSON.parse(output) as T;
}

export class IlinkError extends Error {
  constructor(readonly code: string, readonly outcome: "retryable" | "failed" | "unknown",
              readonly detail = code) { super(code); }
}
export interface CdnMedia {
  encrypt_query_param?: string; aes_key?: string; full_url?: string; encrypt_type?: number;
}
export interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  image_item?: { media?: CdnMedia; aeskey?: string; mid_size?: number; hd_size?: number };
  file_item?: { media?: CdnMedia; file_name?: string; md5?: string; len?: string };
}
export interface WechatMessage {
  message_id?: string; from_user_id?: string; to_user_id?: string; create_time_ms?: number;
  context_token?: string; group_id?: string; message_type?: number; item_list?: MessageItem[];
}
export interface Updates { msgs?: WechatMessage[]; get_updates_buf?: string; longpolling_timeout_ms?:number }
export interface QrStatus {
  status: string; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string;
  baseurl?: string; redirect_host?: string;
}

export class IlinkClient {
  private pollTimeoutMs=35000;
  constructor(private readonly credentials?: Credentials, private readonly routeTag?: string,
              private readonly request = fetch, private readonly version='2.4.9') {
    if (credentials) trustedWechatBase(credentials.baseUrl);
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version) || version.split('.').some(n=>Number(n)>255)) throw new Error('Invalid ilink client version');
  }
  async getQr(signal?: AbortSignal): Promise<{ qrcode: string; qrcode_img_content: string }> {
    return this.call(ILINK_BASE, "ilink/bot/get_bot_qrcode?bot_type=3", { local_token_list: [] }, 15000, signal);
  }
  async qrStatus(base: string, qr: string, verify?: string, signal?: AbortSignal): Promise<QrStatus> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`;
    if (verify) endpoint += `&verify_code=${encodeURIComponent(verify)}`;
    return this.call(trustedWechatBase(base), endpoint, undefined, 35000, signal);
  }
  async updates(cursor: string, signal: AbortSignal): Promise<Updates> {
    try {
      const result=await this.call<Updates>(this.credentials!.baseUrl, "ilink/bot/getupdates", {
        get_updates_buf: cursor, base_info: this.baseInfo(),
      }, this.pollTimeoutMs, signal);
      if (Number.isSafeInteger(result.longpolling_timeout_ms) && result.longpolling_timeout_ms!>0) {
        this.pollTimeoutMs=Math.min(result.longpolling_timeout_ms!,120000);
      }
      return result;
    } catch(error) {
      if (error instanceof IlinkError && error.code==='ilink_timeout' && !signal.aborted) return {msgs:[],get_updates_buf:cursor};
      throw error;
    }
  }
  async send(payload: ReplyJob["payload"], signal: AbortSignal): Promise<void> {
    if (payload.to_user_id !== this.credentials!.userId) {
      throw new IlinkError("reply_recipient_or_context_invalid", "failed");
    }
    await this.call(this.credentials!.baseUrl, "ilink/bot/sendmessage", {
      msg: { from_user_id: "", to_user_id: payload.to_user_id, client_id: payload.client_id,
        message_type: 2, message_state: 2, ...(payload.context_token?{context_token:payload.context_token}:{}),
        item_list: [{ type: 1, text_item: { text: payload.text } }] }, base_info: this.baseInfo(),
    }, 15000, signal, true);
  }
  private baseInfo() { return { channel_version: this.version, bot_agent: "DotWechatBridge/0.1.0" }; }
  private async call<T>(base: string, path: string, body: unknown, timeout: number,
                        signal?: AbortSignal, sending = false): Promise<T> {
    const [major,minor,patch]=this.version.split('.').map(Number);
    const headers: Record<string, string> = { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String((major<<16)|(minor<<8)|patch) };
    if (this.routeTag) headers.SKRouteTag = this.routeTag;
    if (body !== undefined) {
      Object.assign(headers, { "Content-Type": "application/json", AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).reduce((value, byte) => value * 256 + byte, 0))).toString("base64") });
      if (this.credentials) headers.Authorization = `Bearer ${this.credentials.botToken}`;
    }
    let response: Response;
    try {
      response = await this.request(`${trustedWechatBase(base)}/${path}`, {
        method: body === undefined ? "GET" : "POST", headers,
        body: body === undefined ? undefined : JSON.stringify(body), redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        const outcome = sending ? (response.status === 429 ? "retryable" : response.status >= 500 ? "unknown" : "failed") : "retryable";
        throw new IlinkError(`ilink_http_${response.status}`, outcome, `微信请求失败（HTTP ${response.status}）`);
      }
      const result = parseIlinkJson<T & { ret?: number; errcode?: number; errmsg?: string }>(await limitedText(response, 2 * 1024 * 1024));
      const codes=[result.ret,result.errcode];
      const code=codes.includes(-14)?-14:codes.find(value => value !== undefined && value !== 0);
      if (code !== undefined) {
        const context = (body as { msg?: { context_token?: string } } | undefined)?.msg?.context_token;
        const detail = code === -14 ? "微信凭据已过期，请重新扫码" : `微信请求失败（${code}）${result.errmsg ? `：${redactedReason(result.errmsg, [this.credentials?.botToken, context])}` : ""}`;
        throw new IlinkError(code === -14 ? "credential_expired" : `ilink_error_${code}`, "failed", detail.slice(0,256));
      }
      return result;
    } catch (error) {
      if (error instanceof IlinkError) throw error;
      const fault = error as { name?: string; cause?: { code?: string }; code?: string };
      const timedOut = fault.name === "TimeoutError" || fault.code === "ETIMEDOUT" || fault.cause?.code === "ETIMEDOUT";
      const transportCode = fault.cause?.code ?? fault.code;
      const detail = timedOut ? "发送超时" : `微信网络请求失败${transportCode && /^[A-Z0-9_]{1,40}$/.test(transportCode) ? `（${transportCode}）` : ""}`;
      throw new IlinkError(timedOut ? (sending?"send_timeout":"ilink_timeout") : "ilink_transport_error", sending ? "unknown" : "retryable", detail);
    }
  }
}

function redactedReason(reason: string, secrets: (string | undefined)[]): string {
  let text = reason.replace(/https?:\/\/[^\s"<>]+/gi, "[链接]");
  for (const secret of secrets) if (secret) text = text.split(secret).join("[已隐藏]");
  return text.replace(/(?:bot_token|context_token|authorization|token)\s*[:=]\s*[^\s,;]+/gi, "[已隐藏]").replace(/[\r\n]/g, " ").slice(0, 256);
}

async function limitedText(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty ilink response");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    bytes += chunk.value.length;
    if (bytes > max) { await reader.cancel(); throw new Error("Oversized ilink response"); }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function personalMessages(messages: WechatMessage[], owner: string, bot: string): WechatMessage[] {
  return messages.filter(message => message.from_user_id === owner && message.from_user_id !== bot &&
    message.message_type === 1 && !message.group_id && message.message_id);
}

export function inboundMessages(messages: WechatMessage[], owner: string, bot: string): IncomingMessage[] {
  return personalMessages(messages, owner, bot).map(message => {
      const items = message.item_list ?? [];
      const text = items.flatMap(item => item.text_item?.text ? [item.text_item.text] : item.voice_item?.text ? [item.voice_item.text] : []).join("\n");
      const kind = items.some(item => item.type === 3) ? "voice" : text ? "text" : "media";
      return { upstream_id: message.message_id!, sender: owner, occurred_at: message.create_time_ms ?? Date.now(),
        text: text || "[微信媒体消息]", kind, context_token: message.context_token??'', message_type: 1 };
    });
}
