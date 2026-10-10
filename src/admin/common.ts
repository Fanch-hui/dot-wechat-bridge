export interface Participant {
  participant_id:string;
  display_name:string;
  enabled:boolean;
  bound:boolean;
  status:string;
  last_seen_at:number|string|null;
  delivery_issues:unknown;
}
export interface MemberList {participants:Participant[];gateway_online:boolean;gateway_compatible?:boolean;events_ready:boolean}
export interface BindingView {
  id:string;participant_id:string;state:string;qr_content?:string;error_code?:string;expires_at?:number|string;
}
export function element<T extends HTMLElement>(id:string):T {return document.getElementById(id) as T;}
export function node<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string):HTMLElementTagNameMap[K] {
  const result=document.createElement(tag);
  if(text!==undefined) result.textContent=text;
  if(className) result.className=className;
  return result;
}
export function append(parent:HTMLElement,...children:HTMLElement[]):void {
  for(const child of children) parent.appendChild(child);
}
const errors:Record<string,string>={
  owner_authentication_required:'请使用所有者账号登录后刷新页面。',
  user_authentication_required:'请登录后刷新页面。',
  authentication_required:'请登录后刷新页面。',
  owner_required:'只有所有者可以管理成员。',
  owner_access_required:'只有所有者可以管理成员。',
  origin_forbidden:'操作来源未通过校验，请刷新页面重试。',
  gateway_offline:'微信接入服务离线，请等待服务恢复。',
  gateway_upgrade_required:'请先将微信接入服务升级为多人版本。',
  all_members_subscription_required:'请先让 Dot 订阅全部成员：conversation=all。',
  events_not_ready:'请先为 Dot 启用全部成员的消息订阅。',
  participant_disabled:'该成员已停用，请先恢复。',
  participant_not_found:'成员已不存在，请刷新列表。',
  participant_already_bound:'这个微信已经绑定其他成员。',
  sender_already_bound:'这个微信已经绑定其他成员。',
  binding_identity_mismatch:'扫码微信与该成员原绑定微信不同，请为新微信添加成员。',
  binding_identity_duplicate:'这个微信已经绑定其他成员。',
  wechat_already_assigned:'这个微信已经绑定其他成员。',
  invalid_verification_code:'请填写微信显示的数字验证码。',
  binding_not_waiting_for_verification:'当前扫码会话已不再等待验证码，请检查最新状态。',
  binding_expired:'二维码已过期，请重新获取。',
  binding_cancelled:'绑定已取消。',
  invalid_display_name:'请填写有效称呼。',
  invalid_code:'请填写有效验证码。',
  invalid_verify_code:'验证码无效，请重新填写。',
  bridge_unavailable:'服务暂时不可用，请稍后重试。',
};
export function errorText(error:unknown):string {
  const code=error instanceof Error?error.message:String(error);
  return errors[code]??(code==='network_error'?'连接失败，请检查网络后重试。':`操作失败（${code}）`);
}
export function showError(id:string,error?:unknown):void {
  const target=element(id);target.hidden=!error;target.textContent=error?errorText(error):'';
}
export async function api<T>(action:string,body:object={}):Promise<T> {
  let response:Response;
  try {response=await fetch(`/api/admin/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'same-origin',cache:'no-store'});}
  catch {throw new Error('network_error');}
  let result:any;
  try {result=await response.json();} catch {throw new Error(`http_${response.status}`);}
  if(!response.ok) throw new Error(result.error??`http_${response.status}`);
  return result as T;
}
export function dateText(value:number|string|null|undefined):string {
  if(!value) return '暂无来信';
  const date=new Date(value);
  return Number.isNaN(date.getTime())?'暂无来信':new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);
}
