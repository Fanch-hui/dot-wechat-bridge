import { Database } from "./database.ts";
import { Vault, hash } from "./security.ts";
import { Job } from "./models.ts";
import { requireValue } from "./errors.ts";

export class Outbound {
  constructor(readonly db: Database, readonly vault: Vault) {}
  async send(key: string, text: string, now: number, participantId = 'personal') {
    const participant=await this.db.one<{sender:string|null;enabled:number}>("SELECT sender,enabled FROM participants WHERE id=?", [participantId]);
    requireValue(participant?.sender,"wechat_not_bound");
    requireValue(participant.enabled===1,"participant_disabled");
    const id="send_"+(await hash(participantId==='personal'?key:JSON.stringify([participantId,key]))).replaceAll(/[+/=]/g,"");
    const existing=await this.db.one<Job>("SELECT * FROM jobs WHERE id=?", [id]);
    if (existing) return this.check(existing,text);
    const last=await this.db.one<{sequence:number;context_cipher:string}>(
      "SELECT sequence,context_cipher FROM messages WHERE participant_id=? ORDER BY sequence DESC LIMIT 1", [participantId]);
    const context=last?await this.vault.open<string>(last.context_cipher):'';
    const payload=await this.vault.seal({client_id:id,to_user_id:participant.sender,text,context_token:context});
    await this.db.run(`INSERT OR IGNORE INTO jobs(id,kind,purpose,participant_id,payload_cipher,message_ids,available_at,created_at)
      SELECT ?,'reply','send',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM participants WHERE id=? AND enabled=1)`,
      [id,participantId,payload,JSON.stringify(last?[last.sequence]:[]),now,now,participantId]);
    const job=await this.db.one<Job>("SELECT * FROM jobs WHERE id=?", [id]);
    requireValue(job,"participant_disabled");
    return this.check(job,text);
  }
  private async check(job: Job, text: string) {
    const saved=await this.vault.open<{text:string}>(job.payload_cipher);
    requireValue(saved.text===text,"idempotency_conflict");
    return {reply_id:job.id,status:job.state};
  }
}
