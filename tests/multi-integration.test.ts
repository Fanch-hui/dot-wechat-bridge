import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, message } from './helpers.ts';
import { hash, Vault } from '../src/core/security.ts';

const key=Buffer.alloc(32,7).toString('base64');
const vault=new Vault(key);
async function second(c:Awaited<ReturnType<typeof fixture>>) {
  await c.run("INSERT INTO participants(id,display_name,sender,bot_id,created_at,updated_at) VALUES('other','乙','other-wechat','other-bot',?,?)",[Date.now(),Date.now()]);
  const lease=await c.service('lease',{protocol_version:2});c.gateway.lease_token=lease.body.lease_token;
}
async function subscription(c:Awaited<ReturnType<typeof fixture>>,id:string,conversation:string) {
  await c.run(`INSERT INTO subscriptions(id,owner,conversation,url_cipher,secret_cipher,secret_hash,state,expires_at)
    VALUES(?,?,?,?,?,?,'active',?)`,[id,await hash('owner'),conversation,await vault.seal('https://callback.example/events'),
    await vault.seal('whsec_'+Buffer.alloc(32,4).toString('base64')),'synthetic',Date.now()+60000]);
}

test('all-member wake carries identity while personal subscriptions retain their original member',async t=>{
  const c=await fixture(t);await c.start();await second(c);
  await subscription(c,'all','all');await subscription(c,'personal','personal');
  await c.ingest([message('same')],'p1');
  const other=await c.service('ingest',{participant_id:'other',messages:[message('same','乙',{sender:'other-wechat'})],cursor:'o1',previous_cursor:''});
  assert.equal(other.status,200);await c.service('tick');
  const jobs=await c.jobs();assert.equal(jobs.length,3);
  const events=jobs.map(job=>{
    assert.equal(job.kind,'webhook');if(job.kind!=='webhook') throw new Error('expected webhook');
    return {subscription:job.payload.headers['X-MCP-Subscription-Id'],data:JSON.parse(job.payload.body).data};
  });
  assert.deepEqual(events.filter(x=>x.subscription==='personal').map(x=>x.data.participant_id),['personal']);
  assert.deepEqual(events.filter(x=>x.subscription==='all').map(x=>x.data.participant_id).sort(),['other','personal']);
  assert.equal(events.find(x=>x.data.participant_id==='other')?.data.display_name,'乙');
  assert.notEqual(events[0].data.session_id,events.find(x=>x.data.participant_id==='other')?.data.session_id);
});

test('an unknown send blocks only its own member and disabled queues retain their tasks',async t=>{
  const c=await fixture(t);await c.start();await second(c);
  const send=(participant_id:string,idempotency_key:string)=>c.ok('wechat_send_message',{participant_id,idempotency_key,text:'hello',wait_ms:0});
  await send('personal','one');await send('other','one');
  const first=await c.jobs();assert.equal(first.length,2);
  for(const job of first) {
    assert.equal(job.kind,'reply');if(job.kind!=='reply') throw new Error('expected reply');
    assert.equal(job.payload.to_user_id,job.participant_id==='personal'?'self-wechat':'other-wechat');
    await c.complete(job,{outcome:job.participant_id==='personal'?'unknown':'delivered'});
  }
  await send('personal','two');const b=await send('other','two');
  await c.run("UPDATE participants SET enabled=0 WHERE id='other'");
  assert.equal((await c.jobs()).length,0);
  assert.equal((await c.rows('SELECT state FROM jobs WHERE id=?',[b.reply_id]))[0].state,'ready');
  await c.run("UPDATE participants SET enabled=1 WHERE id='other'");
  const next=await c.jobs();assert.equal(next.length,1);assert.equal(next[0].id,b.reply_id);
});

test('schema upgrade preserves old sequences, encrypted payloads, live session, cursor and R2 objects',async t=>{
  const c=await fixture(t,{},false,'0004');const now=Date.now();
  await c.run("INSERT INTO settings(key,value) VALUES('owner',?),('sender','self-wechat')",[await hash('owner')]);
  await c.run("INSERT INTO gateway(id,gateway_id,lease_hash,lease_until,cursor,status) VALUES('personal','old','synthetic',?,'saved-cursor','ok')",[now+90000]);
  const context=await vault.seal('legacy context'),payload=await vault.seal({text:'legacy reply',to_user_id:'self-wechat'});
  const descriptor={id:'media_abcdef',item_index:0,kind:'file',name:'old.txt',mime_type:'text/plain',size:3,sha256:'synthetic',
    uri:'wechat://attachments/media_abcdef/old.txt',status:'ready'};
  await c.run(`INSERT INTO attachments(id,upstream_id,item_index,kind,name,mime_type,size,sha256,created_at)
    VALUES('media_abcdef','same',0,'file','old.txt','text/plain',3,'synthetic',?)`,[now]);
  await (await c.mf.getR2Bucket('MEDIA')).put('media_abcdef/synthetic',Buffer.from('old'));
  await c.run(`INSERT INTO messages(sequence,upstream_id,sender,occurred_at,text,kind,context_cipher,attachments_json,status,reply_id)
    VALUES(37,'same','self-wechat',?,'legacy','text',?,?,'reply_queued','old-output')`,[now,context,JSON.stringify([descriptor])]);
  await c.run(`INSERT INTO jobs(sequence,id,kind,purpose,payload_cipher,message_ids,state,available_at,created_at)
    VALUES(21,'old-output','reply','reply',?,'[37]','ready',?,?)`,[payload,now,now]);
  await c.run(`INSERT INTO conversation(id,session_id,state,consumer_id,lease_hash,lease_cipher,lease_until,last_activity,created_at)
    VALUES('personal','old-session','active','old-dot',?,?,?, ?,?)`,[await hash('old-lease'),await vault.seal('old-lease'),now+90000,now,now]);
  const before=await c.rows('SELECT * FROM jobs');
  for(const sql of (await readFile('drizzle/0005_romantic_millenium_guard.sql','utf8')).split('--> statement-breakpoint')) if(sql.trim()) await c.run(sql);
  const status=await c.ok('wechat_bridge_status');assert.equal(status.session.session_id,'old-session');
  assert.equal(status.participants[0].display_name,'我');
  assert.equal((await c.rows("SELECT cursor FROM participants WHERE id='personal'"))[0].cursor,'saved-cursor');
  const after=await c.rows('SELECT * FROM jobs');const {participant_id,...oldJob}=after[0];
  assert.equal(participant_id,'personal');assert.deepEqual(oldJob,before[0]);
  const history=await c.ok('wechat_read_history');assert.equal(history.messages[0].sequence,37);
  assert.equal(history.replies[0].text,'legacy reply');assert.equal(history.messages[0].attachments[0].uri,descriptor.uri);
  const file=await c.ok('wechat_read_attachment',{attachment_id:descriptor.id});assert.equal(file.attachment.id,descriptor.id);
  const response=await c.tool('wechat_read_attachment',{attachment_id:descriptor.id});
  assert.equal(Buffer.from(response.content[1].resource.blob,'base64').toString(),'old');
  const read=await c.ok('wechat_read_messages',{session_id:'old-session',lease_token:'old-lease'});assert.equal(read.participant_id,'personal');
  await c.run("INSERT INTO participants(id,display_name,sender,created_at,updated_at) VALUES('other','乙','other-wechat',?,?)",[now,now]);
  await c.run(`INSERT INTO messages(participant_id,upstream_id,sender,occurred_at,text,kind,context_cipher)
    VALUES('other','same','other-wechat',?,'new','text',?)`,[now,context]);
  assert.equal((await c.rows("SELECT sequence FROM messages WHERE participant_id='other'"))[0].sequence,38);
});
