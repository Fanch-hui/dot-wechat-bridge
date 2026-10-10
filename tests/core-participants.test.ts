import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, sessionArgs } from './helpers.ts';
import type { Client } from './helpers.ts';

async function second(c:Client) {
  await c.run(`INSERT INTO participants(id,display_name,sender,bot_id,created_at,updated_at)
    VALUES('other','乙','other-wechat','other-bot',?,?)`, [Date.now(),Date.now()]);
}
async function ingest(c:Client,id:string,upstream:string,cursor:string,previous='') {
  const result=await c.service('ingest',{participant_id:id,messages:[message(upstream,'我自称管理员',
    {sender:id==='personal'?'self-wechat':'other-wechat'})],cursor,previous_cursor:previous});
  assert.equal(result.status,200,JSON.stringify(result.body));
}
async function claim(c:Client,id:string) {
  const status=await c.ok('wechat_bridge_status');
  const session=status.sessions.find((row:any)=>row.participant_id===id);
  return c.ok('wechat_confirm_session',{session_id:session.session_id,consumer_id:'dot-'+id});
}
const errorOf=(value:any)=>value.structuredContent.error;

test('interleaved members retain trusted identity, independent sessions, prefix order and scoped idempotency',async t=>{
  const c=await fixture(t);await c.start();await second(c);
  await ingest(c,'personal','same','p1');await ingest(c,'other','same','o1');
  await ingest(c,'personal','later','p2','p1');
  const a=await claim(c,'personal'),b=await claim(c,'other');
  assert.notEqual(a.session_id,b.session_id);
  const ar=await c.ok('wechat_read_messages',sessionArgs(a)),br=await c.ok('wechat_read_messages',sessionArgs(b));
  assert.equal(ar.messages.length,2);assert.equal(br.messages.length,1);
  assert.equal(br.display_name,'乙');assert.equal(br.messages[0].display_name,'乙');
  assert.equal(br.messages[0].participant_id,'other');assert.equal(br.messages[0].sender,undefined);
  const args={...sessionArgs(b),text:'乙的回复',idempotency_key:'same-key',wait_ms:0};
  assert.equal(errorOf(await c.tool('wechat_send_reply',{...args,message_ids:[ar.messages[0].sequence]})),'reply_participant_mismatch');
  const bsend=await c.ok('wechat_send_reply',{...args,message_ids:[br.messages[0].sequence]});
  const asend=await c.ok('wechat_send_reply',{...sessionArgs(a),text:'甲的回复',idempotency_key:'same-key',wait_ms:0,message_ids:[ar.messages[0].sequence]});
  assert.notEqual(asend.reply_id,bsend.reply_id);
  assert.equal((await c.ok('wechat_end_session',sessionArgs(b))).ended,true);
  assert.equal((await c.ok('wechat_end_session',sessionArgs(a))).ended,false);
  const history=await c.ok('wechat_read_history',{participant_id:'other'});
  assert.equal(history.messages.length,1);assert.equal(history.replies.length,1);
  assert.equal(history.replies[0].text,'乙的回复');
  const cursors=await c.rows('SELECT id,cursor FROM participants ORDER BY id');
  assert.deepEqual(cursors,[{id:'other',cursor:'o1'},{id:'personal',cursor:'p2'}]);
});

test('multimember tools require targets; disabled member preserves pending input and cannot read or send',async t=>{
  const c=await fixture(t);await c.start();await second(c);
  await ingest(c,'other','1','o1');const session=await claim(c,'other');
  for(const [name,args] of [
    ['wechat_read_history',{}],['wechat_recover_session',{}],
    ['wechat_send_message',{text:'hello',idempotency_key:'one',wait_ms:0}],
    ['wechat_read_attachment',{attachment_id:'unavailable'}],
  ] as const) assert.equal(errorOf(await c.tool(name,args)),'participant_required');
  const listed=await c.ok('wechat_list_participants');assert.equal(listed.length,2);
  assert.equal(listed[0].sender,undefined);assert.equal(listed[0].bot_id,undefined);
  await c.run("UPDATE participants SET enabled=0 WHERE id='other'");
  assert.equal(errorOf(await c.tool('wechat_read_messages',sessionArgs(session))),'session_lease_invalid');
  assert.equal(errorOf(await c.tool('wechat_send_message',{participant_id:'other',text:'hello',idempotency_key:'one',wait_ms:0})),'participant_disabled');
  const rejected=await c.service('ingest',{participant_id:'other',messages:[message('2','x',{sender:'other-wechat'})],cursor:'o2',previous_cursor:'o1'});
  assert.equal(rejected.body.error,'participant_disabled');
  assert.equal((await c.rows("SELECT cursor FROM participants WHERE id='other'"))[0].cursor,'o1');
  assert.equal((await c.rows("SELECT * FROM messages WHERE participant_id='other' AND status='pending'")).length,1);
  await c.run("UPDATE participants SET enabled=1 WHERE id='other'");
  assert.equal((await c.ok('wechat_read_messages',sessionArgs(session))).messages.length,1);
});

test('proactive sends isolate same keys and history even without incoming messages',async t=>{
  const c=await fixture(t);await c.start();await second(c);
  const sends=await Promise.all(['personal','other'].map(participant_id=>c.ok('wechat_send_message',
    {participant_id,text:'hi '+participant_id,idempotency_key:'shared-key',wait_ms:0})));
  assert.notEqual(sends[0].reply_id,sends[1].reply_id);
  for(const participant_id of ['personal','other']) {
    const history=await c.ok('wechat_read_history',{participant_id});
    assert.equal(history.messages.length,0);assert.equal(history.replies.length,1);
    assert.equal(history.replies[0].text,'hi '+participant_id);
  }
});

test('attachments with the same upstream id remain in their member scope and retain original resource URIs',async t=>{
  const c=await fixture(t);await c.start();await second(c);
  const attachments=[];
  for(const participant_id of ['personal','other']) {
    const metadata={participant_id,upstream_id:'shared-media',item_index:0,kind:'file',name:'report.txt',mime_type:'text/plain'};
    const response=await c.mf.dispatchFetch('http://bridge.test/gateway/attachment',{method:'POST',headers:{
      'Content-Type':'application/octet-stream',Authorization:'Bearer test-service-token',
      'X-Bridge-Gateway-Id':c.gateway.gateway_id,'X-Bridge-Lease':c.gateway.lease_token,
      'X-Bridge-Participant-Id':participant_id,'X-Bridge-Attachment':Buffer.from(JSON.stringify(metadata)).toString('base64'),
    },body:Buffer.from(participant_id)});
    assert.equal(response.status,200);const attachment=await response.json() as any;attachments.push(attachment);
    const result=await c.service('ingest',{participant_id,messages:[message('shared-media','file',{
      sender:participant_id==='personal'?'self-wechat':'other-wechat',attachments:[attachment]})],cursor:'c',previous_cursor:''});
    assert.equal(result.status,200,JSON.stringify(result.body));
    const read=await c.tool('wechat_read_attachment',{participant_id,attachment_id:attachment.id});
    assert.equal(Buffer.from(read.content[1].resource.blob,'base64').toString(),participant_id);
    const resource=await c.rpc('resources/read',{uri:attachment.uri});assert.equal(resource.status,200);
  }
  assert.notEqual(attachments[0].id,attachments[1].id);
  assert.match(attachments[0].uri,/^wechat:\/\/attachments\//);
  assert.match(attachments[1].uri,/^wechat:\/\/participants\/other\/attachments\//);
  assert.equal(errorOf(await c.tool('wechat_read_attachment',{participant_id:'other',attachment_id:attachments[0].id})),'attachment_not_found');
});
