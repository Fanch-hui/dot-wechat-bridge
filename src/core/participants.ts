import { Database } from './database.ts';
import { requireValue, string } from './errors.ts';

export interface Participant {
  id:string; display_name:string; enabled:number; sender:string|null; bot_id:string|null; binding_id:string|null;
  cursor:string; status:string; created_at:number; updated_at:number;
}
export async function allEventsReady(db:Database,now=Date.now()) {
  return !!await db.one(`SELECT id FROM subscriptions WHERE conversation='all' AND state='active'
    AND (expires_at IS NULL OR expires_at>?) LIMIT 1`,[now]);
}
export class Participants {
  constructor(readonly db:Database) {}
  async initializeLegacy() {
    const now=Date.now();
    await this.db.run(`INSERT OR IGNORE INTO participants(id,display_name,sender,cursor,status,created_at,updated_at)
      VALUES('personal','我',(SELECT value FROM settings WHERE key='sender'),
      COALESCE((SELECT cursor FROM gateway WHERE id='personal'),''),
      CASE WHEN EXISTS(SELECT 1 FROM settings WHERE key='sender')
        THEN COALESCE((SELECT status FROM gateway WHERE id='personal'),'ok') ELSE 'unbound' END,?,?)`,[now,now]);
  }
  async get(id:string,requireEnabled=false) {
    const row=await this.db.one<Participant>('SELECT * FROM participants WHERE id=?',[id]);
    requireValue(row,'participant_not_found',404);
    if(requireEnabled) requireValue(row.enabled===1,'participant_disabled');
    return row;
  }
  async resolve(id?:string) {
    if(id) return this.get(id);
    const rows=await this.db.all<Participant>('SELECT * FROM participants LIMIT 2');
    requireValue(rows.length===1,'participant_required',400);
    return rows[0];
  }
  async list() {
    const rows=await this.db.all<Participant & {last_seen_at:number|null;delivery_issues:number}>(`SELECT p.*,
      (SELECT MAX(occurred_at) FROM messages m WHERE m.participant_id=p.id) AS last_seen_at,
      (SELECT COUNT(*) FROM jobs j WHERE j.participant_id=p.id AND j.kind='reply'
        AND j.state IN ('failed','unknown')) AS delivery_issues FROM participants p ORDER BY p.created_at,p.id`);
    return rows.map(row=>({participant_id:row.id,display_name:row.display_name,enabled:row.enabled===1,
      bound:!!row.sender,status:row.status,last_seen_at:row.last_seen_at,delivery_issues:row.delivery_issues}));
  }
  async create(name:unknown) {
    const displayName=string(name,'display_name',80).trim();
    requireValue(displayName.length>0,'invalid_display_name',400);
    const id='person_'+crypto.randomUUID(),now=Date.now();
    await this.db.run('INSERT INTO participants(id,display_name,created_at,updated_at) VALUES(?,?,?,?)',[id,displayName,now,now]);
    return {participant_id:id,display_name:displayName,enabled:true,bound:false,status:'unbound'};
  }
  async update(id:string,input:{display_name?:unknown;enabled?:unknown}) {
    const row=await this.get(id);
    requireValue(input.display_name!==undefined || input.enabled!==undefined,'empty_update',400);
    const name=input.display_name===undefined?row.display_name:string(input.display_name,'display_name',80).trim();
    requireValue(name.length>0,'invalid_display_name',400);
    requireValue(input.enabled===undefined || typeof input.enabled==='boolean','invalid_enabled',400);
    const enabled=input.enabled===undefined?row.enabled:input.enabled?1:0;
    if(enabled===1 && row.enabled===0 && row.sender) {
      const other=await this.db.one('SELECT id FROM participants WHERE id<>? AND enabled=1 AND sender IS NOT NULL LIMIT 1',[id]);
      if(other) requireValue(await allEventsReady(this.db),'all_members_subscription_required');
    }
    const now=Date.now();
    await this.db.binding.batch([
      this.db.statement('UPDATE participants SET display_name=?,enabled=?,updated_at=? WHERE id=?',[name,enabled,now,id]),
      ...(enabled===0?[
        this.db.statement(`UPDATE binding_requests SET state='cancelled',qr_cipher=NULL,verification_cipher=NULL,
          updated_at=? WHERE participant_id=? AND state IN ('queued','waiting','scanned','need_verifycode')`,[now,id]),
        this.db.statement(`UPDATE conversation SET state='expired',lease_until=0,lease_hash=NULL,lease_cipher=NULL,
          consumer_id=NULL WHERE id=? AND state<>'ended'`,[id]),
        this.db.statement("UPDATE jobs SET state='cancelled' WHERE participant_id=? AND purpose='wake' AND state='ready'",[id]),
      ]:[]),
    ]);
    return {participant_id:id,display_name:name,enabled:enabled===1,bound:!!row.sender,status:row.status};
  }
  async bindLegacy(sender:string,botId?:string) {
    string(sender,'sender',256);
    requireValue(await this.db.get('owner'),'connect_owner_plugin_first');
    const row=await this.get('personal');
    requireValue(!row.sender || row.sender===sender,'another_wechat_is_already_bound');
    const old=await this.db.get('sender');
    requireValue(!old || old===sender,'another_wechat_is_already_bound');
    requireValue(!await this.db.one('SELECT id FROM participants WHERE sender=? AND id<>?',[sender,'personal']),
      'wechat_already_assigned');
    await this.db.binding.batch([
      this.db.statement("INSERT OR IGNORE INTO settings(key,value) VALUES('sender',?)",[sender]),
      this.db.statement("UPDATE participants SET sender=?,bot_id=COALESCE(?,bot_id),status='ok',updated_at=? WHERE id='personal' AND (sender IS NULL OR sender=?)",
        [sender,botId??null,Date.now(),sender]),
    ]);
    requireValue((await this.get('personal')).sender===sender,'another_wechat_is_already_bound');
    return {bound:true,participant_id:'personal'};
  }
}
