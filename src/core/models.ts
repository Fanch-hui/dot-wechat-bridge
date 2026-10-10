export interface Session {
  participant_id: string; display_name: string;
  session_id: string; state: string; consumer_id: string | null;
  lease_hash: string | null; lease_cipher: string | null; lease_until: number;
  wake_attempts: number; wake_deadline: number; last_activity: number; created_at: number;
}
export interface Message {
  participant_id: string; display_name: string;
  sequence: number; upstream_id: string; sender: string; occurred_at: number;
  text: string; kind: string; context_cipher: string; status: string; reply_id: string | null;
  attachments_json: string;
}
export interface Job {
  participant_id: string | null;
  id: string; sequence: number; kind: "reply" | "webhook";
  purpose: "reply" | "send" | "verification" | "wake"; state: string; attempts: number;
  session_id: string | null; subscription_id: string | null; payload_cipher: string;
  message_ids: string | null; available_at: number; claim_hash: string | null;
  claim_until: number; gateway_id: string | null; http_status: number | null;
  error_code: string | null; error_message: string | null; response_challenge: string | null; created_at: number;
}
export interface Subscription {
  id: string; owner: string; url_cipher: string; secret_cipher: string; secret_hash: string;
  old_secret_cipher: string | null; rotation_until: number; expires_at: number | null;
  state: string; verified_until: number; verification_job: string | null;
}
export interface WebhookPayload {
  url: string; body: string; event_id: string; secret: string;
  old_secret?: string; rotation_until?: number;
}
