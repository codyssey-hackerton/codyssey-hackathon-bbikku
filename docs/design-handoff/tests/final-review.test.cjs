const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assets=path.resolve(__dirname,'../probes/assets');
function setup(initial={},delayRead=false){
 const records=new Map(Object.entries(initial)),handlers={},elements={};
 const element=()=>({innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,dataset:{},
  classList:{toggle(){},add(){},remove(){}},setAttribute(){},addEventListener(type,fn){this['on'+type]=fn},
  querySelector(){return element()},querySelectorAll(){return []}});
 const root=element();root.addEventListener=(type,fn)=>handlers[type]=fn;
 elements['screen-reviews']=root;elements['preview-go']=element();elements['preview-go-status']=element();
 elements['preview-go'].addEventListener=(type,fn)=>handlers.go=fn;
 const document={getElementById(id){return elements[id] ||= element()},querySelectorAll(){return []}};
 let resume;const gate=delayRead?new Promise(resolve=>resume=resolve):Promise.resolve();
 const db={collection(){return {async get(){await gate;return {docs:Array.from(records,([id,value])=>({id,data:()=>value}))}}}},
  doc(p){const key=p.split('/').pop();return {async get(){return {exists:records.has(key),data:()=>records.get(key)}},async set(value){records.set(key,value)}}}};
 const context=vm.createContext({document,window:{},getDb:async()=>db,Date,console});
 for(const name of ['routine-model.js','pikku-icons.js','shared-home.js','routine-ui.js','event-ui.js','calendar-ui.js','ai-context.js','creation-ui.js','final-preview.js'])
  vm.runInContext(fs.readFileSync(path.join(assets,name),'utf8'),context,{filename:name});
 return {context,records,handlers,elements,resume};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('screen review renders all ten requested screens and marks the unbuilt contact flow as pending',async()=>{
 const p=setup();await flush();
 const html=p.elements['screen-reviews'].innerHTML;
 assert.equal((html.match(/class="screen-review" data-screen=/g)||[]).length,10);
 for(const name of ['홈','월간 캘린더','일간 캘린더','AI 비서','일정 추가','루틴','추천 확인','공동 일정 연락 승인','추천 승인 확인','일정 추가 결과'])assert.ok(html.includes(name),name);
 assert.match(html,/연락 승인 화면은 미정/);
 assert.match(html,/데일리 미팅 준비/);
 assert.match(html,/AI로 작성하기/);
 assert.match(html,/data-pikku-icon="home"/);
 assert.equal(p.elements['preview-go'].disabled,true);
});

test('Figma handoff stays disabled while a screen is not yet designed even if every available screen is approved',async()=>{
 const p=setup();await flush();
 vm.runInContext("reviews.filter(item=>!item.pending).forEach(item=>reviewSaved.set(item.slug,{reaction:'ok'}));updatePreviewGo()",p.context);
 assert.equal(p.elements['preview-go'].disabled,true);
 assert.match(p.elements['preview-go-status'].textContent,/연락 승인 화면은 아직 준비 중/);
 await p.handlers.go({currentTarget:p.elements['preview-go']});
 assert.equal(p.records.has('preview-go'),false);
});

test('a correction cannot be accepted as okay while its text or remove choice is still present',async()=>{
 const p=setup();await flush();
 const section={dataset:{screen:'home'},editor:{hidden:false,text:{value:'카드 간격을 바꾸고 싶어요'}},status:{textContent:''}};
 section.querySelector=q=>q==='.review-editor textarea'?section.editor.text:q==='.review-editor'?section.editor:section.status;
 section.querySelectorAll=()=>[];
 p.elements['screen-reviews'].querySelector=()=>section;
 await vm.runInContext("storeReview('home','ok')",p.context);
 assert.equal(p.records.has('screen-home'),false);
 assert.match(section.status.textContent,/작성 중인 수정 의견/);
});

test('saved screen feedback does not overwrite a draft while loading',async()=>{
 const p=setup({'screen-home':{reaction:'fix',text:'이전 의견'}},true);
 const section={dataset:{screen:'home'},editor:{hidden:false,text:{value:'작성 중인 의견'}}};
 section.querySelector=q=>q==='.review-editor'?section.editor:section.editor.text;
 p.elements['screen-reviews'].querySelector=()=>section;
 vm.runInContext("reviewDirty.add('home')",p.context);
 p.resume();await flush();
 assert.equal(section.editor.text.value,'작성 중인 의견');
});
test('clearing a correction keeps its previous text and allows a subsequent explicit approval',async()=>{
 const prior={unit:'screen',reaction:'fix',text:'기존 의견',marks:[],remove:[],swap:{}};
 const p=setup({'screen-home':prior});await flush();
 const editor={hidden:false,text:{value:'기존 의견'},querySelector(){return this.text},querySelectorAll(){return []}};
 const section={dataset:{screen:'home'},editor,status:{textContent:''},classList:{remove(){},toggle(){},add(){}},querySelector(q){return q==='.review-editor'?editor:q==='.review-editor textarea'?editor.text:this.status},querySelectorAll(){return []}};
 p.elements['screen-reviews'].querySelector=()=>section;
 await vm.runInContext("clearReview('home')",p.context);
 assert.equal(p.records.get('screen-home').reaction,'pending');
 assert.equal(p.records.get('screen-home').previousFeedback.text,'기존 의견');
 await vm.runInContext("storeReview('home','ok')",p.context);
 assert.equal(p.records.get('screen-home').reaction,'ok');
 assert.equal(p.records.get('screen-home').previousFeedback.previousFeedback.text,'기존 의견');
});
test('an applied correction is confirmed explicitly without discarding the saved original',async()=>{
 const prior={unit:'screen',reaction:'fix',text:'완료 버튼을 줄여주세요',marks:[],remove:[],swap:{},updatedAt:'2026-10-31T18:20:00.344Z'};
 const p=setup({'screen-day':prior});await flush();
 const editor={hidden:false,text:{value:prior.text},querySelector(){return this.text},querySelectorAll(){return []}};
 const section={dataset:{screen:'day'},editor,status:{textContent:''},classList:{remove(){},toggle(){},add(){}},querySelector(q){return q==='.review-editor'?editor:q==='.review-editor textarea'?editor.text:this.status},querySelectorAll(){return []}};
 p.elements['screen-reviews'].querySelector=()=>section;
 vm.runInContext("restoreReview('day',reviewSaved.get('day'))",p.context);
 assert.match(section.status.textContent,/반영/);
 assert.equal(p.records.get('screen-day').reaction,'fix');
 await vm.runInContext("storeReview('day','ok')",p.context);
 assert.equal(p.records.get('screen-day').reaction,'ok');
 assert.equal(p.records.get('screen-day').text,'');
 assert.equal(p.records.get('screen-day').previousFeedback.text,prior.text);
});
test('a newer correction in another tab cannot be overwritten by accepting an older applied correction',async()=>{
 const prior={reaction:'fix',text:'완료 버튼을 줄여주세요',marks:[],remove:[],swap:{},updatedAt:'2026-10-31T18:20:00.344Z'};
 const p=setup({'screen-day':prior});await flush();
 const editor={hidden:false,text:{value:prior.text},querySelector(){return this.text},querySelectorAll(){return []}};
 const section={dataset:{screen:'day'},editor,status:{textContent:''},classList:{remove(){},toggle(){},add(){}},querySelector(q){return q==='.review-editor'?editor:q==='.review-editor textarea'?editor.text:this.status},querySelectorAll(){return []}};
 p.elements['screen-reviews'].querySelector=()=>section;
 const newer={...prior,text:'새로운 의견',updatedAt:'2026-11-01T00:00:00.000Z'};
 p.records.set('screen-day',newer);
 await vm.runInContext("storeReview('day','ok')",p.context);
 assert.equal(p.records.get('screen-day').text,'새로운 의견');
 assert.equal(p.records.get('screen-day').reaction,'fix');
 assert.match(section.status.textContent,/변경/);
});
test('state examples open a distinct preview and leave existing sample events unchanged',async()=>{
 const p=setup();await flush();
 const before=vm.runInContext('JSON.stringify(state.events)',p.context);
 const expanded=vm.runInContext("stateVisualFor(reviewMap.get('day'),1)",p.context);
 assert.match(expanded,/schedule-stack is-open/);
 const overlap=vm.runInContext("stateVisualFor(reviewMap.get('day'),2)",p.context);
 assert.match(overlap,/시간 겹침/);
 assert.equal(vm.runInContext('JSON.stringify(state.events)',p.context),before);
 const loading=vm.runInContext("stateVisualFor(reviewMap.get('home'),1)",p.context);
 assert.match(loading,/불러오는 중/);
 assert.match(loading,/상태 표현을 살펴보기 위한 예시/);
});
