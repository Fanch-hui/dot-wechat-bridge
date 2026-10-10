import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, sessionArgs, type Client } from './helpers.ts';
import type { ReplyJob } from '../src/shared/contracts.ts';

const media=(key:string,patch:Record<string,unknown>={})=>({kind:'file',name:'report.txt',data_base64:Buffer.from('hello').toString('base64'),idempotency_key:key,wait_ms:0,...patch});
const errorOf=(result:any)=>result.structuredContent.error;
async function start(c:Client,version=3) {
  await c.start();const lease=await c.service('lease',{protocol_version:version});
  assert.equal(lease.status,200);c.gateway.lease_token=lease.body.lease_token;
}
const fields=(job:ReplyJob)=>({job_id:job.id,claim_token:job.claim_token});
async function download(c:Client,job:ReplyJob,patch={}) {
  return c.mf.dispatchFetch('http://bridge.test/gateway/media-download',{method:'POST',headers:{
    'Content-Type':'application/json',Authorization:'Bearer test-service-token'},body:JSON.stringify({...c.gateway,...fields(job),...patch})});
}
async function cache(c:Client,job:ReplyJob,value='downloaded') {
  const response=await c.mf.dispatchFetch('http://bridge.test/gateway/media-cache',{method:'POST',headers:{
    'Content-Type':'application/octet-stream',Authorization:'Bearer test-service-token','X-Bridge-Gateway-Id':c.gateway.gateway_id,
    'X-Bridge-Lease':c.gateway.lease_token,'X-Bridge-Job-Id':job.id,'X-Bridge-Claim-Token':job.claim_token},body:Buffer.from(value)});
  return {status:response.status,body:await response.json() as any};
}
async function complete(c:Client,job:ReplyJob) {
  assert.equal((await c.service('start-send',fields(job))).status,200);await c.complete(job);
}
async function second(c:Client) {
  await c.run("INSERT INTO participants(id,display_name,sender,created_at,updated_at) VALUES('other','乙','other-wechat',?,?)",[Date.now(),Date.now()]);
}

test('media sends require owner, protocol 3 and a valid single source; inline bytes are retained',async t=>{
  const c=await fixture(t);await start(c,2);
  assert.equal(errorOf(await c.tool('wechat_send_media',media('old'))),'gateway_media_not_ready');
  await start(c);
  assert.equal((await c.rpc('tools/call',{name:'wechat_send_media',arguments:media('forbidden')},'stranger')).status,403);
  for(const patch of [{data_base64:'a==='},{data_base64:'Zh=='},{source_url:'https://example.com/a'},
    {data_base64:undefined,source_url:'http://example.com/a'}, {data_base64:undefined,source_url:'https://127.0.0.1/a'},
    {data_base64:undefined,source_url:'https://user:secret@example.com/a'}, {name:'../bad.txt'}]) {
    assert.equal((await c.tool('wechat_send_media',media('invalid',patch))).isError,true);
  }
  assert.equal(errorOf(await c.tool('wechat_send_media',media('large',{data_base64:Buffer.alloc(524289).toString('base64')}))),'inline_media_too_large');
  const queued=await c.ok('wechat_send_media',media('valid'));const [job]=await c.jobs() as ReplyJob[];
  assert.equal(job.id,queued.reply_id);assert.equal(job.payload.text,'');assert.equal(job.payload.media?.source.type,'stored');
  assert.equal((await c.rows('SELECT state FROM jobs WHERE id=?',[job.id]))[0].state,'preparing');
  const response=await download(c,job);assert.equal(response.status,200);assert.equal(await response.text(),'hello');
  assert.equal((await download(c,job,{claim_token:'wrong'})).status,409);
  const denied=await c.mf.dispatchFetch('http://bridge.test/gateway/media-download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...c.gateway,...fields(job)})});
  assert.equal(denied.status,401);
  assert.equal((await cache(c,{...job,claim_token:'wrong'})).body.error,'job_claim_invalid');
  assert.equal((await c.service('complete',{...fields(job),outcome:'delivered'})).body.error,'job_state_invalid');
  await complete(c,job);assert.equal((await download(c,job)).status,409);
  assert.equal((await c.ok('wechat_send_media',media('valid'))).status,'delivered');
});

test('stable media idempotency distinguishes kind, name, content, source and text',async t=>{
  const c=await fixture(t);await start(c);
  const a=await c.ok('wechat_send_media',media('shared'));const b=await c.ok('wechat_send_media',media('shared'));
  assert.equal(a.reply_id,b.reply_id);
  for(const patch of [{kind:'image'},{name:'other.txt'},{data_base64:Buffer.from('different').toString('base64')},
    {data_base64:undefined,source_url:'https://example.com/report.txt'}]) {
    assert.equal(errorOf(await c.tool('wechat_send_media',media('shared',patch))),'idempotency_conflict');
  }
  assert.equal(errorOf(await c.tool('wechat_send_message',{text:'hello',idempotency_key:'shared',wait_ms:0})),'idempotency_conflict');
  const attempts=await Promise.all(['same','other'].map(name=>c.tool('wechat_send_media',media('race',{name}))));
  assert.equal(attempts.filter(r=>!r.isError).length,1);assert.equal(errorOf(attempts.find(r=>r.isError)),'idempotency_conflict');
});

test('URL snapshots are immutable across retries and never appear in public history',async t=>{
  const c=await fixture(t);await start(c);
  const args=media('url',{data_base64:undefined,source_url:'https://example.com/report.pdf?signature=private',name:'report.pdf'});
  await c.ok('wechat_send_media',args);let [job]=await c.jobs() as ReplyJob[];
  assert.equal((await download(c,job)).status,404);
  const snapshot=await cache(c,job);assert.equal(snapshot.status,200);
  assert.deepEqual((await cache(c,job)).body,snapshot.body);
  assert.equal((await cache(c,job,'changed')).body.error,'media_cache_conflict');
  assert.equal(await (await download(c,job)).text(),'downloaded');
  await c.complete(job,{outcome:'retryable'});
  assert.equal((await c.service('complete',{...fields(job),outcome:'delivered'})).body.error,'job_claim_invalid');
  await c.run('UPDATE jobs SET available_at=0');
  [job]=await c.jobs() as ReplyJob[];assert.deepEqual(job.payload.media?.cached,snapshot.body);
  assert.equal((await c.ok('wechat_send_media',args)).status,'preparing');
  await complete(c,job);
  const history=await c.ok('wechat_read_history');
  assert.deepEqual(history.replies[0].media,{kind:'file',name:'report.pdf',size:10,sha256:snapshot.body.sha256});
  const visible=JSON.stringify(history);assert.equal(visible.includes('private'),false);assert.equal(visible.includes('outgoing/'),false);
});

test('media and text share member order; equal keys and stored bytes remain scoped to each member',async t=>{
  const c=await fixture(t);await start(c);await second(c);
  assert.equal(errorOf(await c.tool('wechat_send_media',media('missing'))),'participant_required');
  const a=await c.ok('wechat_send_media',media('same',{participant_id:'personal',kind:'image',name:'pic.png'}));
  const b=await c.ok('wechat_send_media',media('same',{participant_id:'other'}));
  const after=await c.ok('wechat_send_message',{participant_id:'personal',text:'after',idempotency_key:'after',wait_ms:0});
  const jobs=await c.jobs() as ReplyJob[];assert.deepEqual(jobs.map(j=>j.id),[a.reply_id,b.reply_id]);
  const keys=jobs.map(j=>j.payload.media?.source.type==='stored'?j.payload.media.source.key:'');assert.notEqual(keys[0],keys[1]);
  await c.complete(jobs[0],{outcome:'failed',error_code:'upload_error'});await complete(c,jobs[1]);
  assert.equal((await c.jobs()).length,0);
  await c.ok('wechat_resolve_reply',{reply_id:a.reply_id,action:'skip'});
  const [text]=await c.jobs();assert.equal(text.id,after.reply_id);await c.complete(text);
});

test('session media derives member identity and rejects other members message IDs and supplied target',async t=>{
  const c=await fixture(t);await start(c);await second(c);
  await c.ingest([message('a')],'a');
  assert.equal((await c.service('ingest',{participant_id:'other',messages:[message('b','other',{sender:'other-wechat'})],cursor:'b',previous_cursor:''})).status,200);
  const status=await c.ok('wechat_bridge_status');
  const sid=status.sessions.find((s:any)=>s.participant_id==='other').session_id;
  const session=await c.ok('wechat_confirm_session',{session_id:sid,consumer_id:'dot-other'});
  const args=media('response',{...sessionArgs(session),message_ids:[2]});
  assert.equal(errorOf(await c.tool('wechat_send_media',{...args,participant_id:'personal'})),'reply_participant_mismatch');
  assert.equal(errorOf(await c.tool('wechat_send_media',{...args,message_ids:[1]})),'reply_participant_mismatch');
  assert.equal(errorOf(await c.tool('wechat_send_media',media('partial',{session_id:sid}))),'media_session_fields_required');
  const reply=await c.ok('wechat_send_media',args);const [job]=await c.jobs() as ReplyJob[];
  assert.equal(job.id,reply.reply_id);assert.equal(job.participant_id,'other');await complete(c,job);
  assert.equal((await c.rows('SELECT status FROM messages WHERE sequence=2'))[0].status,'replied');
});

test('preparation can renew and expire safely; disabling before send stops activation and old gateways never claim media',async t=>{
  const c=await fixture(t);await start(c);
  await c.ok('wechat_send_media',media('prepare'));const [old]=await c.jobs() as ReplyJob[];
  const before=(await c.rows('SELECT claim_until FROM jobs'))[0].claim_until;
  const renewed=await c.service('job-heartbeat',fields(old));assert.equal(renewed.status,200);assert.ok(renewed.body.claim_until>=before);
  await c.run('UPDATE jobs SET claim_until=0');
  assert.equal((await c.service('complete',{...fields(old),outcome:'failed'})).body.error,'job_claim_invalid');
  await start(c,2);assert.equal((await c.jobs()).length,0);
  assert.equal((await c.service('complete',{...fields(old),outcome:'failed'})).body.error,'job_claim_invalid');
  await start(c);const [newer]=await c.jobs() as ReplyJob[];assert.notEqual(newer.claim_token,old.claim_token);
  assert.equal((await download(c,old)).status,409);
  await c.run('UPDATE participants SET enabled=0');assert.equal((await c.service('start-send',fields(newer))).body.error,'job_claim_invalid');
  await c.run('UPDATE participants SET enabled=1');assert.equal((await c.service('start-send',fields(newer))).status,200);
  assert.equal((await c.service('job-heartbeat',fields(newer))).body.error,'job_claim_invalid');
  await c.run('UPDATE jobs SET claim_until=0');await c.jobs();assert.equal((await c.rows('SELECT state FROM jobs'))[0].state,'unknown');
  await c.complete(newer);assert.equal((await c.rows('SELECT state FROM jobs'))[0].state,'delivered');
});

test('preparation result receipts survive lost ACKs without changing state or permitting an old claim to report sending',async t=>{
  const c=await fixture(t);await start(c);
  for(const outcome of ['retryable','failed'] as const) {
    const queued=await c.ok('wechat_send_media',media('lost-'+outcome));
    const [job]=await c.jobs() as ReplyJob[];
    await c.complete(job,{outcome,error_code:'upload_interrupted'});
    const saved=(await c.rows('SELECT state,claim_until,claim_hash,gateway_id FROM jobs WHERE id=?',[queued.reply_id]))[0];
    assert.equal(saved.state,outcome==='retryable'?'ready':'failed');assert.equal(saved.claim_until,0);assert.ok(saved.claim_hash);
    const retry=await c.service('complete',{...fields(job),outcome,error_code:'upload_interrupted'});
    assert.equal(retry.status,200);assert.deepEqual(retry.body,{accepted:true});
    assert.deepEqual((await c.rows('SELECT state,claim_until,claim_hash,gateway_id FROM jobs WHERE id=?',[queued.reply_id]))[0],saved);
    for(const stale of ['delivered','unknown']) {
      assert.equal((await c.service('complete',{...fields(job),outcome:stale})).body.error,'job_claim_invalid');
    }
    if(outcome==='retryable') {
      await c.run('UPDATE jobs SET available_at=0 WHERE id=?',[job.id]);
      const [claimed]=await c.jobs() as ReplyJob[];assert.notEqual(claimed.claim_token,job.claim_token);
      assert.equal((await c.service('complete',{...fields(job),outcome})).body.error,'job_claim_invalid');
      await c.complete(claimed,{outcome:'failed'});
    }
    await c.ok('wechat_resolve_reply',{reply_id:queued.reply_id,action:'skip'});
  }
});

test('existing proactive and session media results remain readable offline while new sends require a ready gateway',async t=>{
  const c=await fixture(t);await start(c);await c.ingest([message('offline')],'one');
  const proactive=media('saved');await c.ok('wechat_send_media',proactive);await complete(c,(await c.jobs())[0] as ReplyJob);
  const session=await c.session();const reply=media('saved-reply',{...sessionArgs(session),message_ids:[1]});
  await c.ok('wechat_send_media',reply);await complete(c,(await c.jobs())[0] as ReplyJob);
  await c.run("UPDATE gateway SET lease_until=0,status='error'");
  assert.equal((await c.ok('wechat_send_media',proactive)).status,'delivered');
  assert.equal((await c.ok('wechat_send_media',reply)).status,'delivered');
  assert.equal(errorOf(await c.tool('wechat_send_media',{...proactive,name:'changed.txt'})),'idempotency_conflict');
  assert.equal(errorOf(await c.tool('wechat_send_media',media('new'))),'gateway_media_not_ready');
  assert.equal(errorOf(await c.tool('wechat_send_media',{...reply,idempotency_key:'new-reply'})),'gateway_media_not_ready');
});
