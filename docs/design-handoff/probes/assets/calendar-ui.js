/* Monthly-to-daily navigation for the design preview. */
function month(){
 const selected=state.selectedDate,year=selected.getFullYear(),monthIndex=selected.getMonth(),first=new Date(year,monthIndex,1).getDay();
 const cells=Math.ceil((first+new Date(year,monthIndex+1,0).getDate())/7)*7;
 let days='';
 for(let i=0;i<cells;i++){
  const date=new Date(year,monthIndex,1-first+i),key=R.dateKey(date),other=date.getMonth()!==monthIndex,chosen=sameDate(date,selected);
  const events=calendarEventsFor(key).slice(0,3);
  const dots=events.map(event=>`<i style="background:${escapeHtml(event.color||'#7894ff')}"></i>`).join('');
  days+=`<button class="month-day ${other?'other':''} ${chosen?'chosen':''} ${date.getDay()===0?'sun':date.getDay()===6?'sat':''}" data-date="${key}" aria-label="${R.dateLabel(key)} 일간 일정 보기" aria-pressed="${chosen}"><span class="day-content">${date.getDate()}<small class="dots">${dots}</small></span></button>`;
 }
 const upcoming=state.events.filter(event=>event.upcoming&&event.date>=R.dateKey(selected)).slice(0,3);
 const upcomingHtml=upcoming.map(event=>{const date=R.parseDate(event.date);return `<div class="upcoming-item"><div class="upcoming-date">${date.getDate()}<small>${date.getMonth()+1}월 ${R.weekdays[date.getDay()]}</small></div><div class="stripe" style="background:${event.color}"></div><div class="upcoming-text"><strong>${escapeHtml(event.name)}</strong><span>${escapeHtml(event.time)}</span></div></div>`}).join('')||'<div class="routine-empty">다가오는 예시 일정이 없어요.</div>';
 return `${heading('월간 캘린더 🗓️')}<div class="month-title"><span></span><div class="weather"><span class="sun">🌤</span><span>18°<small>서울 · 맑음</small></span></div></div><div class="month-card"><div class="month-top"><button class="month-arrow" data-action="prev-month" aria-label="이전 달">${svg('left')}</button><strong>${year}년 ${monthIndex+1}월</strong><button class="month-arrow" data-action="next-month" aria-label="다음 달">${svg('right')}</button></div><div class="weekday"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div><div class="month-grid">${days}</div></div><div class="upcoming"><div class="section-row"><h2>다가오는 주요 일정</h2><button class="month-arrow" data-action="day-view" aria-label="선택한 날짜의 일간 일정 보기">${svg('right')}</button></div>${upcomingHtml}</div>`;
}
function dayEventsFor(key){
 const midnight=R.parseDate(key),previous=R.addDays(key,-1),items=calendarEventsFor(key);
 if(midnight&&previous){
  for(const item of calendarEventsFor(previous)){
   const span=timelineInterval(item);
   if(span.start&&span.end&&span.start<midnight&&span.end>midnight)items.push(item);
  }
 }
 return items.sort((a,b)=>(scheduleStart(a)?.getTime()??Infinity)-(scheduleStart(b)?.getTime()??Infinity));
}
function day(){
 const date=state.selectedDate,key=R.dateKey(date),start=new Date(date);
 start.setDate(date.getDate()-date.getDay()+6);if(start>date)start.setDate(start.getDate()-7);
 let strip='';
 for(let i=0;i<7;i++){
  const item=new Date(start);item.setDate(start.getDate()+i);
  strip+=`<div class="week-col">${R.weekdays[item.getDay()]}<button class="week-day ${sameDate(item,date)?'selected':''}" data-day="${R.dateKey(item)}" aria-label="${R.dateLabel(R.dateKey(item))}" aria-pressed="${sameDate(item,date)}">${item.getDate()}</button></div>`;
 }
 const events=dayEventsFor(key);
 const rows=scheduleList(events,'day',key);
 return `<div class="day-head"><div class="row"><button class="month-arrow" data-action="prev-day" aria-label="이전 날짜">${svg('left')}</button><strong>${date.getFullYear()}년 ${date.getMonth()+1}월 ${date.getDate()}일</strong><button class="month-arrow" data-action="next-day" aria-label="다음 날짜">${svg('right')}</button></div><button class="segmented" data-action="month-view">월간 보기</button></div><div class="week-strip" aria-label="일자 선택">${strip}</div><div class="timeline">${rows}</div>`;
}
