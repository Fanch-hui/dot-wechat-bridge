import { Bridge } from "../core/bridge.ts";
import { BridgeError, requireValue } from "../core/errors.ts";
import { tools } from "./catalog.ts";

function validate(name:string,args:Record<string,unknown>) {
  const def=tools.find(t=>t.name===name);
  requireValue(def,"unknown_tool",400);
  const schema=def.inputSchema;
  requireValue(schema.required.every(k=>args[k]!==undefined) && Object.keys(args).every(k=>k in schema.properties),"invalid_arguments",400);
  for (const [key,value] of Object.entries(args)) {
    const rule=schema.properties[key] as {type:string;minLength?:number;maxLength?:number;minimum?:number;maximum?:number;enum?:unknown[]};
    if (rule.type==='string') requireValue(typeof value==='string' && value.length>=(rule.minLength??0) && value.length<=(rule.maxLength??Infinity),`invalid_${key}`,400);
    if (rule.type==='integer') requireValue(Number.isSafeInteger(value) && Number(value)>=(rule.minimum??0) && Number(value)<=(rule.maximum??Number.MAX_SAFE_INTEGER),`invalid_${key}`,400);
    if (rule.type==='boolean') requireValue(typeof value==='boolean',`invalid_${key}`,400);
    if (rule.enum) requireValue(rule.enum.includes(value),`invalid_${key}`,400);
    if (rule.type==='array') requireValue(Array.isArray(value) && value.length>0 && value.length<=32 && value.every(v=>Number.isSafeInteger(v)&&v>0),`invalid_${key}`,400);
  }
}
export async function callTool(bridge:Bridge,name:string,args:Record<string,unknown>) {
  try {
    validate(name,args);
    const now=Date.now(), sid=args.session_id as string, lease=args.lease_token as string;
    let result:unknown;
    switch(name) {
      case 'wechat_read_attachment': {
        const participant=await bridge.participants.resolve(args.participant_id as string|undefined);
        const {attachment,resource}=await bridge.attachments.read(args.attachment_id as string,participant.id);
        const nativeImage=attachment.kind==='image' && ['image/png','image/jpeg','image/gif','image/webp'].includes(attachment.mime_type);
        const content=nativeImage?{type:'image',data:resource.blob,mimeType:resource.mimeType}:{type:'resource',resource};
        return {content:[{type:'text',text:JSON.stringify(attachment)},content],structuredContent:{attachment}};
      }
      case 'wechat_list_participants': result=await bridge.participants.list(); break;
      case 'wechat_bridge_status': result=await bridge.status(); break;
      case 'wechat_confirm_session': result=await bridge.sessions.confirm(sid,args.consumer_id as string,now); break;
      case 'wechat_read_messages': result=await bridge.messages.read(sid,lease,(args.wait_ms??0) as number); break;
      case 'wechat_send_reply': {
        const queued=await bridge.messages.reply(sid,lease,args.message_ids as number[],args.idempotency_key as string,
          args.text as string,now);
        result=await bridge.replyStatus(queued.reply_id,(args.wait_ms??20_000) as number); break;
      }
      case 'wechat_send_message': {
        const participant=await bridge.participants.resolve(args.participant_id as string|undefined);
        const queued=await bridge.outbound.send(args.idempotency_key as string,args.text as string,now,participant.id);
        result=await bridge.replyStatus(queued.reply_id,(args.wait_ms??20_000) as number); break;
      }
      case 'wechat_send_media': {
        const sessionFields=['session_id','lease_token','message_ids'].filter(key=>args[key]!==undefined);
        requireValue(sessionFields.length===0 || sessionFields.length===3,'media_session_fields_required',400);
        const participant=sessionFields.length?
          await bridge.sessions.authorize(sid,lease,now):await bridge.participants.resolve(args.participant_id as string|undefined);
        const participantId='participant_id' in participant?participant.participant_id:participant.id;
        requireValue(args.participant_id===undefined || args.participant_id===participantId,'reply_participant_mismatch',400);
        const media=await bridge.media.create(args,participantId);
        const queued=sessionFields.length?
          await bridge.messages.reply(sid,lease,args.message_ids as number[],args.idempotency_key as string,'',now,media):
          await bridge.outbound.send(args.idempotency_key as string,'',now,participantId,media);
        result=await bridge.replyStatus(queued.reply_id,(args.wait_ms??20_000) as number); break;
      }
      case 'wechat_heartbeat': result=await bridge.sessions.heartbeat(sid,lease,now); break;
      case 'wechat_end_session': result=await bridge.sessions.end(sid,lease,now); break;
      case 'wechat_read_history': {
        const participant=await bridge.participants.resolve(args.participant_id as string|undefined);
        result=await bridge.history((args.before_sequence??Number.MAX_SAFE_INTEGER) as number,(args.limit??20) as number,participant.id); break;
      }
      case 'wechat_recover_session': {
        const participant=await bridge.participants.resolve(args.participant_id as string|undefined);
        result=await bridge.sessions.recover(now,participant.id); break;
      }
      case 'wechat_resolve_reply': result=await bridge.queue.resolve(args.reply_id as string,args.action as string,args.accept_duplicate_risk===true,now); break;
    }
    return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
  } catch(error) {
    if (!(error instanceof BridgeError)) throw error;
    const reasons:Record<string,string>={
      gateway_media_not_ready:'图片和文件接入服务尚未就绪，请先更新并启动协议 3 接入服务',
      media_source_required:'请提供 source_url 或 data_base64，且只提供一种文件来源',
      invalid_source_url:'文件地址须为公网 HTTPS 直接下载链接',
      invalid_data_base64:'文件内容须使用完整的标准 base64 编码',
      inline_media_too_large:'直接上传的文件不得超过 512KiB，请使用公网 HTTPS 下载链接',
      media_session_fields_required:'回复附件需要同时提供 session_id、lease_token 和 message_ids',
      missing_wechat_reply_context:'缺少微信回复上下文，无法发送这条回复',
      wechat_not_bound:'该成员尚未绑定微信，请先扫码绑定',
      participant_required:'请先用 wechat_list_participants 确定成员，并提供 participant_id',
      participant_not_found:'未找到指定成员',
      participant_disabled:'该成员已停用',
      reply_participant_mismatch:'来信 ID 不属于当前会话成员，请分别处理各成员消息',
      session_lease_invalid:'会话处理租约已失效，请检查会话状态',
      reply_must_cover_pending_prefix:'首次回复必须先处理最早的待处理消息；追加回复须属于当前会话',
      reply_message_not_found:'未找到这条微信来信，请使用读取结果中的 sequence',
      idempotency_conflict:'同一发送标识已用于不同的消息或正文',
      concurrent_reply_conflict:'这些消息已由另一个回复处理，请重新读取队列',
      attachment_not_found:'未找到这份微信附件，请使用消息或历史中 attachments 的 id',
      attachment_content_unavailable:'微信附件暂时无法读取，请稍后重试',
      attachment_storage_unavailable:'微信附件存储暂不可用，请稍后重试',
    };
    const message=reasons[error.code]??`操作未完成（${error.code}）`;
    return {isError:true,content:[{type:'text',text:message}],structuredContent:{error:error.code,error_message:message,
      ...(['wechat_send_reply','wechat_send_message','wechat_send_media'].includes(name)?{status_text:'发送失败'}:{})}};
  }
}
