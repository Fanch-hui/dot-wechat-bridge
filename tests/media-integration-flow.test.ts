import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, type Client } from './helpers.ts';
import { BridgeClient } from '../src/gateway/bridge.ts';
import { IlinkClient } from '../src/gateway/ilink.ts';
import { ParticipantRuntime } from '../src/gateway/participant-runtime.ts';
import { Journal } from '../src/gateway/storage.ts';
import { JobDispatcher } from '../src/gateway/job-dispatcher.ts';
import type { ReplyJob } from '../src/shared/contracts.ts';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9qUAAAAASUVORK5CYII=','base64');
const credentials={baseUrl:'https://ilinkai.weixin.qq.com',userId:'self-wechat',botId:'test-bot',botToken:'test-bot-token'};
function bridgeClient(c:Client, after?:(path:string)=>void) {
  return new BridgeClient({bridgeUrl:'https://bridge.test',bridgeToken:'test-service-token',runtimeDir:'.runtime',
    tickMs:20,qrTimeoutMs:1000,qrRefreshLimit:0},(async (input,init)=>{
      const response=await c.mf.dispatchFetch(String(input),init as any);
      after?.(new URL(String(input)).pathname);
      return response as unknown as Response;
    }) as typeof fetch);
}
async function start(c:Client) {
  await c.start();const lease=await c.service('lease',{protocol_version:3});
  c.gateway.lease_token=lease.body.lease_token;
}

test('MCP media traverses Worker R2, gateway encryption and send gate for files and images',async t=>{
  const c=await fixture(t);await start(c);
  const directory=await mkdtemp(join(tmpdir(),'dot-wechat-media-flow-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const bridge=bridgeClient(c);
  const journal=await Journal.load(join(directory,'journal.json'));
  for(const [kind,name,bytes] of [['file','报告.pdf',Buffer.from('sample file bytes')],['image','图片.png',png]] as const) {
    const args={kind,name,data_base64:bytes.toString('base64'),idempotency_key:`flow-${kind}`,wait_ms:0};
    const queued=await c.ok('wechat_send_media',args);const [job]=await c.jobs() as ReplyJob[];
    let upload:any,sent:any,marked=false;
    const request=(async (input,init)=>{
      const url=String(input);
      if(url.endsWith('/getuploadurl')) {
        upload=JSON.parse(String(init?.body));
        assert.equal(upload.rawfilemd5,createHash('md5').update(bytes).digest('hex'));
        assert.equal(upload.rawsize,bytes.length);assert.equal(upload.media_type,kind==='image'?1:3);
        assert.equal(upload.to_user_id,'self-wechat');
        return Response.json({upload_param:'test-upload'});
      }
      if(url.includes('/c2c/upload?')) {
        const encrypted=Buffer.from(init!.body as Uint8Array);
        const cipher=createDecipheriv('aes-128-ecb',Buffer.from(upload.aeskey,'hex'),null);
        assert.deepEqual(Buffer.concat([cipher.update(encrypted),cipher.final()]),bytes);
        assert.equal(encrypted.length,upload.filesize);
        assert.equal((init!.headers as Record<string,string>).Authorization,undefined);
        assert.equal((await c.rows('SELECT state FROM jobs WHERE id=?',[job.id]))[0].state,'preparing');
        return new Response(null,{headers:{'x-encrypted-param':'test-download'}});
      }
      assert.ok(url.endsWith('/sendmessage'));assert.equal(marked,true);
      assert.equal((await c.rows('SELECT state FROM jobs WHERE id=?',[job.id]))[0].state,'sending');
      sent=JSON.parse(String(init?.body)).msg;
      assert.equal(sent.client_id,queued.reply_id);assert.equal(sent.to_user_id,'self-wechat');
      assert.equal(sent.item_list.length,1);
      const item=sent.item_list[0],data=kind==='image'?item.image_item:item.file_item;
      assert.equal(item.type,kind==='image'?2:4);
      assert.equal(Buffer.from(data.media.aes_key,'base64').toString(),upload.aeskey);
      if(kind==='image') assert.equal(data.mid_size,upload.filesize);
      else {assert.equal(data.file_name,name);assert.equal(data.len,String(bytes.length));}
      return Response.json({ret:0});
    }) as typeof fetch;
    const participant=new ParticipantRuntime('personal',credentials,'',journal,new IlinkClient(credentials,undefined,request),
      bridge,()=>({...c.gateway,participant_id:'personal'}),20);
    const result=await participant.send(job,new AbortController().signal,async ()=>{marked=true;});
    assert.equal(result.outcome,'delivered');assert.ok(sent);
    await bridge.post('complete',{...c.gateway,...result});
    assert.equal((await c.ok('wechat_send_media',args)).status,'delivered');
    assert.equal((await c.jobs()).length,0);
  }
  const history=await c.ok('wechat_read_history');
  assert.deepEqual(history.replies.map((r:any)=>[r.media.kind,r.media.name,r.status]),
    [['file','报告.pdf','delivered'],['image','图片.png','delivered']]);
});

test('stale preparation receipt is discarded without changing the reclaimed Worker task',async t=>{
  const c=await fixture(t);await start(c);
  const directory=await mkdtemp(join(tmpdir(),'dot-wechat-media-stale-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await c.ok('wechat_send_media',{kind:'file',name:'test.txt',data_base64:'aGVsbG8=',idempotency_key:'stale',wait_ms:0});
  const [old]=await c.jobs() as ReplyJob[];
  await c.run('UPDATE jobs SET claim_until=0 WHERE id=?',[old.id]);
  const [current]=await c.jobs() as ReplyJob[];assert.notEqual(current.claim_token,old.claim_token);
  const journal=await Journal.load(join(directory,'journal.json'));
  journal.data.jobs[old.id]={kind:'reply',claimToken:old.claim_token,started:false};await journal.save();
  const controller=new AbortController(),reports:string[]=[];
  const bridge=bridgeClient(c,path=>{if(path==='/gateway/jobs') controller.abort();});
  await new JobDispatcher(bridge,journal,()=>c.gateway,20,()=>undefined,undefined,message=>reports.push(message)).run(controller.signal);
  assert.deepEqual(journal.data.jobs,{});assert.equal(reports.length,1);
  const row=(await c.rows('SELECT state,claim_hash FROM jobs WHERE id=?',[old.id]))[0];
  assert.equal(row.state,'preparing');
  assert.equal(row.claim_hash,createHash('sha256').update(current.claim_token).digest('base64'));
});

test('a repeated start grant does not authorize new sending after the member is disabled',async t=>{
  const c=await fixture(t);await start(c);
  await c.ok('wechat_send_media',{kind:'file',name:'test.txt',data_base64:'aGVsbG8=',idempotency_key:'disabled',wait_ms:0});
  const [job]=await c.jobs() as ReplyJob[];const fields={job_id:job.id,claim_token:job.claim_token};
  assert.equal((await c.service('start-send',fields)).status,200);
  await c.run("UPDATE participants SET enabled=0 WHERE id='personal'");
  assert.equal((await c.service('start-send',fields)).status,409);
  await c.complete(job);
  assert.equal((await c.rows('SELECT state FROM jobs WHERE id=?',[job.id]))[0].state,'delivered');
});
