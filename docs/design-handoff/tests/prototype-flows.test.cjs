const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assets = path.resolve(__dirname, '../probes/assets');
function preview(storage = new Map()) {
  const elements = {}, listeners = {};
  const element = () => {
    const nested={};
    return {innerHTML:'', textContent:'', value:'', hidden:false, scrollTop:0, scrollHeight:100,
      dataset:{feedbackPath:'feedback/sketch-'}, classList:{toggle(){},add(){},remove(){}},
      addEventListener(k, fn){this['on'+k]=fn}, setAttribute(){}, focus(){}, querySelector(key){return nested[key] ||= element()}, querySelectorAll(){return []}};
  };
  const document={getElementById(id){return elements[id] ||= element()}, querySelectorAll(){return []},
    querySelector(){return element()}, addEventListener(k,fn){listeners[k]=fn}, activeElement:{tagName:'BODY'}};
  const localStorage={getItem(key){return storage.has(key)?storage.get(key):null},setItem(key,value){storage.set(key,String(value))},removeItem(key){storage.delete(key)}};
  const context=vm.createContext({document, window:{localStorage}, Date, console, setTimeout, clearTimeout, getDb:async()=>null});
  for (const name of ['routine-model.js','pikku-icons.js','shared-home.js','routine-ui.js','event-ui.js','calendar-ui.js','ai-context.js','creation-ui.js','preview-storage.js','draft.js']) {
    const file=path.join(assets,name);
    if(fs.existsSync(file)) vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:name});
  }
  return {context,elements,listeners,storage};
}
test('Thursday routine view excludes an example that repeats only on Monday, Wednesday, and Friday', () => {
  const p=preview();
  vm.runInContext("state.screen='routine';render()",p.context);
  assert.doesNotMatch(p.elements.screen.innerHTML, /아침 운동/);
});
function click(preview, selector, dataset={}) {
  const target={dataset};
  preview.listeners.click({target:{closest(query){return query===selector?target:null}}});
}
function action(preview, name, dataset={}) {click(preview,'[data-action]',{action:name,...dataset})}
function submit(preview, form) {preview.listeners.submit({preventDefault(){},target:form})}
const model=require('../probes/assets/routine-model.js');
const demoNow=new Date(2025,3,17,11,1);

test('daily completion controls use a compact visual while home and appointments keep their existing layout', () => {
 const p=preview();
 const task=vm.runInContext("eventCard(state.events[2],2,'timeline')",p.context);
 const home=vm.runInContext("eventCard(state.events[2],2,'home')",p.context);
 const appointment=vm.runInContext("eventCard(state.events[1],1,'timeline')",p.context);
 assert.match(task,/card-state[^\"]*is-compact/);
 assert.doesNotMatch(home,/card-state[^\"]*is-compact/);
 assert.doesNotMatch(appointment,/card-state[^\"]*is-compact/);
 const css=fs.readFileSync(path.join(assets,'draft.css'),'utf8');
 assert.match(css,/\.card-state\.is-compact\s*\{[^}]*min-width:\s*44px/);
 assert.match(css,/\.card-state\.is-compact\s+\.card-state-visual\s*\{[^}]*min-width:\s*0/);
});

test('routine screen completion uses text and color without a check icon and remains reversible', () => {
 const p=preview();
 click(p,'[data-nav]',{nav:'routine'});
 const data={id:'r4',origin:'2025-04-17',kind:'regular'};
 action(p,'routine-check',data);
 const routine=vm.runInContext("routineScheduleCard({routine:state.routines.find(r=>r.id==='r4'),origin:'2025-04-17',kind:'regular'},'routine')",p.context);
 const home=vm.runInContext("routineScheduleCard({routine:state.routines.find(r=>r.id==='r4'),origin:'2025-04-17',kind:'regular'},'home')",p.context);
 assert.match(routine,/card-state[^\"]*is-compact/);
 assert.match(routine,/card-state-visual"><span>완료됨<\/span>/);
 assert.match(home,/card-state-visual"><span class="pikku-icon" data-pikku-icon="check"/);
 action(p,'routine-check',data);
 assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r4').records['2025-04-17']",p.context),undefined);
});

test('future, unrecorded, and explicitly missed routines have distinct states', () => {
  const r={days:[4],start:'19:00',duration:20,records:{},recoveries:{}};
  const row={routine:r,origin:'2025-04-17',kind:'regular'};
  assert.equal(model.status(row,demoNow),'예정');
  r.start='08:00';
  assert.equal(model.status(row,demoNow),'확인 필요');
  r.records['2025-04-17']='missed';
  assert.equal(model.status(row,demoNow),'미완료');
});

test('recommendations avoid occupied intervals and never suggest elapsed times', () => {
  assert.equal(model.findSlot('2025-04-17',30,[{start:675,end:720},{start:750,end:780}],demoNow),'12:00');
  assert.equal(model.available('2025-04-17','10:00',30,[],demoNow),false);
  assert.equal(model.available('2025-04-17','13:00',30,[{start:780,end:840}],demoNow),false);
  assert.equal(model.findSlot('2025-04-17',30,[{start:660,end:1320}],demoNow),null);
});

test('monthly date selection opens that date in the daily schedule', () => {
  const p=preview();
  click(p,'[data-nav]',{nav:'calendar'});
  assert.match(p.elements.screen.innerHTML,/월간 캘린더/);
  click(p,'[data-date],[data-day]',{date:'2025-04-22'});
  assert.equal(vm.runInContext('state.screen',p.context),'day');
  assert.match(p.elements.screen.innerHTML,/2025년 4월 22일/);
  assert.match(p.elements.screen.innerHTML,/프로젝트 발표/);
  assert.doesNotMatch(p.elements.screen.innerHTML,/>주간 ﹀/);
});

test('changing one completion record leaves recurrence and other dates unchanged', () => {
  const p=preview();click(p,'[data-nav]',{nav:'routine'});
  const before=vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r4').days)",p.context);
  action(p,'routine-check',{id:'r4',origin:'2025-04-17',kind:'regular'});
  assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r4').records['2025-04-17']",p.context),'done');
  assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r4').records['2025-04-18']",p.context),undefined);
  assert.equal(vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r4').days)",p.context),before);
  action(p,'routine-check',{id:'r4',origin:'2025-04-17',kind:'regular'});
  assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r4').records['2025-04-17']",p.context),undefined);
  assert.match(p.elements.screen.innerHTML,/예정/);
});

test('routine registration, edit, and confirmed delete work in the preview', () => {
  const p=preview();click(p,'[data-nav]',{nav:'routine'});
  action(p,'add-routine');assert.match(p.elements.sheet.innerHTML,/새 루틴 만들기/);
  const form=(id,name,days,time,duration,goal)=>({id:'routine-form',dataset:{id},
    elements:{name:{value:name},start:{value:time},duration:{value:String(duration)},goal:{value:goal}},
    querySelectorAll(){return days.map(value=>({value:String(value)}))}});
  submit(p,form('','명상',[1,4],'08:45',15,'마음 가라앉히기'));
  assert.equal(vm.runInContext("state.routines.find(r=>r.name==='명상').start",p.context),'08:45');
  submit(p,form('r5','저녁 명상',[2,4],'20:00',25,'하루 정리'));
  assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r5').name",p.context),'저녁 명상');
  assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r5').duration",p.context),25);
  action(p,'routine-delete',{id:'r5',origin:'2025-04-17',kind:'regular'});
  assert.match(p.elements.sheet.innerHTML,/루틴을 삭제할까요/);
  action(p,'routine-delete-confirm',{id:'r5',origin:'2025-04-17',kind:'regular'});
  assert.equal(vm.runInContext("!!state.routines.find(r=>r.id==='r5')",p.context),false);
});

test('recovery is only added after approval, and rejected or conflicting changes do not mutate the calendar', () => {
  const p=preview();click(p,'[data-nav]',{nav:'routine'});
  const row={id:'r3',origin:'2025-04-17',kind:'regular'};
  action(p,'routine-recover',row);assert.match(p.elements.sheet.innerHTML,/지금도 필요한지/);
  action(p,'routine-propose',row);
  assert.match(p.elements.sheet.innerHTML,/아직 일정에 반영되지 않은/);
  assert.equal(vm.runInContext("Object.keys(state.routines.find(r=>r.id==='r3').recoveries).length",p.context),0);
  action(p,'routine-reject');
  assert.equal(vm.runInContext("Object.keys(state.routines.find(r=>r.id==='r3').recoveries).length",p.context),0);
  action(p,'routine-recover',row);action(p,'routine-propose',row);action(p,'routine-modify');
  const edit=(date,time)=>({id:'routine-recovery-form',elements:{date:{value:date},time:{value:time}}});
  submit(p,edit('2025-04-17','13:15'));
  assert.match(p.elements.sheet.innerHTML,/다른 일정과 겹쳐요/);
  assert.equal(vm.runInContext("Object.keys(state.routines.find(r=>r.id==='r3').recoveries).length",p.context),0);
  submit(p,edit('2025-04-18','12:00'));
  assert.match(p.elements.sheet.innerHTML,/4월 18일 금요일/);
  assert.equal(vm.runInContext("Object.keys(state.routines.find(r=>r.id==='r3').recoveries).length",p.context),0);
  action(p,'routine-accept');
  assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r3').recoveries['2025-04-17'].date",p.context),'2025-04-18');
  assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r3').records['2025-04-17']",p.context),'missed');
  assert.equal(vm.runInContext("calendarEventsFor('2025-04-18').some(e=>e.name.includes('오전 산책 · 다시 계획'))",p.context),true);
  vm.runInContext("state.screen='day';render()",p.context);
  assert.match(p.elements.screen.innerHTML,/오전 산책/);
  assert.match(p.elements.screen.innerHTML,/복구/);
  vm.runInContext("state.routines.find(r=>r.id==='r3').duration=45",p.context);
  assert.equal(vm.runInContext("calendarEventsFor('2025-04-18').find(e=>e.kind==='routine'&&e.row.origin==='2025-04-17'&&e.row.kind==='recovery').time",p.context),'오후 12:00 - 오후 12:20');
  action(p,'routine-delete',{id:'r3',origin:'2025-04-17',kind:'regular'});
  action(p,'routine-delete-confirm',{id:'r3',origin:'2025-04-17',kind:'regular'});
  assert.equal(vm.runInContext("calendarEventsFor('2025-04-18').some(e=>e.name.includes('오전 산책 · 다시 계획'))",p.context),true);
});

test('overnight routines stay in progress and reserve time on the next day', () => {
  const r={id:'night',days:[4],start:'23:30',duration:480,records:{},recoveries:{}};
  const row={routine:r,origin:'2025-04-17',kind:'regular'};
  assert.equal(model.status(row,new Date(2025,3,18,1,0)),'진행 중');
  const p=preview();
  vm.runInContext("state.routines.push({id:'night',name:'야간 작업',days:[4],start:'23:30',duration:480,records:{},recoveries:{}})",p.context);
  assert.equal(vm.runInContext("routineBusy('2025-04-18',null).intervals.some(x=>x.start===0&&x.end===450)",p.context),true);
  assert.equal(model.findSlot('2025-04-18',30,[{start:0,end:450}],demoNow),'07:30');
});

test('an approved recovery remains visible even if the repeating weekdays are edited', () => {
  const r={id:'x',days:[1],start:'07:00',duration:30,records:{'2025-04-17':'missed'},
    recoveries:{'2025-04-17':{date:'2025-04-17',time:'12:00',duration:30}}};
  const rows=model.occurrences([r],'2025-04-17');
  assert.equal(rows.length,1);assert.equal(rows[0].kind,'recovery');
  assert.equal(model.status(rows[0],demoNow),'다시 예정');
});

test('routine names are escaped when shown in a card', () => {
  const p=preview();click(p,'[data-nav]',{nav:'routine'});
  vm.runInContext("state.routines[1].name='<img src=x>';render()",p.context);
  assert.match(p.elements.screen.innerHTML,/&lt;img src=x&gt;/);
  assert.doesNotMatch(p.elements.screen.innerHTML,/<img src=x>/);
});

test('the routine date selector and all-routines view show the right items', () => {
  const p=preview();click(p,'[data-nav]',{nav:'routine'});
  assert.match(p.elements.screen.innerHTML,/오늘의 루틴/);
  assert.doesNotMatch(p.elements.screen.innerHTML,/아침 운동/);
  action(p,'routine-view',{view:'all'});
  assert.match(p.elements.screen.innerHTML,/아침 운동/);
  action(p,'routine-view',{view:'today'});
  action(p,'routine-date',{date:'2025-04-16'});
  assert.match(p.elements.screen.innerHTML,/아침 운동/);
  assert.equal(vm.runInContext('R.dateKey(state.selectedDate)',p.context),'2025-04-16');
});

test('a future routine remains scheduled until the user explicitly marks it missed', () => {
  const p=preview();click(p,'[data-nav]',{nav:'routine'});
  assert.equal(vm.runInContext("R.status({routine:state.routines.find(r=>r.id==='r4'),origin:'2025-04-17',kind:'regular'},previewNow)",p.context),'예정');
  action(p,'routine-detail',{id:'r4',origin:'2025-04-17',kind:'regular'});
  assert.match(p.elements.sheet.innerHTML,/미완료로 기록/);
  action(p,'routine-set-record',{id:'r4',origin:'2025-04-17',kind:'regular',record:'missed'});
  assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r4').records['2025-04-17']",p.context),'missed');
});

test('routine registration requires at least one repeat weekday', () => {
  const p=preview();click(p,'[data-nav]',{nav:'routine'});
  const form={id:'routine-form',dataset:{id:''},elements:{name:{value:'명상'},start:{value:'08:30'},duration:{value:'20'},goal:{value:''}},querySelectorAll(){return []}};
  const before=vm.runInContext('state.routines.length',p.context);
  submit(p,form);
  assert.equal(vm.runInContext('state.routines.length',p.context),before);
});

test('home progress counts each active time range and never auto-completes unrecorded items', () => {
 const p=preview();
 vm.runInContext(`state.routines=[];state.events=[
  {name:'진행 중 할 일',time:'오전 11:00 - 11:30',type:'task',status:'pending',done:false,kind:'personal',show:true,color:'#7894ff'},
  {name:'앞으로 할 일',time:'오후 1:00 - 2:00',type:'task',status:'pending',done:false,kind:'personal',show:true,color:'#7894ff'},
  {name:'지난 미기록',time:'오전 8:00 - 9:00',type:'task',status:'pending',done:false,kind:'personal',show:true,color:'#7894ff'},
  {name:'진행 중 약속',time:'오전 11:00 - 11:30',type:'appointment',status:'pending',done:false,kind:'personal',show:true,color:'#7894ff'}
 ];state.screen='home';render()`,p.context);
 assert.match(p.elements.screen.innerHTML,/진행 중<strong>2개/);
 assert.match(p.elements.screen.innerHTML,/완료<strong>0개/);
 assert.match(p.elements.screen.innerHTML,/남은 일정<strong>2개/);
});

test('a fixed appointment provides details rather than a task-completion check', () => {
 const p=preview();
 vm.runInContext(`state.events=[{name:'점심 약속',time:'오후 1:00 - 2:00',type:'appointment',status:'pending',done:false,kind:'personal',show:true,color:'#7894ff'}];render()`,p.context);
 assert.match(p.elements.screen.innerHTML,/data-action="event-detail"/);
 assert.doesNotMatch(p.elements.screen.innerHTML,/data-action="toggle-event"/);
});

test('a home completion and its undo are reflected in the same daily calendar item', () => {
 const p=preview();
 action(p,'toggle-event',{index:'2'});
 assert.equal(vm.runInContext('state.events[2].status',p.context),'done');
 click(p,'[data-nav]',{nav:'calendar'});
 click(p,'[data-date],[data-day]',{date:'2025-04-17'});
 assert.match(p.elements.screen.innerHTML,/데일리 미팅 준비/);
 assert.match(p.elements.screen.innerHTML,/완료/);
 action(p,'toggle-event',{index:'2'});
 assert.equal(vm.runInContext('state.events[2].status',p.context),'pending');
 assert.match(p.elements.screen.innerHTML,/진행 중/);
});

test('a fixed appointment provides attendance controls without changing task completion', () => {
 const p=preview();
 action(p,'event-detail',{index:'1'});
 assert.match(p.elements.sheet.innerHTML,/참석 여부/);
 action(p,'event-attendance',{index:'1',attendance:'attend'});
 assert.equal(vm.runInContext('state.events[1].attendance',p.context),'attend');
 assert.notEqual(vm.runInContext('state.events[1].status',p.context),'done');
});

test('explicitly marking a task missed leaves its scheduled date and time unchanged', () => {
 const p=preview();
 const before=vm.runInContext('JSON.stringify({date:eventDate(state.events[3]),time:state.events[3].time})',p.context);
 action(p,'event-detail',{index:'3'});
 action(p,'event-record',{index:'3',record:'missed'});
 assert.equal(vm.runInContext('state.events[3].status',p.context),'missed');
 assert.equal(vm.runInContext('JSON.stringify({date:eventDate(state.events[3]),time:state.events[3].time})',p.context),before);
 assert.match(p.elements.sheet.innerHTML,/다시 계획하기/);
});

test('unrecorded past tasks and appointments need confirmation instead of becoming failures', () => {
 const p=preview();
 assert.equal(vm.runInContext("eventStatus({type:'task',status:'pending',time:'오전 8:00 - 9:00'})",p.context),'확인 필요');
 assert.equal(vm.runInContext("eventStatus({type:'appointment',attendance:'unknown',time:'오전 8:00 - 9:00'})",p.context),'확인 필요');
 assert.equal(vm.runInContext("eventStatus({type:'task',status:'pending',time:'오후 7:00 - 8:00'})",p.context),'예정');
});

test('undoing a quick completion restores the prior explicit missed state', () => {
 const p=preview();
 action(p,'event-record',{index:'3',record:'missed'});
 action(p,'toggle-event',{index:'3'});
 assert.equal(vm.runInContext('state.events[3].status',p.context),'done');
 action(p,'toggle-event',{index:'3'});
 assert.equal(vm.runInContext('state.events[3].status',p.context),'missed');
});

test('an expired or too-tight task deadline never changes the existing schedule', () => {
 const p=preview();
 const before=vm.runInContext('JSON.stringify({date:eventDate(state.events[3]),time:state.events[3].time})',p.context);
 action(p,'event-record',{index:'3',record:'missed'});
 action(p,'event-recover',{index:'3'});
 p.elements.sheet.querySelector('#event-deadline').value='2025-04-17T10:00';
 action(p,'event-propose',{index:'3'});
 assert.match(p.elements.sheet.innerHTML,/기한이 지났거나/);
 assert.equal(vm.runInContext('state.eventProposal',p.context),null);
 assert.equal(vm.runInContext('JSON.stringify({date:eventDate(state.events[3]),time:state.events[3].time})',p.context),before);
 p.elements.sheet.querySelector('#event-deadline').value='2025-04-17T11:15';
 action(p,'event-propose',{index:'3'});
 assert.match(p.elements.sheet.innerHTML,/기한 안에 가능한 시간을 찾지 못했어요/);
 assert.equal(vm.runInContext('state.eventProposal.date',p.context),undefined);
 assert.equal(vm.runInContext('state.events[3].status',p.context),'missed');
});

test('routine recovery also respects an explicitly entered deadline', () => {
 const p=preview();click(p,'[data-nav]',{nav:'routine'});
 const row={id:'r3',origin:'2025-04-17',kind:'regular'};
 action(p,'routine-recover',row);
 p.elements.sheet.querySelector('#routine-deadline').value='2025-04-17T11:10';
 action(p,'routine-propose',row);
 assert.match(p.elements.sheet.innerHTML,/기한 안에 가능한 시간을 찾지 못했어요/);
 assert.equal(vm.runInContext("Object.keys(state.routines.find(r=>r.id==='r3').recoveries).length",p.context),0);
});

test('task recovery rejection and invalid edits do not mutate its schedule, but approval does', () => {
 const p=preview();
 action(p,'event-record',{index:'3',record:'missed'});
 const before=vm.runInContext('JSON.stringify({date:eventDate(state.events[3]),time:state.events[3].time})',p.context);
 action(p,'event-recover',{index:'3'});action(p,'event-propose',{index:'3'});
 assert.match(p.elements.sheet.innerHTML,/아직 일정에 반영되지 않은/);
 assert.equal(vm.runInContext('JSON.stringify({date:eventDate(state.events[3]),time:state.events[3].time})',p.context),before);
 action(p,'event-reject');
 assert.equal(vm.runInContext('JSON.stringify({date:eventDate(state.events[3]),time:state.events[3].time})',p.context),before);
 action(p,'event-recover',{index:'3'});action(p,'event-propose',{index:'3'});action(p,'event-modify');
 const form=(date,time)=>({id:'event-recovery-form',elements:{date:{value:date},time:{value:time}}});
 submit(p,form('2025-04-17','11:15'));
 assert.match(p.elements.sheet.innerHTML,/다른 일정과 겹쳐요/);
 assert.equal(vm.runInContext('JSON.stringify({date:eventDate(state.events[3]),time:state.events[3].time})',p.context),before);
 submit(p,form('2025-04-18','12:00'));
 assert.match(p.elements.sheet.innerHTML,/4월 18일 금요일/);
 assert.equal(vm.runInContext('JSON.stringify({date:eventDate(state.events[3]),time:state.events[3].time})',p.context),before);
 action(p,'event-accept');
 assert.equal(vm.runInContext('state.events[3].date',p.context),'2025-04-18');
 assert.equal(vm.runInContext('state.events[3].status',p.context),'pending');
 assert.equal(vm.runInContext('state.events[3].recoveryHistory[0].status',p.context),'missed');
 vm.runInContext("state.screen='day';render()",p.context);
 assert.match(p.elements.screen.innerHTML,/다시 계획한 일정/);
});

test('a stale initial recommendation cannot be accepted after another event occupies its slot', () => {
 const p=preview();
 vm.runInContext("state.events.push({id:'busy',name:'고정 약속',date:'2025-04-17',time:'오전 11:30 - 오후 12:00',type:'appointment',attendance:'unknown',kind:'personal',show:true,color:'#7894ff'});render()",p.context);
 assert.match(p.elements.screen.innerHTML,/제안한 시간을 다시 확인해 주세요/);
 const count=vm.runInContext('state.events.length',p.context);
 action(p,'accept-proposal');
 assert.equal(vm.runInContext('state.events.length',p.context),count);
 assert.equal(vm.runInContext('state.added',p.context),false);
 assert.match(p.elements.sheet.innerHTML,/다시 확인해 주세요/);
});

test('a recommendation is separate until approved and then displays as an approved event', () => {
 const p=preview();
 assert.match(p.elements.screen.innerHTML,/삐꾸의 추천 · 아직 미반영/);
 assert.equal(vm.runInContext("state.events.some(e=>e.source==='recommendation')",p.context),false);
 action(p,'proposal');assert.match(p.elements.sheet.innerHTML,/일정에 추가할까요/);
 action(p,'accept-proposal');
 assert.equal(vm.runInContext("state.events.some(e=>e.source==='recommendation')",p.context),true);
 assert.match(p.elements.screen.innerHTML,/삐꾸의 추천 · 반영됨/);
 assert.match(p.elements.screen.innerHTML,/승인한 추천 일정/);
});

test('an empty home and a fixed-only home never invent a completion rate', () => {
 const p=preview();
 vm.runInContext("state.events=[];state.routines=[];render()",p.context);
 assert.match(p.elements.screen.innerHTML,/완료를 기록할 할 일이 없어요/);
 assert.doesNotMatch(p.elements.screen.innerHTML,/NaN/);
 vm.runInContext("state.events=[{name:'약속',time:'오후 1:00 - 2:00',type:'appointment',attendance:'unknown',kind:'personal',show:true,color:'#7894ff'}];render()",p.context);
 assert.match(p.elements.screen.innerHTML,/완료<strong>0개/);
 assert.match(p.elements.screen.innerHTML,/완료를 기록할 할 일이 없어요/);
});

test('changing an expired task deadline is only committed with an approved recovery', () => {
 const p=preview();
 vm.runInContext("state.events[2].deadline='2025-04-17T10:00'",p.context);
 action(p,'event-record',{index:'2',record:'missed'});
 action(p,'event-recover',{index:'2'});
 assert.doesNotMatch(p.elements.sheet.innerHTML,/id="event-deadline"[^>]*readonly/);
 p.elements.sheet.querySelector('#event-deadline').value='2025-04-17T12:30';
 action(p,'event-propose',{index:'2'});
 assert.equal(vm.runInContext('state.events[2].deadline',p.context),'2025-04-17T10:00');
 assert.match(p.elements.sheet.innerHTML,/기한 변경/);
 action(p,'event-accept');
 assert.equal(vm.runInContext('state.events[2].deadline',p.context),'2025-04-17T12:30');
 assert.equal(vm.runInContext('state.events[2].status',p.context),'pending');
});

test('a past appointment with recorded attendance is not counted as a remaining task', () => {
 const p=preview();
 vm.runInContext(`state.routines=[];state.events=[
  {name:'끝난 약속',time:'오전 8:00 - 9:00',type:'appointment',attendance:'attend',kind:'personal',show:true,color:'#7894ff'},
  {name:'예정된 할 일',time:'오후 1:00 - 2:00',type:'task',status:'pending',kind:'personal',show:true,color:'#7894ff'}
 ];render()`,p.context);
 assert.match(p.elements.screen.innerHTML,/완료<strong>0개/);
 assert.match(p.elements.screen.innerHTML,/남은 일정<strong>1개/);
 assert.match(p.elements.screen.innerHTML,/지난 약속 1개/);
});

test('undoing a routine completion restores its earlier missed record without changing the repeat rule', () => {
 const p=preview();click(p,'[data-nav]',{nav:'routine'});
 const data={id:'r3',origin:'2025-04-17',kind:'regular'};
 const days=vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r3').days)",p.context);
 action(p,'routine-check',data);
 assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r3').records['2025-04-17']",p.context),'done');
 action(p,'routine-check',data);
 assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r3').records['2025-04-17']",p.context),'missed');
 assert.equal(vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r3').days)",p.context),days);
});

test('an approved routine recovery shares its completion record with the daily calendar', () => {
 const p=preview();click(p,'[data-nav]',{nav:'routine'});
 const original={id:'r3',origin:'2025-04-17',kind:'regular'};
 action(p,'routine-recover',original);action(p,'routine-propose',original);action(p,'routine-accept');
 click(p,'[data-nav]',{nav:'calendar'});click(p,'[data-date],[data-day]',{date:'2025-04-17'});
 assert.match(p.elements.screen.innerHTML,/오전 산책/);
 action(p,'routine-check',{id:'r3',origin:'2025-04-17',kind:'recovery'});
 assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r3').recoveries['2025-04-17'].record",p.context),'done');
 assert.match(p.elements.screen.innerHTML,/복구 확정/);
 assert.match(p.elements.screen.innerHTML,/완료/);
 click(p,'[data-nav]',{nav:'routine'});
 assert.match(p.elements.screen.innerHTML,/오전 산책/);
 assert.match(p.elements.screen.innerHTML,/완료/);
});

test('rejecting a proposed deadline change keeps the original deadline and schedule', () => {
 const p=preview();
 vm.runInContext("state.events[2].deadline='2025-04-17T10:00'",p.context);
 const before=vm.runInContext('JSON.stringify({time:state.events[2].time,deadline:state.events[2].deadline})',p.context);
 action(p,'event-record',{index:'2',record:'missed'});action(p,'event-recover',{index:'2'});
 p.elements.sheet.querySelector('#event-deadline').value='2025-04-17T12:30';
 action(p,'event-propose',{index:'2'});action(p,'event-reject');
 assert.equal(vm.runInContext('JSON.stringify({time:state.events[2].time,deadline:state.events[2].deadline})',p.context),before);
 assert.equal(vm.runInContext('state.events[2].status',p.context),'missed');
});

test('a changed deadline invalidates an unapproved proposal', () => {
 const p=preview();
 action(p,'event-record',{index:'3',record:'missed'});action(p,'event-recover',{index:'3'});action(p,'event-propose',{index:'3'});
 vm.runInContext("state.events[3].deadline='2025-04-17T12:00'",p.context);
 const originalTime=vm.runInContext('state.events[3].time',p.context);
 action(p,'event-accept');
 assert.equal(vm.runInContext('state.events[3].time',p.context),originalTime);
 assert.equal(vm.runInContext('state.events[3].status',p.context),'missed');
 assert.match(p.elements.sheet.innerHTML,/일정이 바뀌어/);
});

test('attendance on an upcoming appointment is expressed as planned rather than completed', () => {
 const p=preview();
 vm.runInContext("state.events[1].time='오후 2:00 - 3:00';state.events[1].attendance='attend';render()",p.context);
 assert.match(p.elements.screen.innerHTML,/고정 약속/);
 assert.match(p.elements.screen.innerHTML,/참석 예정/);
 assert.notEqual(vm.runInContext('state.events[1].status',p.context),'done');
});

test('a new fixed appointment invalidates a task recovery before approval', () => {
 const p=preview();
 action(p,'event-record',{index:'3',record:'missed'});action(p,'event-recover',{index:'3'});action(p,'event-propose',{index:'3'});
 assert.equal(vm.runInContext('state.eventProposal.time',p.context),'11:30');
 const original=vm.runInContext('state.events[3].time',p.context);
 vm.runInContext("state.events.push({id:'new-fixed',name:'새 고정 약속',time:'오전 11:30 - 오후 12:30',date:'2025-04-17',type:'appointment',attendance:'unknown',kind:'personal',show:true,color:'#7894ff'})",p.context);
 action(p,'event-accept');
 assert.equal(vm.runInContext('state.events[3].time',p.context),original);
 assert.equal(vm.runInContext('state.events[3].status',p.context),'missed');
 assert.match(p.elements.sheet.innerHTML,/다른 일정과 겹쳐요/);
});

test('a new fixed appointment invalidates a routine recovery before approval', () => {
 const p=preview();click(p,'[data-nav]',{nav:'routine'});
 const row={id:'r3',origin:'2025-04-17',kind:'regular'};
 action(p,'routine-recover',row);action(p,'routine-propose',row);
 assert.equal(vm.runInContext('state.routineProposal.time',p.context),'11:30');
 vm.runInContext("state.events.push({id:'new-fixed',name:'새 고정 약속',time:'오전 11:30 - 오후 12:30',date:'2025-04-17',type:'appointment',attendance:'unknown',kind:'personal',show:true,color:'#7894ff'})",p.context);
 action(p,'routine-accept');
 assert.equal(vm.runInContext("Object.keys(state.routines.find(r=>r.id==='r3').recoveries).length",p.context),0);
 assert.match(p.elements.sheet.innerHTML,/다른 일정과 겹쳐요/);
});

test('a new example appointment must have a readable time before it can affect suggestions', () => {
 const p=preview();action(p,'add');
 const before=vm.runInContext('state.events.length',p.context);
 const form={id:'add-form',elements:{name:{value:'병원 약속'},time:{value:'회의 끝나고'},eventType:{value:'appointment'}}};
 submit(p,form);
 assert.equal(vm.runInContext('state.events.length',p.context),before);
 assert.match(p.elements.sheet.querySelector('#event-add-error').textContent,/시간/);
 form.elements.time.value='오후 3:00 - 4:00';submit(p,form);
 assert.equal(vm.runInContext('state.events.length',p.context),before+1);
 assert.equal(vm.runInContext('state.events[state.events.length-1].type',p.context),'appointment');
});

test('an invalid routine recovery edit keeps the attempted date and time visible', () => {
 const p=preview();click(p,'[data-nav]',{nav:'routine'});
 const row={id:'r3',origin:'2025-04-17',kind:'regular'};
 action(p,'routine-recover',row);action(p,'routine-propose',row);action(p,'routine-modify');
 submit(p,{id:'routine-recovery-form',elements:{date:{value:'2025-04-17'},time:{value:'13:15'}}});
 assert.match(p.elements.sheet.innerHTML,/다른 일정과 겹쳐요/);
 assert.match(p.elements.sheet.innerHTML,/id="recovery-time"[^>]*value="13:15"/);
});

test('event cards offer the same labeled status control and vertical more menu', () => {
 const p=preview();
 assert.match(p.elements.screen.innerHTML,/data-action="event-menu"/);
 assert.match(p.elements.screen.innerHTML,/앨리스와 브런치 더보기/);
 assert.match(p.elements.screen.innerHTML,/참석 확인/);
 assert.match(p.elements.screen.innerHTML,/완료됨/);
});

test('a routine occurrence marked from home stays in sync with daily and routine screens', () => {
 const p=preview();
 vm.runInContext("state.events=[];state.routines=state.routines.filter(r=>r.id==='r2');state.routines[0].records={};render()",p.context);
 assert.match(p.elements.screen.innerHTML,/물 한 잔 마시기/);
 assert.match(p.elements.screen.innerHTML,/data-action="routine-check"/);
 action(p,'routine-check',{id:'r2',origin:'2025-04-17',kind:'regular'});
 assert.equal(vm.runInContext("state.routines[0].records['2025-04-17']",p.context),'done');
 click(p,'[data-nav]',{nav:'calendar'});click(p,'[data-date],[data-day]',{date:'2025-04-17'});
 assert.match(p.elements.screen.innerHTML,/물 한 잔 마시기/);
 assert.match(p.elements.screen.innerHTML,/완료됨/);
 click(p,'[data-nav]',{nav:'routine'});
 assert.match(p.elements.screen.innerHTML,/물 한 잔 마시기/);
 assert.match(p.elements.screen.innerHTML,/완료됨/);
});

test('appointment status opens attendance choices and more offers details and modification', () => {
 const p=preview();
 action(p,'event-attendance-open',{index:'1'});
 assert.match(p.elements.sheet.innerHTML,/참석 여부/);
 assert.match(p.elements.sheet.innerHTML,/data-attendance="absent"/);
 action(p,'event-menu',{index:'1'});
 assert.match(p.elements.sheet.innerHTML,/상세 정보 보기/);
 assert.match(p.elements.sheet.innerHTML,/수정/);
 assert.match(p.elements.sheet.innerHTML,/취소 요청/);
 assert.doesNotMatch(p.elements.sheet.innerHTML,/다시 계획하기/);
});

test('a task more menu offers recovery only for explicitly missed work', () => {
 const p=preview();
 action(p,'event-menu',{index:'3'});
 assert.doesNotMatch(p.elements.sheet.innerHTML,/다시 계획하기/);
 action(p,'event-record',{index:'3',record:'missed'});
 action(p,'event-menu',{index:'3'});
 assert.match(p.elements.sheet.innerHTML,/AI로 다시 계획하기/);
});

test('changing or canceling a shared appointment never updates its original without the other person', () => {
 const p=preview();
 const before=vm.runInContext('JSON.stringify(state.events[1])',p.context);
 action(p,'event-edit',{index:'1'});
 assert.match(p.elements.sheet.innerHTML,/일정 수정/);
 const form={id:'event-edit-form',dataset:{index:'1',id:'e2'},elements:{name:{value:'브런치 변경'},date:{value:'2025-04-18'},time:{value:'오후 12:00 - 1:00'}}};
 submit(p,form);
 assert.match(p.elements.sheet.innerHTML,/상대/);
 assert.equal(vm.runInContext('JSON.stringify(state.events[1])',p.context),before);
 action(p,'event-edit-confirm',{index:'1'});
 assert.equal(vm.runInContext('JSON.stringify(state.events[1])',p.context),before);
 action(p,'event-delete',{index:'1'});
 assert.match(p.elements.sheet.innerHTML,/상대/);
 action(p,'event-delete-confirm',{index:'1'});
 assert.equal(vm.runInContext('JSON.stringify(state.events[1])',p.context),before);
});

test('personal task changes require confirmation and appear in both home and daily views', () => {
 const p=preview();
 const before=vm.runInContext('state.events[3].name',p.context);
 action(p,'event-menu',{index:'3'});
 assert.match(p.elements.sheet.innerHTML,/상세 정보 보기/);
 assert.match(p.elements.sheet.innerHTML,/삭제/);
 action(p,'event-edit',{index:'3'});
 submit(p,{id:'event-edit-form',dataset:{index:'3',id:'e4'},elements:{name:{value:'프로젝트 계획 정리'},date:{value:'2025-04-17'},time:{value:'오후 1:00 - 2:00'}}});
 assert.match(p.elements.sheet.innerHTML,/변경 내용을 확인해요/);
 assert.equal(vm.runInContext('state.events[3].name',p.context),before);
 action(p,'event-edit-confirm',{index:'3'});
 assert.equal(vm.runInContext('state.events[3].name',p.context),'프로젝트 계획 정리');
 assert.match(p.elements.screen.innerHTML,/프로젝트 계획 정리/);
 click(p,'[data-nav]',{nav:'calendar'});click(p,'[data-date],[data-day]',{date:'2025-04-17'});
 assert.match(p.elements.screen.innerHTML,/프로젝트 계획 정리/);
});

test('a personal appointment is deleted only after the user confirms', () => {
 const p=preview();
 vm.runInContext("state.events[1].involvement='personal'",p.context);
 const before=vm.runInContext('state.events.length',p.context);
 action(p,'event-delete',{index:'1'});
 assert.match(p.elements.sheet.innerHTML,/일정을 삭제할까요/);
 assert.equal(vm.runInContext('state.events.length',p.context),before);
 action(p,'event-delete-confirm',{index:'1'});
 assert.equal(vm.runInContext('state.events.length',p.context),before-1);
 assert.equal(vm.runInContext("state.events.some(e=>e.id==='e2')",p.context),false);
});

test('editing a personal task cannot introduce a conflict or exceed its deadline', () => {
 const p=preview();
 const before=vm.runInContext('JSON.stringify(state.events[2])',p.context);
 action(p,'event-edit',{index:'2'});
 submit(p,{id:'event-edit-form',dataset:{index:'2',id:'e3'},elements:{name:{value:'데일리 미팅 준비'},date:{value:'2025-04-17'},time:{value:'오후 1:00 - 2:00'}}});
 assert.match(p.elements.sheet.innerHTML,/기한 안에/);
 assert.equal(vm.runInContext('JSON.stringify(state.events[2])',p.context),before);
 action(p,'event-edit',{index:'3'});
 const otherBefore=vm.runInContext('JSON.stringify(state.events[3])',p.context);
 submit(p,{id:'event-edit-form',dataset:{index:'3',id:'e4'},elements:{name:{value:'프로젝트 기획 점검'},date:{value:'2025-04-17'},time:{value:'오전 11:15 - 11:45'}}});
 assert.match(p.elements.sheet.innerHTML,/다른 일정과 겹치거나/);
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',p.context),otherBefore);
});

test('routine menus expose recovery only after an explicit missed record', () => {
 const p=preview();click(p,'[data-nav]',{nav:'routine'});
 const row={id:'r4',origin:'2025-04-17',kind:'regular'};
 const days=vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r4').days)",p.context);
 action(p,'routine-menu',row);
 assert.match(p.elements.sheet.innerHTML,/상세 정보 보기/);
 assert.match(p.elements.sheet.innerHTML,/완료 상태 변경/);
 assert.doesNotMatch(p.elements.sheet.innerHTML,/AI로 다시 계획하기/);
 action(p,'routine-status',row);action(p,'routine-set-record',{...row,record:'missed'});
 assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r4').records['2025-04-17']",p.context),'missed');
 assert.equal(vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r4').days)",p.context),days);
 assert.equal(vm.runInContext('state.routineProposal',p.context),null);
 action(p,'routine-menu',row);
 assert.match(p.elements.sheet.innerHTML,/AI로 다시 계획하기/);
});

test('completed state is not repeated in the card metadata', () => {
 const p=preview();
 const taskCard=vm.runInContext('eventCard(state.events[0],0)',p.context);
 assert.match(taskCard,/완료됨/);
 assert.doesNotMatch(taskCard,/할 일 · 완료/);
 const routine=vm.runInContext("routineScheduleCard({routine:state.routines.find(r=>r.id==='r2'),origin:'2025-04-17',kind:'regular'})",p.context);
 assert.match(routine,/완료됨/);
 assert.doesNotMatch(routine,/루틴 · 완료/);
});

test('an unscheduled routine still has a more menu but cannot mark that date complete', () => {
 const p=preview();click(p,'[data-nav]',{nav:'routine'});
 action(p,'routine-view',{view:'all'});
 assert.match(p.elements.screen.innerHTML,/아침 운동 예정 없음/);
 assert.match(p.elements.screen.innerHTML,/아침 운동 더보기/);
 const before=vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r1').records)",p.context);
 action(p,'routine-check',{id:'r1',origin:'2025-04-17',kind:'regular'});
 assert.equal(vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r1').records)",p.context),before);
});

test('the home overview counts the selected day routines using their recorded states', () => {
 const p=preview();
 vm.runInContext('state.events=[];render()',p.context);
 assert.match(p.elements.screen.innerHTML,/오늘의 일정 3개/);
 assert.match(p.elements.screen.innerHTML,/완료<strong>1개/);
 assert.match(p.elements.screen.innerHTML,/남은 일정<strong>2개/);
 assert.match(p.elements.screen.innerHTML,/할 일·루틴 3개 중 1개 완료/);
});

test('an edit proposal is rechecked if a new fixed appointment occupies the requested time', () => {
 const p=preview();
 const before=vm.runInContext('JSON.stringify(state.events[3])',p.context);
 action(p,'event-edit',{index:'3'});
 submit(p,{id:'event-edit-form',dataset:{index:'3',id:'e4'},elements:{name:{value:'프로젝트 기획 점검'},date:{value:'2025-04-18'},time:{value:'오후 12:00 - 1:00'}}});
 assert.match(p.elements.sheet.innerHTML,/변경 내용을 확인해요/);
 vm.runInContext("state.events.push({id:'fixed',name:'고정 약속',date:'2025-04-18',time:'오후 12:00 - 1:00',type:'appointment',involvement:'personal',attendance:'unknown',kind:'personal',show:true,color:'#7894ff'})",p.context);
 action(p,'event-edit-confirm',{index:'3'});
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',p.context),before);
 assert.match(p.elements.sheet.innerHTML,/다른 일정과 겹치거나/);
});

test('shared tasks are also protected from direct edit or delete', () => {
 const p=preview();
 vm.runInContext("state.events[3].involvement='shared'",p.context);
 const before=vm.runInContext('JSON.stringify(state.events[3])',p.context);
 action(p,'event-edit',{index:'3'});
 submit(p,{id:'event-edit-form',dataset:{index:'3',id:'e4'},elements:{name:{value:'공동 작업 변경'},date:{value:'2025-04-18'},time:{value:'오후 12:00 - 1:00'}}});
 action(p,'event-edit-confirm',{index:'3'});
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',p.context),before);
 assert.match(p.elements.sheet.innerHTML,/상대방 확인이 필요해요/);
 action(p,'event-delete',{index:'3'});action(p,'event-delete-confirm',{index:'3'});
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',p.context),before);
});

test('deleting a personal upcoming task removes it from the monthly list after confirmation', () => {
 const p=preview();
 assert.match(vm.runInContext('month()',p.context),/최종 결과물 제출/);
 action(p,'event-delete',{index:'7'});
 assert.match(vm.runInContext('month()',p.context),/최종 결과물 제출/);
 action(p,'event-delete-confirm',{index:'7'});
 assert.doesNotMatch(vm.runInContext('month()',p.context),/최종 결과물 제출/);
});

test('an appointment more menu starts with an AI entry and passes the selected event into chat without changes', () => {
 const p=preview(), before=vm.runInContext('JSON.stringify(state.events)',p.context);
 action(p,'event-menu',{index:'1'});
 assert.match(p.elements.sheet.innerHTML,/data-action="event-ask-ai"[^>]*>[\s\S]*?삐꾸에게 부탁하기/);
 assert.ok(p.elements.sheet.innerHTML.indexOf('삐꾸에게 부탁하기')<p.elements.sheet.innerHTML.indexOf('상세 정보 보기'));
 action(p,'event-ask-ai',{index:'1'});
 assert.equal(vm.runInContext('state.screen',p.context),'chat');
 assert.equal(vm.runInContext('state.aiContext.id',p.context),'e2');
 assert.match(p.elements.screen.innerHTML,/앨리스와 브런치/);
 assert.match(p.elements.screen.innerHTML,/4월 17일/);
 assert.match(p.elements.screen.innerHTML,/오전 9:30/);
 assert.match(p.elements.screen.innerHTML,/고정 약속/);
 assert.match(p.elements.screen.innerHTML,/준비시간/);
 assert.equal(vm.runInContext('JSON.stringify(state.events)',p.context),before);
 assert.equal(vm.runInContext('state.aiProposal',p.context),null);
});

test('a missed routine enters contextual chat without modifying the occurrence and checks need before recovery', () => {
 const p=preview(), row={id:'r3',origin:'2025-04-17',kind:'regular'};
 const before=vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r3'))",p.context);
 action(p,'routine-menu',row);
 assert.match(p.elements.sheet.innerHTML,/data-action="routine-ask-ai"[^>]*>[\s\S]*?삐꾸에게 부탁하기/);
 assert.ok(p.elements.sheet.innerHTML.indexOf('삐꾸에게 부탁하기')<p.elements.sheet.innerHTML.indexOf('상세 정보 보기'));
 action(p,'routine-ask-ai',row);
 assert.equal(vm.runInContext('state.screen',p.context),'chat');
 assert.equal(vm.runInContext('state.aiContext.id',p.context),'r3');
 assert.equal(vm.runInContext('state.aiContext.origin',p.context),'2025-04-17');
 assert.match(p.elements.screen.innerHTML,/오전 산책/);
 assert.match(p.elements.screen.innerHTML,/오전 9:00/);
 assert.equal(vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r3'))",p.context),before);
 action(p,'ai-question',{question:'move'});
 assert.match(p.elements.screen.innerHTML,/필요한지|필요 여부/);
 assert.equal(vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r3'))",p.context),before);
 action(p,'ai-recovery');
 assert.match(p.elements.sheet.innerHTML,/지금도 필요한지/);
});

test('a task time proposal stays separate until accepted and can be edited or rejected', () => {
 const p=preview(), before=vm.runInContext('JSON.stringify(state.events[3])',p.context);
 action(p,'event-ask-ai',{index:'3'});
 action(p,'ai-question',{question:'move'});
 assert.match(p.elements.screen.innerHTML,/아직 반영되지 않은/);
 assert.match(p.elements.screen.innerHTML,/수락/);
 assert.match(p.elements.screen.innerHTML,/수정/);
 assert.match(p.elements.screen.innerHTML,/거절/);
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',p.context),before);
 action(p,'ai-reject');
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',p.context),before);
 action(p,'ai-question',{question:'move'});action(p,'ai-edit');
 submit(p,{id:'ai-proposal-form',elements:{date:{value:'2025-04-17'},time:{value:'13:30'}}});
 assert.match(p.elements.sheet.innerHTML,/겹치|확인/);
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',p.context),before);
 submit(p,{id:'ai-proposal-form',elements:{date:{value:'2025-04-18'},time:{value:'12:00'}}});
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',p.context),before);
 action(p,'ai-accept');
 assert.equal(vm.runInContext('state.events[3].date',p.context),'2025-04-18');
 assert.match(vm.runInContext('state.events[3].time',p.context),/오후 12:00/);
});

test('accepting a shared appointment suggestion never changes or contacts the other participant', () => {
 const p=preview(), before=vm.runInContext('JSON.stringify(state.events[1])',p.context);
 action(p,'event-ask-ai',{index:'1'});action(p,'ai-question',{question:'move'});
 assert.equal(vm.runInContext('JSON.stringify(state.events[1])',p.context),before);
 action(p,'ai-accept');
 assert.equal(vm.runInContext('JSON.stringify(state.events[1])',p.context),before);
 assert.match(p.elements.sheet.innerHTML,/상대방 확인/);
 assert.match(p.elements.sheet.innerHTML,/실제 연락을 보내지/);
});

test('a routine occurrence and its repeating rule are changed separately after approval', () => {
 const p=preview(), row={id:'r4',origin:'2025-04-17',kind:'regular'};
 const before=vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r4'))",p.context);
 action(p,'routine-ask-ai',row);action(p,'ai-question',{question:'move'});
 assert.match(p.elements.screen.innerHTML,/이번 회차/);
 assert.equal(vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r4'))",p.context),before);
 action(p,'ai-accept');
 assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r4').start",p.context),'19:00');
 assert.ok(vm.runInContext("!!state.routines.find(r=>r.id==='r4').recoveries['2025-04-17']",p.context));
 const afterOccurrence=vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r4'))",p.context);
 action(p,'ai-question',{question:'repeat'});
 assert.match(p.elements.screen.innerHTML,/반복 규칙 전체/);
 assert.equal(vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r4'))",p.context),afterOccurrence);
 action(p,'ai-accept');
 assert.notEqual(vm.runInContext("state.routines.find(r=>r.id==='r4').start",p.context),'19:00');
 assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r4').days.length",p.context),7);
});

test('unknown free text is not presented as a real AI response or used to change a selected item', () => {
 const p=preview(), before=vm.runInContext('JSON.stringify(state.events)',p.context);
 action(p,'event-ask-ai',{index:'3'});
 submit(p,{id:'chat-form',elements:{message:{value:'저녁 메뉴를 골라줘'}}});
 assert.match(p.elements.screen.innerHTML,/저녁 메뉴를 골라줘/);
 assert.match(p.elements.screen.innerHTML,/실제 AI|연결되지/);
 assert.equal(vm.runInContext('JSON.stringify(state.events)',p.context),before);
});

test('a typed missed-work request asks to record the status before proposing recovery', () => {
 const p=preview(),before=vm.runInContext('JSON.stringify(state.events[3])',p.context);
 action(p,'event-ask-ai',{index:'3'});
 submit(p,{id:'chat-form',elements:{message:{value:'오늘 못 했는데 다시 할 시간을 추천해줘.'}}});
 assert.match(p.elements.screen.innerHTML,/수행 상태 확인/);
 assert.equal(vm.runInContext('state.aiProposal',p.context),null);
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',p.context),before);
 action(p,'ai-record');
 assert.match(p.elements.sheet.innerHTML,/못했어요/);
 action(p,'event-record',{index:'3',record:'missed'});
 action(p,'ai-recovery');
 assert.match(p.elements.sheet.innerHTML,/지금도 필요한지/);
});

test('a changed example calendar invalidates an AI time proposal at acceptance', () => {
 const p=preview(),before=vm.runInContext('JSON.stringify(state.events[3])',p.context);
 action(p,'event-ask-ai',{index:'3'});action(p,'ai-question',{question:'move'});
 vm.runInContext("state.events.push({id:'collision',name:'새 약속',date:state.aiProposal.date,time:routineTimeRange(state.aiProposal.time,state.aiProposal.duration),type:'appointment',involvement:'personal',color:'#888'})",p.context);
 action(p,'ai-accept');
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',p.context),before);
 assert.match(p.elements.screen.innerHTML,/겹쳐요/);
});

test('a shared missed task recovery remains unchanged after user accepts the example proposal', () => {
 const p=preview();
 vm.runInContext("state.events[3].involvement='shared';state.events[3].status='missed'",p.context);
 const before=vm.runInContext('JSON.stringify(state.events[3])',p.context);
 action(p,'event-ask-ai',{index:'3'});action(p,'ai-question',{question:'move'});action(p,'ai-recovery');
 action(p,'event-propose',{index:'3'});action(p,'event-accept');
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',p.context),before);
 assert.match(p.elements.sheet.innerHTML,/상대방 확인/);
});

test('a recovered routine updates the selected context without changing its repeat rule', () => {
 const p=preview(),row={id:'r3',origin:'2025-04-17',kind:'regular'};
 const days=vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r3').days)",p.context);
 action(p,'routine-ask-ai',row);action(p,'ai-question',{question:'move'});action(p,'ai-recovery');
 action(p,'routine-propose',row);action(p,'routine-accept');
 assert.equal(vm.runInContext('state.aiContext.kind',p.context),'recovery');
 assert.equal(vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r3').days)",p.context),days);
 assert.doesNotMatch(p.elements.screen.innerHTML,/기한과 필요 여부 확인하기/);
});

test('a typed specific time makes the preview limitation explicit before a proposal can be accepted', () => {
 const p=preview();action(p,'event-ask-ai',{index:'3'});
 submit(p,{id:'chat-form',elements:{message:{value:'내일 오후 2시로 옮겨줘'}}});
 assert.match(p.elements.screen.innerHTML,/날짜와 시간을 자동으로 읽지 못/);
 assert.match(p.elements.screen.innerHTML,/수정/);
 assert.equal(vm.runInContext('state.events[3].date',p.context),undefined);
});

test('asking about a completed routine does not require undoing its completion record', () => {
 const p=preview(),row={id:'r2',origin:'2025-04-17',kind:'regular'};
 const before=vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r2'))",p.context);
 action(p,'routine-ask-ai',row);
 submit(p,{id:'chat-form',elements:{message:{value:'이 루틴 시간을 바꾸는 게 좋을까?'}}});
 assert.match(p.elements.screen.innerHTML,/완료|반복/);
 assert.doesNotMatch(p.elements.screen.innerHTML,/먼저 완료 기록을 확인/);
 assert.equal(vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r2'))",p.context),before);
});


function cardStackMarkup(html) {
 return html.match(/<section class="schedule-stack[^]*?<\/section>/)?.[0] || '';
}
test('the current event is the front card with actual past cards layered behind and no visible summary header', () => {
 const p=preview(),html=p.elements.screen.innerHTML,stack=cardStackMarkup(html);
 assert.ok(stack,'a card stack should wrap the current event');
 assert.match(stack,/data-stack-front="event:e3"/);
 assert.match(stack,/data-stack-layer="event:e2"/);
 assert.match(stack,/data-stack-layer="routine:r3:2025-04-17:regular"/);
 assert.match(stack,/data-stack-layer="routine:r2:2025-04-17:regular"/);
 assert.match(stack,/data-action="stack-toggle"[^>]*aria-label="이전 일정 카드 펼치기"/);
 assert.doesNotMatch(stack,/>지난 일정 \d+개</);
 assert.doesNotMatch(stack,/완료 \d+개 · 미완료/);
 assert.ok(html.indexOf('data-stack-front="event:e3"')<html.indexOf('>프로젝트 기획 점검</span>'));
 const back=stack.match(/<div class="stack-back"[^]*?<\/div><button class="stack-peek"/)?.[0]||'';
 assert.match(back,/schedule-card/);assert.match(back,/aria-hidden="true"/);assert.match(back,/inert/);
});

test('the exposed rear layers open and close the old cards in recent-end order without changing them', () => {
 const p=preview(),before=vm.runInContext('JSON.stringify(state.events)',p.context);
 action(p,'stack-toggle',{scope:'home',date:'2025-04-17'});
 let stack=cardStackMarkup(p.elements.screen.innerHTML);
 assert.match(stack,/schedule-stack is-open/);
 assert.match(stack,/aria-expanded="true"/);
 const history=stack.match(/<div class="stack-history"[^]*?<button class="stack-close"/)?.[0]||'';
 assert.ok(history.indexOf('앨리스와 브런치')<history.indexOf('오전 산책'));
 assert.ok(history.indexOf('오전 산책')<history.indexOf('물 한 잔 마시기'));
 assert.ok(history.indexOf('물 한 잔 마시기')<history.indexOf('아침 정리'));
 assert.match(history,/data-action="event-menu"/);assert.match(history,/data-action="routine-menu"/);
 assert.equal(vm.runInContext('JSON.stringify(state.events)',p.context),before);
 action(p,'stack-toggle',{scope:'home',date:'2025-04-17'});
 stack=cardStackMarkup(p.elements.screen.innerHTML);
 assert.match(stack,/aria-expanded="false"/);assert.match(stack,/data-stack-front="event:e3"/);
});

test('the front card keeps its existing detail and status controls independently of the rear hit area', () => {
 const p=preview(),stack=cardStackMarkup(p.elements.screen.innerHTML);
 const front=stack.match(/<div class="stack-front"[^]*?<\/section>/)?.[0]||'';
 assert.match(front,/data-action="event-detail"/);
 assert.match(front,/data-action="toggle-event"/);
 assert.match(front,/data-action="event-menu"/);
 action(p,'toggle-event',{index:'2'});
 assert.equal(vm.runInContext("state.events.find(e=>e.id==='e3').status",p.context),'done');
 assert.match(cardStackMarkup(p.elements.screen.innerHTML),/data-stack-front="event:e3"/);
});

test('home filters only show actual matching past cards in the front-card stack', () => {
 const p=preview();click(p,'[data-filter]',{filter:'work'});
 assert.doesNotMatch(p.elements.screen.innerHTML,/class="schedule-stack/);
 click(p,'[data-filter]',{filter:'personal'});
 const stack=cardStackMarkup(p.elements.screen.innerHTML);
 assert.match(stack,/data-stack-front="event:e5"/);
 assert.doesNotMatch(stack,/data-stack-layer="event:e3"/);
});

test('end time, explicit duration or a valid deadline determines past while a completed future item stays ahead', () => {
 const p=preview();
 vm.runInContext("state.routines=[];state.events=[{id:'past',name:'끝난 미확인',time:'오전 9:00 - 10:00',type:'task',status:'pending',kind:'personal',color:'#7894ff'},{id:'unknown',name:'종료 미정',time:'오전 8:00',type:'task',status:'pending',kind:'personal',color:'#7894ff'},{id:'due',name:'마감 있음',time:'오전 9:00',deadline:'2025-04-17T10:00',type:'task',status:'pending',kind:'personal',color:'#7894ff'},{id:'future',name:'미리 완료',time:'오후 1:00 - 2:00',type:'task',status:'done',kind:'personal',color:'#7894ff'}];render()",p.context);
 const html=p.elements.screen.innerHTML,stack=cardStackMarkup(html);
 assert.match(stack,/data-stack-front="event:future"/);
 assert.match(stack,/data-stack-layer="event:past"/);
 assert.match(stack,/data-stack-layer="event:due"/);
 assert.doesNotMatch(stack,/data-stack-layer="event:unknown"/);
 assert.match(html,/종료 미정/);
 assert.equal(vm.runInContext("state.events[0].status",p.context),'pending');
});

test('a deadline before a future start does not put that task behind the front card', () => {
 const p=preview();
 vm.runInContext("state.routines=[];state.events=[{id:'a',name:'시작 전',time:'오후 2:00',deadline:'2025-04-17T10:00',type:'task',status:'pending',kind:'personal',color:'#7894ff'}];render()",p.context);
 assert.doesNotMatch(p.elements.screen.innerHTML,/class="schedule-stack/);
 assert.match(p.elements.screen.innerHTML,/시작 전/);
});

test('one or several past items still use real cards when no current or future event exists', () => {
 const p=preview();
 vm.runInContext("state.routines=[];state.events=[{id:'old',name:'이전 일정',time:'오전 8:00 - 9:00',type:'task',status:'pending',kind:'personal',color:'#7894ff'},{id:'last',name:'마지막 일정',time:'오전 9:00 - 10:00',type:'task',status:'pending',kind:'personal',color:'#7894ff'}];render()",p.context);
 let stack=cardStackMarkup(p.elements.screen.innerHTML);
 assert.match(stack,/data-stack-front="event:last"/);assert.match(stack,/data-stack-layer="event:old"/);
 vm.runInContext("state.events.shift();render()",p.context);
 assert.doesNotMatch(p.elements.screen.innerHTML,/class="schedule-stack/);
 assert.match(p.elements.screen.innerHTML,/마지막 일정/);
});

test('today’s daily calendar shares the card stack, while other dates show their full timeline', () => {
 const p=preview();click(p,'[data-nav]',{nav:'calendar'});click(p,'[data-date],[data-day]',{date:'2025-04-17'});
 let stack=cardStackMarkup(p.elements.screen.innerHTML);
 assert.match(stack,/data-stack-front="event:e3"/);
 assert.match(stack,/data-stack-layer="event:e2"/);
 assert.match(stack,/data-time-start[^>]*>11:00</);assert.match(stack,/data-time-end[^>]*>11:30</);
 click(p,'[data-date],[data-day]',{date:'2025-04-16'});
 assert.doesNotMatch(p.elements.screen.innerHTML,/class="schedule-stack/);
 assert.match(p.elements.screen.innerHTML,/물 한 잔 마시기/);
 click(p,'[data-date],[data-day]',{date:'2025-04-18'});
 assert.doesNotMatch(p.elements.screen.innerHTML,/class="schedule-stack/);
});

test('expanded past cards retain state synchronization and AI contextual actions', () => {
 const p=preview(),row={id:'r3',origin:'2025-04-17',kind:'regular'};
 const days=vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r3').days)",p.context);
 action(p,'stack-toggle',{scope:'home',date:'2025-04-17'});
 action(p,'routine-check',row);
 assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r3').records['2025-04-17']",p.context),'done');
 assert.match(cardStackMarkup(p.elements.screen.innerHTML),/schedule-stack is-open/);
 click(p,'[data-nav]',{nav:'calendar'});click(p,'[data-date],[data-day]',{date:'2025-04-17'});
 assert.match(cardStackMarkup(p.elements.screen.innerHTML),/오전 산책/);
 click(p,'[data-nav]',{nav:'routine'});
 assert.equal(vm.runInContext("JSON.stringify(state.routines.find(r=>r.id==='r3').days)",p.context),days);
 action(p,'routine-menu',row);assert.match(p.elements.sheet.innerHTML,/삐꾸에게 부탁하기/);
 action(p,'routine-ask-ai',row);
 assert.equal(vm.runInContext('state.aiContext.id',p.context),'r3');
});

test('changing the preview time changes the front card without completing an unrecorded task', () => {
 const p=preview();
 vm.runInContext("setPreviewTime('10:00')",p.context);
 assert.match(cardStackMarkup(p.elements.screen.innerHTML),/data-stack-front="event:e2"/);
 vm.runInContext("setPreviewTime('11:01')",p.context);
 assert.match(cardStackMarkup(p.elements.screen.innerHTML),/data-stack-front="event:e3"/);
 vm.runInContext("setPreviewTime('15:00')",p.context);
 assert.match(cardStackMarkup(p.elements.screen.innerHTML),/data-stack-front="event:e5"/);
 assert.equal(vm.runInContext("state.events.find(e=>e.id==='e3').status",p.context),'pending');
});

test('the preview clock moves an ended card behind the next one as a minute elapses', () => {
 const p=preview();
 vm.runInContext("setPreviewTime('11:29')",p.context);
 assert.match(cardStackMarkup(p.elements.screen.innerHTML),/data-stack-front="event:e3"/);
 vm.runInContext("advancePreviewClockBy(60000)",p.context);
 const stack=cardStackMarkup(p.elements.screen.innerHTML);
 assert.match(stack,/data-stack-front="event:e4"/);
 assert.match(stack,/data-stack-layer="event:e3"/);
 assert.match(stack,/is-changing/);
 assert.equal(vm.runInContext("state.events.find(e=>e.id==='e3').status",p.context),'pending');
});

test('a day rollover advances the sample date without moving yesterday’s unscheduled event data', () => {
 const p=preview();
 vm.runInContext("setPreviewTime('23:59');advancePreviewClockBy(60000)",p.context);
 assert.equal(vm.runInContext('previewToday',p.context),'2025-04-18');
 assert.equal(vm.runInContext("eventDate(state.events.find(e=>e.id==='e3'))",p.context),'2025-04-17');
 assert.doesNotMatch(p.elements.screen.innerHTML,/데일리 미팅 준비/);
 assert.match(p.elements.screen.innerHTML,/2025년 4월 18일 금요일/);
});

test('the real stack toggle keeps the hidden duplicate inert and moves keyboard focus between controls', () => {
 const p=preview();
 const code=[
  "(() => {",
  "const attrs={};",
  "const history={inert:true,setAttribute(k,v){attrs['history:'+k]=v}};",
  "const close={focused:0,focus(){this.focused++}};",
  "const peek={dataset:{scope:'home',date:'2025-04-17'},inert:false,tabIndex:0,focused:0,setAttribute(k,v){attrs['peek:'+k]=v},focus(){this.focused++}};",
  "const classes={on:false,toggle(k,v){if(k==='is-open')this.on=v}};",
  "const section={classList:classes,querySelector(q){return q==='[data-stack-history]'?history:q==='[data-stack-peek]'?peek:close}};",
  "peek.closest=()=>section;close.closest=()=>section;close.dataset=peek.dataset;",
  "toggleScheduleStack(peek);const opened=[classes.on,history.inert,peek.inert,attrs['peek:aria-expanded'],close.focused];",
  "toggleScheduleStack(close);return {opened,closed:[classes.on,history.inert,peek.inert,attrs['peek:aria-expanded'],peek.focused]};",
  "})()"
 ].join('');
 const result=vm.runInContext(code,p.context);
 assert.deepEqual(Array.from(result.opened),[true,false,true,'true',1]);
 assert.deepEqual(Array.from(result.closed),[false,true,false,'false',1]);
});

test('a long past title is still a bounded rear card and a full, usable card when expanded', () => {
 const p=preview();
 vm.runInContext("state.events[1].name='아주 길게 작성한 지난 약속 제목도 잘 보이도록 확인하기';render()",p.context);
 const stack=cardStackMarkup(p.elements.screen.innerHTML);
 assert.match(stack,/data-stack-layer="event:e2"/);
 assert.match(stack,/아주 길게 작성한 지난 약속 제목/);
 assert.match(stack,/data-history-item="event:e2"/);
 const css=fs.readFileSync(path.join(assets,'draft.css'),'utf8');
 assert.match(css,/\.stack-layer \.schedule-card\{[^}]*max-height:62px/);
});

test('the original stacked-card reference is available from the preview', () => {
 const p=preview(),dialog=p.context.document.getElementById('ref-dialog');
 let opened=false;dialog.showModal=()=>{opened=true};
 click(p,'[data-ref]',{ref:'stack'});
 assert.equal(opened,true);
 assert.equal(p.elements['ref-image'].src,'assets/stack-reference.jpg');
 assert.ok(fs.existsSync(path.join(assets,'stack-reference.jpg')));
});

test('the preview time input changes the current front card through the actual control handler', () => {
 const p=preview(),input=p.elements['preview-time'];
 assert.equal(typeof input.onchange,'function');
 input.onchange({target:{value:'15:00'}});
 assert.match(cardStackMarkup(p.elements.screen.innerHTML),/data-stack-front="event:e5"/);
 assert.equal(p.elements['preview-clock'].textContent,'15:00');
});

test('ending the front item changes only its position, keeping its explicit missed state', () => {
 const p=preview();
 vm.runInContext("state.events[2].status='missed';setPreviewTime('11:29')",p.context);
 assert.match(cardStackMarkup(p.elements.screen.innerHTML),/data-stack-front="event:e3"/);
 vm.runInContext('advancePreviewClockBy(60000)',p.context);
 const stack=cardStackMarkup(p.elements.screen.innerHTML);
 assert.match(stack,/data-stack-layer="event:e3"/);
 assert.equal(vm.runInContext("state.events.find(e=>e.id==='e3').status",p.context),'missed');
});

test('the plus button opens an AI-first choice sheet without immediately creating anything', () => {
 const p=preview(),before=vm.runInContext('JSON.stringify(state.events)',p.context);
 click(p,'[data-nav]',{nav:'add'});
 assert.match(p.elements.sheet.innerHTML,/삐꾸에게 부탁하기/);
 assert.match(p.elements.sheet.innerHTML,/AI에게 말하면 일정과 계획을 만들어드려요/);
 assert.match(p.elements.sheet.innerHTML,/일정 추가/);
 assert.match(p.elements.sheet.innerHTML,/할 일 추가/);
 assert.match(p.elements.sheet.innerHTML,/루틴 추가/);
 assert.ok(p.elements.sheet.innerHTML.indexOf('삐꾸에게 부탁하기')<p.elements.sheet.innerHTML.indexOf('일정 추가'));
 assert.equal(vm.runInContext('JSON.stringify(state.events)',p.context),before);
});

test('manual add choices keep separate event, to-do and routine forms', () => {
 const p=preview();
 action(p,'create-event');assert.match(p.elements.sheet.innerHTML,/일정 이름/);assert.match(p.elements.sheet.innerHTML,/AI로 작성하기/);
 assert.match(p.elements.sheet.innerHTML,/value="appointment" selected/);
 action(p,'create-task');assert.match(p.elements.sheet.innerHTML,/value="task" selected/);
 action(p,'create-routine');assert.match(p.elements.sheet.innerHTML,/새 루틴 만들기/);
});

test('new-schedule AI opens the existing assistant without an unrelated selected-event context', () => {
 const p=preview();action(p,'event-ask-ai',{index:'1'});
 click(p,'[data-nav]',{nav:'add'});action(p,'create-ai');
 assert.equal(vm.runInContext('state.screen',p.context),'chat');
 assert.equal(vm.runInContext('state.aiContext',p.context),null);
 assert.match(p.elements.screen.innerHTML,/새로운 일정|새 일정/);
 assert.doesNotMatch(p.elements.screen.innerHTML,/선택한 일정/);
 assert.match(p.elements.screen.innerHTML,/실제 AI|연결되지/);
});

test('a spoken meeting request asks missing duration and only saves after approval', () => {
 const p=preview(),before=vm.runInContext('state.events.length',p.context);
 action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'내일 오후 3시에 회의 잡아줘.'}}});
 assert.match(p.elements.screen.innerHTML,/얼마나|소요시간/);
 assert.equal(vm.runInContext('state.events.length',p.context),before);
 submit(p,{id:'chat-form',elements:{message:{value:'30분'}}});
 assert.match(p.elements.screen.innerHTML,/회의/);
 assert.match(p.elements.screen.innerHTML,/4월 18일/);
 assert.match(p.elements.screen.innerHTML,/오후 3:00/);
 assert.match(p.elements.screen.innerHTML,/수락/);
 assert.equal(vm.runInContext('state.events.length',p.context),before);
 action(p,'create-accept');
 assert.equal(vm.runInContext('state.events.length',p.context),before+1);
 assert.equal(vm.runInContext('state.events.at(-1).date',p.context),'2025-04-18');
 assert.match(vm.runInContext('state.events.at(-1).time',p.context),/오후 3:00/);
 assert.equal(vm.runInContext('state.events.at(-1).involvement',p.context),'shared');
 const reloaded=preview(p.storage);
 assert.ok(vm.runInContext("state.events.some(e=>e.name==='회의'&&e.date==='2025-04-18')",reloaded.context));
});

test('a daily routine request checks conflicts and needs explicit acceptance', () => {
 const p=preview(),before=vm.runInContext('state.routines.length',p.context);
 action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'매일 아침 8시에 운동하는 루틴 등록해줘.'}}});
 submit(p,{id:'chat-form',elements:{message:{value:'30분'}}});
 assert.match(p.elements.screen.innerHTML,/겹치|충돌/);
 assert.equal(vm.runInContext('state.routines.length',p.context),before);
 submit(p,{id:'chat-form',elements:{message:{value:'오전 8시 30분'}}});
 assert.match(p.elements.screen.innerHTML,/매일/);
 assert.equal(vm.runInContext('state.routines.length',p.context),before);
 action(p,'create-accept');
 assert.equal(vm.runInContext('state.routines.length',p.context),before+1);
 assert.equal(vm.runInContext("state.routines.at(-1).start",p.context),'08:30');
 assert.equal(vm.runInContext("state.routines.at(-1).days.length",p.context),7);
 const reloaded=preview(p.storage);
 assert.ok(vm.runInContext("state.routines.some(r=>r.name==='운동'&&r.start==='08:30')",reloaded.context));
});

test('an unclear to-do request asks for a title rather than inventing tasks', () => {
 const p=preview(),before=vm.runInContext('state.events.length',p.context);
 action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'오늘 할 일 정리해줘.'}}});
 assert.match(p.elements.screen.innerHTML,/이름|무엇/);
 assert.equal(vm.runInContext('state.events.length',p.context),before);
});

test('a new conflicting appointment invalidates an unaccepted AI creation proposal', () => {
 const p=preview();
 action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'내일 오후 3시에 회의 잡아줘. 30분'}}});
 const before=vm.runInContext('state.events.length',p.context);
 vm.runInContext("state.events.push({id:'new-conflict',name:'약속',date:'2025-04-18',time:'오후 3:00 - 3:30',type:'appointment',involvement:'personal',color:'#888'})",p.context);
 action(p,'create-accept');
 assert.equal(vm.runInContext('state.events.length',p.context),before+1);
 assert.match(p.elements.screen.innerHTML,/겹치|충돌/);
});

test('AI suggestions for a partly filled form require a choice before replacing entered values', () => {
 const p=preview();
 action(p,'create-task');
 const form=p.elements.sheet.querySelector('#add-form');
 form.elements={name:{value:'친구 선물'},time:{value:'오후 2:00'},date:{value:'2025-04-17'},eventType:{value:'task'},involvement:{value:'personal'}};
 action(p,'create-form-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'내일 오후 3시에 회의 잡아줘. 30분'}}});
 assert.equal(vm.runInContext("state.formDrafts.task.name",p.context),'친구 선물');
 action(p,'create-apply');
 assert.match(p.elements.sheet.innerHTML,/기존 값|입력한 내용/);
 assert.match(p.elements.sheet.innerHTML,/제안/);
 action(p,'create-keep');
 assert.match(p.elements.sheet.innerHTML,/value="친구 선물"/);
 assert.match(p.elements.sheet.innerHTML,/value="오후 2:00"/);
 assert.equal(vm.runInContext("state.events.some(e=>e.name==='친구 선물')",p.context),false);
});

test('existing completion records and a saved manual item survive a refresh', () => {
 const p=preview();
 action(p,'toggle-event',{index:'2'});
 action(p,'create-task');
 submit(p,{id:'add-form',elements:{name:{value:'빨래하기'},time:{value:'오후 5:00'},date:{value:'2025-04-17'},eventType:{value:'task'},involvement:{value:'personal'}}});
 const reloaded=preview(p.storage);
 assert.equal(vm.runInContext("state.events.find(e=>e.id==='e3').status",reloaded.context),'done');
 assert.ok(vm.runInContext("state.events.some(e=>e.name==='빨래하기')",reloaded.context));
});

test('choosing a new example does not carry an earlier meeting name or time into a to-do', () => {
 const p=preview();action(p,'create-ai');
 action(p,'create-question',{question:'meeting'});
 assert.match(p.elements.screen.innerHTML,/얼마나/);
 action(p,'create-question',{question:'todo'});
 assert.equal(vm.runInContext('state.aiCreate.slots.name',p.context),'');
 assert.equal(vm.runInContext('state.aiCreate.slots.time',p.context),'');
 assert.match(p.elements.screen.innerHTML,/이름|무엇/);
 assert.equal(vm.runInContext('state.aiCreate.proposal',p.context),null);
});

test('a flexible this-week request respects a later instruction to choose tomorrow', () => {
 const p=preview();action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'이번 주 남는 시간에 운동 일정 만들어줘.'}}});
 submit(p,{id:'chat-form',elements:{message:{value:'30분'}}});
 assert.ok(vm.runInContext('!!state.aiCreate.proposal',p.context));
 submit(p,{id:'chat-form',elements:{message:{value:'내일'}}});
 assert.equal(vm.runInContext('state.aiCreate.proposal.date',p.context),'2025-04-18');
});

test('a partially typed manual draft survives refresh without becoming a scheduled event', () => {
 const p=preview();action(p,'create-task');
 const form={id:'add-form',dataset:{draftKind:'task'},elements:{name:{value:'치과 예약'},time:{value:''},date:{value:'2025-04-18'},eventType:{value:'task'},involvement:{value:'personal'}}};
 p.listeners.input({target:{form}});
 assert.equal(vm.runInContext("state.events.some(e=>e.name==='치과 예약')",p.context),false);
 const reloaded=preview(p.storage);
 action(reloaded,'create-task');
 assert.match(reloaded.elements.sheet.innerHTML,/value="치과 예약"/);
 assert.match(reloaded.elements.sheet.innerHTML,/value="2025-04-18"/);
 assert.equal(vm.runInContext("state.events.some(e=>e.name==='치과 예약')",reloaded.context),false);
});

test('an invalid stored preview is left untouched and does not crash the sample', () => {
 const raw='{"version":1,"events":[null],"routines":[]}';
 const storage=new Map([['pikku-image-reference-preview-v1',raw]]);
 let p;assert.doesNotThrow(()=>{p=preview(storage)});
 assert.match(p.elements['preview-persistence'].textContent,/읽지 못|저장/);
 assert.equal(storage.get('pikku-image-reference-preview-v1'),raw);
 assert.match(p.elements.screen.innerHTML,/좋은 아침/);
});

test('a storage failure does not claim a newly accepted example was saved persistently', () => {
 const blocked={has(){return false},get(){return null},set(){throw Error('blocked')}};
 const p=preview(blocked);
 action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'내일 오후 3시에 회의 잡아줘. 30분'}}});
 action(p,'create-accept');
 assert.match(p.elements['preview-persistence'].textContent,/저장하지 못|사라질/);
 assert.match(p.elements.screen.innerHTML,/현재 화면|저장하지 못/);
});

test('form proposal replacement is possible only after the explicit choice and remains an unsaved draft', () => {
 const p=preview();action(p,'create-task');
 const form=p.elements.sheet.querySelector('#add-form');
 form.elements={name:{value:'기존 제목'},time:{value:'오후 2:00'},date:{value:'2025-04-17'},eventType:{value:'task'},involvement:{value:'personal'}};
 action(p,'create-form-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'내일 오후 3시에 회의 잡아줘. 30분'}}});
 action(p,'create-apply');
 assert.equal(vm.runInContext("state.formDrafts.task.name",p.context),'기존 제목');
 action(p,'create-replace');
 assert.match(p.elements.sheet.innerHTML,/value="회의"/);
 assert.match(p.elements.sheet.innerHTML,/value="2025-04-18"/);
 assert.equal(vm.runInContext("state.events.some(e=>e.name==='회의')",p.context),false);
 const reloaded=preview(p.storage);action(reloaded,'create-task');
 assert.match(reloaded.elements.sheet.innerHTML,/value="회의"/);
});

test('a created routine does not retroactively appear on dates before it was registered', () => {
 const p=preview();
 vm.runInContext("state.routines=[];render()",p.context);
 action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'매일 아침 8시에 운동하는 루틴 등록해줘. 30분'}}});
 action(p,'create-accept');
 assert.equal(vm.runInContext("calendarEventsFor('2025-04-16').some(e=>e.name.includes('운동'))",p.context),false);
 assert.equal(vm.runInContext("calendarEventsFor('2025-04-18').some(e=>e.name.includes('운동'))",p.context),true);
});

test('a title-only manual form can request a free time and receive a noncommitted draft', () => {
 const p=preview();action(p,'create-task');
 const form=p.elements.sheet.querySelector('#add-form');
 form.elements={name:{value:'집 청소'},time:{value:''},date:{value:'2025-04-17'},eventType:{value:'task'},involvement:{value:'personal'}};
 action(p,'create-form-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'오늘 남는 시간에 30분으로 추천해줘.'}}});
 assert.ok(vm.runInContext('!!state.aiCreate.proposal',p.context));
 assert.match(p.elements.screen.innerHTML,/집 청소/);
 const before=vm.runInContext('state.events.length',p.context);
 action(p,'create-apply');
 assert.match(p.elements.sheet.innerHTML,/value="집 청소"/);
 assert.match(p.elements.sheet.innerHTML,/value="오전 11:30/);
 assert.equal(vm.runInContext('state.events.length',p.context),before);
});

test('a new typed request resets prior incomplete request fields rather than inventing a task', () => {
 const p=preview();action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'내일 오후 3시에 회의 잡아줘.'}}});
 submit(p,{id:'chat-form',elements:{message:{value:'오늘 할 일 정리해줘.'}}});
 assert.equal(vm.runInContext('state.aiCreate.slots.name',p.context),'');
 assert.equal(vm.runInContext('state.aiCreate.slots.time',p.context),'');
 assert.equal(vm.runInContext('state.aiCreate.proposal',p.context),null);
 assert.match(p.elements.screen.innerHTML,/일정 이름|어떤 일/);
});

test('a user-provided title reply is preserved verbatim rather than shortened by keywords', () => {
 const p=preview();action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'오늘 할 일 정리해줘.'}}});
 submit(p,{id:'chat-form',elements:{message:{value:'운동 가방 챙기기'}}});
 assert.equal(vm.runInContext('state.aiCreate.slots.name',p.context),'운동 가방 챙기기');
 assert.equal(vm.runInContext('state.aiCreate.slots.type',p.context),'task');
});

test('a routine proposal that becomes stale overnight cannot silently start in the past', () => {
 const p=preview();vm.runInContext('state.routines=[];render()',p.context);
 action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'매일 아침 8시에 운동하는 루틴 등록해줘. 30분'}}});
 assert.ok(vm.runInContext('!!state.aiCreate.proposal',p.context));
 const before=vm.runInContext('state.routines.length',p.context);
 vm.runInContext('advancePreviewClockBy(2*24*60*60*1000)',p.context);
 action(p,'create-accept');
 assert.equal(vm.runInContext('state.routines.length',p.context),before);
 assert.match(p.elements.screen.innerHTML,/다시 확인|지났/);
});

test('a rejected new-event proposal does not create a record, including after refresh', () => {
 const p=preview(),before=vm.runInContext('state.events.length',p.context);
 action(p,'create-ai');submit(p,{id:'chat-form',elements:{message:{value:'내일 오후 3시에 회의 잡아줘. 30분'}}});
 action(p,'create-reject');
 assert.equal(vm.runInContext('state.events.length',p.context),before);
 const reloaded=preview(p.storage);
 assert.equal(vm.runInContext('state.events.length',reloaded.context),before);
});

test('the this-week exercise request proposes an available slot inside that week without saving first', () => {
 const p=preview(),before=vm.runInContext('state.events.length',p.context);
 action(p,'create-ai');action(p,'create-question',{question:'exercise'});
 submit(p,{id:'chat-form',elements:{message:{value:'30분'}}});
 const proposal=vm.runInContext('state.aiCreate.proposal',p.context);
 assert.ok(proposal);
 assert.ok(proposal.date>='2025-04-17'&&proposal.date<='2025-04-20');
 assert.equal(vm.runInContext('state.events.length',p.context),before);
 assert.equal(vm.runInContext('creationConflict(state.aiCreate.proposal)',p.context),'');
});

test('leaving new-item creation for an existing event replaces the context without saving the proposal', () => {
 const p=preview(),before=vm.runInContext('state.events.length',p.context);
 action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'내일 오후 3시에 회의 잡아줘. 30분'}}});
 assert.ok(vm.runInContext('!!state.aiCreate.proposal',p.context));
 action(p,'event-ask-ai',{index:'1'});
 assert.equal(vm.runInContext('state.aiCreate',p.context),null);
 assert.equal(vm.runInContext('state.aiContext.id',p.context),'e2');
 assert.equal(vm.runInContext('state.events.length',p.context),before);
});

test('routine completion and confirmed deletion survive refresh without recycling IDs', () => {
 const p=preview(),row={id:'r3',origin:'2025-04-17',kind:'regular'};
 action(p,'routine-check',row);
 action(p,'event-delete',{index:'3'});action(p,'event-delete-confirm',{index:'3'});
 const reloaded=preview(p.storage);
 assert.equal(vm.runInContext("state.routines.find(r=>r.id==='r3').records['2025-04-17']",reloaded.context),'done');
 assert.equal(vm.runInContext("state.events.some(e=>e.id==='e4')",reloaded.context),false);
 action(reloaded,'create-task');
 submit(reloaded,{id:'add-form',dataset:{draftKind:'task'},elements:{name:{value:'새 할 일'},time:{value:'오후 5:00'},date:{value:'2025-04-17'},eventType:{value:'task'},involvement:{value:'personal'}}});
 assert.equal(vm.runInContext("new Set(state.events.map(e=>e.id)).size===state.events.length",reloaded.context),true);
});

test('returning from form assistance keeps entered values without saving an event', () => {
 const p=preview();action(p,'create-event');
 const form=p.elements.sheet.querySelector('#add-form');
 form.elements={name:{value:'병원 예약'},time:{value:''},date:{value:'2025-04-18'},eventType:{value:'appointment'},involvement:{value:'personal'}};
 action(p,'create-form-ai');action(p,'create-back');
 assert.match(p.elements.sheet.innerHTML,/value="병원 예약"/);
 assert.match(p.elements.sheet.innerHTML,/value="2025-04-18"/);
 assert.equal(vm.runInContext("state.events.some(e=>e.name==='병원 예약')",p.context),false);
});

test('the recommended question chips use the same approval flow as typing', () => {
 const p=preview(),before=vm.runInContext('state.events.length',p.context);
 action(p,'create-ai');action(p,'create-question',{question:'meeting'});
 submit(p,{id:'chat-form',elements:{message:{value:'30분'}}});
 assert.ok(vm.runInContext('!!state.aiCreate.proposal',p.context));
 assert.equal(vm.runInContext('state.events.length',p.context),before);
 action(p,'create-accept');
 assert.equal(vm.runInContext('state.events.length',p.context),before+1);
});

test('an unapproved creation conversation survives refresh without saving the proposed event', () => {
 const p=preview(),before=vm.runInContext('state.events.length',p.context);
 action(p,'create-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'내일 오후 3시에 회의 잡아줘. 30분'}}});
 const reloaded=preview(p.storage);
 assert.equal(vm.runInContext('state.screen',reloaded.context),'chat');
 assert.ok(vm.runInContext('!!state.aiCreate.proposal',reloaded.context));
 assert.equal(vm.runInContext('state.events.length',reloaded.context),before);
 assert.match(reloaded.elements.screen.innerHTML,/수락/);
 action(reloaded,'create-accept');
 assert.equal(vm.runInContext('state.events.length',reloaded.context),before+1);
});

test('an existing-event assistant context and unapproved suggestion survive refresh without changing the item', () => {
 const p=preview(),before=vm.runInContext('JSON.stringify(state.events[3])',p.context);
 action(p,'event-ask-ai',{index:'3'});action(p,'ai-question',{question:'move'});
 const reloaded=preview(p.storage);
 assert.equal(vm.runInContext('state.screen',reloaded.context),'chat');
 assert.equal(vm.runInContext('state.aiContext.id',reloaded.context),'e4');
 assert.ok(vm.runInContext('!!state.aiProposal',reloaded.context));
 assert.equal(vm.runInContext('JSON.stringify(state.events[3])',reloaded.context),before);
});

test('a new routine form can ask AI while preserving its typed name, weekdays and time', () => {
 const p=preview(),before=vm.runInContext('state.routines.length',p.context);
 action(p,'create-routine');
 assert.match(p.elements.sheet.innerHTML,/AI로 작성하기/);
 const form=p.elements.sheet.querySelector('#routine-form');
 form.dataset={id:''};
 form.elements={name:{value:'나의 요가'},start:{value:'07:30'},duration:{value:'30'},goal:{value:'건강'}};
 form.querySelectorAll=()=>[1,2,3,4,5].map(value=>({value:String(value)}));
 action(p,'create-routine-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'매일 아침 8시 30분에 운동하는 루틴 등록해줘.'}}});
 assert.ok(vm.runInContext('!!state.aiCreate.proposal',p.context));
 assert.equal(vm.runInContext('state.routines.length',p.context),before);
 action(p,'create-apply');
 assert.match(p.elements.sheet.innerHTML,/기존 값 유지/);
 action(p,'create-keep');
 assert.match(p.elements.sheet.innerHTML,/value="나의 요가"/);
 assert.match(p.elements.sheet.innerHTML,/value="07:30"/);
 assert.equal(vm.runInContext("state.formDrafts.routine.days.join(',')",p.context),'1,2,3,4,5');
 assert.equal(vm.runInContext('state.routines.length',p.context),before);
 const reloaded=preview(p.storage);action(reloaded,'create-routine');
 assert.match(reloaded.elements.sheet.innerHTML,/value="나의 요가"/);
});

test('AI routine suggestions change the direct-input draft only after explicit replacement', () => {
 const p=preview();action(p,'create-routine');
 const form=p.elements.sheet.querySelector('#routine-form');
 form.dataset={id:''};
 form.elements={name:{value:'기존 루틴'},start:{value:'07:30'},duration:{value:'30'},goal:{value:'건강'}};
 form.querySelectorAll=()=>[1,2,3,4,5].map(value=>({value:String(value)}));
 action(p,'create-routine-ai');
 submit(p,{id:'chat-form',elements:{message:{value:'매일 아침 8시 30분에 운동하는 루틴 등록해줘.'}}});
 action(p,'create-apply');
 assert.equal(vm.runInContext('state.formDrafts.routine.name',p.context),'기존 루틴');
 action(p,'create-replace');
 assert.match(p.elements.sheet.innerHTML,/value="운동"/);
 assert.match(p.elements.sheet.innerHTML,/value="08:30"/);
 assert.equal(vm.runInContext("state.routines.some(r=>r.name==='운동')",p.context),false);
});

test('a typed routine form draft survives refresh and is cleared only after registration', () => {
 const p=preview();action(p,'create-routine');
 const form={id:'routine-form',dataset:{id:''},elements:{name:{value:'매일 명상'},start:{value:'07:15'},duration:{value:'15'},goal:{value:'집중'}},querySelectorAll(){return [1,3,5].map(value=>({value:String(value)}))}};
 p.listeners.input({target:{form}});
 assert.equal(vm.runInContext("state.routines.some(r=>r.name==='매일 명상')",p.context),false);
 const reloaded=preview(p.storage);action(reloaded,'create-routine');
 assert.match(reloaded.elements.sheet.innerHTML,/value="매일 명상"/);
 submit(reloaded,form);
 assert.equal(vm.runInContext("state.routines.some(r=>r.name==='매일 명상')",reloaded.context),true);
 assert.equal(vm.runInContext('state.formDrafts.routine',reloaded.context),undefined);
 const again=preview(p.storage);
 assert.ok(vm.runInContext("state.routines.some(r=>r.name==='매일 명상')",again.context));
});

test('returning from routine AI assistance keeps its original draft without registering it', () => {
 const p=preview();action(p,'create-routine');
 const form=p.elements.sheet.querySelector('#routine-form');form.dataset={id:''};
 form.elements={name:{value:'점심 산책'},start:{value:'12:00'},duration:{value:'20'},goal:{value:'휴식'}};
 form.querySelectorAll=()=>[1,2,3,4,5].map(value=>({value:String(value)}));
 action(p,'create-routine-ai');action(p,'create-back');
 assert.match(p.elements.sheet.innerHTML,/value="점심 산책"/);
 assert.match(p.elements.sheet.innerHTML,/value="12:00"/);
 assert.equal(vm.runInContext("state.routines.some(r=>r.name==='점심 산책')",p.context),false);
});

test('daily timeline displays exact start and end on the axis without repeating time in the event card', () => {
 const p=preview();
 click(p,'[data-nav]',{nav:'calendar'});click(p,'[data-date],[data-day]',{date:'2025-04-17'});
 const row=vm.runInContext("scheduleCardFor(calendarEventsFor('2025-04-17').find(e=>e.id==='e4'),'day')",p.context);
 assert.match(row,/data-time-start[^>]*>13:00</);
 assert.match(row,/data-time-end[^>]*>14:00</);
 assert.doesNotMatch(row,/class="task-time"/);
 assert.match(row,/프로젝트 기획 점검/);
 assert.match(row,/data-action="toggle-event"/);
 assert.match(row,/data-action="event-menu"/);
 const home=vm.runInContext("eventCard(state.events[3],3,'home')",p.context);
 assert.match(home,/오후 1:00 - 2:00/);
});

test('daily timeline never invents an end time for a start-only event', () => {
 const p=preview();
 vm.runInContext("state.events.push({id:'unknown',name:'시간 미정',time:'오후 3:00',date:'2025-04-17',deadline:'2025-04-17T17:00',type:'task',status:'pending',color:'#7894ff'})",p.context);
 const row=vm.runInContext("scheduleCardFor(calendarEventsFor('2025-04-17').find(e=>e.id==='unknown'),'day')",p.context);
 assert.match(row,/data-time-start[^>]*>15:00</);
 assert.match(row,/data-time-end[^>]*>종료 미정</);
 assert.doesNotMatch(row,/>15:30</);
 assert.doesNotMatch(row,/>17:00</);
});

test('all simultaneously active day events are highlighted and visibly marked as overlapping without changing records', () => {
 const p=preview();
 vm.runInContext("state.routines=[];state.events=[{id:'a',name:'회의',date:'2025-04-17',time:'오전 10:30 - 11:30',type:'appointment',attendance:'unknown',color:'#7894ff'},{id:'b',name:'작업',date:'2025-04-17',time:'오전 11:00 - 12:00',type:'task',status:'pending',color:'#ad67f2'},{id:'c',name:'다음 일정',date:'2025-04-17',time:'오후 1:00 - 2:00',type:'task',status:'pending',color:'#7894ff'}];state.selectedDate=R.parseDate('2025-04-17');state.screen='day';render()",p.context);
 const html=p.elements.screen.innerHTML;
 assert.equal((html.match(/timeline-card schedule-card is-current/g)||[]).length,2);
 assert.equal((html.match(/class="timeline-overlap"/g)||[]).length,2);assert.equal((html.match(/timeline-row has-overlap/g)||[]).length,2);
 assert.match(html,/진행 중/);
 assert.equal(vm.runInContext("state.events[1].status",p.context),'pending');
});

test('a completed event within its time range keeps completion distinct from the current time indication', () => {
 const p=preview();vm.runInContext("state.events[2].status='done';state.screen='day';render()",p.context);
 const card=vm.runInContext("itemCard(calendarEventsFor('2025-04-17').find(e=>e.id==='e3'),'day')",p.context);
 assert.match(card,/is-current/);
 assert.match(card,/is-recorded/);
 assert.match(card,/진행 중/);
 assert.match(card,/완료됨/);
 assert.doesNotMatch(card,/task-time/);
});

test('timeline spacing reflects a free interval while remaining compact and overlaps stay marked', () => {
 const p=preview();const result=vm.runInContext("(()=>{const items=[{id:'a',date:'2025-04-17',time:'오전 9:00 - 10:00'},{id:'b',date:'2025-04-17',time:'오전 9:30 - 10:30'},{id:'c',date:'2025-04-17',time:'오전 11:00 - 11:30'},{id:'d',date:'2025-04-17',time:'오후 3:00 - 4:00'}];const map=timelineLayout(items);return items.map(e=>map.get(e));})()",p.context);
 assert.equal(result[0].overlap,true);assert.equal(result[1].overlap,true);
 assert.equal(result[2].overlap,false);assert.ok(result[3].gap>result[2].gap);
 assert.ok(result[3].gap<=32);
});

test('an overnight event is visible on the next day with unambiguous previous-day start and actual end', () => {
 const p=preview();vm.runInContext("state.routines=[];state.events=[{id:'night',name:'야간 작업',date:'2025-04-17',time:'오후 11:30 - 오전 1:00',type:'task',status:'pending',color:'#7894ff'}];state.selectedDate=R.parseDate('2025-04-18');state.screen='day';render()",p.context);
 const html=p.elements.screen.innerHTML;
 assert.match(html,/야간 작업/);
 assert.match(html,/data-time-start[^>]*>전날 23:30</);
 assert.match(html,/data-time-end[^>]*>01:00</);
});

test('previous and next date arrows move by one day across month boundaries', () => {
 const p=preview();vm.runInContext("state.selectedDate=R.parseDate('2025-05-01');state.screen='day';render()",p.context);
 action(p,'prev-day');assert.equal(vm.runInContext('R.dateKey(state.selectedDate)',p.context),'2025-04-30');
 action(p,'next-day');assert.equal(vm.runInContext('R.dateKey(state.selectedDate)',p.context),'2025-05-01');
 assert.match(p.elements.screen.innerHTML,/월간 보기/);
});

test('expanded daily stack exposes each past item with its own accurate start and end and keeps menu actions', () => {
 const p=preview();vm.runInContext("state.screen='day';render()",p.context);
 action(p,'stack-toggle',{scope:'day',date:'2025-04-17'});
 const html=p.elements.screen.innerHTML;
 const old=html.slice(html.indexOf('data-history-item="event:e2"'),html.indexOf('data-history-item="routine:'));
 assert.match(old,/data-time-start[^>]*>09:30</);
 assert.match(old,/data-time-end[^>]*>10:30</);
 assert.match(old,/data-action="event-menu"/);
 assert.match(old,/data-action="event-attendance-open"/);
 assert.doesNotMatch(old,/class="task-time"/);
});

test('a daily card can ask PIKKU to move an event 30 minutes later only after approval', () => {
 const p=preview();vm.runInContext("state.screen='day';render()",p.context);
 action(p,'event-menu',{index:'3'});assert.match(p.elements.sheet.innerHTML,/삐꾸에게 부탁하기/);
 action(p,'event-ask-ai',{index:'3'});
 assert.equal(vm.runInContext("state.aiContext.id",p.context),'e4');
 submit(p,{id:'chat-form',elements:{message:{value:'이 일정 30분 늦춰줘.'}}});
 assert.equal(vm.runInContext("state.aiProposal?.time",p.context),'13:30');
 assert.equal(vm.runInContext("state.events[3].time",p.context),'오후 1:00 - 2:00');
 action(p,'ai-accept');
 assert.match(vm.runInContext("state.events[3].time",p.context),/오후 1:30/);
});

test('a request for preparation time suggests a free slot without moving or adding a meeting', () => {
 const p=preview();vm.runInContext("state.screen='day';render()",p.context);
 action(p,'event-menu',{index:'6'});action(p,'event-ask-ai',{index:'6'});
 const before=vm.runInContext('JSON.stringify(state.events)',p.context);
 submit(p,{id:'chat-form',elements:{message:{value:'다음 회의 준비할 시간 추천해줘.'}}});
 assert.match(p.elements.screen.innerHTML,/오전 9:45/);
 assert.match(p.elements.screen.innerHTML,/일정은 추가하지 않았어요/);
 assert.equal(vm.runInContext('JSON.stringify(state.events)',p.context),before);
 assert.equal(vm.runInContext('state.aiProposal',p.context),null);
});

test('asking about overlap on an event with unknown duration does not invent a 30-minute interval', () => {
 const p=preview();vm.runInContext("state.events.push({id:'unknown-ai',name:'시간 미정',date:'2025-04-17',time:'오후 3:00',type:'task',status:'pending',color:'#7894ff'});state.screen='day';render()",p.context);
 action(p,'event-menu',{index:'9'});action(p,'event-ask-ai',{index:'9'});
 submit(p,{id:'chat-form',elements:{message:{value:'이 일정이 다른 일정이랑 겹치는지 확인해줘.'}}});
 assert.match(p.elements.screen.innerHTML,/시간을 확인할 수 없어/);
 assert.equal(vm.runInContext("state.events[9].time",p.context),'오후 3:00');
});

test('a relative shift that collides with another event keeps the original unchanged', () => {
 const p=preview();vm.runInContext("state.events.push({id:'busy',name:'겹치는 일정',date:'2025-04-17',time:'오후 2:00 - 2:30',type:'appointment',involvement:'personal',color:'#7894ff'});state.screen='day';render()",p.context);
 action(p,'event-menu',{index:'3'});action(p,'event-ask-ai',{index:'3'});
 submit(p,{id:'chat-form',elements:{message:{value:'이 일정 30분 늦춰줘.'}}});
 assert.equal(vm.runInContext('state.aiProposal',p.context),null);
 assert.match(p.elements.screen.innerHTML,/다른 예시 일정과 겹쳐요/);
 assert.equal(vm.runInContext("state.events[3].time",p.context),'오후 1:00 - 2:00');
});

test('a relative shift of a shared appointment keeps its original even after the example proposal is accepted', () => {
 const p=preview();vm.runInContext("state.events[3].type='appointment';state.events[3].involvement='shared';state.screen='day';render()",p.context);
 action(p,'event-menu',{index:'3'});action(p,'event-ask-ai',{index:'3'});
 submit(p,{id:'chat-form',elements:{message:{value:'이 일정 30분 늦춰줘.'}}});
 assert.equal(vm.runInContext("state.aiProposal?.time",p.context),'13:30');
 action(p,'ai-accept');
 assert.equal(vm.runInContext("state.events[3].time",p.context),'오후 1:00 - 2:00');
 assert.match(p.elements.sheet.innerHTML,/상대방/);
});

test('an overnight routine appears in the next day with its real occurrence record', () => {
 const p=preview();vm.runInContext("state.events=[];state.routines=[{id:'night',name:'야간 루틴',days:[4],start:'23:30',duration:90,records:{},recoveries:{}}];state.selectedDate=R.parseDate('2025-04-18');state.screen='day';render()",p.context);
 const html=p.elements.screen.innerHTML;
 assert.match(html,/야간 루틴/);
 assert.match(html,/data-time-start[^>]*>전날 23:30</);
 assert.match(html,/data-time-end[^>]*>01:00</);
 assert.match(html,/data-origin="2025-04-17"/);
});

test('an earlier event without an end remains in chronological position instead of being guessed into the past stack', () => {
 const p=preview();vm.runInContext("state.routines=[];state.events=[{id:'unknown',name:'종료 미정 일정',date:'2025-04-17',time:'오전 10:00',type:'task',status:'pending',color:'#7894ff'},{id:'current',name:'현재 작업',date:'2025-04-17',time:'오전 11:00 - 11:30',type:'task',status:'pending',color:'#7894ff'}];state.selectedDate=R.parseDate('2025-04-17');state.screen='day';render()",p.context);
 const html=p.elements.screen.innerHTML;
 assert.ok(html.indexOf('종료 미정 일정')<html.indexOf('현재 작업'));
 assert.match(html,/data-time-end[^>]*>종료 미정</);
 assert.equal(vm.runInContext("state.events[0].status",p.context),'pending');
});

test('the sample evening exercise and stretching routine are both current and visibly overlap', () => {
 const p=preview();vm.runInContext("previewNow.setHours(19,5,0,0);state.selectedDate=R.parseDate('2025-04-17');state.screen='day';render()",p.context);
 const html=p.elements.screen.innerHTML;
 const event=vm.runInContext("itemCard(dayEventsFor('2025-04-17').find(x=>x.id==='e5'),'day')",p.context);
 const routine=vm.runInContext("itemCard(dayEventsFor('2025-04-17').find(x=>x.row?.routine.id==='r4'),'day')",p.context);
 assert.match(event,/is-current/);assert.match(routine,/is-current/);
 assert.match(html,/저녁 운동/);assert.match(html,/저녁 스트레칭/);
 assert.ok((html.match(/class="timeline-overlap"/g)||[]).length>=2);
});

test('navigation and action icons use original local Streamline assets while the PIKKU character stays unchanged', () => {
 const p=preview();
 const mapped=vm.runInContext("['home','calendar','plus','routine','search','check','more','clock','send','spark'].map(svg)",p.context);
 for(const html of mapped){
  assert.match(html,/data-pikku-icon=/);
  assert.match(html,/assets\/streamline-core\/[a-z]+\.svg/);
  assert.doesNotMatch(html,/https?:/);
 }
 assert.match(vm.runInContext("svg('more')",p.context),/is-vertical/);
 assert.match(vm.runInContext("svg('buddy')",p.context),/<svg/);
 assert.doesNotMatch(vm.runInContext("svg('buddy')",p.context),/streamline-core/);
 for(const file of fs.readdirSync(path.join(assets,'streamline-core')).filter(f=>f.endsWith('.svg'))){
  const content=fs.readFileSync(path.join(assets,'streamline-core',file),'utf8');
  assert.match(content,/<svg[\s>]/);assert.ok(content.length>100,file);
 }
 assert.match(fs.readFileSync(path.join(assets,'streamline-core','ATTRIBUTION.md'),'utf8'),/CC BY 4\.0/);
});

test('requested gradients and high-contrast semantic colors are specified for the preview', () => {
 const css=fs.readFileSync(path.join(assets,'draft.css'),'utf8').toLowerCase();
 assert.match(css,/linear-gradient\(160deg,#e2e8ff 0%,#f2f4fc 100%\)/);
 assert.match(css,/linear-gradient\(145deg,#fdeae2 0%,#f1e6ed 37%,#e0e2fe 100%\)/);
 assert.match(css,/\.primary,\.ai-proposal-actions \.accept\{background:#5369ca;color:#fff\}/);
 assert.match(css,/\.card-state\.is-done \.card-state-visual\{background:#f0fbf5;border-color:#7edda9;color:#1e7649\}/);
 function lum(hex){const c=hex.match(/\w\w/g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]}
 function contrast(a,b){const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
 assert.ok(contrast('ffffff','5369ca')>=4.5);
 assert.ok(contrast('626b80','ffffff')>=4.5);
 assert.ok(contrast('5d677b','e2e8ff')>=4.5);
 assert.ok(contrast('1e7649','ffffff')>=4.5);
 assert.ok(contrast('465cb1','eef3ff')>=4.5);
 assert.ok(contrast('4058ad','dee5ff')>=4.5);
 assert.ok(contrast('626b80','e8edff')>=4.5);
 assert.ok(contrast('a54d3c','fff0eb')>=4.5);
 assert.ok(contrast('1e7649','e7f9ef')>=4.5);
});
