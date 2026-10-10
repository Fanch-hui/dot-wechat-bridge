import { Database } from "../core/database.ts";
import { Config } from "../core/config.ts";
import { Queue } from "../core/queue.ts";
import { equal, hash, token, Vault } from "../core/security.ts";
import { pause, requireValue, BridgeError } from "../core/errors.ts";
import { Job, Subscription } from "../core/models.ts";
import { EVENT_NAME } from "./catalog.ts";

export class CallbackError extends BridgeError {
  constructor(readonly reason: string) { super("callback_endpoint_error",400); }
}
interface SubscribeParams {
  name?:unknown; arguments?:unknown; delivery?:{mode?:unknown;url?:unknown;secret?:unknown};
  cursor?:unknown; ttlMs?:unknown;
}
export class Subscriptions {
  constructor(readonly db: Database, readonly vault: Vault, readonly queue: Queue, readonly cfg: Config) {}
  private async identity(owner: string, args: SubscribeParams) {
    requireValue(args.name===EVENT_NAME && args.delivery?.mode==='webhook',"invalid_event",400);
    const filter=args.arguments as Record<string,unknown> | undefined;
    requireValue(filter && ['personal','all'].includes(filter.conversation as string) && Object.keys(filter).length===1,"invalid_event_filter",400);
    requireValue(args.cursor===undefined || args.cursor===null,"event_replay_not_supported",400);
    requireValue(typeof args.delivery.url==='string',"invalid_callback_url",400);
    let url:URL;
    try {url=new URL(args.delivery.url);} catch {throw new CallbackError("invalid_url");}
    requireValue(url.protocol==='https:' && !url.username && !url.password && !url.hash,
      "invalid_callback_url",400);
    return {id:"sub_"+(await hash(JSON.stringify([owner,url.href,EVENT_NAME,{conversation:filter.conversation}])))
      .replaceAll(/[+/=]/g,""),url:url.href,conversation:filter.conversation as string};
  }

  async subscribe(owner: string, args: SubscribeParams) {
    const {id,url,conversation}=await this.identity(owner,args);
    const secret=args.delivery!.secret;
    requireValue(typeof secret==='string' && /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret),"invalid_signing_secret",400);
    let size:number;
    try {size=atob(secret.slice(6)).length;} catch {throw new BridgeError("invalid_signing_secret",400);}
    requireValue(size>=24 && size<=64,"invalid_signing_secret",400);
    requireValue(args.ttlMs===undefined || args.ttlMs===null || (Number.isSafeInteger(args.ttlMs) && Number(args.ttlMs)>0),
      "invalid_ttl",400);
    const ttl=Math.max(1_000,Math.min(typeof args.ttlMs==='number'?args.ttlMs:this.cfg.subscriptionTtlMs,this.cfg.subscriptionTtlMs));
    const now=Date.now(), secretHash=await hash(secret);
    const old=await this.db.one<Subscription>("SELECT * FROM subscriptions WHERE id=? AND owner=?", [id,owner]);
    if (old?.state==='active' && old.secret_hash===secretHash && old.verified_until>now) {
      await this.db.run("UPDATE subscriptions SET expires_at=? WHERE id=? AND owner=?", [now+ttl,id,owner]);
      return {id,refreshBefore:new Date(now+ttl).toISOString(),cursor:null,truncated:false};
    }
    const jobId="verify_"+crypto.randomUUID(), challenge=token();
    const oldSecret=old?.secret_hash!==secretHash && old?.state==='active'?old.secret_cipher:null;
    const rotationUntil=oldSecret?now+this.cfg.rotationMs:0;
    await this.db.run(`INSERT INTO subscriptions(id,owner,url_cipher,secret_cipher,secret_hash,old_secret_cipher,
      rotation_until,expires_at,state,verification_job,conversation) VALUES(?,?,?,?,?,?,?,?,'verifying',?,?)
      ON CONFLICT(id) DO UPDATE SET secret_cipher=excluded.secret_cipher,secret_hash=excluded.secret_hash,
      old_secret_cipher=excluded.old_secret_cipher,rotation_until=excluded.rotation_until,
      expires_at=excluded.expires_at,state='verifying',verification_job=excluded.verification_job`,
      [id,owner,await this.vault.seal(url),await this.vault.seal(secret),secretHash,oldSecret,rotationUntil,now+ttl,jobId,conversation]);
    await this.queue.enqueue(jobId,'verification',{url,secret,event_id:jobId,
      body:JSON.stringify({type:'verification',challenge})},id,now);
    const deadline=now+this.cfg.verifyWaitMs;
    while (Date.now()<deadline) {
      const job=await this.db.one<Job>("SELECT * FROM jobs WHERE id=?", [jobId]);
      if (job?.state==='delivered') {
        if (!equal(job.response_challenge??"",challenge)) throw new CallbackError("challenge_failed");
        const expires=Date.now()+ttl;
        const updated=await this.db.run(`UPDATE subscriptions SET state='active',expires_at=?,verified_until=?
          WHERE id=? AND owner=? AND verification_job=? AND state='verifying'`, [expires,Date.now()+300_000,id,owner,jobId]);
        requireValue(updated.meta.changes===1,"subscription_changed_during_verification");
        return {id,refreshBefore:new Date(expires).toISOString(),cursor:null,truncated:false};
      }
      if (job?.state==='failed') throw new CallbackError(job.error_code==='callback_address_blocked'?'invalid_url':'challenge_failed');
      await pause(100);
    }
    await this.db.run("UPDATE jobs SET state='cancelled' WHERE id=? AND state='ready'", [jobId]);
    throw new CallbackError("timeout");
  }

  async unsubscribe(owner: string, args: SubscribeParams) {
    const {id}=await this.identity(owner,args);
    await this.db.binding.batch([
      this.db.statement("UPDATE subscriptions SET state='revoked' WHERE id=? AND owner=?", [id,owner]),
      this.db.statement("UPDATE jobs SET state='cancelled' WHERE subscription_id=? AND state='ready'", [id]),
    ]);
    return {};
  }
}
