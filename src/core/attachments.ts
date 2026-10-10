import type { Attachment, AttachmentUpload, IncomingAttachment } from "../shared/contracts.ts";
import { MAX_ATTACHMENT_BYTES } from "../shared/contracts.ts";
import { Database } from "./database.ts";
import { requireValue, string } from "./errors.ts";
import { hash } from "./security.ts";

interface SavedAttachment extends Omit<Attachment, "uri" | "status"> { upstream_id: string; participant_id: string }
const uriFor = (row: Pick<SavedAttachment, "id" | "name" | "participant_id">) => row.participant_id === "personal"
  ? `wechat://attachments/${row.id}/${encodeURIComponent(row.name)}`
  : `wechat://participants/${encodeURIComponent(row.participant_id)}/attachments/${row.id}/${encodeURIComponent(row.name)}`;
const descriptor = ({ upstream_id, participant_id, ...row }: SavedAttachment): Attachment => ({ ...row, uri: uriFor({ ...row, participant_id }), status: "ready" });

function base64(data: Uint8Array): string {
  let raw = "";
  for (let offset = 0; offset < data.length; offset += 8192) raw += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return btoa(raw);
}

export class Attachments {
  constructor(readonly db: Database, readonly bucket?: R2Bucket) {}
  private async saved(id: string, participantId: string) {
    return this.db.one<SavedAttachment>("SELECT id,participant_id,upstream_id,item_index,kind,name,mime_type,size,sha256 FROM attachments WHERE id=? AND participant_id=?", [id,participantId]);
  }
  async upload(input: AttachmentUpload, bytes: Uint8Array<ArrayBuffer>, now: number, participantId = 'personal'): Promise<Attachment> {
    requireValue(this.bucket, "attachment_storage_unavailable", 503);
    const upstream = string(input.upstream_id, "upstream_id", 128), name = string(input.name, "attachment_name", 200);
    requireValue(!/[\\/\x00-\x1f\x7f]/.test(name), "invalid_attachment_name", 400);
    requireValue(Number.isSafeInteger(input.item_index) && input.item_index >= 0 && input.item_index < 32 &&
      ["image", "file"].includes(input.kind), "invalid_attachment", 400);
    requireValue(typeof input.mime_type === "string" && input.mime_type.length <= 160 &&
      /^[\w.+-]+\/[\w.+-]+$/.test(input.mime_type), "invalid_attachment_mime", 400);
    requireValue(bytes.byteLength <= MAX_ATTACHMENT_BYTES, "attachment_too_large", 413);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    const id = "media_" + (await hash(JSON.stringify(participantId === "personal" ? [upstream,input.item_index] : [participantId,upstream,input.item_index]))).replaceAll(/[+/=]/g, "");
    const existing = await this.saved(id,participantId);
    if (!existing) {
      // The content hash keeps concurrent uploads from overwriting one another.
      await this.bucket.put(`${id}/${sha256}`, bytes, { httpMetadata: { contentType: input.mime_type } });
      await this.db.run(`INSERT OR IGNORE INTO attachments(id,participant_id,upstream_id,item_index,kind,name,mime_type,size,sha256,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [id, participantId, upstream, input.item_index, input.kind, name, input.mime_type, bytes.length, sha256, now]);
    }
    const row = existing ?? await this.saved(id,participantId);
    requireValue(row && row.sha256 === sha256 && row.kind === input.kind && row.name === name && row.mime_type === input.mime_type,
      "attachment_upload_conflict");
    return descriptor(row);
  }

  async validate(input: IncomingAttachment[] | undefined, upstream: string, participantId = 'personal'): Promise<IncomingAttachment[]> {
    if (input === undefined) return [];
    requireValue(Array.isArray(input) && input.length <= 32, "invalid_attachments", 400);
    const result: IncomingAttachment[] = [], indices = new Set<number>();
    for (const item of input) {
      requireValue(item && Number.isSafeInteger(item.item_index) && item.item_index >= 0 && item.item_index < 32 &&
        !indices.has(item.item_index), "invalid_attachment", 400);
      indices.add(item.item_index);
      if (item.status === "ready") {
        const row = await this.saved(string(item.id, "attachment_id", 128),participantId);
        requireValue(row && row.upstream_id === upstream && row.item_index === item.item_index, "attachment_not_found", 404);
        result.push(descriptor(row));
      } else {
        requireValue(item.status === "failed" && ["image", "file"].includes(item.kind) &&
          typeof item.error_code === "string" && /^[a-z0-9_]{1,80}$/.test(item.error_code), "invalid_attachment", 400);
        result.push({ item_index: item.item_index, kind: item.kind, name: string(item.name, "attachment_name", 200),
          status: "failed", error_code: item.error_code, error_message: string(item.error_message, "attachment_error", 256) });
      }
    }
    return result;
  }

  async read(id: string, participantId = 'personal') {
    requireValue(this.bucket, "attachment_storage_unavailable", 503);
    const row = await this.saved(id,participantId);
    requireValue(row, "attachment_not_found", 404);
    const linked = await this.db.one(`SELECT sequence FROM messages WHERE upstream_id=? AND participant_id=? AND
      EXISTS(SELECT 1 FROM json_each(attachments_json) WHERE json_extract(value,'$.id')=?)`, [row.upstream_id, participantId, id]);
    requireValue(linked, "attachment_not_found", 404);
    const object = await this.bucket.get(`${id}/${row.sha256}`);
    requireValue(object, "attachment_content_unavailable", 503);
    const blob = base64(new Uint8Array(await object.arrayBuffer()));
    return { attachment: descriptor(row), resource: { uri: uriFor(row), mimeType: row.mime_type, blob } };
  }

  async readResource(uri: string) {
    const scoped = /^wechat:\/\/participants\/([^/?#]+)\/attachments\/(media_[A-Za-z0-9]+)\/[^/?#]+$/.exec(uri);
    const legacy = /^wechat:\/\/attachments\/(media_[A-Za-z0-9]+)\/[^/?#]+$/.exec(uri);
    requireValue(scoped || legacy, "attachment_uri_invalid", 400);
    let participantId = 'personal';
    try { if (scoped) participantId = decodeURIComponent(scoped[1]); }
    catch { requireValue(false, "attachment_uri_invalid", 400); }
    const result = await this.read(scoped ? scoped[2] : legacy![1],participantId);
    requireValue(result.resource.uri === uri, "attachment_uri_invalid", 400);
    return { contents: [result.resource] };
  }
}
