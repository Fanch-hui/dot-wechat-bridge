import { Database } from "../core/database.ts";
import { Sessions } from "../core/sessions.ts";
import { Queue } from "../core/queue.ts";
import { Vault } from "../core/security.ts";
import { Subscription } from "../core/models.ts";
import { EVENT_NAME } from "./catalog.ts";

export class Wake {
  constructor(readonly db: Database, readonly sessions: Sessions, readonly queue: Queue, readonly vault: Vault) {}
  async tick(now: number) {
    await this.queue.maintain(now);
    const participants=await this.db.all<{id:string;display_name:string}>("SELECT id,display_name FROM participants WHERE enabled=1 AND sender IS NOT NULL");
    for (const participant of participants) await this.participantTick(participant,now);
  }
  private async participantTick(participant:{id:string;display_name:string},now:number) {
    const session=await this.sessions.ensure(now,false,participant.id);
    if (!session || session.state!=='waking' || session.wake_deadline>now) return;
    const pending=await this.db.one<{n:number;first:number;last:number}>(
      "SELECT count(*) AS n,min(sequence) AS first,max(sequence) AS last FROM messages WHERE status='pending' AND participant_id=?",[participant.id]);
    if (!pending?.n) return;
    const subs=await this.db.all<Subscription>(`SELECT * FROM subscriptions WHERE state='active'
      AND (expires_at IS NULL OR expires_at>?) AND owner=(SELECT value FROM settings WHERE key='owner')
      AND (conversation='all' OR (conversation='personal' AND ?='personal'))`, [now,participant.id]);
    if (!subs.length) return;
    const inFlight=await this.db.one<{n:number}>(
      "SELECT count(*) AS n FROM jobs WHERE purpose='wake' AND session_id=? AND state IN ('ready','sending')", [session.session_id]);
    if (inFlight?.n) return;
    if (session.wake_attempts>=this.sessions.cfg.maxWakeAttempts) {
      await this.db.run("UPDATE conversation SET state='wake_failed' WHERE session_id=? AND state='waking'", [session.session_id]);
      return;
    }
    const claimed=await this.db.run(`UPDATE conversation SET wake_attempts=wake_attempts+1,wake_deadline=?
      WHERE session_id=? AND state='waking' AND wake_attempts=? AND wake_deadline<=?`,
      [now+this.sessions.cfg.wakeTimeoutMs,session.session_id,session.wake_attempts,now]);
    if (!claimed.meta.changes) return;
    const attempt=session.wake_attempts+1;
    const eventId=`evt_${session.session_id}_${attempt}`;
    const body=JSON.stringify({eventId,name:EVENT_NAME,timestamp:new Date(now).toISOString(),data:{
      participant_id:participant.id,display_name:participant.display_name,
      session_id:session.session_id,pending_count:pending.n,first_sequence:pending.first,last_sequence:pending.last,attempt,
    },cursor:null});
    for (const sub of subs) {
      await this.queue.enqueue(`${sub.id}_${eventId}`,'wake',{
        url:await this.vault.open<string>(sub.url_cipher),secret:await this.vault.open<string>(sub.secret_cipher),body,event_id:eventId,
        ...(sub.old_secret_cipher && sub.rotation_until>now?{old_secret:await this.vault.open<string>(sub.old_secret_cipher),
          rotation_until:sub.rotation_until}:{}),
      },sub.id,now,session.session_id,participant.id);
    }
  }
}
