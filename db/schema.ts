import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(), value: text("value").notNull(),
});

export const messages = sqliteTable("messages", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  participant_id: text("participant_id").notNull().default("personal"),
  upstream_id: text("upstream_id").notNull(),
  sender: text("sender").notNull(), occurred_at: integer("occurred_at").notNull(),
  text: text("text").notNull(), kind: text("kind").notNull(),
  context_cipher: text("context_cipher").notNull(),
  attachments_json: text("attachments_json").notNull().default("[]"),
  status: text("status").notNull().default("pending"), reply_id: text("reply_id"),
}, t => [index("messages_status_sequence").on(t.status, t.sequence),
  uniqueIndex("messages_participant_upstream").on(t.participant_id,t.upstream_id),
  index("messages_participant_status_sequence").on(t.participant_id,t.status,t.sequence)]);

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(), upstream_id: text("upstream_id").notNull(),
  participant_id: text("participant_id").notNull().default("personal"),
  item_index: integer("item_index").notNull(), kind: text("kind").notNull(),
  name: text("name").notNull(), mime_type: text("mime_type").notNull(),
  size: integer("size").notNull(), sha256: text("sha256").notNull(),
  created_at: integer("created_at").notNull(),
}, t => [index("attachments_upstream").on(t.upstream_id, t.item_index)]);

export const conversation = sqliteTable("conversation", {
  id: text("id").primaryKey(), session_id: text("session_id").notNull(),
  state: text("state").notNull(), consumer_id: text("consumer_id"),
  lease_hash: text("lease_hash"), lease_cipher: text("lease_cipher"),
  lease_until: integer("lease_until").notNull().default(0),
  wake_attempts: integer("wake_attempts").notNull().default(0),
  wake_deadline: integer("wake_deadline").notNull().default(0),
  last_activity: integer("last_activity").notNull(), created_at: integer("created_at").notNull(),
});

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(), owner: text("owner").notNull(),
  conversation: text("conversation").notNull().default("personal"),
  url_cipher: text("url_cipher").notNull(), secret_cipher: text("secret_cipher").notNull(),
  secret_hash: text("secret_hash").notNull(), old_secret_cipher: text("old_secret_cipher"),
  rotation_until: integer("rotation_until").notNull().default(0),
  expires_at: integer("expires_at"), state: text("state").notNull(),
  verified_until: integer("verified_until").notNull().default(0), verification_job: text("verification_job"),
});

export const jobs = sqliteTable("jobs", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  id: text("id").notNull().unique(), kind: text("kind").notNull(), purpose: text("purpose").notNull(),
  participant_id: text("participant_id").default("personal"),
  session_id: text("session_id"), subscription_id: text("subscription_id"),
  payload_cipher: text("payload_cipher").notNull(), message_ids: text("message_ids"),
  state: text("state").notNull().default("ready"), attempts: integer("attempts").notNull().default(0),
  available_at: integer("available_at").notNull(), claim_hash: text("claim_hash"),
  claim_until: integer("claim_until").notNull().default(0),
  gateway_id: text("gateway_id"), http_status: integer("http_status"),
  error_code: text("error_code"), error_message: text("error_message"), response_challenge: text("response_challenge"),
  created_at: integer("created_at").notNull(),
}, t => [index("jobs_ready_sequence").on(t.state, t.available_at, t.sequence),
  index("jobs_participant_sequence").on(t.participant_id,t.kind,t.sequence)]);

export const gateway = sqliteTable("gateway", {
  id: text("id").primaryKey(), gateway_id: text("gateway_id").notNull(),
  lease_hash: text("lease_hash").notNull(), lease_until: integer("lease_until").notNull(),
  cursor: text("cursor").notNull().default(""), status: text("status").notNull().default("ok"),
  protocol_version: integer("protocol_version").notNull().default(1),
});

export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(), display_name: text("display_name").notNull(),
  enabled: integer("enabled").notNull().default(1), sender: text("sender").unique(), bot_id: text("bot_id"), binding_id: text("binding_id"),
  cursor: text("cursor").notNull().default(""), status: text("status").notNull().default("unbound"),
  created_at: integer("created_at").notNull(), updated_at: integer("updated_at").notNull(),
});

export const bindingRequests = sqliteTable("binding_requests", {
  id: text("id").primaryKey(), participant_id: text("participant_id").notNull(),
  state: text("state").notNull().default("queued"), qr_cipher: text("qr_cipher"),
  verification_cipher: text("verification_cipher"), error_code: text("error_code"),
  expires_at: integer("expires_at").notNull(), created_at: integer("created_at").notNull(), updated_at: integer("updated_at").notNull(),
}, t => [index("bindings_participant_state").on(t.participant_id,t.state)]);
