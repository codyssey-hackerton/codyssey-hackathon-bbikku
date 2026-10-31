/* Local, deterministic conversation examples; no AI or external calendar is connected. */
state.aiContext=null;
state.aiProposal=null;
state.aiMessages=[];
state.aiRecoveryPrompt=false;

function resolveAiContext(ref=state.aiContext){
 if(!ref)return null;
 if(ref.entity==='event'){
  const index=state.events.findIndex(item=>item.id===ref.id),item=state.events[index];
  if(!item)return null;
  const interval=timelineInterval(item);
  return {entity:'event',id:item.id,item,index,name:item.name,type:item.type==='appointment'?'고정 약속':'할 일',
   date:eventDate(item),time:item.time,start:interval.start?R.timeKey(interval.start.getHours()*60+interval.start.getMinutes()):null,
   duration:interval.end?(interval.end-interval.start)/60000:null,status:eventStatus(item),shared:isSharedEvent(item),deadline:item.deadline||''};
 }
 const row=routineRow(ref.id,ref.origin,ref.kind);
 if(!row||(row.kind==='recovery'&&!row.routine.recoveries[row.origin]))return null;
 const scheduled=row.kind==='recovery'||R.occursOn(row.routine,row.origin);
 return {entity:'routine',id:row.routine.id,item:row.routine,row,name:row.routine.name,type:'루틴',
  date:R.occurrenceDate(row),time:routineTimeRange(R.occurrenceTime(row),R.occurrenceDuration(row)),
  start:R.occurrenceTime(row),duration:R.occurrenceDuration(row),
  status:scheduled?R.status(row,previewNow):'예정 없음',scheduled,shared:false,deadline:row.kind==='recovery'?(row.routine.recoveries[row.origin].deadline||''):''};
}
function startContextChat(ref){
 const selected=resolveAiContext(ref);if(!selected)return;
 state.aiCreate=null;state.aiContext={...ref,name:selected.name,date:selected.date,time:selected.time,type:selected.type};
 state.aiMessages=[];state.aiProposal=null;state.aiRecoveryPrompt=false;
 modal.hidden=true;state.screen='chat';render();
}
function aiAskButton(action,attrs,description='이 일정에 대해 물어보기'){
 return '<button class="ai-menu-action" data-action="'+action+'" '+attrs+'><span class="ai-menu-icon">'+svg('spark')+'</span><span><strong>삐꾸에게 부탁하기</strong><small>'+escapeHtml(description)+'</small></span><span class="ai-menu-arrow">›</span></button>';
}
function aiQuestions(selected){
 if(selected.entity==='routine')return [[selected.status==='완료'?'advice':'move',selected.status==='완료'?'이 시간 괜찮을까요?':'오늘 다른 시간 추천해줘'],['conflict','다른 일정과 겹치나요?'],['repeat','매일 아침으로 변경해줘']];
 if(selected.type==='고정 약속')return [['move','다른 시간 추천해줘'],['conflict','다른 일정과 겹치나요?'],['prepare','준비시간은 얼마나 잡을까요?']];
 return [['move','다른 시간 추천해줘'],['conflict','다른 일정과 겹치나요?'],['advice','이 시간을 바꾸는 게 좋을까요?']];
}
function aiProposalMarkup(p){
 if(!p)return '';
 const when=p.scope==='repeat'?'매일 · '+R.timeLabel(p.time):R.dateLabel(p.date)+' · '+R.timeLabel(p.time)+'부터 '+p.duration+'분';
 return '<div class="ai-proposal"><div class="ai-proposal-label">'+svg('spark')+' 삐꾸의 제안 · 아직 반영되지 않은 일정</div><strong>'+escapeHtml(when)+'</strong><p>'+escapeHtml(p.scope==='repeat'?'반복 규칙 전체 · 앞으로 매일 이 시간에 예정돼요.':'이번 회차 · 다른 예시 일정과 겹치지 않는 시간이에요.')+'</p><p>'+escapeHtml(p.reason)+'</p>'+(p.error?'<p class="routine-error" role="alert">'+escapeHtml(p.error)+'</p>':'')+'<div class="ai-proposal-actions"><button data-action="ai-reject">거절</button><button data-action="ai-edit">수정</button><button class="accept" data-action="ai-accept">수락</button></div></div>';
}
function contextChat(){
 const selected=resolveAiContext(),fallback=state.aiContext;
 const detail=selected?'<strong>'+escapeHtml(selected.name)+'</strong><span>'+escapeHtml(selected.type)+' · '+escapeHtml(R.dateLabel(selected.date))+' · '+escapeHtml(selected.time)+'</span>':'<strong>'+escapeHtml(fallback.name)+'</strong><span>선택한 항목을 찾을 수 없어요.</span>';
 const questionButtons=selected?aiQuestions(selected).map(([key,label])=>'<button data-action="ai-question" data-question="'+key+'">'+escapeHtml(label)+'</button>').join(''):'';
 const messages=state.aiMessages.map(message=>'<div class="bubble '+(message.role==='user'?'user':'')+'">'+escapeHtml(message.text)+'</div>').join('');
 const recovery=state.aiRecoveryPrompt?(selected?.status==='미완료'?'<button class="ai-recovery-check" data-action="ai-recovery">기한과 필요 여부 확인하기 ›</button>':'<button class="ai-recovery-check" data-action="ai-record">수행 상태 확인하기 ›</button>'):'';
 return '<div class="chat-header"><div class="bot-icon">'+svg('bot')+'</div>AI 비서</div><div class="ai-context"><div class="ai-context-caption">선택한 일정</div>'+detail+'<button data-action="ai-clear" aria-label="선택한 일정 닫기">'+svg('close')+'</button></div><div class="bubble ai-intro">선택한 일정에 대해 함께 살펴볼게요. 무엇이 궁금하세요?</div><div class="ai-questions">'+questionButtons+'</div>'+messages+recovery+aiProposalMarkup(state.aiProposal)+'<div class="chat-spacer"></div><div class="ai-preview-hint">예시 대화예요. 실제 AI나 캘린더에는 연결되지 않아요.</div><form class="composer" id="chat-form"><input name="message" aria-label="메시지" placeholder="메시지를 입력하세요..." autocomplete="off"><button class="send" type="submit" aria-label="메시지 보내기">'+svg('send')+'</button></form>';
}
function aiSay(text){state.aiMessages.push({role:'assistant',text})}
function aiExcluded(selected,key){
 return selected.entity==='event'?{eventIndex:selected.index}:{routine:selected.item,origin:key||selected.row.origin};
}
function aiConflict(selected){
 if(!selected.start||!selected.duration){aiSay('시간을 확인할 수 없어 충돌 여부를 판단하지 못했어요.');return}
 if(selected.entity==='routine'&&!selected.scheduled){aiSay('선택한 날짜에는 예정된 회차가 없어요. 반복 규칙을 먼저 확인해 주세요.');return}
 const start=R.minutes(selected.start),end=start+selected.duration,busy=routineBusy(selected.date,aiExcluded(selected));
 let unknown=busy.unknown,clash=busy.intervals.some(item=>R.overlaps(start,end,item.start,item.end));
 if(end>1440){
  const next=routineBusy(R.addDays(selected.date,1),aiExcluded(selected));
  unknown=unknown||next.unknown;clash=clash||next.intervals.some(item=>R.overlaps(0,end-1440,item.start,item.end));
 }
 if(unknown){aiSay('시간을 확인할 수 없는 예시 일정이 있어 겹치는지 확정할 수 없어요.');return}
 aiSay(clash?'현재 시안의 다른 예시 일정과 시간이 겹쳐요.':'현재 시안에 있는 다른 예시 일정과는 겹치지 않아요.');
}
function aiProposalError(p,selected){
 if(!selected||selected.entity!==p.entity||selected.id!==p.id)return '선택한 일정을 찾을 수 없어요.';
 if(JSON.stringify(selected.item)!==p.before)return '원래 일정이 바뀌었어요. 새로 질문해 주세요.';
 if(p.scope==='repeat'){
  const start=R.minutes(p.time);
  if(start===null||start<420||start+p.duration>1320)return '오전 7시부터 오후 10시 사이에 끝나는 시간을 골라 주세요.';
  for(let i=0;i<7;i++){
   const date=R.addDays(previewToday,i),busy=routineBusy(date,aiExcluded(selected,date));
   if(busy.unknown||busy.intervals.some(slot=>R.overlaps(start,start+p.duration,slot.start,slot.end)))return '앞으로 일주일의 예시 일정과 겹치거나 시간을 확인할 수 없어요.';
  }
  return '';
 }
 if(!p.date||!p.time||!R.parseDate(p.date))return '날짜와 시간을 확인해 주세요.';
 if(!R.withinDeadline(p.date,p.time,p.duration,p.deadline))return '확인한 기한 안에 끝나는 시간을 골라 주세요.';
 const busy=routineBusy(p.date,aiExcluded(selected));
 if(busy.unknown||!R.available(p.date,p.time,p.duration,busy.intervals,previewNow))return '지난 시간이거나 다른 예시 일정과 겹쳐요.';
 return '';
}
function aiMoveProposal(selected){
 if(selected.entity==='routine'&&!selected.scheduled){aiSay('선택한 날짜에는 예정된 루틴이 없어요. 반복 규칙을 확인해 주세요.');return}
 if(selected.status==='다시 계획됨'){aiSay('이 회차는 이미 다른 시간으로 옮겨졌어요. 변경된 회차를 선택해 주세요.');return}
 if(selected.status==='완료'){aiSay('이미 완료로 기록된 회차예요. 옮기려면 먼저 완료 기록을 확인해 주세요.');return}
 if(selected.status==='미완료'){
  state.aiRecoveryPrompt=true;
  aiSay('다시 할 수 있도록 기한과 지금도 필요한지 먼저 확인할게요. 아직 일정은 바뀌지 않았어요.');
  return;
 }
 if(!selected.start||!selected.duration||selected.duration<5||selected.duration>480){aiSay('기존 시간을 확인할 수 없어 다른 시간을 제안하지 못했어요.');return}
 const first=selected.date>previewToday?selected.date:previewToday;
 for(let i=0;i<8;i++){
  const date=R.addDays(first,i),busy=routineBusy(date,aiExcluded(selected));
  if(busy.unknown)continue;
  if(date===selected.date)busy.intervals.push({start:R.minutes(selected.start),end:R.minutes(selected.start)+selected.duration});
  const time=R.findSlot(date,selected.duration,busy.intervals,previewNow);
  if(time&&R.withinDeadline(date,time,selected.duration,selected.deadline)){
   state.aiProposal={entity:selected.entity,id:selected.id,scope:'occurrence',before:JSON.stringify(selected.item),date,time,duration:selected.duration,deadline:selected.deadline,
    reason:'예시 일정의 빈 시간을 살펴 골랐어요.'};
   aiSay('다른 예시 시간을 찾아봤어요. 확인하고 결정해 주세요.');return;
  }
 }
 aiSay('확인할 수 있는 예시 일정과 기한 안에서 빈 시간을 찾지 못했어요. 기존 일정은 그대로예요.');
}
function aiRepeatProposal(selected){
 if(selected.entity!=='routine'){aiSay('이 항목은 반복 루틴이 아니에요.');return}
 if(!selected.duration||selected.duration<5||selected.duration>480){aiSay('루틴 소요시간을 먼저 확인해 주세요.');return}
 for(let minute=420;minute<720;minute+=15){
  const p={entity:'routine',id:selected.id,scope:'repeat',before:JSON.stringify(selected.item),time:R.timeKey(minute),duration:selected.duration,
   reason:'앞으로 일주일의 예시 일정과 겹치지 않는 아침 시간을 골랐어요.'};
  if(!aiProposalError(p,selected)){state.aiProposal=p;aiSay('매일 반복하는 시간 변경안을 준비했어요. 전체 반복 규칙에 적용돼요.');return}
 }
 aiSay('앞으로 일주일의 예시 일정에서 겹치지 않는 아침 시간을 찾지 못했어요. 기존 규칙은 그대로예요.');
}
function aiPreparationSuggestion(selected){
 const start=R.minutes(selected.start),date=selected.date;
 if(start===null||!R.parseDate(date)){aiSay('선택한 일정의 시작 시간을 확인할 수 없어요.');return}
 const busy=routineBusy(date,aiExcluded(selected));
 if(busy.unknown){aiSay('시간을 확인할 수 없는 예시 일정이 있어 준비시간을 추천하지 못했어요.');return}
 for(let minute=Math.floor((start-15)/15)*15;minute>=420;minute-=15){
  const time=R.timeKey(minute);
  if(R.available(date,time,15,busy.intervals,previewNow)){
   aiSay(R.dateLabel(date)+' '+R.timeLabel(time)+'부터 15분을 준비시간으로 추천해요. 예시 일정에서 빈 시간으로 확인했어요. 일정은 추가하지 않았어요.');return;
  }
 }
 aiSay('선택한 일정 전에 비어 있는 예시 시간을 찾지 못했어요. 일정은 추가하지 않았어요.');
}
function aiShiftProposal(selected,minutes){
 if(selected.status==='완료'||selected.status==='미완료'||selected.status==='다시 계획됨'||(selected.entity==='routine'&&!selected.scheduled)){aiMoveProposal(selected);return}
 if(!selected.start||!selected.duration||!Number.isInteger(minutes)||minutes<=0||minutes>1440){aiSay('기존 시간과 소요시간을 확인해 주세요. 일정은 그대로예요.');return}
 const date=R.parseDate(selected.date),start=R.minutes(selected.start);
 if(!date||start===null){aiSay('기존 시간을 확인할 수 없어요. 일정은 그대로예요.');return}
 date.setHours(0,0,0,0);date.setMinutes(start+minutes);
 const proposal={entity:selected.entity,id:selected.id,scope:'occurrence',before:JSON.stringify(selected.item),date:R.dateKey(date),time:R.timeKey(date.getHours()*60+date.getMinutes()),duration:selected.duration,deadline:selected.deadline,reason:'요청한 만큼 늦춘 시간을 예시 일정과 기한에 맞춰 확인했어요.'};
 const error=aiProposalError(proposal,selected);
 if(error){aiSay('요청한 시간으로 바꾸기 어려워요. '+error+' 기존 일정은 그대로예요.');return}
 state.aiProposal=proposal;aiSay('요청한 시간으로 늦추는 변경안을 준비했어요. 확인하고 결정해 주세요.');
}
function aiRequest(text,question=''){
 const selected=resolveAiContext();
 state.aiMessages.push({role:'user',text});state.aiProposal=null;state.aiRecoveryPrompt=false;
 if(!selected){aiSay('선택한 항목을 찾을 수 없어요. 목록에서 다시 선택해 주세요.');return}
 if(!question&&/못\s*했|하지\s*못|미완료|놓쳤/.test(text)&&selected.type!=='고정 약속'&&selected.status!=='미완료'){
  state.aiRecoveryPrompt=true;aiSay('먼저 수행 상태를 직접 확인해 주세요. 기록하기 전에는 미완료로 바꾸지 않아요.');return;
 }
 const shift=!question?text.match(/(\d+)\s*분\s*(?:만큼\s*)?(?:늦추|늦춰|미뤄|미루|뒤로)/):null;
 if(shift){aiShiftProposal(selected,Number(shift[1]));return}
 let intent=question;
 if(!intent){
  if(/겹치|충돌/.test(text))intent='conflict';
  else if(/좋을까|괜찮을까|어떨까/.test(text))intent='advice';
  else if(/준비(?:할)?\s*시간/.test(text))intent='prepare';
  else if(/매일|매주|반복|요일|앞으로/.test(text)&&/옮|바꾸|바꿔|변경|조정|추천/.test(text))intent='repeat';
  else if(/옮|이동|바꾸|바꿔|변경|조정|추천|다시/.test(text))intent='move';
 }
 if(intent==='conflict'){aiConflict(selected);return}
 if(intent==='prepare'){aiPreparationSuggestion(selected);return}
 if(intent==='advice'){aiSay(selected.entity==='routine'?'완료 기록은 그대로예요. 실제 생활 패턴을 분석하는 기능은 아직 연결되지 않았어요. 반복 시간을 바꿔보고 싶다면 아래 추천 질문을 선택해 주세요.':'현재는 생활 패턴을 분석할 수 없는 예시예요. 필요하다면 다른 시간을 추천해 볼게요.');return}
 if(intent==='repeat'||intent==='move'){
  if(intent==='repeat')aiRepeatProposal(selected);else aiMoveProposal(selected);
  if(!question&&state.aiProposal&&/내일|모레|다음\s*주|오전|오후|\d{1,2}\s*(?:시|:)/.test(text))aiSay('이 예시는 요청한 날짜와 시간을 자동으로 읽지 못해요. 제안의 수정을 눌러 직접 골라 주세요.');
  return;
 }
 aiSay('자유 대화는 아직 실제 AI에 연결되지 않았어요. 추천 질문을 선택하면 예시 흐름을 확인할 수 있어요.');
}
function aiEditForm(error='',choice=state.aiProposal){
 const p=state.aiProposal;if(!p)return;
 const dateInput=p.scope==='repeat'?'':'<label class="field" for="ai-date">날짜</label><input id="ai-date" type="date" name="date" value="'+escapeHtml(choice.date||previewToday)+'" required>';
 eventSheet('<h2>제안 시간 수정</h2><p>확인 후에도 수락하기 전까지 기존 일정은 그대로예요.</p><form id="ai-proposal-form">'+dateInput+'<label class="field" for="ai-time">시작 시간</label><input id="ai-time" type="time" name="time" value="'+escapeHtml(choice.time||'08:00')+'" required><p class="routine-error" role="alert">'+escapeHtml(error)+'</p><div class="sheet-actions"><button class="secondary" type="button" data-close>취소</button><button class="primary" type="submit">변경안 확인</button></div></form>');
}
function aiEditSubmit(form){
 const p=state.aiProposal;if(!p)return;
 const choice={...p,date:p.scope==='repeat'?p.date:form.elements.date.value,time:form.elements.time.value},error=aiProposalError(choice,resolveAiContext());
 if(error){aiEditForm(error,choice);return}
 choice.reason='직접 고른 시간이 예시 일정과 겹치지 않는지 확인했어요.';choice.error='';
 state.aiProposal=choice;modal.hidden=true;render();appScreen.scrollTop=appScreen.scrollHeight;
}
function aiAccept(){
 const p=state.aiProposal,selected=resolveAiContext();if(!p)return;
 const error=aiProposalError(p,selected);
 if(error){p.error=error;render();return}
 if(selected.shared){
  state.aiProposal=null;aiSay('공동 일정은 상대방 확인 전까지 원래 약속을 유지해요. 실제 연락은 보내지 않았어요.');render();eventSharedHold();return;
 }
 if(p.scope==='repeat'){
  selected.item.days=[0,1,2,3,4,5,6];selected.item.start=p.time;
  aiSay('예시의 반복 규칙을 승인한 시간으로 변경했어요. 기존 회차 기록은 유지돼요.');
 }else if(selected.entity==='event'){
  selected.item.date=p.date;selected.item.time=routineTimeRange(p.time,p.duration);selected.item.source='rescheduled';
  state.selectedDate=R.parseDate(p.date);
  aiSay('승인한 시간을 예시 일정에 반영했어요.');
 }else{
  const row=selected.row;
  if(row.kind==='recovery')Object.assign(row.routine.recoveries[row.origin],{date:p.date,time:p.time,duration:p.duration,move:true});
  else row.routine.recoveries[row.origin]={date:p.date,time:p.time,duration:p.duration,move:true};
  state.aiContext.kind='recovery';state.selectedDate=R.parseDate(p.date);
  aiSay('이 회차만 승인한 시간으로 옮겼어요. 반복 규칙은 그대로예요.');
 }
 state.aiProposal=null;modal.hidden=true;render();appScreen.scrollTop=appScreen.scrollHeight;
}
function handleAiAction(action,el){
 if(action==='ai-clear'){state.aiContext=null;state.aiProposal=null;state.aiMessages=[];state.aiRecoveryPrompt=false;render();return}
 if(action==='ai-question'){
  const selected=resolveAiContext(),pair=selected&&aiQuestions(selected).find(item=>item[0]===el.dataset.question);
  if(pair){aiRequest(pair[1],pair[0]);render();appScreen.scrollTop=appScreen.scrollHeight}return;
 }
 if(action==='ai-record'){
  const selected=resolveAiContext();if(!selected)return;
  if(selected.entity==='event')eventStatusSheet(selected.index);else routineStatusSheet(selected.row);return;
 }
 if(action==='ai-recovery'){
  const selected=resolveAiContext();if(!selected||selected.status!=='미완료')return;
  if(selected.entity==='event')eventChooseRecovery(selected.index);else routineChooseRecovery(selected.row);return;
 }
 if(action==='ai-edit'){aiEditForm();return}
 if(action==='ai-reject'){state.aiProposal=null;aiSay('제안을 반영하지 않았어요. 기존 일정은 그대로예요.');render();return}
 if(action==='ai-accept'){aiAccept();return}
}
