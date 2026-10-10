import { Bridge } from './core/bridge.ts';
import { BridgeError, requireValue, string } from './core/errors.ts';
import { equal } from './core/security.ts';
import type { Env } from './core/config.ts';
import type { AttachmentUpload, IncomingMessage, JobResult } from './shared/contracts.ts';
import type { BindingReport } from './core/bindings.ts';
import { MAX_ATTACHMENT_BYTES } from './shared/contracts.ts';

export function authorizeGateway(request:Request,env:Env) {
  requireValue(env.BRIDGE_TOKEN && equal(request.headers.get('Authorization')??'',`Bearer ${env.BRIDGE_TOKEN}`),
    'gateway_authentication_required',401);
}
export async function bodyBytes(request:Request,maxBytes:number):Promise<Uint8Array<ArrayBuffer>> {
  const chunks:Uint8Array[]=[];let size=0;
  const reader=request.body?.getReader();requireValue(reader,'body_required',400);
  for (;;) {
    const {value,done}=await reader.read();if(done) break;
    size+=value.byteLength;
    if(size>maxBytes) {await reader.cancel();throw new BridgeError('request_too_large',413);}
    chunks.push(value);
  }
  const body=new Uint8Array(size);let offset=0;
  for(const chunk of chunks) {body.set(chunk,offset);offset+=chunk.length;}
  return body;
}
export async function json(request:Request):Promise<Record<string,any>> {
  requireValue(request.headers.get('Content-Type')?.split(';')[0]==='application/json','json_required',415);
  let result:unknown;
  try {result=JSON.parse(new TextDecoder().decode(await bodyBytes(request,1_048_576)));}
  catch(error) {if(error instanceof BridgeError) throw error;throw new BridgeError('invalid_json',400);}
  requireValue(result && typeof result==='object' && !Array.isArray(result),'invalid_request',400);
  return result as Record<string,any>;
}
export async function gateway(request:Request,env:Env,path:string) {
  authorizeGateway(request,env);
  const bridge=new Bridge(env),now=Date.now();
  await bridge.participants.initializeLegacy();
  if(path==='/gateway/attachment') {
    const id=string(request.headers.get('X-Bridge-Gateway-Id'),'gateway_id',128);
    const lease=string(request.headers.get('X-Bridge-Lease'),'lease_token',128);
    await bridge.gateway.authorize(id,lease,now);
    requireValue(request.headers.get('Content-Type')==='application/octet-stream','binary_required',415);
    const metadata=string(request.headers.get('X-Bridge-Attachment'),'attachment_metadata',4096);
    let input:AttachmentUpload;
    try {input=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(metadata),c=>c.charCodeAt(0))));}
    catch {throw new BridgeError('invalid_attachment_metadata',400);}
    requireValue(input && typeof input==='object' && !Array.isArray(input),'invalid_attachment_metadata',400);
    const participantId=request.headers.get('X-Bridge-Participant-Id')??input.participant_id??'personal';
    await bridge.participants.get(participantId,true);
    return bridge.attachments.upload(input,await bodyBytes(request,MAX_ATTACHMENT_BYTES),now,participantId);
  }
  const input=await json(request);
  if(path==='/gateway/bind') return bridge.gateway.bind(string(input.sender,'sender',256),input.bot_id);
  const id=string(input.gateway_id,'gateway_id',128);
  if(path==='/gateway/lease') return bridge.gateway.acquire(id,now,input.protocol_version??1);
  const lease=string(input.lease_token,'lease_token',128);
  const leaseHash=await bridge.gateway.authorize(id,lease,now);
  switch(path) {
    case '/gateway/control': {
      const participants=await bridge.db.all('SELECT id,display_name,enabled,sender,bot_id,binding_id,cursor,status FROM participants ORDER BY created_at,id');
      return {participants,bindings:await bridge.bindings.control(now)};
    }
    case '/gateway/binding':return bridge.bindings.report(input as BindingReport,now);
    case '/gateway/ingest': {
      requireValue(typeof input.cursor==='string' && input.cursor.length<=65536 && typeof input.previous_cursor==='string'
        && input.previous_cursor.length<=65536 && Array.isArray(input.messages),'invalid_batch',400);
      return bridge.messages.ingest(input.messages as IncomingMessage[],input.cursor,input.previous_cursor,id,leaseHash,now,
        input.participant_id===undefined?'personal':string(input.participant_id,'participant_id',128));
    }
    case '/gateway/tick': {
      const result=await bridge.gateway.tick(id,lease,now);await bridge.wake.tick(now);return result;
    }
    case '/gateway/jobs': {
      const limit=input.limit??8;
      requireValue(Number.isSafeInteger(limit) && limit>=1 && limit<=16,'invalid_limit',400);
      return {jobs:await bridge.queue.claim(id,limit,now)};
    }
    case '/gateway/complete': {
      string(input.job_id,'job_id',256);string(input.claim_token,'claim_token',128);
      requireValue(input.error_code===undefined || (typeof input.error_code==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(input.error_code)),
        'invalid_error_code',400);
      requireValue(input.error_message===undefined || (typeof input.error_message==='string' && input.error_message.length<=256),
        'invalid_error_message',400);
      requireValue(input.challenge===undefined || (typeof input.challenge==='string' && input.challenge.length<=128),'invalid_challenge',400);
      return bridge.queue.complete(id,input as JobResult,now);
    }
    case '/gateway/health': {
      requireValue(['ok','credential_expired','error'].includes(input.status),'invalid_status',400);
      if(input.participant_id) {
        const participant=await bridge.participants.get(string(input.participant_id,'participant_id',128));
        await bridge.db.run('UPDATE participants SET status=?,updated_at=? WHERE id=?',[input.status,now,participant.id]);
      } else await bridge.db.run("UPDATE gateway SET status=? WHERE gateway_id=? AND lease_hash=?",[input.status,id,leaseHash]);
      return {accepted:true};
    }
    default:throw new BridgeError('route_not_found',404);
  }
}
