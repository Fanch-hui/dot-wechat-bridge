import type { GatewayConfig } from "./config.ts";
import type { Attachment, AttachmentUpload, GatewayAuth } from "../shared/contracts.ts";
import { Buffer } from "node:buffer";

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
    if (!response.ok) throw new Error(`bridge_http_${response.status}`);
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
}
