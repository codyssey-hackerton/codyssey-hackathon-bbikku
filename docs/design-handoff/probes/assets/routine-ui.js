/* Interactive routine and calendar examples. Everything here is local preview data. */
const R=PikkuRoutineModel;
state.routineView='today';
state.routineNextId=5;
state.routineProposal=null;
state.routines=[
  {id:'r1',name:'아침 운동',days:[1,3,5],start:'07:30',duration:30,goal:'가볍게 몸 깨우기',icon:'☀',color:'mint',records:{'2025-04-16':'done'},recoveries:{}},
  {id:'r2',name:'물 한 잔 마시기',days:[0,1,2,3,4,5,6],start:'08:00',duration:10,goal:'하루를 가볍게 시작하기',icon:'◌',color:'mint',records:{'2025-04-17':'done'},recoveries:{}},
  {id:'r3',name:'오전 산책',days:[0,1,2,3,4,5,6],start:'09:00',duration:20,goal:'잠깐 바깥 공기 마시기',icon:'✦',color:'purple',records:{'2025-04-17':'missed'},recoveries:{}},
  {id:'r4',name:'저녁 스트레칭',days:[0,1,2,3,4,5,6],start:'19:00',duration:15,goal:'몸의 긴장 풀기',icon:'☾',color:'purple',records:{},recoveries:{}}
];
function routineById(id){return state.routines.find(r=>r.id===id)}
function routineRow(id,origin,kind){const routine=routineById(id);return routine?{routine,origin,kind:kind==='recovery'?'recovery':'regular'}:null}
function routineTimeRange(time,duration){const start=R.minutes(time),end=start+duration;return `${R.timeLabel(time)} - ${R.timeLabel(R.timeKey(end%1440))}${end>=1440?' (다음 날)':''}`}
function calendarEventsFor(key){
 const list=[];
 state.events.forEach((event,index)=>{if(eventDate(event)===key)list.push({...event,index,kind:'event'})});
 for(const row of R.occurrences(state.routines,key)){
  if(R.status(row,previewNow)==='다시 계획됨')continue;
  const routine=row.routine;
  list.push({kind:'routine',row,name:`${routine.name}${row.kind==='recovery'?' · 다시 계획':''}`,date:key,time:routineTimeRange(R.occurrenceTime(row),R.occurrenceDuration(row)),color:routine.color==='mint'?'#7edda9':'#ad67f2'});
 }
 return list;
}
function routineBusy(key,excluded){
 const intervals=[]; let unknown=false;
 function include(start,end,previous){
  if(previous){if(end>1440)intervals.push({start:0,end:end-1440});}
  else intervals.push({start,end});
 }
 for(const previous of [false,true]){
  const date=previous?R.addDays(key,-1):key;
  for(const event of calendarEventsFor(date)) {
   if(event.kind==='routine') continue;
   if(excluded?.eventIndex!==undefined&&event.kind==='event'&&event.index===excluded.eventIndex)continue;
   const value=R.parseEventTime(event.time);
   if(value)include(value.start,value.end,previous);else unknown=true;
  }
  for(const row of R.occurrences(state.routines,date)) {
   if(excluded?.routine && row.routine.id===excluded.routine.id && row.origin===excluded.origin)continue;
   if(R.status(row,previewNow)==='다시 계획됨')continue;
   const start=R.minutes(R.occurrenceTime(row));
   include(start,start+R.occurrenceDuration(row),previous);
  }

 }
 return {intervals,unknown};
}
function routineStatusClass(status){return status==='완료'?'done':status==='미완료'?'missed':status==='다시 예정'?'recovery':status==='예정'?'upcoming':'neutral'}
function routineCard(row,allowRecord=true){return routineScheduleCard(row,'routine',!allowRecord)}
function routineEmptyCard(r,key){return routineScheduleCard({routine:r,origin:key,kind:'regular'},'routine',true)}
function routineView(){
 const key=R.dateKey(state.selectedDate),selected=R.parseDate(key), offset=(selected.getDay()+6)%7;
 const start=R.addDays(key,-offset), rows=R.occurrences(state.routines,key).filter(row=>R.status(row,previewNow)!=='다시 계획됨'), done=rows.filter(row=>R.status(row,previewNow)==='완료').length;
 const percent=rows.length?Math.round(done/rows.length*100):0;
 let week='';
 for(let i=0;i<7;i++){
  const dayKey=R.addDays(start,i),day=R.parseDate(dayKey),isSelected=dayKey===key,isToday=dayKey===previewToday;
  week+=`<button class="routine-day-button ${isSelected?'active':''} ${isToday?'is-today':''}" data-action="routine-date" data-date="${dayKey}" aria-pressed="${isSelected}" aria-label="${R.dateLabel(dayKey)}${isToday?' 오늘':''}"><span>${R.weekdays[day.getDay()]}</span><strong>${day.getDate()}</strong><small>${isToday?'오늘':'&nbsp;'}</small></button>`;
 }
 const title=key===previewToday?'오늘의 루틴':`${selected.getMonth()+1}월 ${selected.getDate()}일 루틴`;
 let cards=state.routineView==='today'?rows.map(row=>routineCard(row)).join(''):state.routines.map(r=>{
  const row=rows.find(x=>x.routine.id===r.id);
  return row?routineCard(row):routineEmptyCard(r,key);
 }).join('');
 if(!cards)cards=`<div class="card routine-empty">${state.routineView==='today'?'선택한 날짜에 예정된 루틴이 없어요.':'아직 등록한 루틴이 없어요.'}</div>`;
 const label=key===previewToday?'오늘':`${selected.getMonth()+1}월 ${selected.getDate()}일`;
 return `${heading('나의 루틴 ✨')}<div class="routine-banner"><b>나의 작은 습관들</b><p>${label}은 ${rows.length}개 중 ${done}개를 완료했어요. <strong>${percent}%</strong></p><div class="routine-progress"><span style="width:${percent}%"></span></div></div><div class="section-heading routine-week-heading"><h2>날짜별 루틴</h2><div><button class="routine-week-arrow" data-action="routine-prev-week" aria-label="이전 7일">‹</button><span class="date">${R.dateLabel(start).replace('요일','')} - ${R.dateLabel(R.addDays(start,6)).replace('요일','')}</span><button class="routine-week-arrow" data-action="routine-next-week" aria-label="다음 7일">›</button></div></div><div class="routine-day routine-day-select">${week}</div><div class="filters routine-tabs"><button class="filter ${state.routineView==='today'?'active':''}" data-action="routine-view" data-view="today">${title}</button><button class="filter ${state.routineView==='all'?'active':''}" data-action="routine-view" data-view="all">전체 루틴</button></div><div class="section-heading"><h2>${state.routineView==='today'?title:'등록한 모든 루틴'}</h2><button class="link" data-action="add-routine">＋ 루틴 추가</button></div>${cards}<p class="routine-preview-note">예시 시각: ${previewDateLabel()} ${R.timeLabel(R.timeKey(previewNow.getHours()*60+previewNow.getMinutes()))} · 시안 기록은 이 브라우저에 저장돼요.</p>`;
}
function setRoutineSheet(body){modal.hidden=false;sheet.innerHTML=`<div class="sheet-top"><span></span><button class="close" data-close aria-label="닫기">${svg('close')}</button></div>${body}`}
function routineForm(routine,asNew=false){
 const edit=!!routine&&!asNew, r=routine||state.formDrafts?.routine||{name:'',days:[1,2,3,4,5],start:'07:30',duration:30,goal:''};
 const days=[1,2,3,4,5,6,0].map(n=>`<label class="routine-weekday-option"><input type="checkbox" name="days" value="${n}" ${r.days.includes(n)?'checked':''}><span>${R.weekdays[n]}</span></label>`).join('');
 setRoutineSheet(`<h2>${edit?'루틴 수정':'새 루틴 만들기'}</h2><p>${edit?'반복 규칙 전체를 수정하며 기존 수행 기록은 보관해요.':'이어가고 싶은 일을 원하는 요일과 시간에 정해요.'}</p><form id="routine-form" data-id="${edit?escapeHtml(r.id):''}">${!edit?`<button class="ai-form-button" type="button" data-action="create-routine-ai">${svg('spark')} AI로 작성하기</button>`:''}<label class="field" for="routine-name">루틴 이름</label><input id="routine-name" name="name" value="${escapeHtml(r.name)}" placeholder="예: 아침 운동" maxlength="30" required><div class="routine-field-head"><span class="field">반복 요일</span><button type="button" class="link" data-action="routine-everyday">매일 선택</button></div><div class="routine-weekdays">${days}</div><div class="routine-form-grid"><div><label class="field" for="routine-start">시작 시간</label><input type="time" id="routine-start" name="start" value="${escapeHtml(r.start)}" required></div><div><label class="field" for="routine-duration">소요시간 (분)</label><input type="number" id="routine-duration" name="duration" value="${escapeHtml(String(r.duration??''))}" min="5" max="480" step="5" required></div></div><label class="field" for="routine-goal">목표 <small>선택</small></label><input id="routine-goal" name="goal" value="${escapeHtml(r.goal)}" placeholder="이 루틴으로 이루고 싶은 것" maxlength="50"><p class="routine-error" id="routine-error" role="alert"></p><div class="sheet-actions"><button class="secondary" type="button" data-close>취소</button><button class="primary" type="submit">${edit?'반복 규칙 저장':'루틴 등록'}</button></div></form>`);
}
function routineDetail(row){
 if(!row)return;
 const r=row.routine,key=row.origin,canRecord=row.kind==='recovery'||R.occursOn(r,key),status=canRecord?R.status(row,previewNow):'예정 없음';
 const attrs=`data-id="${escapeHtml(r.id)}" data-origin="${escapeHtml(key)}" data-kind="${row.kind}"`;
 const disabled=status==='다시 계획됨';
 let history='',recorded=0,completed=0;
 for(let n=6;n>=0;n--){const date=R.addDays(previewToday,-n);if(!R.occursOn(r,date)&&!r.records[date]&&!r.recoveries[date])continue;const v=r.records[date],recovery=r.recoveries[date];if(v){recorded++;if(v==='done'||recovery?.record==='done')completed++}const label=v==='done'?'완료':v==='missed'?(recovery?.record==='done'?'미완료 · 복구 완료':recovery?'미완료 · 다시 계획됨':'미완료'):'기록 없음';history+=`<div class="routine-history-row"><span>${R.dateLabel(date)}</span><b>${label}</b></div>`}
 setRoutineSheet(`<h2>${escapeHtml(r.name)}</h2><p>${escapeHtml(R.repeatLabel(r.days))} · ${escapeHtml(R.timeLabel(r.start))} · ${r.duration}분</p><div class="sheet-detail"><strong>목표</strong><br>${escapeHtml(r.goal||'아직 설정하지 않았어요.')}<br><strong>${R.dateLabel(key)} 상태</strong> · ${status}</div>${canRecord&&!disabled?`<div class="routine-record-actions"><button class="secondary" data-action="routine-set-record" ${attrs} data-record="done">완료로 기록</button><button class="secondary" data-action="routine-set-record" ${attrs} data-record="missed">미완료로 기록</button><button class="secondary" data-action="routine-set-record" ${attrs} data-record="clear">기록 지우기</button></div>`:''}${status==='미완료'?`<button class="primary routine-sheet-wide" data-action="routine-recover" ${attrs}>다시 계획하기</button>`:''}<div class="routine-history"><h3>최근 수행 기록</h3><p>${recorded?`기록한 ${recorded}회 중 ${completed}회 완료 · ${Math.round(completed/recorded*100)}%`:'아직 완료·미완료 기록이 없어요.'}</p>${history||'<p>최근 반복 일정이 없어요.</p>'}</div><div class="sheet-actions"><button class="secondary" data-action="routine-delete" data-id="${escapeHtml(r.id)}">삭제</button><button class="primary" data-action="routine-edit" data-id="${escapeHtml(r.id)}">수정</button></div>`);
}
function routineChooseRecovery(row,error='',value=undefined){
 if(!row || R.status(row,previewNow)!=='미완료')return;
 const attrs=`data-id="${escapeHtml(row.routine.id)}" data-origin="${escapeHtml(row.origin)}" data-kind="${row.kind}"`,existing=row.kind==='recovery'?(row.routine.recoveries[row.origin]?.deadline||''):'',deadline=value===undefined?existing:value;
 setRoutineSheet(`<h2>다시 이어가 볼까요?</h2><p>${R.dateLabel(R.occurrenceDate(row))}에 놓친 ${escapeHtml(row.routine.name)}이 지금도 필요한지 먼저 확인해요.</p><div class="sheet-detail">기한이 유효한지 확인하고 예시 일정과 루틴을 살펴 제안해요. 수락하기 전에는 일정이 바뀌지 않아요.</div><label class="field" for="routine-deadline">기한 (선택)</label><input id="routine-deadline" type="datetime-local" value="${escapeHtml(deadline)}"><p>${existing?'기한 변경도 수락 전에는 반영되지 않아요.':'기한이 없다면 비워 두세요.'}</p>${error?`<p class="routine-error" role="alert">${escapeHtml(error)}</p>`:''}<div class="sheet-actions"><button class="secondary" data-close>지금은 아니에요</button><button class="primary" data-action="routine-propose" ${attrs}>필요해요</button></div>`);
}
function routineRecommend(row){
 if(!row || R.status(row,previewNow)!=='미완료')return;
 const existing=row.kind==='recovery'?(row.routine.recoveries[row.origin]?.deadline||''):'',input=sheet.querySelector('#routine-deadline'),deadline=input?input.value:existing;
 if(existing&&!deadline){routineChooseRecovery(row,'기존에 설정된 기한을 확인해 주세요.',deadline);return}
 const limit=deadline?R.parseDateTime(deadline):null;
 if(deadline&&(!limit||limit<=previewNow)){routineChooseRecovery(row,'기한이 지났거나 올바르지 않아요. 기한을 확인한 뒤 다시 시도해 주세요.',deadline);return}
 let choice=null;
 for(let i=0;i<8;i++){
  const date=R.addDays(previewToday,i);if(deadline&&date>deadline.slice(0,10))break;
  const busy=routineBusy(date,row);if(busy.unknown)continue;
  const time=R.findSlot(date,row.routine.duration,busy.intervals,previewNow);
  if(time&&R.withinDeadline(date,time,row.routine.duration,deadline)){choice={date,time};break}
 }
 state.routineProposal={id:row.routine.id,origin:row.origin,kind:row.kind,originalDeadline:existing,deadline,...choice};
 routineProposalSheet();
}
function routineProposalSheet(error=''){
 const proposal=state.routineProposal,r=proposal&&routineById(proposal.id);if(!r)return;
 const info=proposal.date?`<div class="sheet-detail"><strong>${escapeHtml(r.name)}</strong><br>${R.dateLabel(proposal.date)} · ${R.timeLabel(proposal.time)}부터 ${r.duration}분<br><span>예시 일정과 다른 루틴의 시간을 피해 골랐어요.</span>${proposal.deadline?`<br>${proposal.originalDeadline&&proposal.originalDeadline!==proposal.deadline?'기한 변경 · '+escapeHtml(proposal.originalDeadline.replace('T',' '))+' → ':'확인한 기한 · '}${escapeHtml(proposal.deadline.replace('T',' '))}`:''}</div>`:`<div class="sheet-detail">${proposal.deadline?'확인한 기한 안에':'예시 일정에서'} 가능한 시간을 찾지 못했어요. 기존 일정은 그대로예요.</div>`;
 setRoutineSheet(`<h2>삐꾸의 시간 제안 ✨</h2><p>아직 일정에 반영되지 않은 예시 제안이에요.</p>${info}${error?`<p class="routine-error" role="alert">${escapeHtml(error)}</p>`:''}<div class="sheet-actions"><button class="secondary" data-action="routine-reject">거절</button><button class="secondary" data-action="routine-modify">시간 수정</button>${proposal.date?'<button class="primary" data-action="routine-accept">수락</button>':''}</div>`);
}
function routineRecoveryEdit(error='',choice=state.routineProposal){
 const p=state.routineProposal,r=p&&routineById(p.id);if(!r)return;
 setRoutineSheet(`<h2>시간을 바꿔 볼까요?</h2><p>다른 일정과 겹치지 않는 시간을 골라 주세요.</p><form id="routine-recovery-form"><label class="field" for="recovery-date">날짜</label><input id="recovery-date" type="date" name="date" value="${escapeHtml(choice.date||previewToday)}" min="${previewToday}" required><label class="field" for="recovery-time">시작 시간</label><input id="recovery-time" type="time" name="time" value="${escapeHtml(choice.time||'12:00')}" required><p>${escapeHtml(r.name)} · ${r.duration}분</p><p class="routine-error" role="alert">${escapeHtml(error)}</p><div class="sheet-actions"><button class="secondary" type="button" data-action="routine-proposal-back">뒤로</button><button class="primary" type="submit">변경안 확인</button></div></form>`);
}
function routineSlotError(proposal,row){
 if(!row||!proposal.date||!proposal.time)return '날짜와 시간을 확인해 주세요.';
 if(!R.withinDeadline(proposal.date,proposal.time,row.routine.duration,proposal.deadline))return '확인한 기한 안에 끝나는 시간을 골라 주세요.';
 const busy=routineBusy(proposal.date,row);
 if(busy.unknown)return '시간을 확인할 수 없는 예시 일정이 있어 다른 날짜를 선택해 주세요.';
 if(!R.available(proposal.date,proposal.time,row.routine.duration,busy.intervals,previewNow))return '지난 시간이거나 다른 일정과 겹쳐요. 오전 7시부터 오후 10시 사이의 빈 시간을 골라 주세요.';
 return '';
}
function routineMenu(row){
 if(!row)return;
 const r=row.routine,status=R.status(row,previewNow),attrs=`data-id="${escapeHtml(r.id)}" data-origin="${escapeHtml(row.origin)}" data-kind="${row.kind}"`;
 const canRecord=(row.kind==='recovery'&&!!r.recoveries[row.origin])||(row.kind==='regular'&&R.occursOn(r,row.origin));
 setRoutineSheet(`<h2>${escapeHtml(r.name)}</h2><p>어떤 작업을 할까요?</p>${aiAskButton('routine-ask-ai',attrs)}<div class="card-menu-list"><button data-action="routine-detail" ${attrs}>상세 정보 보기</button><button data-action="routine-edit" ${attrs}>수정</button>${canRecord&&status!=='다시 계획됨'?`<button data-action="routine-status" ${attrs}>완료 상태 변경</button>`:''}${status==='미완료'?`<button data-action="routine-recover" ${attrs}>AI로 다시 계획하기</button>`:''}<button data-action="routine-delete" ${attrs}>삭제</button></div>`);
}
function routineStatusSheet(row){
 if(!row)return;
 const r=row.routine,canRecord=(row.kind==='recovery'&&!!r.recoveries[row.origin])||(row.kind==='regular'&&R.occursOn(r,row.origin));
 if(!canRecord||R.status(row,previewNow)==='다시 계획됨')return;
 const status=R.status(row,previewNow),attrs=`data-id="${escapeHtml(r.id)}" data-origin="${escapeHtml(row.origin)}" data-kind="${row.kind}"`;
 setRoutineSheet(`<h2>수행 상태</h2><p>${escapeHtml(r.name)} · ${R.dateLabel(R.occurrenceDate(row))}</p><div class="sheet-detail">현재 상태 · ${status}<br>선택하지 않은 항목은 자동으로 미완료가 되지 않아요.</div><div class="event-record-actions routine-status-actions"><button class="secondary ${status==='완료'?'event-selected':''}" data-action="routine-set-record" ${attrs} data-record="done" aria-pressed="${status==='완료'}">완료</button><button class="secondary ${status==='미완료'?'event-selected':''}" data-action="routine-set-record" ${attrs} data-record="missed" aria-pressed="${status==='미완료'}">못했어요</button><button class="secondary" data-action="routine-set-record" ${attrs} data-record="clear">기록 지우기</button></div>${status==='미완료'?`<button class="primary routine-sheet-wide" data-action="routine-recover" ${attrs}>AI로 다시 계획하기</button>`:''}`);
}
function handleRoutineAction(action,el){
 const id=el.dataset.id,origin=el.dataset.origin,kind=el.dataset.kind,row=id?routineRow(id,origin,kind):null;
 if(action==='add-routine'){routineForm();return}
 if(action==='routine-view'){state.routineView=el.dataset.view==='all'?'all':'today';render();return}
 if(action==='routine-date'){const date=R.parseDate(el.dataset.date);if(date){state.selectedDate=date;render()}return}
 if(action==='routine-prev-week'||action==='routine-next-week'){state.selectedDate=R.parseDate(R.addDays(R.dateKey(state.selectedDate),action==='routine-prev-week'?-7:7));render();return}
 if(action==='routine-detail'){routineDetail(row);return}
 if(action==='routine-menu'){routineMenu(row);return}
 if(action==='routine-ask-ai'&&row){startContextChat({entity:'routine',id,origin,kind:row.kind});return}
 if(action==='routine-status'){routineStatusSheet(row);return}
 if(action==='routine-edit'){const r=routineById(id);if(r)routineForm(r);return}
 if(action==='routine-everyday'){sheet.querySelectorAll('input[name="days"]').forEach(box=>box.checked=true);const form=sheet.querySelector('#routine-form');if(form&&!form.dataset?.id)captureRoutineDraft(form);return}
 if(action==='routine-check'&&row){
  if((row.kind==='regular'&&!R.occursOn(row.routine,row.origin))||R.status(row,previewNow)==='다시 계획됨')return;if(R.status(row,previewNow)==='완료')routineUndoCompletion(row);else routineSetRecord(row,'done');state.routineProposal=null;render();return;
 }
 if(action==='routine-set-record'&&row){routineSetRecord(row,el.dataset.record);state.routineProposal=null;render();routineStatusSheet(row);return}
 if(action==='routine-delete'&&row){setRoutineSheet(`<h2>루틴을 삭제할까요?</h2><p>${escapeHtml(row.routine.name)}의 반복 규칙을 삭제해요. 이미 추가한 예시 복구 일정은 캘린더에 남아요.</p><div class="sheet-actions"><button class="secondary" data-close>취소</button><button class="primary" data-action="routine-delete-confirm" data-id="${escapeHtml(id)}" data-origin="${escapeHtml(origin||R.dateKey(state.selectedDate))}" data-kind="regular">삭제</button></div>`);return}
 if(action==='routine-delete-confirm'&&row){
  Object.values(row.routine.recoveries).forEach(rec=>state.events.push({id:`e${state.eventNextId++}`,name:`${row.routine.name} · 다시 계획`,date:rec.date,time:routineTimeRange(rec.time,rec.duration ?? row.routine.duration),type:'task',status:rec.record||'pending',deadline:rec.deadline||'',color:'#ad72ef',kind:'personal',show:true,source:'recovery'}));
  state.routines=state.routines.filter(r=>r.id!==id);state.routineProposal=null;modal.hidden=true;render();toast('루틴을 삭제했어요');return;
 }
 if(action==='routine-recover'){routineChooseRecovery(row);return}
 if(action==='routine-propose'){routineRecommend(row);return}
 if(action==='routine-reject'){state.routineProposal=null;modal.hidden=true;toast('제안을 반영하지 않았어요');return}
 if(action==='routine-modify'){routineRecoveryEdit();return}
 if(action==='routine-proposal-back'){routineProposalSheet();return}
 if(action==='routine-accept'){
  const p=state.routineProposal,current=p&&routineRow(p.id,p.origin,p.kind),error=p&&routineSlotError(p,current);
  if(!p||!current)return;
  if(R.status(current,previewNow)!=='미완료'||(current.kind==='recovery'?(current.routine.recoveries[p.origin]?.deadline||''):'')!==p.originalDeadline){routineProposalSheet('루틴 상태가 바뀌어 다시 확인이 필요해요.');return}
  if(error){routineProposalSheet(error);return}
  const previous=current.routine.recoveries[p.origin];
  const history=previous?[...(previous.history||[]),{date:previous.date,time:previous.time,deadline:previous.deadline||'',record:previous.record||null}]:[];
  current.routine.recoveries[p.origin]={date:p.date,time:p.time,duration:current.routine.duration,deadline:p.deadline,record:null,history};
  state.selectedDate=R.parseDate(p.date);state.routineView='today';state.routineProposal=null;if(state.aiContext?.entity==='routine'&&state.aiContext.id===p.id&&state.aiContext.origin===p.origin){state.aiContext.kind='recovery';state.aiRecoveryPrompt=false}modal.hidden=true;render();toast('승인한 예시 일정을 추가했어요');
 }
}
function routineSetRecord(row,value){
 if(!['done','missed','clear'].includes(value))return;
 const status=R.status(row,previewNow);
 if(status==='다시 계획됨'||(row.kind==='regular'&&!R.occursOn(row.routine,row.origin)))return;
 const target=row.kind==='recovery'?row.routine.recoveries[row.origin]:row.routine.records;
 if(!target)return;
 const key=row.kind==='recovery'?'record':row.origin,undoKey=`${row.kind}:${row.origin}`;
 row.routine.undoRecords ||= {};
 if(value==='done'&&target[key]!=='done')row.routine.undoRecords[undoKey]=target[key]||null;
 if(value!=='done')delete row.routine.undoRecords[undoKey];
 if(value==='clear')delete target[key];else target[key]=value;
}
function routineUndoCompletion(row){
 const target=row.kind==='recovery'?row.routine.recoveries[row.origin]:row.routine.records;if(!target)return;
 const key=row.kind==='recovery'?'record':row.origin,undoKey=`${row.kind}:${row.origin}`,previous=row.routine.undoRecords?.[undoKey];
 if(previous==='missed')target[key]='missed';else delete target[key];
 if(row.routine.undoRecords)delete row.routine.undoRecords[undoKey];
}
function handleRoutineSubmit(form){
 const name=form.elements.name.value.trim(),start=form.elements.start.value,duration=Number(form.elements.duration.value),goal=form.elements.goal.value.trim();
 const days=Array.from(form.querySelectorAll('input[name="days"]:checked')).map(box=>Number(box.value));
 const error=sheet.querySelector('#routine-error');
 if(!name||R.minutes(start)===null||!Number.isInteger(duration)||duration<5||duration>480||!days.length){if(error)error.textContent='이름, 반복 요일, 시작 시간과 5~480분 소요시간을 확인해 주세요.';return}
 const id=form.dataset.id,old=id&&routineById(id);
 if(old){Object.assign(old,{name,days,start,duration,goal});state.routineProposal=null}
 else state.routines.push({id:`r${state.routineNextId++}`,name,days,start,duration,goal,icon:'✦',color:'purple',records:{},recoveries:{},startDate:previewToday});
 if(!old)delete state.formDrafts.routine;
 modal.hidden=true;render();toast(old?'루틴을 수정했어요':'루틴을 등록했어요');
}
function handleRecoverySubmit(form){
 const p=state.routineProposal,row=p&&routineRow(p.id,p.origin,p.kind);if(!p||!row)return;
 const choice={...p,date:form.elements.date.value,time:form.elements.time.value},error=routineSlotError(choice,row);
 if(error){routineRecoveryEdit(error,choice);return}
 state.routineProposal=choice;routineProposalSheet();
}
