import { Database } from './database.ts';
import { hash, Vault } from './security.ts';
import { requireValue, string } from './errors.ts';
import type { Job } from './models.ts';
import type { OutgoingMedia, StoredMedia, ReplyJob } from '../shared/contracts.ts';
import { MAX_ATTACHMENT_BYTES, MAX_INLINE_MEDIA_BYTES } from '../shared/contracts.ts';

export function sameOutput(saved: {text:string;media?:OutgoingMedia}, text:string, media?:OutgoingMedia) {
  const stable=(value?:OutgoingMedia)=>value?JSON.stringify([value.kind,value.name,value.source]):null;
  return saved.text===text && stable(saved.media)===stable(media);
}
export function mediaDescription(media?:OutgoingMedia) {
  if (!media) return undefined;
  const stored=media.cached??(media.source.type==='stored'?media.source:undefined);
  return {kind:media.kind,name:media.name,...(stored?{size:stored.size,sha256:stored.sha256}:{})};
}
function sourceUrl(value:unknown) {
  const url=string(value,'source_url',8192);
  let parsed:URL;
  try {parsed=new URL(url);} catch {requireValue(false,'invalid_source_url',400);}
  const host=parsed.hostname.toLowerCase();
  requireValue(parsed.protocol==='https:' && !parsed.username && !parsed.password && !parsed.hash &&
    (!parsed.port || parsed.port==='443') && host.includes('.') && !host.endsWith('.') &&
    !host.endsWith('.local') && !host.endsWith('.localhost') && !/^[\d.]+$/.test(host) && !host.includes(':'),
    'invalid_source_url',400);
  return url;
}
function inline(value:unknown):Uint8Array<ArrayBuffer> {
  const encoded=string(value,'data_base64',Math.ceil(MAX_INLINE_MEDIA_BYTES/3)*4);
  requireValue(encoded.length%4===0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),
    'invalid_data_base64',400);
  const raw=atob(encoded);
  requireValue(btoa(raw)===encoded,'invalid_data_base64',400);
  requireValue(raw.length>0 && raw.length<=MAX_INLINE_MEDIA_BYTES,'inline_media_too_large',413);
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}

export async function requireMediaGateway(db:Database,now:number) {
    const row=await db.one<{protocol_version:number;lease_until:number;status:string}>("SELECT protocol_version,lease_until,status FROM gateway WHERE id='personal'");
    requireValue(row && row.protocol_version>=3 && row.status==='ok' && row.lease_until>now,'gateway_media_not_ready',503);
  }

export class OutgoingMediaStore {
  constructor(readonly db:Database,readonly vault:Vault,readonly bucket?:R2Bucket) {}
  async create(args:Record<string,unknown>,participantId:string):Promise<OutgoingMedia> {
    requireValue(args.kind==='image' || args.kind==='file','invalid_media_kind',400);
    const name=string(args.name,'media_name',200);
    requireValue(!/[\\/\x00-\x1f\x7f]/.test(name),'invalid_media_name',400);
    requireValue((args.source_url!==undefined)!==(args.data_base64!==undefined),'media_source_required',400);
    const source=args.source_url!==undefined?{type:'url' as const,url:sourceUrl(args.source_url)}:
      {type:'stored' as const,...await this.store(inline(args.data_base64),participantId)};
    return {kind:args.kind,name,source};
  }
  private async store(bytes:Uint8Array<ArrayBuffer>,participantId:string):Promise<StoredMedia> {
    requireValue(this.bucket,'attachment_storage_unavailable',503);
    requireValue(bytes.length>0 && bytes.length<=MAX_ATTACHMENT_BYTES,'attachment_too_large',413);
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    const sha256=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
    const key=`outgoing/${encodeURIComponent(participantId)}/${sha256}`;
    await this.bucket.put(key,bytes,{httpMetadata:{contentType:'application/octet-stream'}});
    return {key,size:bytes.length,sha256};
  }
  private async claimed(gatewayId:string,jobId:string,claimToken:string,now:number) {
    const job=await this.db.one<Job>('SELECT * FROM jobs WHERE id=?',[jobId]);
    requireValue(job?.kind==='reply' && job.gateway_id===gatewayId && job.claim_hash===await hash(claimToken)
      && job.state==='preparing' && job.claim_until>now,'job_claim_invalid');
    const payload=await this.vault.open<ReplyJob['payload']>(job.payload_cipher);
    requireValue(payload.media,'job_media_required',400);
    return {job,payload,media:payload.media};
  }
  async download(gatewayId:string,jobId:string,claimToken:string,now:number) {
    requireValue(this.bucket,'attachment_storage_unavailable',503);
    const {media}=await this.claimed(gatewayId,jobId,claimToken,now);
    const stored=media.cached??(media.source.type==='stored'?media.source:undefined);
    requireValue(stored,'media_not_cached',404);
    const object=await this.bucket.get(stored.key);
    requireValue(object && object.size===stored.size,'attachment_content_unavailable',503);
    return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store',
      'Content-Length':String(stored.size),'X-Bridge-Media-Sha256':stored.sha256}});
  }
  async cache(gatewayId:string,jobId:string,claimToken:string,bytes:Uint8Array<ArrayBuffer>,now:number) {
    const {job,payload,media}=await this.claimed(gatewayId,jobId,claimToken,now);
    requireValue(media.source.type==='url','media_cache_not_required',400);
    const stored=await this.store(bytes,job.participant_id!);
    now=Math.max(now,Date.now());
    await this.claimed(gatewayId,jobId,claimToken,now);
    if (media.cached) {
      requireValue(media.cached.sha256===stored.sha256 && media.cached.size===stored.size,'media_cache_conflict');
      return media.cached;
    }
    const next=await this.vault.seal({...payload,media:{...media,cached:stored}});
    const update=await this.db.run(`UPDATE jobs SET payload_cipher=? WHERE id=? AND payload_cipher=? AND state='preparing'
      AND claim_hash=? AND claim_until>? AND gateway_id=?`,[next,job.id,job.payload_cipher,job.claim_hash,now,gatewayId]);
    if (!update.meta.changes) {
      const current=await this.claimed(gatewayId,jobId,claimToken,now);
      requireValue(current.media.cached?.sha256===stored.sha256 && current.media.cached?.size===stored.size,'media_cache_conflict');
    }
    return stored;
  }
}
