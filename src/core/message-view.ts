import type { Message } from "./models.ts";
import type { IncomingAttachment } from "../shared/contracts.ts";

export function messageView({ sender, context_cipher, attachments_json, ...row }: Message) {
  const attachments = JSON.parse(attachments_json) as IncomingAttachment[];
  return { ...row, ...(attachments.length ? { attachments } : {}) };
}
