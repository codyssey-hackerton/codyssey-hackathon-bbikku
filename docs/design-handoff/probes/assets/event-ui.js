/* Local example interactions for to-dos and fixed appointments. */
state.eventProposal=null;
state.eventNextId=10;
function eventSheet(body){modal.hidden=false;sheet.innerHTML=`<div class="sheet-top"><span></span><button class="close" data-close aria-label="닫기">${svg('close')}</button></div>${body}`}
function eventDetail(index){
 const event=state.events[index];if(!event)return;
 const status=eventStatus(event),attr=`data-index="${index}"`;
 const header=`<h2>${escapeHtml(event.name)}</h2><p>${event.type==='appointment'?'고정 약속':'할 일'} · ${R.dateLabel(eventDate(event))}</p><div class="sheet-detail"><strong>${escapeHtml(event.time)}</strong><br>현재 상태 · ${status}${event.deadline?`<br>기한 · ${escapeHtml(event.deadline.replace('T',' '))}`:''}${event.source==='recovery'?'<br>사용자가 승인해 다시 계획한 일정':event.source==='recommendation'?'<br>사용자가 승인한 추천 일정':''}</div>`;
 if(event.type==='appointment'){
  eventSheet(`${header}<div class="event-sheet-section"><strong>참석 여부</strong><p>완료 체크와 별도로 직접 선택해요.</p><div class="event-record-actions"><button class="secondary ${(event.attendance||'unknown')==='attend'?'event-selected':''}" data-action="event-attendance" ${attr} data-attendance="attend" aria-pressed="${(event.attendance||'unknown')==='attend'}">참석</button><button class="secondary ${(event.attendance||'unknown')==='absent'?'event-selected':''}" data-action="event-attendance" ${attr} data-attendance="absent" aria-pressed="${(event.attendance||'unknown')==='absent'}">불참</button><button class="secondary ${(event.attendance||'unknown')==='unknown'?'event-selected':''}" data-action="event-attendance" ${attr} data-attendance="unknown" aria-pressed="${(event.attendance||'unknown')==='unknown'}">확인 전</button></div></div>`);
  return;
 }
 eventSheet(`${header}<div class="event-sheet-section"><strong>수행 기록</strong><p>직접 선택하기 전까지 완료나 미완료로 처리하지 않아요.</p><div class="event-record-actions"><button class="secondary ${event.status==='done'?'event-selected':''}" data-action="event-record" ${attr} data-record="done" aria-pressed="${event.status==='done'}">완료</button><button class="secondary ${event.status==='missed'?'event-selected':''}" data-action="event-record" ${attr} data-record="missed" aria-pressed="${event.status==='missed'}">미완료</button><button class="secondary" data-action="event-record" ${attr} data-record="clear">기록 지우기</button></div></div>${event.status==='missed'?`<button class="primary routine-sheet-wide" data-action="event-recover" ${attr}>다시 계획하기</button>`:''}`);
}
function isSharedEvent(event){return event.involvement==='shared'||(event.type==='appointment'&&event.involvement!=='personal')}
function eventAttendanceSheet(index){
 const event=state.events[index];if(!event||event.type!=='appointment')return;
 const value=event.attendance||'unknown',attrs=`data-index="${index}"`;
 eventSheet(`<h2>참석 여부</h2><p>${escapeHtml(event.name)} · ${escapeHtml(event.time)}</p><div class="sheet-detail">현재 상태 · ${eventStatus(event)}<br>직접 선택하기 전에는 참석이나 불참으로 처리하지 않아요.</div><div class="event-record-actions routine-status-actions"><button class="secondary ${value==='attend'?'event-selected':''}" data-action="event-attendance" ${attrs} data-attendance="attend" aria-pressed="${value==='attend'}">참석</button><button class="secondary ${value==='absent'?'event-selected':''}" data-action="event-attendance" ${attrs} data-attendance="absent" aria-pressed="${value==='absent'}">불참</button><button class="secondary ${value==='unknown'?'event-selected':''}" data-action="event-attendance" ${attrs} data-attendance="unknown" aria-pressed="${value==='unknown'}">미확인</button></div>`);
}
function eventStatusSheet(index){
 const event=state.events[index];if(!event)return;
 if(event.type==='appointment'){eventAttendanceSheet(index);return}
 const status=eventStatus(event),attrs=`data-index="${index}"`;
 eventSheet(`<h2>수행 상태</h2><p>${escapeHtml(event.name)} · ${escapeHtml(event.time)}</p><div class="sheet-detail">현재 상태 · ${status}<br>직접 선택하지 않으면 완료나 미완료로 처리하지 않아요.</div><div class="event-record-actions routine-status-actions"><button class="secondary ${event.status==='done'?'event-selected':''}" data-action="event-record" ${attrs} data-record="done" aria-pressed="${event.status==='done'}">완료</button><button class="secondary ${event.status==='missed'?'event-selected':''}" data-action="event-record" ${attrs} data-record="missed" aria-pressed="${event.status==='missed'}">못했어요</button><button class="secondary" data-action="event-record" ${attrs} data-record="clear">기록 지우기</button></div>${event.status==='missed'?`<button class="primary routine-sheet-wide" data-action="event-recover" ${attrs}>AI로 다시 계획하기</button>`:''}`);
}
function eventMenu(index){
 const event=state.events[index];if(!event)return;
 const attrs=`data-index="${index}"`,shared=isSharedEvent(event);
 eventSheet(`<h2>${escapeHtml(event.name)}</h2><p>어떤 작업을 할까요?</p>${aiAskButton('event-ask-ai',attrs)}<div class="card-menu-list"><button data-action="event-detail" ${attrs}>상세 정보 보기</button><button data-action="event-edit" ${attrs}>${shared?'수정 요청':'수정'}</button><button data-action="event-status" ${attrs}>${event.type==='appointment'?'참석 여부 변경':'완료 상태 변경'}</button>${event.type!=='appointment'&&event.status==='missed'?`<button data-action="event-recover" ${attrs}>AI로 다시 계획하기</button>`:''}<button data-action="event-delete" ${attrs}>${shared?'취소 요청':'삭제'}</button></div>`);
}
function eventEditForm(index,error='',draft=null){
 const event=state.events[index];if(!event)return;
 const v=draft||{name:event.name,date:eventDate(event),time:event.time};
 eventSheet(`<h2>일정 수정</h2><p>${isSharedEvent(event)?'공동 일정은 상대방 확인 전 원래 일정이 유지돼요.':'변경 내용을 확인한 후에 적용해요.'}</p><form id="event-edit-form" data-index="${index}" data-id="${escapeHtml(event.id)}"><label class="field" for="edit-event-name">제목</label><input id="edit-event-name" name="name" maxlength="30" value="${escapeHtml(v.name)}" required><label class="field" for="edit-event-date">날짜</label><input id="edit-event-date" name="date" type="date" value="${escapeHtml(v.date)}" required><label class="field" for="edit-event-time">시간</label><input id="edit-event-time" name="time" value="${escapeHtml(v.time)}" placeholder="예: 오후 3:00 - 4:00" required><p class="routine-error" role="alert">${escapeHtml(error)}</p><div class="sheet-actions"><button class="secondary" type="button" data-close>취소</button><button class="primary" type="submit">변경 내용 확인</button></div></form>`);
}
function eventEditError(index,draft){
 const event=state.events[index],date=R.parseDate(draft.date),interval=R.parseEventTime(draft.time);
 if(!event||!draft.name||!date||!interval)return '제목과 날짜, 읽을 수 있는 시간(예: 오후 3:00 - 4:00)을 확인해 주세요.';
 if(event.deadline&&!R.withinDeadline(draft.date,R.timeKey(interval.start),interval.end-interval.start,event.deadline))return '기한 안에 끝나는 시간을 선택해 주세요.';
 if(draft.date!==eventDate(event)||draft.time!==event.time){
  const busy=routineBusy(draft.date,{eventIndex:index});
  if(busy.unknown||busy.intervals.some(item=>R.overlaps(interval.start,interval.end,item.start,item.end)))return '다른 일정과 겹치거나 시간을 확인할 수 없어요.';
  if(interval.end>1440){const next=routineBusy(R.addDays(draft.date,1),{eventIndex:index});if(next.unknown||next.intervals.some(item=>R.overlaps(0,interval.end-1440,item.start,item.end)))return '다음 날 일정과 겹치거나 시간을 확인할 수 없어요.'}
 }
 return '';
}
function eventEditSubmit(form){
 const index=Number(form.dataset.index),event=state.events[index];if(!event||event.id!==form.dataset.id)return;
 const draft={name:form.elements.name.value.trim(),date:form.elements.date.value,time:form.elements.time.value.trim()},error=eventEditError(index,draft);
 if(error){eventEditForm(index,error,draft);return}
 state.pendingEventEdit={id:event.id,index,before:JSON.stringify(event),draft};
 const shared=isSharedEvent(event);
 eventSheet(`<h2>변경 내용을 확인해요</h2><div class="sheet-detail"><strong>${escapeHtml(event.name)}</strong><br>${R.dateLabel(eventDate(event))} · ${escapeHtml(event.time)}<br>→ ${escapeHtml(draft.name)}<br>${R.dateLabel(draft.date)} · ${escapeHtml(draft.time)}</div><p>${shared?'공동 일정은 상대방 수락과 재확인 전까지 원래 약속을 유지해요.':'확인하면 이 시안의 일정이 바뀌어요.'}</p><div class="sheet-actions"><button class="secondary" data-close>취소</button><button class="primary" data-action="event-edit-confirm" data-index="${index}">${shared?'승인 절차 확인':'변경 저장'}</button></div>`);
}
function eventSharedHold(){eventSheet('<h2>상대방 확인이 필요해요</h2><p>공동 약속은 연락 승인과 상대방 수락 후 다시 확인해야 바뀌어요. 이 시안에서는 실제 연락을 보내지 않으며 원래 일정은 그대로 유지돼요.</p><div class="sheet-actions"><button class="primary" data-close>확인</button></div>')}
function eventDeleteSheet(index){
 const event=state.events[index];if(!event)return;
 state.pendingEventDelete={id:event.id,index,before:JSON.stringify(event)};
 const shared=isSharedEvent(event);
 eventSheet(`<h2>${shared?'약속 취소를 검토할까요?':'일정을 삭제할까요?'}</h2><p>${escapeHtml(event.name)}${shared?'은 상대방 수락 전까지 원래 약속을 유지해요.':'을 이 시안에서 삭제해요.'}</p><div class="sheet-actions"><button class="secondary" data-close>돌아가기</button><button class="primary" data-action="event-delete-confirm" data-index="${index}">${shared?'승인 절차 확인':'삭제'}</button></div>`);
}
function eventChooseRecovery(index,error='',value=undefined){
 const event=state.events[index];if(!event||event.type==='appointment'||event.status!=='missed')return;
 const hasDeadline=!!event.deadline,deadline=value===undefined?(event.deadline||''):value;
 eventSheet(`<h2>다시 이어가 볼까요?</h2><p>${escapeHtml(event.name)}이 지금도 필요한지, 다시 할 수 있는 기한이 남았는지 먼저 확인해요.</p><div class="sheet-detail">예시 일정과 고정 약속을 살펴 빈 시간을 제안해요. 수락하기 전까지 기존 일정은 바뀌지 않아요.</div><label class="field" for="event-deadline">기한 ${hasDeadline?'':'(선택)'}</label><input id="event-deadline" type="datetime-local" value="${escapeHtml(deadline)}"><p>${hasDeadline?'기한 변경도 제안을 수락하기 전에는 반영되지 않아요.':'기한이 없다면 비워 두세요.'}</p>${error?`<p class="routine-error" role="alert">${escapeHtml(error)}</p>`:''}<div class="sheet-actions"><button class="secondary" data-close>지금은 아니에요</button><button class="primary" data-action="event-propose" data-index="${index}">필요해요</button></div>`);
}
function eventRecommend(index){
 const event=state.events[index];if(!event||event.type==='appointment'||event.status!=='missed')return;
 const input=sheet.querySelector('#event-deadline'),deadline=input?input.value:(event.deadline||'');
 if(event.deadline&&!deadline){eventChooseRecovery(index,'기존에 설정된 기한을 확인해 주세요.',deadline);return}
 const limit=deadline?R.parseDateTime(deadline):null;
 if(deadline&&(!limit||limit<=previewNow)){eventChooseRecovery(index,'기한이 지났거나 올바르지 않아요. 기한을 확인한 뒤 다시 시도해 주세요.',deadline);return}
 const interval=R.parseEventTime(event.time);
 if(!interval){eventChooseRecovery(index,'기존 일정 시간을 확인할 수 없어 추천할 수 없어요.',deadline);return}
 const duration=interval.end-interval.start;
 if(duration<5||duration>480){eventChooseRecovery(index,'예시에서는 5분에서 8시간 사이의 일정만 다시 계획할 수 있어요.',deadline);return}
 let choice=null;
 for(let i=0;i<8;i++){
  const date=R.addDays(previewToday,i);if(deadline&&date>deadline.slice(0,10))break;
  const busy=routineBusy(date,{eventIndex:index});if(busy.unknown)continue;
  const time=R.findSlot(date,duration,busy.intervals,previewNow);
  if(time&&R.withinDeadline(date,time,duration,deadline)){choice={date,time};break}
 }
 state.eventProposal={index,id:event.id,originalDate:eventDate(event),originalTime:event.time,originalDeadline:event.deadline||'',duration,deadline,...choice};
 eventProposalSheet();
}
function eventProposalSheet(error=''){
 const p=state.eventProposal,event=p&&state.events[p.index];if(!event)return;
 const info=p.date?`<div class="sheet-detail"><strong>${escapeHtml(event.name)}</strong><br>${R.dateLabel(p.date)} · ${R.timeLabel(p.time)}부터 ${p.duration}분<br><span>기존 예시 일정과 고정 약속을 피해 골랐어요.</span>${p.deadline?`<br>${p.originalDeadline&&p.originalDeadline!==p.deadline?'기한 변경 · '+escapeHtml(p.originalDeadline.replace('T',' '))+' → ': '확인한 기한 · '}${escapeHtml(p.deadline.replace('T',' '))}`:''}</div>`:`<div class="sheet-detail">${p.deadline?'확인한 기한 안에':'예시 일정에서'} 가능한 시간을 찾지 못했어요. 기존 일정은 그대로예요.</div>`;
 eventSheet(`<h2>삐꾸의 시간 제안 ✨</h2><p>아직 일정에 반영되지 않은 예시 제안이에요.</p>${info}${error?`<p class="routine-error" role="alert">${escapeHtml(error)}</p>`:''}<div class="sheet-actions"><button class="secondary" data-action="event-reject">거절</button><button class="secondary" data-action="event-modify">시간 수정</button>${p.date?'<button class="primary" data-action="event-accept">수락</button>':''}</div>`);
}
function eventRecoveryEdit(error='',choice=state.eventProposal){
 const p=state.eventProposal,event=p&&state.events[p.index];if(!event)return;
 eventSheet(`<h2>시간을 바꿔 볼까요?</h2><p>다른 일정과 겹치지 않는 시간을 골라 주세요.</p><form id="event-recovery-form"><label class="field" for="event-recovery-date">날짜</label><input id="event-recovery-date" type="date" name="date" value="${escapeHtml(choice.date||previewToday)}" min="${previewToday}" required><label class="field" for="event-recovery-time">시작 시간</label><input id="event-recovery-time" type="time" name="time" value="${escapeHtml(choice.time||'12:00')}" required><p>${escapeHtml(event.name)} · ${p.duration}분${p.deadline?` · 기한 ${escapeHtml(p.deadline.replace('T',' '))}`:''}</p><p class="routine-error" role="alert">${escapeHtml(error)}</p><div class="sheet-actions"><button class="secondary" type="button" data-action="event-proposal-back">뒤로</button><button class="primary" type="submit">변경안 확인</button></div></form>`);
}
function eventSlotError(p){
 if(!p||!p.date||!p.time)return '날짜와 시간을 확인해 주세요.';
 if(!R.withinDeadline(p.date,p.time,p.duration,p.deadline))return '확인한 기한 안에 끝나는 시간을 골라 주세요.';
 const busy=routineBusy(p.date,{eventIndex:p.index});
 if(busy.unknown)return '시간을 확인할 수 없는 예시 일정이 있어 다른 날짜를 선택해 주세요.';
 if(!R.available(p.date,p.time,p.duration,busy.intervals,previewNow))return '지난 시간이거나 다른 일정과 겹쳐요. 오전 7시부터 오후 10시 사이의 빈 시간을 골라 주세요.';
 return '';
}
function eventRecoverySubmit(form){
 const p=state.eventProposal;if(!p)return;
 const choice={...p,date:form.elements.date.value,time:form.elements.time.value},error=eventSlotError(choice);
 if(error){eventRecoveryEdit(error,choice);return}
 state.eventProposal=choice;eventProposalSheet();
}
function handleEventAction(action,el){
 const index=Number(el.dataset.index),event=state.events[index];
 if(action==='event-toggle'&&event&&event.type!=='appointment'){
  if(event.status==='done'){event.status=event.previousStatus||'pending';delete event.previousStatus}
  else{event.previousStatus=event.status||'pending';event.status='done'}
  state.eventProposal=null;render();return;
 }
 if(action==='event-detail'){eventDetail(index);return}
 if(action==='event-menu'){eventMenu(index);return}
 if(action==='event-ask-ai'&&event){startContextChat({entity:'event',id:event.id});return}
 if(action==='event-attendance-open'){eventAttendanceSheet(index);return}
 if(action==='event-status'){eventStatusSheet(index);return}
 if(action==='event-edit'){eventEditForm(index);return}
 if(action==='event-delete'){eventDeleteSheet(index);return}
 if(action==='event-edit-confirm'){
  const pending=state.pendingEventEdit,current=pending&&state.events[pending.index];
  if(!pending||pending.index!==index||!current||current.id!==pending.id)return;
  if(JSON.stringify(current)!==pending.before){eventEditForm(pending.index,'일정이 바뀌어 다시 확인이 필요해요.',pending.draft);return}
  if(isSharedEvent(current)){state.pendingEventEdit=null;eventSharedHold();return}
  const error=eventEditError(pending.index,pending.draft);if(error){eventEditForm(pending.index,error,pending.draft);return}
  Object.assign(current,pending.draft);state.pendingEventEdit=null;state.eventProposal=null;modal.hidden=true;render();toast('예시 일정을 수정했어요');return;
 }
 if(action==='event-delete-confirm'){
  const pending=state.pendingEventDelete,current=pending&&state.events[pending.index];
  if(!pending||pending.index!==index||!current||current.id!==pending.id)return;
  if(JSON.stringify(current)!==pending.before){eventDeleteSheet(pending.index);return}
  if(isSharedEvent(current)){state.pendingEventDelete=null;eventSharedHold();return}
  if(current.source==='recommendation')state.added=false;
  state.events.splice(pending.index,1);state.pendingEventDelete=null;state.eventProposal=null;modal.hidden=true;render();toast('예시 일정을 삭제했어요');return;
 }
 if(action==='event-attendance'&&event&&event.type==='appointment'){
  if(['attend','absent','unknown'].includes(el.dataset.attendance))event.attendance=el.dataset.attendance;
  render();eventAttendanceSheet(index);return;
 }
 if(action==='event-record'&&event&&event.type!=='appointment'){
  const value=el.dataset.record;if(!['done','missed','clear'].includes(value))return;
  if(value==='done'&&event.status!=='done')event.previousStatus=event.status||'pending';
  if(value!=='done')delete event.previousStatus;
  event.status=value==='clear'?'pending':value;state.eventProposal=null;render();eventStatusSheet(index);return;
 }
 if(action==='event-recover'){eventChooseRecovery(index);return}
 if(action==='event-propose'){eventRecommend(index);return}
 if(action==='event-reject'){state.eventProposal=null;modal.hidden=true;toast('제안을 반영하지 않았어요');return}
 if(action==='event-modify'){eventRecoveryEdit();return}
 if(action==='event-proposal-back'){eventProposalSheet();return}
 if(action==='event-accept'){
  const p=state.eventProposal,current=p&&state.events[p.index];if(!p||!current||current.id!==p.id)return;
  if(current.status!=='missed'||eventDate(current)!==p.originalDate||current.time!==p.originalTime||(current.deadline||'')!==p.originalDeadline){eventProposalSheet('일정이 바뀌어 다시 확인이 필요해요.');return}
  const error=eventSlotError(p);if(error){eventProposalSheet(error);return}
  if(isSharedEvent(current)){state.eventProposal=null;eventSharedHold();return}
  current.recoveryHistory=[...(current.recoveryHistory||[]),{date:p.originalDate,time:p.originalTime,deadline:p.originalDeadline||'',status:'missed'}];
  current.date=p.date;current.time=routineTimeRange(p.time,p.duration);current.status='pending';current.source='recovery';
  if(p.deadline)current.deadline=p.deadline;
  state.selectedDate=R.parseDate(p.date);state.eventProposal=null;if(state.aiContext?.entity==='event'&&state.aiContext.id===current.id)state.aiRecoveryPrompt=false;modal.hidden=true;render();toast('승인한 예시 일정을 반영했어요');
 }
}
