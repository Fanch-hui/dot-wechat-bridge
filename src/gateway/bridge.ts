import type { GatewayConfig } from "./config.ts";
import type { Attachment, AttachmentUpload, GatewayAuth, StoredMedia } from "../shared/contracts.ts";
import { MAX_ATTACHMENT_BYTES } from "../shared/contracts.ts";
import { Buffer } from "node:buffer";

export class BridgeHttpError extends Error {
  constructor(readonly status: number, readonly code?: string) { super(`bridge_http_${status}`); }
  static async from(response: Response): Promise<BridgeHttpError> {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    const code = typeof body?.error === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(body.error) ? body.error : undefined;
    return new BridgeHttpError(response.status, code);
  }
}

export class BridgeClient {
  constructor(private readonly config: GatewayConfig, private readonly request = fetch) {}
  private headers(contentType: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": contentType, Authorization: `Bearer ${this.config.bridgeToken}`,
    };
    if (this.config.sitesAccessToken) headers["OAI-Sites-Authorization"] = this.config.sitesAccessToken.startsWith('Bearer ')
      ? this.config.sitesAccessToken : `Bearer ${this.config.sitesAccessToken}`;
    return headers;
  }
  async post<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.request(`${this.config.bridgeUrl}/gateway/${route}`, {
      method: "POST", headers: this.headers("application/json"), body: JSON.stringify(body), redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    });
    if (!response.ok) throw await BridgeHttpError.from(response);
    return response.json() as Promise<T>;
  }
  async uploadAttachment(auth: GatewayAuth & { participant_id?: string }, metadata: AttachmentUpload, data: Uint8Array, signal: AbortSignal): Promise<Attachment> {
    const response = await this.request(`${this.config.bridgeUrl}/gateway/attachment`, {
      method: "POST", headers: { ...this.headers("application/octet-stream"),
        "X-Bridge-Gateway-Id": auth.gateway_id, "X-Bridge-Lease": auth.lease_token,
        ...(auth.participant_id ? { "X-Bridge-Participant-Id": auth.participant_id } : {}),
        "X-Bridge-Attachment": Buffer.from(JSON.stringify(metadata)).toString("base64") },
      body: data as BodyInit, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    });
    if (!response.ok) throw new Error(`bridge_http_${response.status}`);
    return response.json() as Promise<Attachment>;
  }
  async downloadMedia(auth: GatewayAuth & { job_id: string; claim_token: string }, signal: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(`${this.config.bridgeUrl}/gateway/media-download`, {
      method: "POST", headers: this.headers("application/json"), body: JSON.stringify(auth), redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    });
    if (!response.ok) throw new Error(`bridge_http_${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("bridge_media_empty");
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_ATTACHMENT_BYTES) { await reader.cancel(); throw new Error("bridge_media_too_large"); }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  }
  async cacheMedia(auth: GatewayAuth & { job_id: string; claim_token: string }, data: Uint8Array, signal: AbortSignal): Promise<StoredMedia> {
    const response = await this.request(`${this.config.bridgeUrl}/gateway/media-cache`, {
      method: "POST", headers: { ...this.headers("application/octet-stream"),
        "X-Bridge-Gateway-Id": auth.gateway_id, "X-Bridge-Lease": auth.lease_token,
        "X-Bridge-Job-Id": auth.job_id, "X-Bridge-Claim-Token": auth.claim_token },
      body: data as BodyInit, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    });
    if (!response.ok) throw new Error(`bridge_http_${response.status}`);
    return response.json() as Promise<StoredMedia>;
  }
}
