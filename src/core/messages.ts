import { Database } from "./database.ts";
import { Vault, hash } from "./security.ts";
import { Sessions } from "./sessions.ts";
import { Message, Job } from "./models.ts";
import { pause, requireValue } from "./errors.ts";
import { IncomingMessage, OutgoingMedia, ReplyJob } from "../shared/contracts.ts";
import { Attachments } from "./attachments.ts";
import { messageView } from "./message-view.ts";
import { sameOutput, requireMediaGateway } from "./outgoing-media.ts";

export class Messages {
  constructor(readonly db: Database, readonly vault: Vault, readonly sessions: Sessions, readonly attachments: Attachments) {}
  async ingest(messages: IncomingMessage[], cursor: string, previousCursor: string,
    gatewayId: string, leaseHash: string, now: number, participantId = 'personal') {
    const participant=await this.db.one<{sender:string|null;enabled:number}>("SELECT sender,enabled FROM participants WHERE id=?", [participantId]);
    requireValue(participant?.sender,"wechat_not_bound");
    requireValue(participant.enabled===1,"participant_disabled");
    const sender=participant.sender;
    requireValue(messages.length<=500,"batch_too_large",413);
    const inserts=[];
    for (const message of messages) {
      if (message.sender!==sender || message.group_id || message.message_type!==1) continue;
      requireValue(typeof message.upstream_id==='string' && message.upstream_id.length>0 &&
        message.upstream_id.length<=128 && typeof message.text==='string' && message.text.length<=32_000 &&
        typeof message.context_token==='string' && message.context_token.length<=16_000 &&
        Number.isSafeInteger(message.occurred_at) && ['text','voice','media'].includes(message.kind),"invalid_message",400);
      const attachments=await this.attachments.validate(message.attachments,message.upstream_id,participantId);
      inserts.push(this.db.statement(`INSERT OR IGNORE INTO messages(participant_id,upstream_id,sender,occurred_at,text,kind,context_cipher,attachments_json)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM gateway WHERE id='personal' AND gateway_id=? AND lease_hash=? AND lease_until>?)
        AND EXISTS(SELECT 1 FROM participants WHERE id=? AND enabled=1 AND (cursor=? OR cursor=?))`,
        [participantId,message.upstream_id,sender,message.occurred_at,message.text,message.kind,
          await this.vault.seal(message.context_token),JSON.stringify(attachments),gatewayId,leaseHash,now,participantId,previousCursor,cursor]));
    }
    const commit=this.db.statement(`UPDATE participants SET cursor=? WHERE id=? AND enabled=1 AND (cursor=? OR cursor=?)
      AND EXISTS(SELECT 1 FROM gateway WHERE id='personal' AND gateway_id=? AND lease_hash=? AND lease_until>?)`,
      [cursor,participantId,previousCursor,cursor,gatewayId,leaseHash,now]);
    const operations=[...inserts,commit];
    if (participantId==='personal') operations.push(this.db.statement(`UPDATE gateway SET cursor=? WHERE id='personal'
      AND EXISTS(SELECT 1 FROM participants WHERE id='personal' AND cursor=? AND enabled=1)
      AND gateway_id=? AND lease_hash=? AND lease_until>?`, [cursor,cursor,gatewayId,leaseHash,now]));
    const results=await this.db.binding.batch(operations);
    requireValue(results[inserts.length]?.meta.changes===1,"cursor_conflict");
    await this.sessions.ensure(now,results.slice(0,inserts.length).some(r=>r.meta.changes>0),participantId);
    return {accepted:true};
  }
  pending(limit = 32, participantId = 'personal') {
    return this.db.all<Message>(`SELECT m.*,p.display_name FROM messages m JOIN participants p ON p.id=m.participant_id
      WHERE m.status='pending' AND m.participant_id=? AND p.enabled=1 ORDER BY m.sequence LIMIT ?`, [participantId,limit]);
  }
  async read(sessionId: string, lease: string, waitMs: number) {
    const deadline=Date.now()+Math.min(waitMs,this.sessions.cfg.readWaitMs);
    while (true) {
      const now=Date.now(), session=await this.sessions.authorize(sessionId,lease,now);
      const rows=await this.pending(32,session.participant_id);
      if (rows.length || now>=deadline || now-session.last_activity>=this.sessions.cfg.idleMs) {
        return {participant_id:session.participant_id,display_name:session.display_name,messages:rows.map(messageView),
          should_end:!rows.length && now-session.last_activity>=this.sessions.cfg.idleMs,lease_until:session.lease_until};
      }
      await pause(Math.min(500,deadline-now));
    }
  }
  async reply(sessionId: string, lease: string, ids: number[], key: string, text: string, now: number, media?:OutgoingMedia) {
    const session=await this.sessions.authorize(sessionId,lease,now), participantId=session.participant_id;
    requireValue(ids.length>0 && ids.length<=32 && ids.every((id,i)=>Number.isSafeInteger(id) && id>0 &&
      (i===0 || id>ids[i-1])),"invalid_message_ids",400);
    const jobId="reply_"+(await hash(participantId==='personal'?key:JSON.stringify([participantId,key]))).replaceAll(/[+/=]/g,"");
    const existing=await this.db.one<Job>("SELECT * FROM jobs WHERE id=?", [jobId]);
    if (existing) return this.checkReply(existing,ids,text,media);
    if (media) await requireMediaGateway(this.db,now);
    const rows=await this.replyMessages(ids,sessionId,participantId), last=rows.at(-1)!;
    const context=await this.vault.open<string>(last.context_cipher);
    requireValue(context,"missing_wechat_reply_context");
    const payload=await this.vault.seal({client_id:jobId,to_user_id:last.sender,text,context_token:context,...(media?{media}:{})});
    await this.enqueueReply(jobId,sessionId,await hash(lease),ids,payload,now,participantId);
    const job=await this.db.one<Job>("SELECT * FROM jobs WHERE id=?", [jobId]);
    requireValue(job,"concurrent_reply_conflict");
    return this.checkReply(job,ids,text,media);
  }
  private async checkReply(job: Job, ids: number[], text: string, media?:OutgoingMedia) {
    const saved=await this.vault.open<ReplyJob['payload']>(job.payload_cipher);
    requireValue(sameOutput(saved,text,media) && job.message_ids===JSON.stringify(ids),"idempotency_conflict");
    return {reply_id:job.id,status:job.state};
  }
  private async replyMessages(ids: number[], sessionId: string, participantId: string) {
    const placeholders=ids.map(()=>"?").join(",");
    const rows=await this.db.all<Message & {reply_session_id:string|null}>(`SELECT m.*,j.session_id AS reply_session_id
      FROM messages m LEFT JOIN jobs j ON j.id=m.reply_id WHERE m.sequence IN (${placeholders}) ORDER BY m.sequence`,ids);
    requireValue(rows.length===ids.length && rows.every((r,i)=>r.sequence===ids[i]),"reply_message_not_found",404);
    requireValue(rows.every(row=>row.participant_id===participantId),"reply_participant_mismatch",400);
    const pending=await this.pending(ids.length,participantId);
    const prefix=pending.length===ids.length && pending.every((r,i)=>r.sequence===ids[i]);
    const continuation=rows.every(r=>['reply_queued','replied','skipped'].includes(r.status) && r.reply_session_id===sessionId);
    requireValue(prefix || continuation,"reply_must_cover_pending_prefix");
    return rows;
  }
  private async enqueueReply(id: string, sessionId: string, leaseHash: string, ids: number[], payload: string, now: number, participantId: string) {
    const placeholders=ids.map(()=>"?").join(","), encodedIds=JSON.stringify(ids);
    // Eligibility, queue insertion and the latest reply marker share one transaction.
    const insert=this.db.statement(`INSERT INTO jobs(id,kind,purpose,participant_id,session_id,payload_cipher,message_ids,available_at,created_at)
      SELECT ?,'reply','reply',?,?,?,?,?,? WHERE (
        ((SELECT count(*) FROM messages WHERE participant_id=? AND status='pending' AND sequence IN (${placeholders}))=?
        AND NOT EXISTS(SELECT 1 FROM messages WHERE participant_id=? AND status='pending' AND sequence<?))
        OR (SELECT count(*) FROM messages m JOIN jobs j ON j.id=m.reply_id WHERE m.participant_id=? AND m.sequence IN (${placeholders})
          AND m.status IN ('reply_queued','replied','skipped') AND j.session_id=?)=?)
      AND EXISTS(SELECT 1 FROM conversation c JOIN participants p ON p.id=c.id
        WHERE c.id=? AND c.session_id=? AND c.state='active' AND c.lease_hash=? AND c.lease_until>? AND p.enabled=1)
      ON CONFLICT(id) DO NOTHING`, [id,participantId,sessionId,payload,encodedIds,now,now,
        participantId,...ids,ids.length,participantId,ids[0],participantId,...ids,sessionId,ids.length,participantId,sessionId,leaseHash,now]);
    const reserve=this.db.statement(`UPDATE messages SET status='reply_queued',reply_id=? WHERE participant_id=? AND sequence IN (${placeholders})
      AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND message_ids=? AND participant_id=?)
      AND (reply_id IS NULL OR EXISTS(SELECT 1 FROM jobs previous JOIN jobs next ON next.id=?
        WHERE previous.id=messages.reply_id AND previous.sequence<next.sequence))`, [id,participantId,...ids,id,encodedIds,participantId,id]);
    await this.db.binding.batch([insert,reserve]);
  }
}
