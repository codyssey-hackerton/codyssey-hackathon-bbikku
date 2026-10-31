/* Date and occurrence rules used by the PIKKU design preview. */
const PikkuRoutineModel = (() => {
  const weekdays = ['일','월','화','수','목','금','토'];
  const pad = n => String(n).padStart(2, '0');
  function dateKey(date) { return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`; }
  function parseDate(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const [year,month,day] = key.split('-').map(Number), d = new Date(year,month-1,day);
    return dateKey(d) === key ? d : null;
  }
  function addDays(key, n) { const d = parseDate(key); if(!d) return null; d.setDate(d.getDate()+n); return dateKey(d); }
  function minutes(time) {
    const m = /^(\d{2}):(\d{2})$/.exec(time || '');
    if(!m || Number(m[1])>23 || Number(m[2])>59) return null;
    return Number(m[1])*60+Number(m[2]);
  }
  function timeKey(minute) { return `${pad(Math.floor(minute/60))}:${pad(minute%60)}`; }
  function timeLabel(time) {
    const m=minutes(time); if(m===null) return time;
    return `${m<720?'오전':'오후'} ${Math.floor(m/60)%12||12}:${pad(m%60)}`;
  }
  function dateLabel(key) { const d=parseDate(key); return d ? `${d.getMonth()+1}월 ${d.getDate()}일 ${weekdays[d.getDay()]}요일` : key; }
  function repeatLabel(days) {
    if(days.length===7) return '매일';
    const order=[1,2,3,4,5,6,0];
    return order.filter(d=>days.includes(d)).map(d=>weekdays[d]).join(' · ');
  }
  function occursOn(routine,key) { const date=parseDate(key); return !!date && (!routine.startDate || key>=routine.startDate) && routine.days.includes(date.getDay()); }
  function occurrences(routines,key) {
    const rows=[];
    for(const routine of routines) {
      const recoveries=routine.recoveries || {};
      const regular=occursOn(routine,key);
      if(regular) rows.push({routine,origin:key,kind:recoveries[key]?.date===key?'recovery':'regular'});
      for(const [origin,rec] of Object.entries(recoveries)) {
        if(rec.date===key && (origin!==key || !regular)) rows.push({routine,origin,kind:'recovery'});
      }
    }
    return rows.sort((a,b)=>minutes(a.kind==='recovery'?a.routine.recoveries[a.origin].time:a.routine.start)-minutes(b.kind==='recovery'?b.routine.recoveries[b.origin].time:b.routine.start));
  }
  function occurrenceDate(row) { return row.kind==='recovery' ? row.routine.recoveries[row.origin].date : row.origin; }
  function occurrenceTime(row) { return row.kind==='recovery' ? row.routine.recoveries[row.origin].time : row.routine.start; }
  function occurrenceDuration(row) { return row.kind==='recovery' ? (row.routine.recoveries[row.origin].duration ?? row.routine.duration) : row.routine.duration; }
  function status(row,now) {
    const recovery=row.routine.recoveries?.[row.origin];
    if(row.kind==='regular' && recovery && recovery.date!==row.origin) return '다시 계획됨';
    const recorded=row.kind==='recovery' ? recovery?.record : row.routine.records?.[row.origin];
    if(recorded==='done') return '완료';
    if(recorded==='missed') return '미완료';
    const day=occurrenceDate(row), start=minutes(occurrenceTime(row)), scheduled=parseDate(day);
    scheduled.setHours(Math.floor(start/60),start%60,0,0);
    const delta=(now.getTime()-scheduled.getTime())/60000;
    if(delta<0) return row.kind==='recovery'?'다시 예정':'예정';
    if(delta<occurrenceDuration(row)) return '진행 중';
    return '확인 필요';
  }
  function parseDateTime(value) {
    if(!value)return null;
    const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
    if(!match)return null;
    const day=parseDate(match[1]),time=minutes(match[2]);if(!day||time===null)return null;
    day.setHours(Math.floor(time/60),time%60,0,0);return day;
  }
  function withinDeadline(key,time,duration,deadline) {
    if(!deadline)return true;
    const cutoff=parseDateTime(deadline),day=parseDate(key),start=minutes(time);
    if(!cutoff||!day||start===null)return false;
    day.setHours(Math.floor(start/60),start%60,0,0);
    return day.getTime()+duration*60000<=cutoff.getTime();
  }
  function overlaps(aStart,aEnd,bStart,bEnd) { return aStart<bEnd && bStart<aEnd; }
  function available(key,time,duration,busy,now) {
    const d=parseDate(key), start=minutes(time), length=Number(duration), today=dateKey(now);
    if(!d || start===null || !Number.isInteger(length) || length<5 || length>480) return false;
    if(key<today || start<420 || start+length>1320) return false;
    if(key===today && start<now.getHours()*60+now.getMinutes()) return false;
    return !busy.some(item=>overlaps(start,start+length,item.start,item.end));
  }
  function findSlot(key,duration,busy,now) {
    const today=dateKey(now); if(key<today) return null;
    const earliest=key===today?Math.max(420,Math.ceil((now.getHours()*60+now.getMinutes())/15)*15):420;
    for(let start=earliest;start+duration<=1320;start+=15) {
      const value=timeKey(start); if(available(key,value,duration,busy,now)) return value;
    }
    return null;
  }
  function parseEventTime(text) {
    const match=String(text||'').match(/(오전|오후)\s*(\d{1,2}):(\d{2})(?:\s*[-–~]\s*(?:(오전|오후)\s*)?(\d{1,2}):(\d{2}))?/);
    if(!match) return null;
    const convert=(period,h,m)=>{h=Number(h);m=Number(m);if(h<1||h>12||m>59)return null;return (h%12+(period==='오후'?12:0))*60+m};
    const start=convert(match[1],match[2],match[3]); if(start===null)return null;
    let end=match[5] ? convert(match[4]||match[1],match[5],match[6]) : start+30;
    if(end===null)return null;
    if(end<=start) end+=match[4]?1440:720;
    if(end<=start) end+=1440;
    return end>start && end<=start+1440 ? {start,end} : null;
  }
  return {weekdays,dateKey,parseDate,addDays,minutes,timeKey,timeLabel,dateLabel,repeatLabel,occursOn,occurrences,occurrenceDate,occurrenceTime,occurrenceDuration,status,parseDateTime,withinDeadline,overlaps,available,findSlot,parseEventTime};
})();
if(typeof module!=='undefined' && module.exports) module.exports=PikkuRoutineModel;
