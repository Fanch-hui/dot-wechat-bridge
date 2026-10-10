export interface IncomingMessage {
  upstream_id: string;
  sender: string;
  occurred_at: number;
  text: string;
  kind: "text" | "voice" | "media";
  context_token: string;
  group_id?: string;
  message_type: number;
  attachments?: IncomingAttachment[];
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_INLINE_MEDIA_BYTES = 512 * 1024;
export interface StoredMedia {
  key: string;
  size: number;
  sha256: string;
}
export interface OutgoingMedia {
  kind: "image" | "file";
  name: string;
  source: { type: "url"; url: string } | ({ type: "stored" } & StoredMedia);
  cached?: StoredMedia;
}
export interface Attachment {
  id: string;
  item_index: number;
  kind: "image" | "file";
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  uri: string;
  status: "ready";
}
export interface FailedAttachment {
  item_index: number;
  kind: "image" | "file";
  name: string;
  status: "failed";
  error_code: string;
  error_message: string;
}
export type IncomingAttachment = Attachment | FailedAttachment;
export interface AttachmentUpload {
  participant_id?: string;
  upstream_id: string;
  item_index: number;
  kind: "image" | "file";
  name: string;
  mime_type: string;
}

export interface GatewayLease {
  gateway_id: string;
  lease_token: string;
  cursor: string;
  lease_until: number;
}

export interface ReplyJob {
  participant_id?: string;
  id: string;
  claim_token: string;
  kind: "reply";
  payload: { client_id: string; to_user_id: string; text: string; context_token?: string; media?: OutgoingMedia };
}

export interface WebhookJob {
  id: string;
  claim_token: string;
  kind: "webhook";
  payload: { url: string; body: string; headers: Record<string, string> };
}

export type GatewayJob = ReplyJob | WebhookJob;
export interface JobResult {
  job_id: string;
  claim_token: string;
  outcome: "delivered" | "retryable" | "failed" | "unknown";
  http_status?: number;
  challenge?: string;
  error_code?: string;
  error_message?: string;
}

export interface GatewayAuth { gateway_id: string; lease_token: string; participant_id?: string }

export interface ControlledParticipant {
  id: string; display_name: string; enabled: number; sender: string | null;
  bot_id: string | null; binding_id?: string | null; cursor: string; status: string;
}
export interface ControlledBinding {
  id: string; participant_id: string; state: string; expires_at: number; verification_code?: string;
}
export interface GatewayControlState {
  participants: ControlledParticipant[]; bindings: ControlledBinding[];
}
export interface BindingReport {
  id: string; state: string; qr_content?: string; sender?: string; bot_id?: string; error_code?: string;
}

// POST /gateway/lease {gateway_id} -> GatewayLease
// POST /gateway/bind {sender} -> {bound:true}; once, following an owner MCP call.
// POST /gateway/ingest {...GatewayAuth,cursor,previous_cursor,messages:IncomingMessage[]} -> {accepted:true}
// POST /gateway/attachment raw bytes; X-Bridge-Gateway-Id, X-Bridge-Lease,
// X-Bridge-Attachment (base64 JSON AttachmentUpload) -> Attachment
// POST /gateway/tick {...GatewayAuth} -> {lease_until:number}
// POST /gateway/jobs {...GatewayAuth,limit?:number} -> {jobs:GatewayJob[]}
// POST /gateway/complete {...GatewayAuth,...JobResult} -> {accepted:true}
// POST /gateway/health {...GatewayAuth,status:"ok"|"credential_expired"|"error"} -> {accepted:true}
// All routes require Authorization: Bearer <BRIDGE_TOKEN>, plus private Sites access.
