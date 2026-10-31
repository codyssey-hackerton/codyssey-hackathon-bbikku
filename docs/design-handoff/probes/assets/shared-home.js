const icons={home:'<path d="M3 10.4 12 3l9 7.4v9.1a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5z"/><path d="M10 21v-6h4v6"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/>',spark:'<path d="M12 2c.7 5 2.2 7.4 7 9-4.8 1.6-6.3 4-7 9-.7-5-2.2-7.4-7-9 4.8-1.6 6.3-4 7-9zM19 2v4M17 4h4M4 16v4M2 18h4"/>',plus:'<path d="M12 3v18M3 12h18"/>',more:'<circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/>',routine:'<path d="M20 7a8.5 8.5 0 0 0-14-2L3 8m0 0V3m0 5h5M4 17a8.5 8.5 0 0 0 14 2l3-3m0 0v5m0-5h-5"/><path d="m8.5 12.5 2.4 2.4 4.6-5"/>',search:'<circle cx="10.7" cy="10.7" r="6.9"/><path d="m16 16 4.2 4.2"/>',left:'<path d="m15 5-7 7 7 7"/>',right:'<path d="m9 5 7 7-7 7"/>',down:'<path d="m6 9 6 6 6-6"/>',check:'<path d="m4 12 5 5L20 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',send:'<path d="m21 3-7.5 18-3.3-7.2L3 10.5 21 3zM10.2 13.8 21 3"/>',buddy:'<path d="M6 8.8c-.5-2 .2-3.2 1.2-3.3.8-.1 1.6.6 2.2 1.2a10 10 0 0 1 5.2 0c.6-.6 1.4-1.3 2.2-1.2 1 .1 1.7 1.3 1.2 3.3a7.7 7.7 0 0 1 1.6 4.9c0 4.3-3 6.9-7.6 6.9s-7.6-2.6-7.6-6.9A7.7 7.7 0 0 1 6 8.8Z" fill="#fff" stroke="none"/><circle cx="9.3" cy="13" r=".9" fill="#6379e6" stroke="none"/><circle cx="14.7" cy="13" r=".9" fill="#6379e6" stroke="none"/><path d="M10.2 16.2c1.1.8 2.5.8 3.6 0" stroke="#8798ec" stroke-width="1.2"/><path d="M20 4.2v3M18.5 5.7h3" stroke="#fff" stroke-width="1.1"/>',bot:'<rect x="4" y="6" width="16" height="13" rx="5"/><path d="M12 3v3M2 10v5M22 10v5M8 11h.1M16 11h.1M9 15c2 2 4 2 6 0"/>'};
function svg(name){const source=window.PikkuIcon?.(name);if(source)return source;return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||''}</svg>`}
const previewNow=new Date(2025,3,17,11,1),previewBaseDate=PikkuRoutineModel.dateKey(previewNow);
let previewToday=previewBaseDate;
const state={screen:'home',selectedDate:new Date(2025,3,17),filter:'all',labels:false,showSuggestion:true,added:false,events:[{id:'e1',name:'아침 정리',time:'오전 7:30',duration:30,type:'task',status:'done',color:'#b178f4',kind:'personal',show:true},{id:'e2',name:'앨리스와 브런치',time:'오전 9:30 - 10:30',type:'appointment',involvement:'shared',attendance:'unknown',color:'#7edda9',kind:'personal',show:true},{id:'e3',name:'데일리 미팅 준비',time:'오전 11:00 - 11:30',type:'task',status:'pending',deadline:'2025-04-17T11:30',color:'#7894ff',kind:'work',show:true},{id:'e4',name:'프로젝트 기획 점검',time:'오후 1:00 - 2:00',type:'task',status:'pending',color:'#ff805a',kind:'work',show:true},{id:'e5',name:'저녁 운동',time:'오후 7:00 - 8:00',type:'task',status:'pending',color:'#ad67f2',kind:'personal',show:true},{id:'e6',name:'책 읽기',time:'오후 8:30 - 9:00',type:'task',status:'pending',color:'#76a9ff',kind:'personal',show:true},{id:'e7',name:'프로젝트 발표',date:'2025-04-22',time:'오전 10:00 - 11:00',type:'appointment',involvement:'shared',attendance:'unknown',color:'#7894ff',kind:'work',show:true,upcoming:true},{id:'e8',name:'최종 결과물 제출',date:'2025-04-30',time:'오후 1:00 - 1:30',type:'task',status:'pending',color:'#7edda9',kind:'work',show:true,upcoming:true},{id:'e9',name:'팀 워크숍',date:'2025-05-02',time:'오후 2:00 - 4:00',type:'appointment',involvement:'shared',attendance:'unknown',color:'#b56df5',kind:'work',show:true,upcoming:true}],routines:[],chatMessages:[]};
function eventDate(event){return event.date||previewBaseDate}
function eventRange(event){const date=PikkuRoutineModel.parseDate(eventDate(event)),range=PikkuRoutineModel.parseEventTime(event.time);if(!date||!range)return null;const start=new Date(date);start.setHours(0,0,0,0);start.setMinutes(range.start);return {start,end:new Date(start.getTime()+(range.end-range.start)*60000)}}
function eventInProgress(event){if(event.type!=='appointment'&&(event.status==='done'||event.status==='missed'))return false;const range=eventRange(event);return !!range&&previewNow>=range.start&&previewNow<range.end}
function eventStatus(event){const range=eventRange(event);if(event.type==='appointment'){if(event.attendance==='attend')return range&&previewNow<range.start?'참석 예정':'참석';if(event.attendance==='absent')return range&&previewNow<range.start?'불참 예정':'불참'}else{if(event.status==='done')return '완료';if(event.status==='missed')return '미완료'}if(!range)return '확인 필요';if(eventInProgress(event))return '진행 중';return previewNow>=range.end?'확인 필요':'예정'}
function todayEvents(){
 const events=state.events.map((event,index)=>({...event,index,entryType:'event'})).filter(event=>event.show!==false&&eventDate(event)===previewToday);
 const routines=PikkuRoutineModel.occurrences(state.routines,previewToday).filter(row=>PikkuRoutineModel.status(row,previewNow)!=='다시 계획됨').map(row=>({entryType:'routine',type:'routine',kind:row.routine.category||'personal',row,time:PikkuRoutineModel.timeLabel(PikkuRoutineModel.occurrenceTime(row))}));
 return [...events,...routines].filter(item=>state.filter==='all'||state.filter===item.kind).sort((a,b)=>(PikkuRoutineModel.parseEventTime(a.time)?.start??1440)-(PikkuRoutineModel.parseEventTime(b.time)?.start??1440));
}
function itemDone(item){return item.entryType==='routine'?PikkuRoutineModel.status(item.row,previewNow)==='완료':item.type!=='appointment'&&item.status==='done'}
function itemInProgress(item){return item.entryType==='routine'?PikkuRoutineModel.status(item.row,previewNow)==='진행 중':eventInProgress(item)}
function eventStatusMarkup(event){
 const status=eventStatus(event),type=event.type==='appointment'?'고정 약속':'할 일';
 const showStatus=event.type==='appointment'?((event.attendance||'unknown')==='unknown'||eventInProgress(event)):status!=='완료';
 const label=type+(showStatus?` · ${eventInProgress(event)&&event.type==='appointment'?'진행 중':status}`:'');
 return `<span class="event-status ${status==='미완료'?'missed':status==='진행 중'?'ongoing':''}">${label}</span>${event.source==='recovery'?'<span class="event-source">다시 계획한 일정</span>':event.source==='recommendation'?'<span class="event-source">승인한 추천 일정</span>':''}`;
}
function cardActions({mode,name,attrs,done=false,disabled=false,disabledLabel='예정 없음',attendance='unknown',attendanceLabel='',compact=false,showCheck=true}){
 const appointment=mode==='appointment',action=appointment?'event-attendance-open':mode==='routine'?'routine-check':'toggle-event',menu=mode==='routine'?'routine-menu':'event-menu';
 const label=disabled?disabledLabel:appointment?(attendance==='attend'?(attendanceLabel||'참석'):attendance==='absent'?(attendanceLabel||'불참'):'참석 확인'):(done?'완료됨':'완료');
 const selected=appointment?attendance==='attend':done;
 const statusAttr=appointment?'aria-haspopup="dialog"':`aria-pressed="${done}"`;
 return `<div class="card-actions"><button class="card-state ${selected?'is-done':''} ${appointment&&attendance==='absent'?'is-absent':''} ${compact&&!appointment?'is-compact':''}" data-action="${action}" ${attrs} ${statusAttr} ${disabled?'disabled':''} aria-label="${escapeHtml(name)} ${label}"><span class="card-state-visual">${selected&&showCheck?svg('check'):''}<span>${label}</span></span></button><button class="card-more" data-action="${menu}" ${attrs} aria-haspopup="dialog" aria-label="${escapeHtml(name)} 더보기">${svg('more')}</button></div>`;
}
function timelineMeta(item,active,overlap){
 const routine=!!item.row, status=routine?PikkuRoutineModel.status(item.row,previewNow):eventStatus(item);
 const type=routine?'루틴':item.type==='appointment'?'고정 약속':'할 일';
 let label=type;
 if(active)label+=' · 진행 중';
 else if(status!=='완료'&&status!=='참석'&&status!=='불참'&&status!=='참석 예정'&&status!=='불참 예정')label+=' · '+(status==='진행 중'?'확인 필요':status);
 if(active&&status==='미완료')label+=' · 미완료';
 const badge=routine&&item.row.kind==='recovery'?(item.row.routine.recoveries[item.row.origin]?.move?'이동 확정':'복구 확정'):item.source==='recovery'?'다시 계획한 일정':item.source==='recommendation'?'승인한 추천 일정':'';
 return '<span class="event-status">'+escapeHtml(label)+'</span>'+(badge?'<span class="event-source">'+badge+'</span>':'')+(overlap?'<span class="timeline-overlap">시간 겹침</span>':'');
}
function eventCard(event,index,variant='home',layout=null){
 const attrs='data-index="'+index+'"',mode=event.type==='appointment'?'appointment':'task',timeline=variant==='timeline',css=timeline?'timeline-card':'task';
 const active=timeline&&scheduledNow(event),recorded=timeline&&event.type!=='appointment'&&event.status==='done';
 const extra=(active?' is-current':'')+(recorded?' is-recorded':'');
 const when=timeline?'':'<span class="task-time">'+escapeHtml(event.time)+'</span>';
 const meta=timeline?timelineMeta(event,active,!!layout?.overlap):eventStatusMarkup(event);
 return '<div class="'+css+' schedule-card'+extra+'" data-action="event-detail" '+attrs+'><div class="stripe" style="background:'+escapeHtml(event.color||'#7894ff')+'"></div><button class="task-body event-body" data-action="event-detail" '+attrs+'><span class="task-title">'+escapeHtml(event.name)+'</span>'+when+'<span class="event-meta">'+meta+'</span></button>'+cardActions({mode,name:event.name,attrs,done:event.status==='done',attendance:event.attendance||'unknown',attendanceLabel:eventStatus(event),compact:timeline})+'</div>';
}
function routineScheduleCard(row,variant='home',unscheduled=false,layout=null){
 const M=PikkuRoutineModel,r=row.routine,status=unscheduled?'예정 없음':M.status(row,previewNow),done=status==='완료',disabled=unscheduled||status==='다시 계획됨';
 const attrs='data-id="'+escapeHtml(r.id)+'" data-origin="'+escapeHtml(row.origin)+'" data-kind="'+escapeHtml(row.kind)+'"';
 const when=unscheduled?r.start:M.occurrenceTime(row),duration=unscheduled?r.duration:M.occurrenceDuration(row);
 const info=variant==='routine'?M.repeatLabel(r.days)+' · '+M.timeLabel(when)+' · '+duration+'분':M.timeLabel(when)+' · '+duration+'분';
 const label='루틴'+(done?'':' · '+status),badge=row.kind==='recovery'?(r.recoveries[row.origin]?.move?'<span class="event-source">이동 확정</span>':'<span class="event-source">복구 확정</span>'):'';
 const timeline=variant==='timeline',css=timeline?'timeline-card':variant==='routine'?'task routine-tile':'task';
 const item={row},active=timeline&&scheduledNow(item),extra=(active?' is-current':'')+(timeline&&done?' is-recorded':'');
 const timeMarkup=timeline?'':'<span class="task-time">'+escapeHtml(info)+'</span>';
 const meta=timeline?timelineMeta(item,active,!!layout?.overlap):'<span class="event-status '+(status==='미완료'?'missed':status==='진행 중'?'ongoing':'')+'">'+label+'</span>'+badge;
 return '<div class="'+css+' schedule-card'+extra+'" data-action="routine-detail" '+attrs+'><div class="stripe" style="background:'+(r.color==='mint'?'#7edda9':'#ad67f2')+'"></div><button class="task-body event-body" data-action="routine-detail" '+attrs+'><span class="task-title">'+escapeHtml(r.name)+'</span>'+timeMarkup+'<span class="event-meta">'+meta+'</span></button>'+cardActions({mode:'routine',name:r.name,attrs,done,disabled,disabledLabel:unscheduled?'예정 없음':'이동됨',compact:timeline||variant==='routine',showCheck:variant!=='routine'})+'</div>';
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function sameDate(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate()}
function tick(index,done,type='event',name=''){return `<button class="tick ${done?'checked':''}" data-action="toggle-${type}" data-index="${index}" aria-label="${name?escapeHtml(name)+' ':''}${done?'완료 취소':'완료 표시'}" aria-pressed="${done}">${done?svg('check'):''}</button>`}
function navigation(){let active=state.screen==='day'?'calendar':state.screen;let items=[['home','홈','home'],['calendar','캘린더','calendar'],['chat','AI 비서','buddy'],['add','추가','plus'],['routine','루틴','routine']];nav.innerHTML=items.map(([id,label,icon])=>`<button class="nav-btn ${id===active?'active':''} ${id==='chat'?'center':''}" data-nav="${id}" ${id===active?'aria-current="page"':''}>${id==='chat'?`<span class="center-icon">${svg(icon)}</span>`:svg(icon)}<span>${label}</span></button>`).join('')}
function previewDateLabel(){return previewNow.getFullYear()+'년 '+(previewNow.getMonth()+1)+'월 '+previewNow.getDate()+'일 '+PikkuRoutineModel.weekdays[previewNow.getDay()]+'요일'}
function heading(name){return `<div class="heading"><div><div class="date">${previewDateLabel()}</div><h1>${name}</h1></div><div class="top-actions"><button class="circle" data-action="search" aria-label="검색">${svg('search')}</button><button class="avatar" data-action="profile" aria-label="프로필"></button></div></div>`}
function tasks(){return scheduleList(todayEvents(),'home',previewToday)}
function home(){const list=todayEvents(),total=list.length,done=list.filter(itemDone).length,ongoing=list.filter(itemInProgress).length,closedAppointments=list.filter(e=>e.entryType==='event'&&e.type==='appointment'&&['attend','absent'].includes(e.attendance)&&eventRange(e)&&previewNow>=eventRange(e).end).length,remaining=total-done-ongoing-closedAppointments,trackable=list.filter(e=>e.type!=='appointment').length,rate=trackable?Math.round(done/trackable*100):0,doneArc=total?Math.round(done/total*100):0,progressArc=total?Math.round((done+ongoing)/total*100):0,busy=typeof routineBusy==='function'?routineBusy(previewToday,null):null,suggestionAvailable=!busy||(!busy.unknown&&PikkuRoutineModel.available(previewToday,'11:30',30,busy.intervals,previewNow)),staleSuggestion=!state.added&&!suggestionAvailable;return `${heading('좋은 아침, 지은님 👋')}<div class="filters"><button class="filter ${state.filter==='all'?'active':''}" data-filter="all">전체</button><button class="filter ${state.filter==='personal'?'active':''}" data-filter="personal">개인</button><button class="filter ${state.filter==='work'?'active':''}" data-filter="work">업무</button></div><div class="section-heading"><h2>오늘의 일정 ${total}개</h2><div class="weather"><span class="sun">🌤</span><span>18°<small>서울 · 맑음</small></span></div></div><div class="card summary"><div class="ring" style="background:conic-gradient(from -4deg,#84dbab 0 ${doneArc}%,#7892fa ${doneArc}% ${progressArc}%,#e4e6e9 ${progressArc}% 100%)"></div><div class="metrics"><div class="metric"><i class="dot" style="background:#80dbac"></i>완료<strong>${done}개</strong></div><div class="metric"><i class="dot" style="background:#7791ff"></i>진행 중<strong>${ongoing}개</strong></div><div class="metric"><i class="dot" style="background:#e1e4e8"></i>남은 일정<strong>${remaining}개</strong></div></div></div><p class="completion-note">${trackable?`할 일·루틴 ${trackable}개 중 ${done}개 완료 · ${rate}%`:'완료를 기록할 할 일이 없어요.'}${closedAppointments?` · 지난 약속 ${closedAppointments}개`:''}</p>${state.showSuggestion?`<div class="suggest"><div class="suggest-top"><div class="clockicon">${svg('clock')}</div><div><b>지금은 ${PikkuRoutineModel.timeLabel(PikkuRoutineModel.timeKey(previewNow.getHours()*60+previewNow.getMinutes()))}이에요</b><p>${state.added?'추천한 산책이 일정에 반영됐어요.':staleSuggestion?'시간이 바뀌어 추천을 다시 확인해요.':'11:30 ~ 13:00 사이에 여유가 있어요.'}</p></div><button class="dismiss" data-action="dismiss" aria-label="추천 닫기">${svg('close')}</button></div><div class="suggest-body"><div class="stars">${svg('spark')}</div><div class="suggest-text"><small>삐꾸의 추천 · ${state.added?'반영됨':'아직 미반영'}</small><strong>${staleSuggestion?'제안한 시간을 다시 확인해 주세요':'11:30에 30분 산책 어때요?'}</strong><p>${staleSuggestion?'다른 일정과 겹치거나 시간을 확인할 수 없어요.':'오후 일정 전 가볍게 움직이면<br>기분 전환이 될 수 있어요.'}</p></div><button class="pill-button" data-action="proposal" ${state.added||staleSuggestion?'disabled':''}>${state.added?'추가됨':staleSuggestion?'확인 필요':'일정에 추가'}</button></div><button class="link" data-action="other-suggestion">다른 추천 보기 ›</button></div>`:''}<div class="task-list">${tasks()}</div>`}

/* A past stack groups by a known end, independently of completion or attendance. */
state.pastStacks={home:false,days:{}};
state.stackHeads={};
function scheduleEnd(item){
 const M=PikkuRoutineModel;
 if(item.row){
  const row=item.row,date=M.parseDate(M.occurrenceDate(row)),start=M.minutes(M.occurrenceTime(row)),duration=M.occurrenceDuration(row);
  if(!date||start===null||!Number.isFinite(duration)||duration<=0)return null;
  date.setHours(0,0,0,0);return new Date(date.getTime()+(start+duration)*60000);
 }
 const date=M.parseDate(eventDate(item)),range=M.parseEventTime(item.time);
 const hasEnd=/[-–~]\s*(?:(?:오전|오후)\s*)?\d{1,2}:\d{2}/.test(item.time||'');
 if(date&&range&&(hasEnd||(Number.isFinite(item.duration)&&item.duration>0))){
  date.setHours(0,0,0,0);
  const end=hasEnd?range.end:range.start+item.duration;
  return new Date(date.getTime()+end*60000);
 }
 const deadline=item.deadline?M.parseDateTime(item.deadline):null;
 if(deadline&&date&&range){
  date.setHours(0,0,0,0);
  if(deadline.getTime()<date.getTime()+range.start*60000)return null;
 }
 return deadline;
}
function stackOpen(scope,date){
 if(scope==='home')return state.pastStacks.home;
 return !!state.pastStacks.days[date];
}
function scheduleStart(item){
 const M=PikkuRoutineModel,row=item.row;
 const date=M.parseDate(row?M.occurrenceDate(row):eventDate(item));
 const minutes=row?M.minutes(M.occurrenceTime(row)):M.parseEventTime(item.time)?.start;
 if(!date||minutes===null||minutes===undefined)return null;
 date.setHours(0,0,0,0);return new Date(date.getTime()+minutes*60000);
}
function scheduledNow(item){
 const span=!!item.row||/[-–~]\s*(?:(?:오전|오후)\s*)?\d{1,2}:\d{2}/.test(item.time||'')||(Number.isFinite(item.duration)&&item.duration>0);
 const start=scheduleStart(item),end=span?scheduleEnd(item):null;
 return !!(start&&end&&start<=previewNow&&previewNow<end);
}
function scheduleKey(item){
 return item.row?'routine:'+item.row.routine.id+':'+item.row.origin+':'+item.row.kind:'event:'+item.id;
}
function timelineInterval(item){
 const start=scheduleStart(item);if(!start)return {start:null,end:null};
 const M=PikkuRoutineModel,row=item.row;
 let duration=null;
 if(row)duration=M.occurrenceDuration(row);
 else{
  const range=M.parseEventTime(item.time),hasEnd=/[-–~]\s*(?:(?:오전|오후)\s*)?\d{1,2}:\d{2}/.test(item.time||'');
  if(range&&hasEnd)duration=range.end-range.start;
  else if(Number.isFinite(item.duration)&&item.duration>0)duration=item.duration;
 }
 return {start,end:Number.isFinite(duration)&&duration>0?new Date(start.getTime()+duration*60000):null};
}
function timelineLayout(items){
 const map=new Map(),entries=items.map(item=>({item,...timelineInterval(item)})).sort((a,b)=>(a.start?.getTime()??Infinity)-(b.start?.getTime()??Infinity));
 let latestEnd=null;
 for(const entry of entries){
  const overlap=!!(entry.start&&entry.end&&entries.some(other=>other!==entry&&other.start&&other.end&&entry.start<other.end&&other.start<entry.end));
  const free=entry.start&&latestEnd?Math.max(0,(entry.start-latestEnd)/60000):0;
  const gap=free?Math.min(32,Math.round(8+Math.log2(1+free/15)*5)):8;
  const minutes=entry.end?(entry.end-entry.start)/60000:30;
  const height=Math.min(112,Math.max(72,Math.round(72+Math.max(0,minutes-30)/30*4)));
  map.set(entry.item,{gap,height,overlap});
  if(entry.end&&(!latestEnd||entry.end>latestEnd))latestEnd=entry.end;
 }
 return map;
}
function timelineTimeLabel(date,key){
 if(!date)return '시간 미정';
 const M=PikkuRoutineModel,day=M.dateKey(date),time=String(date.getHours()).padStart(2,'0')+':'+String(date.getMinutes()).padStart(2,'0');
 if(day===key)return time;
 if(day===M.addDays(key,-1))return '전날 '+time;
 if(day===M.addDays(key,1))return '다음 날 '+time;
 return (date.getMonth()+1)+'월 '+date.getDate()+'일 '+time;
}
function timelineRow(item,content,layout,extraClass=''){
 const interval=timelineInterval(item),key=PikkuRoutineModel.dateKey(state.selectedDate),entry=layout?.get(item)||{gap:8,height:72};
 const start=timelineTimeLabel(interval.start,key),end=interval.end?timelineTimeLabel(interval.end,key):'종료 미정';
 return '<div class="timeline-row '+(entry.overlap?'has-overlap ':'')+extraClass+'" style="--day-gap:'+entry.gap+'px;--day-height:'+entry.height+'px"><div class="timeline-time"><span class="timeline-start" data-time-start>'+escapeHtml(start)+'</span><span class="timeline-end" data-time-end>'+escapeHtml(end)+'</span></div>'+content+'</div>';
}
function itemCard(item,scope,layout){
 const options=layout?.get(item);
 return item.row?routineScheduleCard(item.row,scope==='day'?'timeline':'home',false,options):eventCard(item,item.index,scope==='day'?'timeline':'home',options);
}
function scheduleCardFor(item,scope,layout){
 const card=itemCard(item,scope,layout);
 return scope==='day'?timelineRow(item,card,layout):card;
}
function layeredSchedule(front,past,scope,date,changed,layout){
 const open=stackOpen(scope,date),panel='stack-'+scope+'-'+date;
 const layers=past.slice(0,3).reverse().map((item,index,shown)=>{
  const slot=3-shown.length+index;
  return '<div class="stack-layer" data-layer="'+slot+'" data-stack-layer="'+escapeHtml(scheduleKey(item))+'">'+itemCard(item,scope,layout)+'</div>';
 }).join('');
 const history=past.map(item=>'<div class="stack-history-item" data-history-item="'+escapeHtml(scheduleKey(item))+'">'+scheduleCardFor(item,scope,layout)+'</div>').join('');
 const peek='<button class="stack-peek" data-stack-peek data-action="stack-toggle" data-scope="'+scope+'" data-date="'+date+'" aria-label="이전 일정 카드 펼치기" aria-expanded="'+open+'" aria-controls="'+panel+'" '+(open?'inert aria-hidden="true" tabindex="-1"':'')+'></button>';
 const frontCard='<div class="stack-front" data-stack-front="'+escapeHtml(scheduleKey(front))+'">'+itemCard(front,scope,layout)+'</div>';
 const stage='<div class="stack-stage"><div class="stack-back" aria-hidden="true" inert>'+layers+'</div>'+peek+frontCard+'</div>';
 const current=scope==='day'?timelineRow(front,stage,layout,'stack-current'):stage;
 return '<section class="schedule-stack '+(open?'is-open':'')+(changed?' is-changing':'')+'" data-scope="'+scope+'"><div class="stack-history" id="'+panel+'" data-stack-history aria-hidden="'+(!open)+'" '+(open?'':'inert')+'><div class="stack-history-inner">'+history+'<button class="stack-close" data-action="stack-toggle" data-scope="'+scope+'" data-date="'+date+'">접기 ↑</button></div></div>'+current+'</section>';
}
function scheduleList(items,scope,date){
 if(!items.length)return '<div class="card empty">'+(scope==='home'?'해당하는 일정이 없어요.':'이 날짜에는 예시 일정이 없어요.')+'</div>';
 const layout=scope==='day'?timelineLayout(items):null;
 if(date!==previewToday)return items.map(item=>scheduleCardFor(item,scope,layout)).join('');
 const past=[],remaining=[];
 for(const item of items){
  const end=scheduleEnd(item);
  if(end&&end<=previewNow)past.push(item);else remaining.push(item);
 }
 past.sort((a,b)=>scheduleEnd(b)-scheduleEnd(a));
 let front=remaining.find(scheduledNow)||remaining.find(item=>{const start=scheduleStart(item);return !!start&&start>=previewNow})||remaining[0];
 if(front)remaining.splice(remaining.indexOf(front),1);else front=past.shift();
 if(!front)return '';
 const headKey=scope+':'+date,key=scheduleKey(front),changed=!!state.stackHeads[headKey]&&state.stackHeads[headKey]!==key;
 state.stackHeads[headKey]=key;
 const first=past.length?layeredSchedule(front,past,scope,date,changed,layout):scheduleCardFor(front,scope,layout);
 const earlier=scope==='day'?remaining.filter(item=>scheduleStart(item)&&scheduleStart(front)&&scheduleStart(item)<scheduleStart(front)):[];
 for(const item of earlier)remaining.splice(remaining.indexOf(item),1);
 return earlier.map(item=>scheduleCardFor(item,scope,layout)).join('')+first+remaining.map(item=>scheduleCardFor(item,scope,layout)).join('');
}
function toggleScheduleStack(el){
 const scope=el.dataset.scope,date=el.dataset.date,open=!stackOpen(scope,date);
 if(scope==='home')state.pastStacks.home=open;else state.pastStacks.days[date]=open;
 const section=typeof el.closest==='function'?el.closest('.schedule-stack'):null;
 if(!section){if(typeof render==='function')render();return}
 section.classList.toggle('is-open',open);
 const history=section.querySelector('[data-stack-history]'),peek=section.querySelector('[data-stack-peek]'),close=section.querySelector('.stack-close');
 if(history){history.inert=!open;history.setAttribute('aria-hidden',String(!open))}
 if(peek){peek.inert=open;peek.setAttribute('aria-hidden',String(open));peek.setAttribute('aria-expanded',String(open));peek.tabIndex=open?-1:0}
 if(open&&close)close.focus({preventScroll:true});else if(!open&&peek)peek.focus({preventScroll:true});
}
