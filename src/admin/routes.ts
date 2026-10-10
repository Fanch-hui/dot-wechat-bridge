import type { Bridge } from '../core/bridge.ts';
import { BridgeError, requireValue, string } from '../core/errors.ts';
import { hash, equal } from '../core/security.ts';
import { allEventsReady } from '../core/participants.ts';

async function json(request:Request) {
  requireValue(request.headers.get('Content-Type')?.split(';')[0].trim()==='application/json','json_required',415);
  const reader=request.body?.getReader();requireValue(reader,'body_required',400);
  const chunks:Uint8Array[]=[];let size=0;
  for(;;) {
    const {value,done}=await reader.read();if(done) break;
    size+=value.byteLength;
    if(size>8192) {await reader.cancel();throw new BridgeError('request_too_large',413);}
    chunks.push(value);
  }
  const data=new Uint8Array(size);let offset=0;
  for(const chunk of chunks) {data.set(chunk,offset);offset+=chunk.length;}
  let input:unknown;
  try {input=JSON.parse(new TextDecoder().decode(data));} catch {throw new BridgeError('invalid_json',400);}
  requireValue(input && typeof input==='object' && !Array.isArray(input),'invalid_request',400);
  return input as Record<string,unknown>;
}
export async function admin(request:Request,bridge:Bridge):Promise<Response> {
  const url=new URL(request.url),identity=request.headers.get('oai-authenticated-user-id');
  requireValue(identity,'authentication_required',401);
  const owner=await bridge.db.get('owner');
  requireValue(owner && equal(await hash(identity),owner),'owner_access_required',403);
  await bridge.participants.initializeLegacy();
  requireValue(request.method==='POST','method_not_allowed',405);
  requireValue(request.headers.get('Origin')===url.origin,'origin_forbidden',403);
  const input=await json(request),now=Date.now();
  let result:unknown;
  switch(url.pathname) {
    case '/api/admin/list': {
      const gateway=await bridge.db.one<{lease_until:number;protocol_version:number;status:string}>("SELECT * FROM gateway WHERE id='personal'");
      result={participants:await bridge.participants.list(),gateway_online:!!gateway && gateway.lease_until>now,
        gateway_compatible:!!gateway && gateway.protocol_version>=2,events_ready:await allEventsReady(bridge.db,now)};break;
    }
    case '/api/admin/create': result=await bridge.participants.create(input.display_name);break;
    case '/api/admin/update': result=await bridge.participants.update(string(input.participant_id,'participant_id',128),input);break;
    case '/api/admin/bind': {
      const gateway=await bridge.db.one<{lease_until:number;protocol_version:number}>("SELECT * FROM gateway WHERE id='personal'");
      requireValue(gateway && gateway.lease_until>now,'gateway_offline');
      requireValue(gateway.protocol_version>=2,'gateway_upgrade_required');
      result=await bridge.bindings.create(string(input.participant_id,'participant_id',128),now);break;
    }
    case '/api/admin/binding': result=await bridge.bindings.view(string(input.id,'binding_id',128),now);break;
    case '/api/admin/verify': result=await bridge.bindings.verify(string(input.id,'binding_id',128),input.code,now);break;
    case '/api/admin/cancel': result=await bridge.bindings.cancel(string(input.id,'binding_id',128),now);break;
    default:throw new BridgeError('route_not_found',404);
  }
  return Response.json(result,{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
