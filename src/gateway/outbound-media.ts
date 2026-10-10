import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import type { MessageItem } from "./ilink.ts";
import { MAX_ATTACHMENT_BYTES } from "../shared/contracts.ts";

export class OutboundMediaError extends Error {
  constructor(readonly code: string, readonly outcome: "failed" | "retryable", readonly detail: string) { super(detail); }
}
export interface UploadRequest {
  filekey: string; media_type: number; to_user_id: string; rawsize: number;
  rawfilemd5: string; filesize: number; no_need_thumb: boolean; aeskey: string;
}
export interface UploadResponse { upload_param?: string; upload_full_url?: string }
export function trustedUploadUrl(response: UploadResponse, filekey: string): string {
  const full = response.upload_full_url?.trim();
  if (!full && !response.upload_param) throw new OutboundMediaError("media_upload_reference_missing", "failed", "微信未返回附件上传地址");
  let url: URL;
  try { url = new URL(full || `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(response.upload_param!)}&filekey=${encodeURIComponent(filekey)}`); }
  catch { throw new OutboundMediaError("media_upload_url_invalid", "failed", "微信附件上传地址无效"); }
  const authority = (full || url.href).match(/^https:\/\/([^/\?#]+)/i)?.[1];
  if (url.protocol !== "https:" || url.username || url.password || url.port || authority?.includes(":") || url.hash ||
      !(url.hostname === "cdn.weixin.qq.com" || url.hostname.endsWith(".cdn.weixin.qq.com"))) {
    throw new OutboundMediaError("media_upload_url_untrusted", "failed", "微信附件上传地址不受信任");
  }
  return url.href;
}

export async function uploadWechatMedia(data: Uint8Array, kind: "image" | "file", name: string, recipient: string,
  getUploadUrl: (body: UploadRequest) => Promise<UploadResponse>, request: typeof fetch, signal: AbortSignal): Promise<MessageItem> {
  if (data.length > MAX_ATTACHMENT_BYTES) throw new OutboundMediaError("media_too_large", "failed", "附件超过大小限制");
  const key = Buffer.from(randomBytes(16)), filekey = Buffer.from(randomBytes(16)).toString("hex");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const response = await getUploadUrl({ filekey, media_type: kind === "image" ? 1 : 3, to_user_id: recipient,
    rawsize: data.length, rawfilemd5: createHash("md5").update(data).digest("hex"), filesize: ciphertext.length,
    no_need_thumb: true, aeskey: key.toString("hex") });
  const url = trustedUploadUrl(response, filekey);
  const downloadParam = await uploadCiphertext(url, ciphertext, request, signal);
  const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(key.toString("hex"), "utf8").toString("base64"), encrypt_type: 1 };
  return kind === "image" ? { type: 2, image_item: { media, mid_size: ciphertext.length } }
    : { type: 4, file_item: { media, file_name: name, len: String(data.length) } };
}

async function uploadCiphertext(url: string, data: Buffer, request: typeof fetch, signal: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await request(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(data), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
      const downloadParam = response.headers.get("x-encrypted-param");
      await response.body?.cancel();
      if (response.status === 200 && downloadParam) return downloadParam;
      if (response.status >= 400 && response.status < 500) {
        throw new OutboundMediaError(`media_upload_http_${response.status}`, response.status === 429 ? "retryable" : "failed", `微信附件上传失败（HTTP ${response.status}）`);
      }
      if (attempt === 2) throw new OutboundMediaError("media_upload_failed", "retryable", "微信附件上传失败，尚未发送");
    } catch (error) {
      if (error instanceof OutboundMediaError) throw error;
      if (signal.aborted || attempt === 2) throw new OutboundMediaError("media_upload_interrupted", "retryable", "微信附件上传中断，尚未发送");
    }
  }
  throw new OutboundMediaError("media_upload_failed", "retryable", "微信附件上传失败，尚未发送");
}
