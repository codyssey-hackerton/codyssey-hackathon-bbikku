/* New-item conversations and direct entry use local sample data only. */
state.aiCreate=null;
state.formDrafts={};
state.formKind='task';
function showAddChoices(){
 eventSheet('<h2>무엇을 추가할까요?</h2><p>편한 방법을 골라주세요.</p>'+aiAskButton('create-ai','','AI에게 말하면 일정과 계획을 만들어드려요.')+'<div class="card-menu-list"><button data-action="create-event">일정 추가</button><button data-action="create-task">할 일 추가</button><button data-action="create-routine">루틴 추가</button></div>');
}
function addDefaultDate(){return ['calendar','day'].includes(state.screen)?R.dateKey(state.selectedDate):previewToday}
function showAddForm(kind,values){
 kind=kind==='appointment'?'appointment':'task';
 state.formKind=kind;
 const v=values||state.formDrafts[kind]||{name:'',time:'',date:addDefaultDate(),eventType:kind,involvement:'personal'};
 const type=v.eventType==='appointment'?'appointment':'task',involvement=v.involvement==='shared'?'shared':'personal';
 const opt=(value,current,label)=>'<option value="'+value+'" '+(value===current?'selected':'')+'>'+label+'</option>';
 eventSheet('<h2>'+(kind==='appointment'?'새 일정 추가':'새 할 일 추가')+'</h2><p>직접 입력하거나 삐꾸와 함께 초안을 만들어 보세요.</p><form id="add-form" data-draft-kind="'+kind+'">'+
  '<button class="ai-form-button" type="button" data-action="create-form-ai">'+svg('spark')+' AI로 작성하기</button>'+
  '<label class="field" for="event-name">일정 이름</label><input id="event-name" name="name" placeholder="예: 책 읽기" maxlength="30" value="'+escapeHtml(v.name||'')+'" required>'+
  '<label class="field" for="event-date">날짜</label><input id="event-date" name="date" type="date" value="'+escapeHtml(v.date||addDefaultDate())+'" required>'+
  '<label class="field" for="event-time">시간</label><input id="event-time" name="time" placeholder="예: 오후 3:00 - 3:30" maxlength="30" value="'+escapeHtml(v.time||'')+'" required>'+
  '<label class="field" for="event-type">종류</label><select id="event-type" name="eventType">'+opt('appointment',type,'고정 약속')+opt('task',type,'할 일')+'</select>'+
  '<label class="field" for="event-involvement">참여자</label><select id="event-involvement" name="involvement">'+opt('personal',involvement,'나만')+opt('shared',involvement,'다른 사람과 함께')+'</select>'+
  '<p class="event-add-hint">종료 시간이 없으면 지난 일정 여부를 정하지 않아요. 추천 시간 계산에는 30분을 예시로 써요.</p><p class="routine-error" id="event-add-error" role="alert"></p>'+
  '<div class="sheet-actions"><button class="secondary" type="button" data-close>취소</button><button class="primary" type="submit">추가하기</button></div></form>');
}
function captureAddDraft(form){
 if(!form||!form.elements)return null;
 const kind=form.dataset?.draftKind||state.formKind||'task';
 const value=name=>form.elements[name]?.value||'';
 const draft={name:value('name'),time:value('time'),date:value('date')||addDefaultDate(),eventType:value('eventType')||kind,involvement:value('involvement')||'personal'};
 state.formDrafts[kind]=draft;savePreview();return {...draft};
}
function captureRoutineDraft(form){
 if(!form||!form.elements||typeof form.querySelectorAll!=='function')return null;
 const value=name=>form.elements[name]?.value||'';
 const draft={name:value('name'),start:value('start'),duration:value('duration'),goal:value('goal'),
  days:Array.from(form.querySelectorAll('input[name="days"]:checked')).map(box=>Number(box.value))};
 state.formDrafts.routine=draft;savePreview();return {...draft,days:draft.days.slice()};
}
function saveAddForm(form){
 const fields=form.elements,name=fields.name.value.trim(),time=fields.time.value.trim();
 const type=fields.eventType?.value==='appointment'?'appointment':'task',involvement=fields.involvement?.value==='shared'?'shared':'personal';
 const date=fields.date?.value||addDefaultDate(),error=sheet.querySelector('#event-add-error');
 if(!name||!time||!R.parseDate(date)||!R.parseEventTime(time)){
  if(error)error.textContent='이름과 날짜, 읽을 수 있는 시간(예: 오후 3:00 - 3:30)을 확인해 주세요.';return;
 }
 state.events.push({id:'e'+state.eventNextId++,name,time,date,type,involvement,status:'pending',attendance:'unknown',color:'#7894ff',kind:'personal',show:true});
 delete state.formDrafts[form.dataset?.draftKind||state.formKind||type];
 modal.hidden=true;state.screen='home';render();toast('예시 일정을 추가했어요');
}
function startCreateChat(source='new',original=null){
 const routineSource=source==='routine-form';
 const type=routineSource?'routine':original?.eventType==='appointment'?'appointment':original?.eventType==='task'?'task':null;
 const parsed=original?.time?R.parseEventTime(original.time):null;
 const explicitEnd=original?.time&&/[-–~]\s*(?:(?:오전|오후)\s*)?\d{1,2}:\d{2}/.test(original.time);
 state.aiContext=null;state.aiProposal=null;state.aiRecoveryPrompt=false;
 state.aiCreate={source,original:original?{...original}:null,formKind:routineSource?'routine':state.formKind,returnScreen:state.screen,
  slots:{type,name:original?.name||'',date:original?.date||'',time:routineSource?(original?.start||''):(parsed?R.timeKey(parsed.start):''),duration:routineSource?(Number(original?.duration)||null):(explicitEnd?parsed.end-parsed.start:null),days:routineSource?(original?.days?.slice()||[]):null},
  messages:[],expect:'',proposal:null,error:''};
 modal.hidden=true;state.screen='chat';render();
}
function createSay(text){state.aiCreate.messages.push({role:'assistant',text})}
const creationExamples=[
 ['meeting','내일 오후 3시에 회의 잡아줘.'],
 ['exercise','이번 주 남는 시간에 운동 일정 만들어줘.'],
 ['todo','오늘 할 일 정리해줘.'],
 ['routine','매일 아침 8시에 운동하는 루틴 등록해줘.']
];
function createProposalMarkup(p){
 if(!p)return '';
 const when=p.type==='routine'?R.repeatLabel(p.days)+' · '+R.timeLabel(p.time):R.dateLabel(p.date)+' · '+R.timeLabel(p.time);
 const warning=p.involvement==='shared'?'공동 일정은 이 시안에서 실제 연락이나 초대를 보내지 않아요.':'예시 일정만 살펴본 제안이에요. 실제 AI·캘린더·선호 정보는 연결되지 않았어요.';
 const actions=state.aiCreate.source!=='new'?
  '<button data-action="create-reject">거절</button><button class="accept" data-action="create-apply">초안에 적용</button>':
  '<button data-action="create-reject">거절</button><button data-action="create-edit">수정</button><button class="accept" data-action="create-accept">수락</button>';
 return '<div class="ai-proposal"><div class="ai-proposal-label">'+svg('spark')+' 삐꾸의 제안 · 저장 전</div><strong>'+escapeHtml(p.name)+'</strong><p>'+escapeHtml((p.type==='routine'?'루틴':p.type==='task'?'할 일':'일정')+' · '+when+' · '+p.duration+'분')+'</p><p>'+escapeHtml(warning)+'</p>'+(state.aiCreate.error?'<p class="routine-error" role="alert">'+escapeHtml(state.aiCreate.error)+'</p>':'')+'<div class="ai-proposal-actions">'+actions+'</div></div>';
}
function createChat(){
 const c=state.aiCreate;
 const suggestions=creationExamples.map(([id,label])=>'<button data-action="create-question" data-question="'+id+'">'+escapeHtml(label)+'</button>').join('');
 const messages=c.messages.map(message=>'<div class="bubble '+(message.role==='user'?'user':'')+'">'+escapeHtml(message.text)+'</div>').join('');
 const back=c.source!=='new'?'<button class="ai-recovery-check" data-action="create-back">입력 화면으로 돌아가기</button>':'';
 return '<div class="chat-header"><div class="bot-icon">'+svg('bot')+'</div>AI 비서</div><div class="ai-context"><div class="ai-context-caption">새로운 일정 만들기</div><strong>'+(c.source!=='new'?'작성 중인 입력을 보관했어요':'어떤 일정을 만들까요?')+'</strong><span>이야기를 바탕으로 저장 전 초안을 살펴봐요.</span></div><div class="bubble ai-intro">원하는 일정이나 루틴을 말해 주세요.</div><div class="ai-questions">'+suggestions+'</div>'+messages+createProposalMarkup(c.proposal)+back+'<div class="chat-spacer"></div><div class="ai-preview-hint">일부 예시 문장만 이해하는 시안이에요. 실제 AI·캘린더·선호 정보는 연결되지 않아요.</div><form class="composer" id="chat-form"><input name="message" aria-label="메시지" placeholder="메시지를 입력하세요..." autocomplete="off"><button class="send" type="submit" aria-label="메시지 보내기">'+svg('send')+'</button></form>';
}
function parseCreationTime(text){
 const m=text.match(/(오전|오후|아침|저녁|밤)?\s*(\d{1,2})(?::(\d{2})|\s*시(?:\s*(\d{1,2})\s*분)?)/);
 if(!m)return null;
 const hour=Number(m[2]),minute=Number(m[3]||m[4]||0);
 if(hour>23||minute>59||hour<0)return {error:'시간을 다시 확인해 주세요.'};
 if(!m[1]&&hour<=12)return {error:'몇 시인지 오전 또는 오후를 함께 알려 주세요.'};
 if(m[1]&&hour>12)return {error:'오전이나 오후의 시간은 1시부터 12시까지 알려 주세요.'};
 const afternoon=['오후','저녁','밤'].includes(m[1]);
 const h=m[1]?(hour%12+(afternoon?12:0)):hour;
 return {time:R.timeKey(h*60+minute),matched:m[0]};
}
function updateCreationSlots(text){
 const c=state.aiCreate,s=c.slots,expected=c.expect;
 const nameReply=expected==='name'&&!/오늘|내일|모레|오전|오후|\d{1,2}\s*시/.test(text)&&text.trim().length<=30;
 if(nameReply)s.name=text.trim();
 else{
  if(/루틴|매일|매주/.test(text))s.type='routine';
  else if(/할\s*일|투두/.test(text))s.type='task';
  else if(/회의|약속|일정/.test(text))s.type='appointment';
  const quoted=text.match(/["“']([^"”']{1,30})["”']/);
  if(quoted)s.name=quoted[1];
  else if(/회의/.test(text))s.name='회의';
  else if(/운동/.test(text))s.name='운동';
  else if(/장보기/.test(text))s.name='장보기';
 }
 if(/매일/.test(text))s.days=[0,1,2,3,4,5,6];
 else{
  const dayNames=['일','월','화','수','목','금','토'],found=dayNames.map((day,i)=>text.includes(day+'요일')?i:null).filter(day=>day!==null);
  if(found.length)s.days=found;
 }
 let explicitDate=false;
 if(/모레/.test(text)){s.date=R.addDays(previewToday,2);explicitDate=true}
 else if(/내일/.test(text)){s.date=R.addDays(previewToday,1);explicitDate=true}
 else if(/오늘/.test(text)){s.date=previewToday;explicitDate=true}
 if(explicitDate&&s.window==='week')s.window='day';
 const date=text.match(/(\d{4})-(\d{2})-(\d{2})/);
 if(date&&R.parseDate(date[0])){s.date=date[0];if(s.window==='week')s.window='day'}
 const monthDay=text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
 if(monthDay){const key=previewNow.getFullYear()+'-'+String(Number(monthDay[1])).padStart(2,'0')+'-'+String(Number(monthDay[2])).padStart(2,'0');if(R.parseDate(key)){s.date=key;if(s.window==='week')s.window='day'}}
 if(/이번\s*주/.test(text)){s.window='week';if(!/오늘|내일|모레/.test(text))s.date=''}
 if(/남는\s*시간|빈\s*시간|여유\s*시간/.test(text)&&s.type!=='routine'&&s.date&&!s.window){s.window='day';s.time=''}
 const time=parseCreationTime(text);
 if(time?.time){s.time=time.time;s.window='';}
 if(time?.error){c.error=time.error;return}
 let durationText=time?.matched?text.replace(time.matched,''):text;
 const hours=durationText.match(/(\d+)\s*시간/),minutes=durationText.match(/(\d+)\s*분/);
 if(hours||minutes){const amount=(hours?Number(hours[1])*60:0)+(minutes?Number(minutes[1]):0);if(amount>=5&&amount<=480)s.duration=amount;else{c.error='소요시간은 5분에서 8시간 사이로 알려 주세요.';return}}
}
function creationConflict(p){
 if(!p||!p.name||!p.time||!p.duration)return '입력 내용을 다시 확인해 주세요.';
 if(p.type==='routine'){
  const start=R.minutes(p.time);
  if(!R.parseDate(p.startDate)||p.startDate<previewToday||(p.startDate===previewToday&&start<previewNow.getHours()*60+previewNow.getMinutes()))return '루틴 시작 시간이 지났어요. 제안을 다시 확인해 주세요.';
  if(start===null||start<420||start+p.duration>1320)return '오전 7시부터 오후 10시 사이에 끝나는 시간을 골라 주세요.';
  for(let i=0;i<8;i++){
   const date=R.addDays(p.startDate,i),day=R.parseDate(date).getDay();
   if(!p.days.includes(day))continue;
   const busy=routineBusy(date,null);
   if(busy.unknown||busy.intervals.some(slot=>R.overlaps(start,start+p.duration,slot.start,slot.end)))return '예시 일정과 시간이 겹치거나 확인할 수 없어요. 다른 시간을 알려 주세요.';
  }
  return '';
 }
 const busy=routineBusy(p.date,null);
 if(busy.unknown||!R.available(p.date,p.time,p.duration,busy.intervals,previewNow))return '지난 시간이거나 예시 일정과 겹쳐요. 다른 시간을 알려 주세요.';
 return '';
}
function creationProposal(){
 const c=state.aiCreate,s=c.slots;c.expect='';c.error='';
 const need=(field,message)=>{c.expect=field;createSay(message)};
 if(!s.type){need('type','일정, 할 일, 루틴 중 무엇을 만들까요?');return}
 if(!s.name){need('name','어떤 일을 만들까요? 일정 이름을 알려 주세요.');return}
 if(s.type==='routine'&&!s.days?.length){need('days','어떤 요일에 반복할까요? 매일 또는 요일을 알려 주세요.');return}
 if(s.type!=='routine'&&!s.date&&!s.window){need('date','언제 할까요? 오늘이나 내일처럼 날짜를 알려 주세요.');return}
 if(!s.time&&!s.window){need('time','몇 시에 할까요? 오전 또는 오후와 함께 알려 주세요.');return}
 if(!s.duration){need('duration','얼마나 진행할까요? 소요시간을 알려 주세요.');return}
 let date=s.date,time=s.time;
 if(s.window&&s.type!=='routine'){
  const day=R.parseDate(previewToday).getDay(),first=s.window==='day'?s.date:previewToday,end=s.window==='day'?s.date:R.addDays(previewToday,day===0?0:7-day);
  date='';time='';
  for(let key=first;key<=end;key=R.addDays(key,1)){
   const busy=routineBusy(key,null);if(busy.unknown)continue;
   const slot=R.findSlot(key,s.duration,busy.intervals,previewNow);
   if(slot){date=key;time=slot;break}
  }
  if(!date||!time){c.expect='time';createSay('이번 주 예시 일정에서 가능한 시간을 찾지 못했어요. 다른 날짜나 시간을 알려 주세요.');return}
 }
 const startDate=s.type==='routine'&&R.minutes(time)<previewNow.getHours()*60+previewNow.getMinutes()?R.addDays(previewToday,1):previewToday;
 const p={type:s.type,name:s.name,date,time,duration:s.duration,days:s.days,startDate,involvement:s.type==='appointment'&&/회의|약속/.test(s.name)?'shared':'personal'};
 const error=creationConflict(p);
 if(error){c.expect='time';createSay(error);return}
 c.proposal=p;createSay(p.type==='routine'?'앞으로 8일의 예시 일정과 겹치지 않는지 확인했어요. 내용을 확인해 주세요.':'예시 일정과 겹치지 않는지 확인했어요. 내용을 확인해 주세요.');
}
function createRequest(text){
 const c=state.aiCreate;c.messages.push({role:'user',text});c.proposal=null;c.error='';
 if(c.expect&&/(만들|추가|등록|잡아|정리해)/.test(text)&&/(일정|할\s*일|루틴|회의|약속)/.test(text)){c.slots={type:null,name:'',date:'',time:'',duration:null,days:null};c.expect=''}
 updateCreationSlots(text);
 if(c.error){createSay(c.error);return}
 creationProposal();
}
function createApply(mode='ask'){
 const c=state.aiCreate,p=c?.proposal;if(!p||c.source==='new')return;
 if(c.source==='routine-form'){
  if(p.type!=='routine'){eventSheet('<h2>루틴 초안을 작성하고 있어요</h2><p>입력한 루틴은 그대로 보관돼요. 일정이나 할 일은 추가 메뉴에서 작성해 주세요.</p><div class="sheet-actions"><button class="primary" data-action="create-back">입력 화면으로 돌아가기</button></div>');return}
  const original=c.original||{},suggestion={name:p.name,days:p.days.slice(),start:p.time,duration:p.duration,goal:original.goal||''};
  const labels={name:'이름',days:'반복 요일',start:'시작 시간',duration:'소요시간'};
  const conflicts=Object.keys(labels).filter(key=>original[key]!==''&&original[key]!==undefined&&(key==='duration'?Number(original[key])!==Number(suggestion[key]):JSON.stringify(original[key])!==JSON.stringify(suggestion[key])));
  if(mode==='ask'&&conflicts.length){
   const readable=(key,value)=>key==='days'?R.repeatLabel(value):key==='start'?R.timeLabel(value):key==='duration'?value+'분':value;
   const rows=conflicts.map(key=>'<p><strong>'+labels[key]+'</strong> · '+escapeHtml(readable(key,original[key]))+' → '+escapeHtml(readable(key,suggestion[key]))+'</p>').join('');
   eventSheet('<h2>입력한 내용이 있어요</h2><p>어떤 값을 초안에 사용할까요? 아직 루틴은 저장되지 않아요.</p><div class="sheet-detail">'+rows+'</div><div class="sheet-actions"><button class="secondary" data-action="create-keep">기존 값 유지</button><button class="primary" data-action="create-replace">제안 값 사용</button></div>');return;
  }
  const result=mode==='replace'?{...original,...suggestion}:{...suggestion,...Object.fromEntries(Object.entries(original).filter(([,value])=>value!==''&&value!==undefined))};
  state.formDrafts.routine={...result};const screen=c.returnScreen;state.aiCreate=null;state.screen=screen;render();routineForm(result,true);return;
 }
 if(p.type==='routine'){eventSheet('<h2>루틴 초안은 별도로 작성해요</h2><p>지금 입력한 내용은 그대로 보관돼요. 루틴은 추가 메뉴에서 작성해 주세요.</p><div class="sheet-actions"><button class="primary" data-action="create-back">입력 화면으로 돌아가기</button></div>');return}
 const suggestion={name:p.name,date:p.date,time:routineTimeRange(p.time,p.duration),eventType:p.type,involvement:p.involvement},original=c.original||{};
 const labels={name:'이름',date:'날짜',time:'시간',eventType:'종류',involvement:'참여자'};
 const conflicts=Object.keys(labels).filter(key=>original[key]&&suggestion[key]&&original[key]!==suggestion[key]);
 if(mode==='ask'&&conflicts.length){
  const readable=(key,value)=>key==='eventType'?(value==='task'?'할 일':'일정'):key==='involvement'?(value==='shared'?'다른 사람과 함께':'나만'):value;
  const rows=conflicts.map(key=>'<p><strong>'+labels[key]+'</strong> · '+escapeHtml(readable(key,original[key]))+' → '+escapeHtml(readable(key,suggestion[key]))+'</p>').join('');
  eventSheet('<h2>입력한 내용이 있어요</h2><p>어떤 값을 초안에 사용할까요? 아직 일정은 저장되지 않아요.</p><div class="sheet-detail">'+rows+'</div><div class="sheet-actions"><button class="secondary" data-action="create-keep">기존 값 유지</button><button class="primary" data-action="create-replace">제안 값 사용</button></div>');return;
 }
 const result=mode==='replace'?{...original,...suggestion}:{...suggestion,...Object.fromEntries(Object.entries(original).filter(([,value])=>value))};
 state.formDrafts[c.formKind]={...result};const screen=c.returnScreen,kind=c.formKind;state.aiCreate=null;state.screen=screen;render();showAddForm(kind,result);
}
function acceptCreation(){
 const c=state.aiCreate,p=c?.proposal;if(!p||c.source!=='new')return;
 const error=creationConflict(p);
 if(error){c.error=error;render();return}
 if(p.type==='routine')state.routines.push({id:'r'+state.routineNextId++,name:p.name,days:p.days.slice(),start:p.time,duration:p.duration,goal:'',icon:'✦',color:'purple',records:{},recoveries:{},startDate:p.startDate});
 else state.events.push({id:'e'+state.eventNextId++,name:p.name,date:p.date,time:routineTimeRange(p.time,p.duration),type:p.type,involvement:p.involvement,status:'pending',attendance:'unknown',color:'#7894ff',kind:'personal',show:true});
 c.proposal=null;const stored=savePreview();createSay(stored?'승인한 내용을 이 브라우저의 예시 일정에 저장했어요.':'예시 일정이 현재 화면에만 반영됐어요. 브라우저에 저장하지 못해 새로고침하면 사라질 수 있어요.');render();appScreen.scrollTop=appScreen.scrollHeight;
}
function handleCreateAction(action,el){
 if(action==='create-event'){showAddForm('appointment');return}
 if(action==='create-task'){showAddForm('task');return}
 if(action==='create-routine'){routineForm();return}
 if(action==='create-ai'){startCreateChat();return}
 if(action==='create-form-ai'){const original=captureAddDraft(sheet.querySelector('#add-form'));if(original)startCreateChat('form',original);return}
 if(action==='create-routine-ai'){const original=captureRoutineDraft(sheet.querySelector('#routine-form'));if(original)startCreateChat('routine-form',original);return}
 if(action==='create-question'){
  const example=creationExamples.find(([id])=>id===el.dataset.question);if(example){state.aiCreate.slots={type:null,name:'',date:'',time:'',duration:null,days:null};state.aiCreate.expect='';createRequest(example[1]);render();appScreen.scrollTop=appScreen.scrollHeight}return;
 }
 if(action==='create-accept'){acceptCreation();return}
 if(action==='create-reject'){if(state.aiCreate){state.aiCreate.proposal=null;createSay('제안을 저장하지 않았어요.');render()}return}
 if(action==='create-apply'){createApply();return}
 if(action==='create-keep'){createApply('keep');return}
 if(action==='create-replace'){createApply('replace');return}
 if(action==='create-back'){
  const c=state.aiCreate;if(!c||c.source==='new')return;
  const screen=c.returnScreen,kind=c.formKind,original=c.original,routineSource=c.source==='routine-form';state.aiCreate=null;state.screen=screen;render();if(routineSource)routineForm(original,true);else showAddForm(kind,original);return;
 }
 if(action==='create-edit'){
  const c=state.aiCreate,p=c?.proposal;if(!p)return;
  if(p.type==='routine'){state.aiCreate=null;state.screen='routine';render();routineForm({name:p.name,days:p.days,start:p.time,duration:p.duration,goal:''},true);return}
  const draft={name:p.name,date:p.date,time:routineTimeRange(p.time,p.duration),eventType:p.type,involvement:p.involvement};
  state.formDrafts[p.type]=draft;state.aiCreate=null;state.screen='home';render();showAddForm(p.type,draft);return;
 }
}
