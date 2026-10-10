import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import type { RequestOptions } from "node:https";
import type { WebhookJob, JobResult } from "../shared/contracts.ts";

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 ||
        (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes("%") || address.includes(".")) return false;
  const parts = address.toLowerCase().split("::");
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map(value => parseInt(value, 16));
  // Public global unicast, excluding documentation and transition mechanisms.
  return groups[0] >= 0x2000 && groups[0] <= 0x3fff && groups[0] !== 0x2002 &&
    !(groups[0] === 0x2001 && (groups[1] === 0 || groups[1] === 0xdb8 || groups[1] < 0x200));
}

export interface CallbackOptions {
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  addressAllowed?: (address: string) => boolean;
  ca?: RequestOptions["ca"];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export async function deliverWebhook(job: WebhookJob, options: CallbackOptions = {}): Promise<JobResult> {
  const result = (outcome: JobResult["outcome"], fields: Partial<JobResult> = {}): JobResult => ({
    job_id: job.id, claim_token: job.claim_token, outcome, ...fields,
  });
  const deadline = Date.now() + (options.timeoutMs ?? 10000);
  try {
    const url = new URL(job.payload.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return result("failed", { error_code: "callback_url_invalid", error_message: "事件回调地址无效" });
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const resolution = options.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
    const addresses = await withDeadline(resolution(host), deadline);
    if (!addresses.length || addresses.some(item => !(options.addressAllowed ?? publicAddress)(item.address))) {
      return result("failed", { error_code: "callback_address_blocked", error_message: "事件回调目标必须解析为公网地址" });
    }
    const pinned = addresses[0];
    const response = await httpsPost(url, pinned, job, { ...options, timeoutMs: Math.max(1, deadline - Date.now()) });
    if (response.status >= 200 && response.status < 300) {
      let challenge: string | undefined;
      if (response.text) {
        try {
          const body = JSON.parse(response.text) as { challenge?: unknown };
          if (typeof body.challenge === "string") challenge = body.challenge;
        } catch { /* Delivery callbacks need not return JSON. */ }
      }
      return result("delivered", { http_status: response.status, ...(challenge === undefined ? {} : { challenge }) });
    }
    return result(response.status === 429 || response.status >= 500 ? "retryable" : "failed", { http_status: response.status, error_message: `事件回调失败（HTTP ${response.status}）` });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return result(code === "RESPONSE_TOO_LARGE" ? "failed" : "retryable", {
      error_code: code === "RESPONSE_TOO_LARGE" ? "callback_response_too_large" : "callback_transport_error",
      error_message: code === "RESPONSE_TOO_LARGE" ? "事件回调响应过大" : code === "ETIMEDOUT" ? "事件回调超时"
        : `事件回调连接失败${code && /^[A-Z0-9_]{1,40}$/.test(code) ? `（${code}）` : ""}`,
    });
  }
}

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("DNS deadline exceeded"), { code: "ETIMEDOUT" })), Math.max(1, deadline - Date.now()));
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function httpsPost(url: URL, pinned: { address: string; family: number }, job: WebhookJob,
                   options: CallbackOptions): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json", host: url.host };
    for (const [name, value] of Object.entries(job.payload.headers)) {
      if (/^(webhook-[a-z-]+|mcp-protocol-version|x-mcp-subscription-id|content-type)$/i.test(name)) headers[name.toLowerCase()] = value;
    }
    headers["content-length"] = String(Buffer.byteLength(job.payload.body));
    const outgoing = request(url, {
      method: "POST", headers, ca: options.ca, agent: false,
      servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
      lookup: (_hostname, lookupOptions, done) => lookupOptions.all
        ? done(null, [pinned]) : done(null, pinned.address, pinned.family),
    }, incoming => {
      const chunks: Buffer[] = []; let length = 0;
      incoming.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > (options.maxResponseBytes ?? 16384)) {
          outgoing.destroy(Object.assign(new Error("Response too large"), { code: "RESPONSE_TOO_LARGE" })); return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      incoming.on("error", reject);
    });
    const timer = setTimeout(() => outgoing.destroy(Object.assign(new Error("Callback deadline exceeded"), { code: "ETIMEDOUT" })), options.timeoutMs ?? 10000);
    outgoing.once("close", () => clearTimeout(timer));
    outgoing.once("error", reject);
    outgoing.end(job.payload.body);
  });
}
