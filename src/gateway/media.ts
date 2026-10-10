import { createDecipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import type { CdnMedia, MessageItem } from "./ilink.ts";
import { MAX_ATTACHMENT_BYTES } from "../shared/contracts.ts";

const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
export const MAX_MEDIA_BYTES = MAX_ATTACHMENT_BYTES;

export interface DownloadedMedia {
  kind: "image" | "file";
  name: string;
  mime_type: string;
  size: number;
  data: Buffer;
}
export class MediaDownloadError extends Error {
  constructor(readonly code: string, readonly detail: string) { super(detail); }
}
interface DownloadOptions { request?: typeof fetch; signal?: AbortSignal; maxBytes?: number }

function fault(code: string, detail: string): never { throw new MediaDownloadError(code, detail); }

function mediaUrl(media: CdnMedia): string {
  let url: URL;
  try {
    url = new URL(media.full_url || `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? "")}`);
  } catch { return fault("media_url_invalid", "微信附件下载地址无效"); }
  const authority = media.full_url?.match(/^https:\/\/([^/\?#]+)/i)?.[1];
  if (url.protocol !== "https:" || url.username || url.password || url.port || authority?.includes(":") || url.hash ||
      !(url.hostname === "cdn.weixin.qq.com" || url.hostname.endsWith(".cdn.weixin.qq.com"))) {
    fault("media_url_untrusted", "微信附件下载地址不受信任");
  }
  if (!media.full_url && !media.encrypt_query_param) fault("media_reference_missing", "微信附件缺少下载信息");
  return url.href;
}

function aesKey(item: MessageItem, media: CdnMedia): Buffer | undefined {
  const hex = item.type === 2 ? item.image_item?.aeskey : undefined;
  if (hex !== undefined && hex !== "") {
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) fault("media_key_invalid", "微信附件解密信息无效");
    return Buffer.from(hex, "hex");
  }
  if (!media.aes_key) {
    if (item.type === 2) return undefined;
    return fault("media_key_missing", "微信文件缺少解密信息");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(media.aes_key)) fault("media_key_invalid", "微信附件解密信息无效");
  const decoded = Buffer.from(media.aes_key, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  return fault("media_key_invalid", "微信附件解密信息无效");
}

async function download(url: string, limit: number, options: DownloadOptions): Promise<Buffer> {
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    const response = await (options.request ?? fetch)(url, { redirect: "error", signal });
    if (!response.ok) fault("media_download_failed", `微信附件下载失败（HTTP ${response.status}）`);
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      fault("media_too_large", "微信附件超过大小限制");
    }
    const reader = response.body?.getReader();
    if (!reader) fault("media_download_empty", "微信附件下载内容为空");
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) { await reader.cancel(); fault("media_too_large", "微信附件超过大小限制"); }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof MediaDownloadError) throw error;
    if (options.signal?.aborted) return fault("media_download_aborted", "微信附件下载已取消");
    if ((error as { name?: string }).name === "TimeoutError") return fault("media_download_timeout", "微信附件下载超时");
    return fault("media_download_failed", "微信附件下载失败");
  }
}

function safeFilename(name: string | undefined): string {
  const leaf = (name ?? "").replace(/\\/g, "/").split("/").at(-1) ?? "";
  return leaf.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200) || "file.bin";
}

function imageFormat(data: Buffer): { mime: string; extension: string } {
  const magic = Buffer.from(data.subarray(0, 12)).toString("hex");
  if (magic.startsWith("89504e470d0a1a0a")) return { mime: "image/png", extension: "png" };
  if (magic.startsWith("ffd8ff")) return { mime: "image/jpeg", extension: "jpg" };
  if (magic.startsWith("474946383761") || magic.startsWith("474946383961")) return { mime: "image/gif", extension: "gif" };
  if (magic.startsWith("52494646") && magic.slice(16) === "57454250") return { mime: "image/webp", extension: "webp" };
  if (magic.startsWith("424d")) return { mime: "image/bmp", extension: "bmp" };
  return { mime: "application/octet-stream", extension: "bin" };
}

const FILE_MIME: Record<string, string> = {
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
};

export async function downloadMediaFromItem(item: MessageItem, options: DownloadOptions = {}): Promise<DownloadedMedia | null> {
  if (item.type !== 2 && item.type !== 4) return null;
  const kind = item.type === 2 ? "image" : "file";
  const media = item.type === 2 ? item.image_item?.media : item.file_item?.media;
  if (!media) return fault("media_reference_missing", "微信附件缺少下载信息");
  const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_MEDIA_BYTES) {
    return fault("media_limit_invalid", "微信附件大小限制无效");
  }
  const url = mediaUrl(media), key = aesKey(item, media);
  const downloadLimit = key ? Math.floor(maxBytes / 16) * 16 + 16 : maxBytes;
  const expectedSize = kind === "file" && /^\d+$/.test(item.file_item?.len ?? "") ? Number(item.file_item!.len) : undefined;
  // Image sizes describe ciphertext; file.len describes plaintext.
  const imageSize = Math.max(item.image_item?.hd_size ?? 0, item.image_item?.mid_size ?? 0);
  if ((expectedSize ?? 0) > maxBytes || imageSize > downloadLimit) return fault("media_too_large", "微信附件超过大小限制");
  const downloaded = await download(url, downloadLimit, options);
  let data = downloaded;
  if (key) {
    try {
      const decipher = createDecipheriv("aes-128-ecb", key, null);
      data = Buffer.concat([decipher.update(downloaded), decipher.final()]);
    } catch { return fault("media_decrypt_failed", "微信附件解密失败"); }
  }
  if (data.length > maxBytes) return fault("media_too_large", "微信附件超过大小限制");
  if (expectedSize !== undefined && data.length !== expectedSize) return fault("media_size_mismatch", "微信附件内容不完整");
  if (kind === "image") {
    const format = imageFormat(data);
    return { kind, name: `image.${format.extension}`, mime_type: format.mime, size: data.length, data };
  }
  const name = safeFilename(item.file_item?.file_name);
  return { kind, name, mime_type: FILE_MIME[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream", size: data.length, data };
}
