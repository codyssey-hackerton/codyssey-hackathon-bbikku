/* Isolated browser-local preview data. It is not an app account or calendar sync. */
const previewStorageKey='pikku-image-reference-preview-v1';
let previewStorageReady=true;
function updatePreviewStorageNotice(message){
 const node=document.getElementById('preview-persistence');
 if(node)node.textContent=message;
}
function nextPreviewId(items,prefix,stored){
 const existing=items.map(item=>new RegExp('^'+prefix+'(\\d+)$').exec(item.id||'')).filter(Boolean).map(match=>Number(match[1]));
 return Math.max(Number.isInteger(stored)?stored:1,...existing.map(n=>n+1),1);
}
function restorePreview(){
 try{
  if(!window.localStorage)throw Error('storage unavailable');
  const raw=window.localStorage.getItem(previewStorageKey);
  if(raw){
   const data=JSON.parse(raw);
   if(data.version!==1||!Array.isArray(data.events)||!Array.isArray(data.routines))throw Error('invalid preview data');
   const validEvent=item=>item&&typeof item==='object'&&typeof item.id==='string'&&typeof item.name==='string'&&typeof item.time==='string';
   const validRoutine=item=>item&&typeof item==='object'&&typeof item.id==='string'&&typeof item.name==='string'&&Array.isArray(item.days)&&R.minutes(item.start)!==null&&Number.isFinite(item.duration)&&item.records&&typeof item.records==='object'&&item.recoveries&&typeof item.recoveries==='object';
   if(!data.events.every(validEvent)||!data.routines.every(validRoutine))throw Error('invalid preview data');
   state.events=data.events;state.routines=data.routines;
   state.eventNextId=nextPreviewId(state.events,'e',data.eventNextId);
   state.routineNextId=nextPreviewId(state.routines,'r',data.routineNextId);
   state.formDrafts=data.formDrafts&&typeof data.formDrafts==='object'?data.formDrafts:{};
   state.filter=['all','personal','work'].includes(data.filter)?data.filter:'all';
   state.showSuggestion=data.showSuggestion!==false;state.added=data.added===true;
   state.routineView=data.routineView==='all'?'all':'today';
   state.formKind=data.formKind==='appointment'?'appointment':'task';
   const validMessages=value=>Array.isArray(value)&&value.every(message=>message&&['user','assistant'].includes(message.role)&&typeof message.text==='string');
   const creation=data.aiCreate;
   const validProposal=value=>!value||(typeof value==='object'&&['task','appointment','routine'].includes(value.type)&&typeof value.name==='string'&&typeof value.time==='string'&&Number.isFinite(value.duration)&&(value.type!=='routine'||Array.isArray(value.days)));
   if(creation&&['new','form','routine-form'].includes(creation.source)&&creation.slots&&typeof creation.slots==='object'&&validMessages(creation.messages)&&validProposal(creation.proposal))state.aiCreate=creation;
   const context=data.aiContext;
   if(context&&['event','routine'].includes(context.entity)&&typeof context.id==='string'&&validMessages(data.aiMessages)){
    state.aiContext=context;state.aiMessages=data.aiMessages;
    if(data.aiProposal&&typeof data.aiProposal==='object'&&typeof data.aiProposal.time==='string'&&Number.isFinite(data.aiProposal.duration))state.aiProposal=data.aiProposal;
    state.aiRecoveryPrompt=data.aiRecoveryPrompt===true;
   }
   if(Array.isArray(data.chatMessages)&&data.chatMessages.every(message=>typeof message==='string'))state.chatMessages=data.chatMessages;
   if(['home','calendar','day','routine','chat'].includes(data.screen))state.screen=data.screen;
   if(data.selectedDate&&R.parseDate(data.selectedDate))state.selectedDate=R.parseDate(data.selectedDate);
   if(typeof data.previewNow==='string'){
    const parsed=new Date(data.previewNow);
    if(Number.isFinite(parsed.getTime())){const elapsed=Number.isFinite(data.savedAt)?Math.max(0,Date.now()-data.savedAt):0;previewNow.setTime(parsed.getTime()+elapsed);previewToday=R.dateKey(previewNow)}
   }
  }
  updatePreviewStorageNotice('시안의 일정·루틴과 입력·대화 초안은 이 브라우저에 저장돼요. 실제 계정이나 캘린더에는 연결되지 않아요.');
 }catch(error){
  previewStorageReady=false;
  updatePreviewStorageNotice('브라우저 저장을 사용할 수 없거나 저장된 시안을 읽지 못했어요. 새로고침하면 현재 변경이 사라질 수 있어요.');
 }
}
function savePreview(){
 if(!previewStorageReady)return false;
 try{
  window.localStorage.setItem(previewStorageKey,JSON.stringify({version:1,events:state.events,routines:state.routines,eventNextId:state.eventNextId,routineNextId:state.routineNextId,
   formDrafts:state.formDrafts,filter:state.filter,showSuggestion:state.showSuggestion,added:state.added,routineView:state.routineView,
   selectedDate:R.dateKey(state.selectedDate),previewNow:previewNow.toISOString(),savedAt:Date.now(),screen:state.screen,formKind:state.formKind,aiCreate:state.aiCreate,aiContext:state.aiContext,aiMessages:state.aiMessages,aiProposal:state.aiProposal,aiRecoveryPrompt:state.aiRecoveryPrompt,chatMessages:state.chatMessages}));
  return true;
 }catch(error){
  previewStorageReady=false;
  updatePreviewStorageNotice('브라우저에 저장하지 못했어요. 새로고침하면 현재 변경이 사라질 수 있어요.');
  return false;
 }
}
