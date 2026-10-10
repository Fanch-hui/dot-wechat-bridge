import { config, Env } from "./config.ts";
import { Database } from "./database.ts";
import { Vault, hash } from "./security.ts";
import { Sessions } from "./sessions.ts";
import { Messages } from "./messages.ts";
import { Outbound } from "./outbound.ts";
import { Queue } from "./queue.ts";
import { GatewayControl } from "./gateway.ts";
import { Subscriptions } from "../events/subscriptions.ts";
import { Wake } from "../events/wake.ts";
import { Job, Message } from "./models.ts";
import { requireValue, pause } from "./errors.ts";
import { delivery } from "./delivery.ts";
import { Attachments } from "./attachments.ts";
import { Participants } from "./participants.ts";
import { Bindings } from "./bindings.ts";
import { messageView } from "./message-view.ts";
import { OutgoingMediaStore, mediaDescription } from "./outgoing-media.ts";
import type { ReplyJob } from "../shared/contracts.ts";

export class Bridge {
  readonly db:Database; readonly vault:Vault; readonly sessions:Sessions; readonly messages:Messages;
  readonly outbound:Outbound; readonly queue:Queue; readonly gateway:GatewayControl; readonly subscriptions:Subscriptions; readonly wake:Wake;
  readonly media:OutgoingMediaStore; readonly attachments:Attachments; readonly participants:Participants; readonly bindings:Bindings;
  constructor(readonly env:Env) {
    const cfg=config(env);
    this.db=new Database(env.DB); this.vault=new Vault(env.DATA_KEY_B64);
    this.participants=new Participants(this.db); this.bindings=new Bindings(this.db,this.vault);
    this.attachments=new Attachments(this.db,env.MEDIA);
    this.media=new OutgoingMediaStore(this.db,this.vault,env.MEDIA);
    this.sessions=new Sessions(this.db,this.vault,cfg); this.messages=new Messages(this.db,this.vault,this.sessions,this.attachments);
    this.outbound=new Outbound(this.db,this.vault);
    this.queue=new Queue(this.db,this.vault,cfg); this.gateway=new GatewayControl(this.db,cfg);
    this.subscriptions=new Subscriptions(this.db,this.vault,this.queue,cfg);
    this.wake=new Wake(this.db,this.sessions,this.queue,this.vault);
  }
  async owner(identity:string | null) {
    requireValue(identity,"authentication_required",401);
    const principal=await hash(identity);
    await this.db.run("INSERT OR IGNORE INTO settings(key,value) VALUES('owner',?)", [principal]);
    requireValue(await this.db.get("owner")===principal,"owner_access_required",403);
    await this.participants.initializeLegacy();
    return principal;
  }
  async status() {
    const current=await this.sessions.current();
    const participants=await this.participants.list(), sessions=await this.sessions.all();
    const counts=await this.db.all<{status:string;count:number}>("SELECT status,count(*) AS count FROM messages GROUP BY status");
    const issues=await this.db.all<Job>(
      "SELECT * FROM jobs WHERE kind='reply' AND state IN ('failed','unknown') ORDER BY sequence LIMIT 20");
    const gateway=await this.db.one<{status:string;lease_until:number;protocol_version:number}>("SELECT status,lease_until,protocol_version FROM gateway WHERE id='personal'");
    const subscriptions=await this.db.all<{state:string;count:number}>("SELECT state,count(*) AS count FROM subscriptions GROUP BY state");
    return {participants,sessions:sessions.map(row=>({participant_id:row.participant_id,display_name:row.display_name,session_id:row.session_id,
      state:row.state,lease_until:row.lease_until,wake_attempts:row.wake_attempts})),bound:!!await this.db.get("sender"),gateway:gateway??null,media_send_ready:!!gateway && gateway.protocol_version>=3 && gateway.status==='ok' && gateway.lease_until>Date.now(),message_counts:counts,delivery_issues:issues.map(job=>({...delivery(job),participant_id:job.participant_id,
      display_name:participants.find(row=>row.participant_id===job.participant_id)?.display_name})),subscriptions,
      session:current?{participant_id:current.participant_id,display_name:current.display_name,session_id:current.session_id,state:current.state,lease_until:current.lease_until,
        wake_attempts:current.wake_attempts}:null};
  }
  async replyStatus(id:string,waitMs:number) {
    const deadline=Date.now()+Math.min(waitMs,25_000);
    while (true) {
      const job=await this.db.one<Job>("SELECT * FROM jobs WHERE id=?", [id]);
      requireValue(job,"reply_not_found",404);
      if (['delivered','unknown','failed','cancelled'].includes(job.state) || Date.now()>=deadline) return {...delivery(job),participant_id:job.participant_id};
      await pause(200);
    }
  }
  async history(before:number,limit:number,participantId = 'personal') {
    const rows=await this.db.all<Message>(`SELECT m.*,p.display_name FROM messages m JOIN participants p ON p.id=m.participant_id
      WHERE m.participant_id=? AND m.sequence<? ORDER BY m.sequence DESC LIMIT ?`, [participantId,before,limit]);
    const linked=rows.length?`EXISTS(SELECT 1 FROM json_each(j.message_ids) r WHERE r.value IN (${rows.map(()=>'?').join(',')}))`:'0';
    const jobs=await this.db.all<Job>(`SELECT j.* FROM jobs j WHERE j.kind='reply' AND j.participant_id=? AND (${linked} OR (?=1 AND j.id IN (
      SELECT id FROM jobs WHERE participant_id=? AND purpose='send' AND message_ids='[]' ORDER BY sequence DESC LIMIT ?))) ORDER BY j.sequence`,
      [participantId,...rows.map(r=>r.sequence),before===Number.MAX_SAFE_INTEGER?1:0,participantId,limit]);
    const replies=await Promise.all(jobs.map(async job=>{
      const payload=await this.vault.open<ReplyJob['payload']>(job.payload_cipher);
      return {...delivery(job),purpose:job.purpose,message_ids:JSON.parse(job.message_ids!),text:payload.text,
        ...(payload.media?{media:mediaDescription(payload.media)}:{})};
    }));
    const participant=await this.participants.get(participantId);
    return {participant_id:participantId,display_name:participant.display_name,messages:rows.reverse().map(messageView),replies};
  }
}
