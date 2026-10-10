import QRCode from 'qrcode';
import {api,BindingView,element,Participant,showError,dateText} from './common.ts';

const states:Record<string,string>={queued:'正在获取二维码…',waiting:'请用该成员的微信扫码',scanned:'已扫码，请在微信中确认',need_verifycode:'请填写微信显示的验证码',confirmed:'微信已连接',expired:'二维码已过期',cancelled:'绑定已取消',failed:'绑定失败'};
const finished=new Set(['confirmed','expired','cancelled','failed']);
const dialog=()=>element<HTMLDialogElement>('binding-dialog');
let current:BindingView|null=null;
let participant:Participant|null=null;
let generation=0;
let timer:ReturnType<typeof setTimeout>|undefined;
let busy=false;
let qrContent='';
let downloadUrl:string|undefined;
let afterChange:()=>Promise<void>=async()=>{};

function clearQr():void {
  qrContent='';element('qr-region').hidden=true;element('qr-code').replaceChildren();
  element<HTMLAnchorElement>('download-qr').removeAttribute('href');
  if(downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl=undefined;
}
function controls():void {
  const state=current?.state;
  element<HTMLButtonElement>('cancel-binding').disabled=busy||!current||finished.has(state??'');
  element<HTMLButtonElement>('refresh-qr').disabled=busy;
  element<HTMLButtonElement>('verify-submit').disabled=busy;
}
async function render(view:BindingView,version:number):Promise<void> {
  current=view;
  element('binding-state').textContent=states[view.state]??'正在更新绑定状态…';
  element('verify-form').hidden=view.state!=='need_verifycode';
  element('refresh-qr').hidden=!['expired','failed','cancelled'].includes(view.state);
  element('binding-done').hidden=view.state!=='confirmed';
  showError('binding-error',view.error_code);
  controls();
  if(finished.has(view.state)||!view.qr_content) {clearQr();return;}
  element('qr-expiry').textContent=view.expires_at?`有效至 ${dateText(view.expires_at)}`:'';
  if(view.qr_content===qrContent) return;
  clearQr();qrContent=view.qr_content;
  const content=view.qr_content;
  const canvas=document.createElement('canvas');
  try {
    await QRCode.toCanvas(canvas,content,{width:272,margin:3,errorCorrectionLevel:'M'});
    if(version!==generation||current?.id!==view.id||qrContent!==content||!dialog().open) return;
    canvas.setAttribute('role','img');canvas.setAttribute('aria-label','成员微信绑定二维码');
    element('qr-code').replaceChildren(canvas);element('qr-region').hidden=false;
    canvas.toBlob(blob=>{
      if(!blob||version!==generation||current?.id!==view.id||qrContent!==content||!dialog().open) return;
      if(downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl=URL.createObjectURL(blob);
      element<HTMLAnchorElement>('download-qr').href=downloadUrl;
    },'image/png');
  } catch {if(version===generation) showError('binding-error',new Error('qr_render_failed'));}
}
function schedule(version:number):void {
  clearTimeout(timer);
  if(!current||finished.has(current.state)||!dialog().open) return;
  timer=setTimeout(()=>void poll(version),2500);
}
async function poll(version:number):Promise<void> {
  if(version!==generation||!current||!dialog().open) return;
  const id=current.id;
  try {
    const view=await api<BindingView>('binding',{id});
    if(version!==generation||current?.id!==id||!dialog().open) return;
    await render(view,version);
    if(view.state==='confirmed') await afterChange();
  } catch(error) {if(version===generation&&dialog().open) showError('binding-error',error);}
  if(version===generation) schedule(version);
}
async function start():Promise<void> {
  if(!participant||busy) return;
  const version=++generation;clearTimeout(timer);current=null;clearQr();
  busy=true;controls();showError('binding-error');
  element('binding-state').textContent='正在获取二维码…';
  element('verify-form').hidden=true;element('refresh-qr').hidden=true;element('binding-done').hidden=true;
  try {
    const view=await api<BindingView>('bind',{participant_id:participant.participant_id});
    if(version!==generation||!dialog().open) return;
    await render(view,version);
    if(view.state==='confirmed') await afterChange();
    schedule(version);
  } catch(error) {
    if(version!==generation||!dialog().open) return;
    showError('binding-error',error);element('binding-state').textContent='无法获取二维码';element('refresh-qr').hidden=false;
  } finally {if(version===generation) {busy=false;controls();}}
}
export function openBinding(member:Participant,onChange:()=>Promise<void>):void {
  participant=member;afterChange=onChange;
  element('binding-title').textContent=member.display_name;
  element<HTMLInputElement>('verify-code').value='';dialog().showModal();void start();
}
export function initializeBinding():void {
  dialog().addEventListener('close',()=>{generation++;clearTimeout(timer);current=null;busy=false;clearQr();});
  element('refresh-qr').addEventListener('click',()=>void start());
  element('binding-done').addEventListener('click',()=>dialog().close());
  element('cancel-binding').addEventListener('click',async()=>{
    if(!current||busy) return;
    const id=current.id,version=generation;busy=true;controls();showError('binding-error');
    try {
      const view=await api<BindingView>('cancel',{id});
      if(version!==generation||!dialog().open) return;
      await render(view,version);clearTimeout(timer);await afterChange();
    } catch(error) {if(version===generation) showError('binding-error',error);}
    finally {if(version===generation) {busy=false;controls();}}
  });
  element<HTMLFormElement>('verify-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!current||busy) return;
    const id=current.id,version=generation,code=element<HTMLInputElement>('verify-code').value.trim();
    if(!code) return;
    busy=true;controls();showError('binding-error');clearTimeout(timer);
    try {
      const view=await api<BindingView>('verify',{id,code});
      if(version!==generation||!dialog().open) return;
      element<HTMLInputElement>('verify-code').value='';await render(view,version);
      if(view.state==='confirmed') await afterChange();
    } catch(error) {if(version===generation) showError('binding-error',error);}
    finally {if(version===generation) {busy=false;controls();schedule(version);}}
  });
}
