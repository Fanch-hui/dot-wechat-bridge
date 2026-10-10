import { Database } from "./database.ts";
import { Config } from "./config.ts";
import { hash, Vault, token } from "./security.ts";
import { requireValue } from "./errors.ts";
import { Session } from "./models.ts";

const select = `SELECT c.*,c.id AS participant_id,p.display_name FROM conversation c
  JOIN participants p ON p.id=c.id`;

export class Sessions {
  constructor(readonly db: Database, readonly vault: Vault, readonly cfg: Config) {}
  current(participantId = 'personal') {
    return this.db.one<Session>(`${select} WHERE c.id=?`, [participantId]);
  }
  all() { return this.db.all<Session>(`${select} ORDER BY p.created_at,p.id`); }
  private bySession(sessionId: string, enabled = false) {
    return this.db.one<Session>(`${select} WHERE c.session_id=?${enabled ? ' AND p.enabled=1' : ''}`, [sessionId]);
  }
  async ensure(now: number, freshMessage = false, participantId = 'personal') {
    const pending = await this.db.one<{n:number}>(`SELECT count(*) AS n FROM messages m JOIN participants p ON p.id=m.participant_id
      WHERE m.status='pending' AND m.participant_id=? AND p.enabled=1`, [participantId]);
    if (!pending?.n) return this.current(participantId);
    await this.db.run(`INSERT INTO conversation(id,session_id,state,last_activity,created_at)
      VALUES(?,?,'waking',?,?) ON CONFLICT(id) DO UPDATE SET
      session_id=excluded.session_id,state='waking',consumer_id=NULL,lease_hash=NULL,lease_cipher=NULL,
      lease_until=0,wake_attempts=0,wake_deadline=0,created_at=excluded.created_at,last_activity=excluded.last_activity
      WHERE conversation.state IN ('ended','expired') OR
      (conversation.state='active' AND (conversation.lease_until<=? OR conversation.created_at+?<=?))
      OR (conversation.state='wake_failed' AND ?=1)`,
      [participantId,crypto.randomUUID(),now,now,now,this.cfg.maxSessionMs,now,freshMessage?1:0]);
    if (freshMessage) await this.db.run("UPDATE conversation SET last_activity=? WHERE id=?", [now,participantId]);
    return this.current(participantId);
  }
  async confirm(sessionId: string, consumer: string, now: number) {
    const lease = token();
    await this.db.run(`UPDATE conversation SET state='active',consumer_id=?,lease_hash=?,lease_cipher=?,lease_until=?
      WHERE session_id=? AND state IN ('waking','wake_failed')
      AND EXISTS(SELECT 1 FROM participants p WHERE p.id=conversation.id AND p.enabled=1)`,
      [consumer,await hash(lease),await this.vault.seal(lease),now+this.cfg.leaseMs,sessionId]);
    const row = await this.bySession(sessionId,true);
    requireValue(row?.state==='active' && row.consumer_id===consumer && row.lease_until>now,
      "session_already_claimed_or_expired");
    await this.db.run("UPDATE jobs SET state='cancelled' WHERE purpose='wake' AND session_id=? AND state='ready'", [sessionId]);
    return {session_id:sessionId,participant_id:row.participant_id,display_name:row.display_name,
      lease_token:await this.vault.open<string>(row.lease_cipher!),lease_until:row.lease_until,
      read_wait_ms:this.cfg.readWaitMs,idle_timeout_ms:this.cfg.idleMs,max_session_ms:this.cfg.maxSessionMs};
  }
  async authorize(sessionId: string, lease: string, now: number) {
    const row = await this.bySession(sessionId,true);
    requireValue(row?.state==='active' && row.lease_until>now &&
      row.lease_hash===await hash(lease) && row.created_at+this.cfg.maxSessionMs>now, "session_lease_invalid");
    return row;
  }
  async heartbeat(sessionId: string, lease: string, now: number) {
    const row = await this.authorize(sessionId,lease,now);
    await this.db.run("UPDATE conversation SET lease_until=? WHERE session_id=? AND lease_hash=? AND state='active'",
      [now+this.cfg.leaseMs,sessionId,row.lease_hash]);
    return {participant_id:row.participant_id,display_name:row.display_name,
      lease_until:now+this.cfg.leaseMs,should_end:now-row.last_activity>=this.cfg.idleMs};
  }
  async end(sessionId: string, lease: string, now: number) {
    const ended=await this.bySession(sessionId);
    if (ended?.state==='ended' && ended.lease_hash===await hash(lease)) return {ended:true,reason:'idle'};
    const row = await this.authorize(sessionId,lease,now);
    const result=await this.db.run(`UPDATE conversation SET state='ended',lease_until=0
      WHERE session_id=? AND lease_hash=? AND state='active'
      AND NOT EXISTS(SELECT 1 FROM messages WHERE participant_id=? AND status='pending')`, [sessionId,row.lease_hash,row.participant_id]);
    return {ended:result.meta.changes===1,reason:result.meta.changes===1?"idle":"messages_pending"};
  }
  async recover(now: number, participantId = 'personal') {
    const participant=await this.db.one<{enabled:number}>("SELECT enabled FROM participants WHERE id=?", [participantId]);
    requireValue(participant?.enabled===1,"participant_disabled");
    const row=await this.current(participantId);
    requireValue(!row || row.state!=='active' || row.lease_until<=now, "session_is_active");
    await this.db.run("UPDATE conversation SET state='expired' WHERE id=?", [participantId]);
    const next=await this.ensure(now,false,participantId);
    return {participant_id:participantId,session:next?{session_id:next.session_id,participant_id:next.participant_id,
      display_name:next.display_name,state:next.state}:null};
  }
}
