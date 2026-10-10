import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request, type RequestOptions } from "node:https";
import { MAX_ATTACHMENT_BYTES } from "../shared/contracts.ts";
import { publicAddress } from "./callback.ts";
import { OutboundMediaError } from "./outbound-media.ts";

export interface MediaSourceOptions {
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  addressAllowed?: (address: string) => boolean;
  ca?: RequestOptions["ca"];
  timeoutMs?: number;
  maxBytes?: number;
}
export async function downloadPublicMedia(input: string, signal: AbortSignal, options: MediaSourceOptions = {}): Promise<Buffer> {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new OutboundMediaError("media_source_url_invalid", "failed", "附件地址无效"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new OutboundMediaError("media_source_url_invalid", "failed", "附件地址必须是无登录信息的 HTTPS 链接");
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs ?? 60000);
  const combined = AbortSignal.any([signal, deadline.signal]);
  try {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const resolve = options.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
    const addresses = await cancellable(resolve(host), combined);
    if (!addresses.length || addresses.some(item => !(options.addressAllowed ?? publicAddress)(item.address))) {
      throw new OutboundMediaError("media_source_address_blocked", "failed", "附件地址必须解析为公网地址");
    }
    return await pinnedDownload(url, addresses[0], combined, options);
  } catch (error) {
    if (error instanceof OutboundMediaError) throw error;
    throw new OutboundMediaError("media_source_interrupted", "retryable", "附件下载中断，尚未发送");
  } finally { clearTimeout(timer); }
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(value => { signal.removeEventListener("abort", aborted); resolve(value); }, error => {
      signal.removeEventListener("abort", aborted); reject(error);
    });
  });
}
function pinnedDownload(url: URL, pinned: { address: string; family: number }, signal: AbortSignal,
  options: MediaSourceOptions): Promise<Buffer> {
  const limit = Math.min(options.maxBytes ?? MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES);
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "GET", headers: { host: url.host, "accept-encoding": "identity" },
      ca: options.ca, agent: false, signal,
      servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
      lookup: (_hostname, lookupOptions, done) => lookupOptions.all
        ? done(null, [pinned]) : done(null, pinned.address, pinned.family),
    }, incoming => {
      const status = incoming.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        incoming.destroy();
        reject(new OutboundMediaError(`media_source_http_${status}`, status === 429 || status >= 500 ? "retryable" : "failed", `附件下载失败（HTTP ${status}）`));
        return;
      }
      if (Number(incoming.headers["content-length"]) > limit) {
        const error = new OutboundMediaError("media_too_large", "failed", "附件超过大小限制");
        reject(error); outgoing.destroy(error); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          const error = new OutboundMediaError("media_too_large", "failed", "附件超过大小限制");
          reject(error); outgoing.destroy(error);
        }
        else chunks.push(chunk);
      });
      incoming.once("end", () => resolve(Buffer.concat(chunks)));
      incoming.once("error", reject);
      incoming.once("aborted", () => reject(new Error("Incomplete media response")));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
