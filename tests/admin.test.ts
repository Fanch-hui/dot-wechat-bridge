import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './helpers.ts';
import { Database } from '../src/core/database.ts';
import { Vault } from '../src/core/security.ts';
import { Participants } from '../src/core/participants.ts';
import { Bindings } from '../src/core/bindings.ts';

async function setup(t:Parameters<typeof fixture>[0]) {
  const client=await fixture(t),db=new Database(await client.db());
  const participants=new Participants(db),bindings=new Bindings(db,new Vault(Buffer.alloc(32,7).toString('base64')));
  return {client,db,participants,bindings};
}
const ownerHeaders={'oai-authenticated-user-id':'owner',Origin:'http://bridge.test'};

test('admin requires existing owner and same-origin JSON, never claims ownership',async t=>{
  const {client}=await setup(t);
  assert.equal((await client.post('/api/admin/list',{},ownerHeaders)).status,403);
  assert.equal((await client.rows("SELECT * FROM settings WHERE key='owner'")).length,0);
  await client.start();
  assert.equal((await client.post('/api/admin/list',{})).status,401);
  assert.equal((await client.post('/api/admin/create',{display_name:'Sam'},
    {...ownerHeaders,'oai-authenticated-user-id':'stranger'})).status,403);
  assert.equal((await client.post('/api/admin/create',{display_name:'Sam'},
    {...ownerHeaders,Origin:'https://other.test'})).status,403);
  assert.equal((await client.post('/api/admin/create',{display_name:'Sam'},
    {...ownerHeaders,'Content-Type':'text/plain'})).status,415);
  assert.equal((await client.post('/api/admin/create',{display_name:'Sam'},ownerHeaders)).status,200);
  const list=await client.post('/api/admin/list',{},ownerHeaders);
  assert.equal(list.status,200);assert.equal(list.body.participants.length,2);
  assert.equal(JSON.stringify(list.body).includes('self-wechat'),false);
});

test('binding QR needs live modern gateway',async t=>{
  const {client}=await setup(t);await client.start();
  await client.run("UPDATE gateway SET protocol_version=1 WHERE id='personal'");
  assert.equal((await client.post('/api/admin/bind',{participant_id:'personal'},ownerHeaders)).status,409);
  await client.run("UPDATE gateway SET protocol_version=2 WHERE id='personal'");
  const binding=await client.post('/api/admin/bind',{participant_id:'personal'},ownerHeaders);
  assert.equal(binding.status,200);assert.equal(binding.body.state,'queued');
  await client.run("UPDATE gateway SET lease_until=0 WHERE id='personal'");
  const offline=await client.post('/api/admin/bind',{participant_id:'personal'},ownerHeaders);
  assert.equal(offline.body.error,'gateway_offline');
});

test('binding refresh cancels old QR and late confirmation cannot activate it',async t=>{
  const {bindings,participants}=await setup(t),now=Date.now();
  const member=await participants.create('Sam');
  const first=await bindings.create(member.participant_id,now);
  await bindings.report({id:first.id,state:'waiting',qr_content:'https://weixin.qq.com/qr/first'},now+1);
  const second=await bindings.create(member.participant_id,now+2);
  const late=await bindings.report({id:first.id,state:'confirmed',sender:'sam',bot_id:'bot'},now+3);
  assert.equal(late.accepted,false);assert.equal(late.state,'cancelled');
  assert.equal((await participants.get(member.participant_id)).sender,null);
  assert.equal((await bindings.view(first.id,now+4)).qr_content,null);
  assert.equal((await bindings.report({id:second.id,state:'confirmed',sender:'sam',bot_id:'bot'},now+300_002)).accepted,false);
  assert.equal((await bindings.get(second.id)).state,'expired');
});

test('verification is encrypted and only supplied to gateway control',async t=>{
  const {bindings,participants,db}=await setup(t),now=Date.now();
  const member=await participants.create('Sam'),bind=await bindings.create(member.participant_id,now);
  await bindings.report({id:bind.id,state:'need_verifycode',qr_content:'https://weixin.qq.com/qr/code'},now+1);
  const view=await bindings.verify(bind.id,'123456',now+2);
  assert.equal('verification_code' in view,false);
  assert.equal((await bindings.control(now+3))[0].verification_code,'123456');
  const raw=await db.one<{verification_cipher:string}>('SELECT verification_cipher FROM binding_requests WHERE id=?',[bind.id]);
  assert.equal(raw!.verification_cipher.includes('123456'),false);
  await bindings.cancel(bind.id,now+4);
  assert.equal((await bindings.control(now+5)).length,0);
  assert.equal((await bindings.get(bind.id)).verification_cipher,null);
});

test('confirmed identity cannot change and duplicate WeChat cannot migrate histories',async t=>{
  const {bindings,participants,client}=await setup(t),now=Date.now();
  await client.run(`INSERT INTO subscriptions(id,owner,url_cipher,secret_cipher,secret_hash,conversation,state,expires_at)
    VALUES('all','owner','url','secret','hash','all','active',?)`,[now+600_000]);
  const member=await participants.create('Sam'),bind=await bindings.create(member.participant_id,now);
  assert.equal((await bindings.report({id:bind.id,state:'confirmed',sender:'sam',bot_id:'bot'},now+1)).accepted,true);
  const retry=await bindings.create(member.participant_id,now+2);
  await assert.rejects(bindings.report({id:retry.id,state:'confirmed',sender:'someone-else',bot_id:'bot2'},now+3),/binding_identity_mismatch/);
  const next=await participants.create('Alex'),duplicate=await bindings.create(next.participant_id,now+4);
  await assert.rejects(bindings.report({id:duplicate.id,state:'confirmed',sender:'sam',bot_id:'bot'},now+5),/wechat_already_assigned/);
  assert.equal((await participants.get(next.participant_id)).sender,null);
});

test('second bound member requires all-member event subscription',async t=>{
  const {client,bindings,participants}=await setup(t);await client.start();
  const now=Date.now(),member=await participants.create('Sam');
  await assert.rejects(bindings.create(member.participant_id,now),/all_members_subscription_required/);
  await client.run(`INSERT INTO subscriptions(id,owner,url_cipher,secret_cipher,secret_hash,conversation,state,expires_at)
    VALUES('all','owner','url','secret','hash','all','active',?)`,[now+600_000]);
  const bind=await bindings.create(member.participant_id,now+1);
  assert.equal((await bindings.report({id:bind.id,state:'confirmed',sender:'sam',bot_id:'bot'},now+2)).accepted,true);
  await participants.update(member.participant_id,{enabled:false});
  await client.run("UPDATE subscriptions SET state='revoked' WHERE id='all'");
  await assert.rejects(participants.update(member.participant_id,{enabled:true}),/all_members_subscription_required/);
});

test('disabled members cannot complete pending binding and explicit target is required with multiple records',async t=>{
  const {bindings,participants}=await setup(t),now=Date.now();
  await participants.initializeLegacy();
  assert.equal((await participants.resolve()).id,'personal');
  const member=await participants.create('Sam'),bind=await bindings.create(member.participant_id,now);
  await assert.rejects(participants.resolve(),/participant_required/);
  await participants.update(member.participant_id,{enabled:false});
  assert.equal((await bindings.control(now+1)).length,0);
  const late=await bindings.report({id:bind.id,state:'confirmed',sender:'sam',bot_id:'bot'},now+2);
  assert.equal(late.accepted,false);assert.equal(late.state,'cancelled');
  assert.equal((await bindings.view(bind.id,now+3)).qr_content,null);
  await participants.update(member.participant_id,{enabled:true});
  assert.equal((await bindings.control(now+4)).length,0);
  assert.equal((await participants.get(member.participant_id)).sender,null);
});
