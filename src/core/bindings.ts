import { Database } from './database.ts';
import { requireValue, string } from './errors.ts';
import { Vault } from './security.ts';
import { allEventsReady, Participants } from './participants.ts';

type State='queued'|'waiting'|'scanned'|'need_verifycode'|'confirmed'|'expired'|'cancelled'|'failed';
interface Binding {
  id:string;participant_id:string;state:State;qr_cipher:string|null;verification_cipher:string|null;
  error_code:string|null;expires_at:number;created_at:number;updated_at:number;
}
export interface BindingReport {id:string;state:State;qr_content?:string;sender?:string;bot_id?:string;error_code?:string}
const active="'queued','waiting','scanned','need_verifycode'";
const terminal=['confirmed','expired','cancelled','failed'];
export class Bindings {
  readonly participants:Participants;
  constructor(readonly db:Database,readonly vault:Vault) {this.participants=new Participants(db);}
  async get(id:string) {
    const row=await this.db.one<Binding>('SELECT * FROM binding_requests WHERE id=?',[id]);
    requireValue(row,'binding_not_found',404);return row;
  }
  private async expire(now:number) {
    await this.db.run(`UPDATE binding_requests SET state='expired',qr_cipher=NULL,verification_cipher=NULL,
      updated_at=? WHERE state IN (${active}) AND expires_at<=?`,[now,now]);
  }
  async create(participantId:string,now=Date.now()) {
    await this.participants.get(participantId,true);
    const other=await this.db.one('SELECT id FROM participants WHERE id<>? AND enabled=1 AND sender IS NOT NULL LIMIT 1',[participantId]);
    if(other) requireValue(await allEventsReady(this.db,now),'all_members_subscription_required');
    const id='bind_'+crypto.randomUUID();
    await this.db.binding.batch([
      this.db.statement(`UPDATE binding_requests SET state='cancelled',qr_cipher=NULL,verification_cipher=NULL,
        updated_at=? WHERE participant_id=? AND state IN (${active})`,[now,participantId]),
      this.db.statement('INSERT INTO binding_requests(id,participant_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?)',
        [id,participantId,now+300_000,now,now]),
    ]);
    return this.view(id,now);
  }
  async view(id:string,now=Date.now()) {
    await this.expire(now);
    const row=await this.get(id);
    return {id:row.id,participant_id:row.participant_id,state:row.state,expires_at:row.expires_at,
      qr_content:row.qr_cipher?await this.vault.open<string>(row.qr_cipher):null,error_code:row.error_code};
  }
  async verify(id:string,code:unknown,now=Date.now()) {
    requireValue(typeof code==='string' && /^\d{1,12}$/.test(code),'invalid_verification_code',400);
    await this.expire(now);
    const row=await this.get(id);await this.participants.get(row.participant_id,true);
    const result=await this.db.run(`UPDATE binding_requests SET verification_cipher=?,updated_at=?
      WHERE id=? AND state='need_verifycode' AND expires_at>?`,[await this.vault.seal(code),now,id,now]);
    requireValue(result.meta.changes===1,'binding_not_waiting_for_verification');
    return this.view(id,now);
  }
  async cancel(id:string,now=Date.now()) {
    await this.get(id);
    await this.db.run(`UPDATE binding_requests SET state='cancelled',qr_cipher=NULL,verification_cipher=NULL,
      updated_at=? WHERE id=? AND state IN (${active})`,[now,id]);
    return this.view(id,now);
  }
  async control(now=Date.now()) {
    await this.expire(now);
    const rows=await this.db.all<Binding>(`SELECT b.* FROM binding_requests b JOIN participants p ON p.id=b.participant_id
      WHERE b.state IN (${active}) AND p.enabled=1 ORDER BY b.created_at`);
    return Promise.all(rows.map(async row=>({id:row.id,participant_id:row.participant_id,state:row.state,
      expires_at:row.expires_at,...(row.verification_cipher?{verification_code:await this.vault.open<string>(row.verification_cipher)}:{})})));
  }
  async report(input:BindingReport,now=Date.now()) {
    string(input.id,'binding_id',128);
    requireValue(['waiting','scanned','need_verifycode','confirmed','expired','failed'].includes(input.state),'invalid_binding_state',400);
    await this.expire(now);
    const row=await this.get(input.id);
    if(terminal.includes(row.state)) return {accepted:input.state===row.state,state:row.state};
    await this.participants.get(row.participant_id,true);
    if(input.state==='confirmed') return this.confirm(row,input,now);
    requireValue(input.error_code===undefined || /^[a-zA-Z0-9_-]{1,80}$/.test(input.error_code),'invalid_error_code',400);
    let qr=row.qr_cipher;
    if(input.qr_content!==undefined) {
      string(input.qr_content,'qr_content',4096);
      let url:URL|undefined;try {url=new URL(input.qr_content);} catch {}
      requireValue(url?.protocol==='https:' && !url.username && !url.password,'invalid_qr_content',400);
      qr=await this.vault.seal(input.qr_content);
    }
    const clear=terminal.includes(input.state);
    const result=await this.db.run(`UPDATE binding_requests SET state=?,qr_cipher=?,
      verification_cipher=CASE WHEN ?='need_verifycode' THEN verification_cipher ELSE NULL END,error_code=?,updated_at=?
      WHERE id=? AND state IN (${active}) AND expires_at>?`,
      [input.state,clear?null:qr,input.state,input.error_code??null,now,row.id,now]);
    return {accepted:result.meta.changes===1,state:input.state};
  }
  private async confirm(row:Binding,input:BindingReport,now:number) {
    const sender=string(input.sender,'sender',256),bot=string(input.bot_id,'bot_id',256);
    const person=await this.participants.get(row.participant_id,true);
    requireValue(!person.sender || person.sender===sender,'binding_identity_mismatch');
    requireValue(!await this.db.one('SELECT id FROM participants WHERE sender=? AND id<>?',[sender,person.id]),'wechat_already_assigned');
    const other=await this.db.one('SELECT id FROM participants WHERE id<>? AND enabled=1 AND sender IS NOT NULL LIMIT 1',[person.id]);
    if(other) requireValue(await allEventsReady(this.db,now),'all_members_subscription_required');
    const results=await this.db.binding.batch([
      this.db.statement(`UPDATE participants SET sender=?,bot_id=?,binding_id=?,status='ok',updated_at=? WHERE id=? AND enabled=1
        AND (sender IS NULL OR sender=?) AND EXISTS(SELECT 1 FROM binding_requests WHERE id=?
          AND state IN (${active}) AND expires_at>?)`,[sender,bot,row.id,now,person.id,sender,row.id,now]),
      this.db.statement(`UPDATE binding_requests SET state='confirmed',qr_cipher=NULL,verification_cipher=NULL,error_code=NULL,
        updated_at=? WHERE id=? AND state IN (${active}) AND expires_at>? AND EXISTS(
          SELECT 1 FROM participants WHERE id=? AND sender=? AND bot_id=? AND enabled=1)`,[now,row.id,now,person.id,sender,bot]),
      ...(person.id==='personal'?[this.db.statement(`INSERT INTO settings(key,value) SELECT 'sender',?
        WHERE EXISTS(SELECT 1 FROM binding_requests WHERE id=? AND state='confirmed')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[sender,row.id])]:[]),
    ]);
    return {accepted:results[1].meta.changes===1,state:(await this.get(row.id)).state};
  }
}
