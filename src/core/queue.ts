import { Webhook } from "standardwebhooks";
import { Database } from "./database.ts";
import { Config } from "./config.ts";
import { hash, Vault, token } from "./security.ts";
import { requireValue } from "./errors.ts";
import { Job, WebhookPayload } from "./models.ts";
import { GatewayJob, JobResult, ReplyJob } from "../shared/contracts.ts";

export class Queue {
  constructor(readonly db: Database, readonly vault: Vault, readonly cfg: Config) {}
  async enqueue(id: string, purpose: "verification" | "wake", payload: WebhookPayload,
    subscription: string, now: number, session: string | null = null, participant:string|null=null) {
    await this.db.run(`INSERT OR IGNORE INTO jobs(id,kind,purpose,payload_cipher,subscription_id,session_id,available_at,created_at,participant_id)
      VALUES(?,'webhook',?,?,?,?,?,?,?)`, [id,purpose,await this.vault.seal(payload),subscription,session,now,now,participant]);
  }

  async maintain(now: number) {
    await this.db.binding.batch([
      this.db.statement(`UPDATE jobs SET state='ready',claim_hash=NULL,claim_until=0,gateway_id=NULL,available_at=?
        WHERE kind='reply' AND state='preparing' AND claim_until<=?`, [now,now]),
      this.db.statement(`UPDATE jobs SET state='unknown',error_code='send_lease_expired',error_message='接入服务在发送过程中中断，未取得微信发送结果'
        WHERE kind='reply' AND state='sending' AND claim_until<=?`, [now]),
      this.db.statement(`UPDATE jobs SET state=CASE WHEN attempts>=? THEN 'failed' ELSE 'ready' END,
        available_at=?,error_code='relay_lease_expired' WHERE kind='webhook' AND state='sending' AND claim_until<=?`,
        [this.cfg.maxDeliveryAttempts,now,now]),
      this.db.statement(`UPDATE jobs SET state='cancelled' WHERE kind='webhook' AND state='ready' AND purpose='wake'
        AND (NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.id=subscription_id AND s.state='active'
        AND (s.expires_at IS NULL OR s.expires_at>?)) OR NOT EXISTS(SELECT 1 FROM conversation c
        WHERE c.session_id=jobs.session_id AND c.state IN ('waking','wake_failed'))
        OR NOT EXISTS(SELECT 1 FROM participants p WHERE p.id=jobs.participant_id AND p.enabled=1))`, [now]),
      this.db.statement(`UPDATE subscriptions SET state='expired' WHERE expires_at IS NOT NULL AND expires_at<=?
        AND state='active'`, [now]),
    ]);
  }

  async claim(gatewayId: string, limit: number, now: number): Promise<GatewayJob[]> {
    await this.maintain(now);
    const gateway=await this.db.one<{protocol_version:number}>("SELECT protocol_version FROM gateway WHERE gateway_id=?",[gatewayId]);
    const rows=await this.db.all<Job>(`SELECT j.* FROM jobs j WHERE state='ready' AND available_at<=?
      AND (j.kind='webhook' OR EXISTS(SELECT 1 FROM participants p WHERE p.id=j.participant_id AND p.enabled=1 AND p.sender IS NOT NULL))
      AND (j.kind='webhook' OR ?>=2 OR j.participant_id='personal')
      AND (kind='webhook' OR NOT EXISTS(SELECT 1 FROM jobs earlier WHERE earlier.kind='reply'
        AND earlier.participant_id=j.participant_id
        AND earlier.sequence<j.sequence AND earlier.state IN ('ready','preparing','sending','unknown','failed')))
      ORDER BY CASE WHEN purpose='verification' THEN 0 WHEN kind='reply' THEN 1 ELSE 2 END, sequence LIMIT ?`, [now,gateway?.protocol_version??1,limit]);
    const result:GatewayJob[]=[];
    for (const row of rows) {
      const reply=row.kind==='reply'?await this.vault.open<ReplyJob['payload']>(row.payload_cipher):null;
      if (reply?.media && (gateway?.protocol_version??1)<3) continue;
      if (reply && row.purpose==='send') {
        const latest=await this.db.one<{context_cipher:string}>(
          'SELECT context_cipher FROM messages WHERE participant_id=? ORDER BY sequence DESC LIMIT 1',
          [row.participant_id??'personal']);
        if (latest) reply.context_token=await this.vault.open<string>(latest.context_cipher);
      }
      const state=reply?.media?'preparing':'sending';
      const claimToken=token();
      const update=await this.db.run(`UPDATE jobs SET state=?,attempts=attempts+1,claim_hash=?,claim_until=?,gateway_id=?
        WHERE id=? AND state='ready' AND available_at<=?
        AND (kind='webhook' OR EXISTS(SELECT 1 FROM participants WHERE id=jobs.participant_id AND enabled=1))`,
        [state,await hash(claimToken),now+this.cfg.jobLeaseMs,gatewayId,row.id,now]);
      if (!update.meta.changes) continue;
      if (row.kind==='reply') {
        result.push({id:row.id,kind:'reply',claim_token:claimToken,participant_id:row.participant_id??'personal',payload:reply!});
        continue;
      }
      const payload=await this.vault.open<WebhookPayload>(row.payload_cipher);
      let signature=new Webhook(payload.secret).sign(payload.event_id,new Date(now),payload.body);
      if (payload.old_secret && (payload.rotation_until??0)>now) {
        signature+=" "+new Webhook(payload.old_secret).sign(payload.event_id,new Date(now),payload.body);
      }
      result.push({id:row.id,kind:'webhook',claim_token:claimToken,payload:{url:payload.url,body:payload.body,headers:{
        'Content-Type':'application/json','webhook-id':payload.event_id,'webhook-timestamp':String(Math.floor(now/1000)),
        'webhook-signature':signature,'X-MCP-Subscription-Id':row.subscription_id!,
      }}});
    }
    return result;
  }

  async complete(gatewayId: string, result: JobResult, now: number) {
    const row=await this.db.one<Job>("SELECT * FROM jobs WHERE id=?", [result.job_id]);
    requireValue(row?.gateway_id===gatewayId && row.claim_hash===await hash(result.claim_token),"job_claim_invalid");
    // A zero deadline closes preparation while retaining its receipt for ACK retries.
    if (row.claim_until===0 && ['ready','failed'].includes(row.state)) {
      requireValue(['failed','retryable'].includes(result.outcome),'job_claim_invalid');
      return {accepted:true};
    }
    if (['delivered','cancelled'].includes(row.state)) return {accepted:true};
    requireValue(['preparing','sending','unknown','failed','ready'].includes(row.state),"job_state_invalid");
    requireValue(row.state!=='preparing' || row.claim_until>now,'job_claim_invalid');
    requireValue(['delivered','retryable','failed','unknown'].includes(result.outcome),"invalid_outcome",400);
    requireValue(row.state!=='preparing' || ['retryable','failed'].includes(result.outcome),'job_state_invalid');
    let state:string=result.outcome;
    const noRetry=result.http_status===410 || result.http_status===413;
    if (state==='retryable') state=noRetry || row.attempts>=this.cfg.maxDeliveryAttempts?'failed':'ready';
    if (row.kind==='webhook' && state==='unknown') state=row.attempts>=this.cfg.maxDeliveryAttempts?'failed':'ready';
    const delay=Math.min(60_000,1_000*2**Math.max(0,row.attempts-1));
    const statements=[this.db.statement(`UPDATE jobs SET state=?,available_at=?,http_status=?,error_code=?,error_message=?,response_challenge=?,
      claim_until=CASE WHEN ? THEN 0 ELSE claim_until END
      WHERE id=? AND claim_hash=? AND (?=0 OR (state='preparing' AND claim_until>?))`, [state,now+delay,result.http_status??null,result.error_code??null,
        result.error_message?.slice(0,256)??null,result.challenge??null,row.state==='preparing'?1:0,
        row.id,row.claim_hash,row.state==='preparing'?1:0,now])];
    if (row.kind==='reply' && state==='delivered') statements.push(this.db.statement(
      "UPDATE messages SET status='replied' WHERE reply_id=?", [row.id]));
    if (row.kind==='webhook' && result.http_status===410) statements.push(this.db.statement(
      "UPDATE subscriptions SET state='revoked' WHERE id=?", [row.subscription_id]));
    if (row.purpose==='wake' && state==='delivered') statements.push(this.db.statement(
      "UPDATE conversation SET wake_deadline=? WHERE session_id=? AND state='waking'",
      [now+this.cfg.wakeTimeoutMs,row.session_id]));
    await this.db.binding.batch(statements);
    return {accepted:true};
  }

  async heartbeat(gatewayId:string,jobId:string,claimToken:string,now:number) {
    const claimHash=await hash(claimToken);
    const update=await this.db.run(`UPDATE jobs SET claim_until=? WHERE id=? AND gateway_id=? AND claim_hash=?
      AND state='preparing' AND claim_until>?`,[now+this.cfg.jobLeaseMs,jobId,gatewayId,claimHash,now]);
    requireValue(update.meta.changes===1,'job_claim_invalid');
    return {claim_until:now+this.cfg.jobLeaseMs};
  }
  async startSend(gatewayId:string,jobId:string,claimToken:string,now:number) {
    const claimHash=await hash(claimToken);
    const update=await this.db.run(`UPDATE jobs SET state='sending',claim_until=? WHERE id=? AND gateway_id=? AND claim_hash=?
      AND state='preparing' AND claim_until>? AND EXISTS(SELECT 1 FROM participants p WHERE p.id=jobs.participant_id AND p.enabled=1)`,
      [now+this.cfg.jobLeaseMs,jobId,gatewayId,claimHash,now]);
    if (!update.meta.changes) {
      const row=await this.db.one<Job & {participant_enabled:number}>(`SELECT j.*,p.enabled AS participant_enabled
        FROM jobs j JOIN participants p ON p.id=j.participant_id WHERE j.id=?`,[jobId]);
      requireValue(row?.state==='sending' && row.gateway_id===gatewayId && row.claim_hash===claimHash
        && row.claim_until>now && row.participant_enabled===1,'job_claim_invalid');
    }
    return {accepted:true};
  }

  async resolve(id: string, action: string, acceptsDuplicateRisk: boolean, now: number) {
    const job=await this.db.one<Job>("SELECT * FROM jobs WHERE id=? AND kind='reply'", [id]);
    requireValue(job && ['failed','unknown'].includes(job.state),"reply_not_resolvable");
    requireValue(action==='skip' || action==='retry',"invalid_action",400);
    requireValue(job.state!=='unknown' || action==='skip' || acceptsDuplicateRisk,"duplicate_risk_confirmation_required");
    const state=action==='skip'?'cancelled':'ready';
    await this.db.binding.batch([
      this.db.statement("UPDATE jobs SET state=?,available_at=?,attempts=0 WHERE id=? AND state=?", [state,now,id,job.state]),
      this.db.statement("UPDATE messages SET status=? WHERE reply_id=?", [action==='skip'?'skipped':'reply_queued',id]),
    ]);
    return {reply_id:id,status:state};
  }
}
