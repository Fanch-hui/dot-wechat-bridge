import {api,append,dateText,element,errorText,MemberList,node,Participant,showError} from './common.ts';
import {initializeBinding,openBinding} from './binding.ts';

let members:Participant[]=[];
let serviceReady=false;
let eventsReady=false;
let loading=false;
let editing:Participant|null=null;
let saving=false;
const statusNames:Record<string,string>={ok:'已连接',connected:'已连接',credential_expired:'登录已过期',error:'连接异常',unbound:'待绑定',offline:'离线'};

function bindingAllowed(member:Participant):boolean {
  return serviceReady&&member.enabled&&(eventsReady||!members.some(other=>other.participant_id!==member.participant_id&&other.enabled&&other.bound));
}
function memberStatus(member:Participant):string {
  if(!member.enabled) return '已停用';
  if(!member.bound) return '待绑定';
  return statusNames[member.status]??'正在连接';
}
function action(text:string,onClick:()=>void,className='secondary'):HTMLButtonElement {
  const button=node('button',text,className);button.type='button';button.addEventListener('click',onClick);return button;
}
function issueLines(value:unknown):string[] {
  if(Array.isArray(value)) return value.map(item=>{
    if(typeof item==='string') return item;
    if(item&&typeof item==='object') {
      const issue=item as Record<string,unknown>;
      return [issue.error_message??issue.message,issue.error_code??issue.code].filter(v=>typeof v==='string').join(' · ')||'存在未完成投递';
    }
    return '存在未完成投递';
  });
  if(typeof value==='number') return value>0?[`${value} 条投递需要处理`]:[];
  if(value&&typeof value==='object') return issueLines([value]);
  return [];
}
function memberRow(member:Participant):HTMLElement {
  const row=node('article',undefined,'member-row');
  const identity=node('div',undefined,'member-identity');
  const avatar=node('span',Array.from(member.display_name)[0]??'人','avatar');avatar.setAttribute('aria-hidden','true');
  const info=node('div',undefined,'member-info');
  const title=node('div',undefined,'member-title');append(title,node('h3',member.display_name));
  if(members.filter(value=>value.display_name===member.display_name).length>1) append(title,node('span',member.participant_id.slice(-6),'short-id'));
  const badge=node('span',memberStatus(member),'badge');
  if(member.enabled&&member.bound&&['ok','connected'].includes(member.status)) badge.classList.add('connected');
  append(title,badge);append(info,title,node('p',`最近来信 · ${dateText(member.last_seen_at)}`,'muted'));
  append(identity,avatar,info);append(row,identity);
  const actions=node('div',undefined,'member-actions');
  const bind=action(member.bound?'重新扫码':'连接微信',()=>openBinding(member,refresh));
  bind.disabled=!bindingAllowed(member);bind.title=!member.enabled?'请先恢复成员':!serviceReady?'接入服务或 Dot 订阅尚未就绪':'';
  const rename=action('改名',()=>openMemberDialog(member));
  const toggle=action(member.enabled?'停用':'恢复',()=>void setEnabled(member,toggle,row));
  append(actions,bind,rename,toggle);append(row,actions);
  const details=node('details',undefined,'member-details');append(details,node('summary','详情'));
  append(details,node('p',`成员 ID · ${member.participant_id}`,'muted identifier'));
  const issues=issueLines(member.delivery_issues);
  if(issues.length) {
    const list=node('ul',undefined,'delivery-issues');for(const issue of issues) append(list,node('li',issue));append(details,list);
  } else append(details,node('p','暂无投递异常','muted'));
  append(row,details);
  const error=node('p',undefined,'error row-error');error.hidden=true;error.setAttribute('role','alert');append(row,error);
  return row;
}
function renderMembers():void {
  const container=element('members');container.replaceChildren();
  element('member-count').textContent=`${members.length} 位`;
  if(members.length) {for(const member of members) append(container,memberRow(member));return;}
  const empty=node('div',undefined,'empty');append(empty,node('p','添加第一位成员，连接微信与 Dot。'),action('添加成员',()=>openMemberDialog(null),'primary'));append(container,empty);
}
async function refresh():Promise<void> {
  if(loading) return;
  loading=true;element('members').setAttribute('aria-busy','true');element<HTMLButtonElement>('refresh').disabled=true;
  showError('page-error');
  try {
    const result=await api<MemberList>('list');members=result.participants;
    serviceReady=result.gateway_online&&result.gateway_compatible!==false;eventsReady=result.events_ready;
    element('gateway-status').textContent=!result.gateway_online?'接入服务离线':result.gateway_compatible===false?'接入服务待升级':'接入服务在线';
    element('gateway-status').classList.toggle('online',result.gateway_online);
    element('events-status').textContent=result.events_ready?'Dot 已订阅全部成员':'Dot 订阅待配置';
    element('events-status').classList.toggle('online',result.events_ready);
    const notice=element('service-notice');notice.hidden=serviceReady&&eventsReady;
    notice.textContent=!result.gateway_online?'接入服务离线，恢复后可以扫码连接成员。':result.gateway_compatible===false?
      '微信接入服务需要升级后才能在网页扫码。':'请让 Dot 订阅 conversation=all，再连接其他成员。';
    renderMembers();
  } catch(error) {showError('page-error',error);}
  finally {loading=false;element('members').setAttribute('aria-busy','false');element<HTMLButtonElement>('refresh').disabled=false;}
}
async function setEnabled(member:Participant,button:HTMLButtonElement,row:HTMLElement):Promise<void> {
  const error=row.querySelector<HTMLElement>('.row-error')!;
  button.disabled=true;error.hidden=true;
  try {await api('update',{participant_id:member.participant_id,enabled:!member.enabled});await refresh();}
  catch(value) {error.textContent=errorText(value);error.hidden=false;}
  finally {button.disabled=false;}
}
function openMemberDialog(member:Participant|null):void {
  editing=member;
  element('member-dialog-title').textContent=member?'修改称呼':'添加成员';
  element('member-submit').textContent=member?'保存':serviceReady&&(eventsReady||!members.some(m=>m.enabled&&m.bound))?'添加并扫码':'添加';
  element<HTMLInputElement>('member-name').value=member?.display_name??'';
  showError('member-error');element<HTMLDialogElement>('member-dialog').showModal();
}
async function saveMember(event:SubmitEvent):Promise<void> {
  event.preventDefault();if(saving) return;
  const name=element<HTMLInputElement>('member-name').value.trim();
  if(!name) {showError('member-error',new Error('invalid_display_name'));return;}
  saving=true;element<HTMLButtonElement>('member-submit').disabled=true;showError('member-error');
  for(const button of document.querySelectorAll<HTMLButtonElement>('[data-close="member-dialog"]')) button.disabled=true;
  try {
    let created:Participant|undefined;
    if(editing) await api('update',{participant_id:editing.participant_id,display_name:name});
    else created=await api<Participant>('create',{display_name:name});
    element<HTMLDialogElement>('member-dialog').close();await refresh();
    if(created&&bindingAllowed(created)) openBinding(members.find(value=>value.participant_id===created!.participant_id)??created,refresh);
  } catch(error) {showError('member-error',error);}
  finally {
    saving=false;element<HTMLButtonElement>('member-submit').disabled=false;
    for(const button of document.querySelectorAll<HTMLButtonElement>('[data-close="member-dialog"]')) button.disabled=false;
  }
}
initializeBinding();
element('add-member').addEventListener('click',()=>openMemberDialog(null));
element('refresh').addEventListener('click',()=>void refresh());
element<HTMLFormElement>('member-form').addEventListener('submit',event=>void saveMember(event));
element<HTMLDialogElement>('member-dialog').addEventListener('cancel',event=>{if(saving) event.preventDefault();});
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-close]')) button.addEventListener('click',()=>element<HTMLDialogElement>(button.dataset.close!).close());
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible') void refresh();});
setInterval(()=>{if(document.visibilityState==='visible'&&!element<HTMLDialogElement>('member-dialog').open) void refresh();},15000);
void refresh();
