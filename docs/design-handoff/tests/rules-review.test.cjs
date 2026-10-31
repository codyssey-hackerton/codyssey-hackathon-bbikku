const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const src=fs.readFileSync(path.resolve(__dirname,'../probes/assets/rules-preview.js'),'utf8');
function setup(initial={},delayRead=false){
 const records=new Map(Object.entries(initial));
 const handlers={},nodes=new Map(),status={textContent:''};
 const iconNames=['home','calendar','spark','plus','routine','more','check','close','search','clock','send','profile','bell','settings','alert','wifi','help','trash'];
 const iconSet=Object.fromEntries(iconNames.map(n=>[n,'<span class="pikku-icon" aria-hidden="true"></span>']));
 for(let i=1;i<=11;i++){
  const section={dataset:{section:String(i)},text:{value:''},status:{textContent:''},clear:{hidden:true},chips:[]};
  section.chips=[{dataset:{ruleChip:'배경'},pressed:'false',getAttribute(){return this.pressed},setAttribute(k,v){this.pressed=v},closest(){return section}}];
  section.querySelector=(query)=>query==='textarea'?section.text:query==='[data-rule-clear]'?section.clear:section.status;
  section.querySelectorAll=(query)=>query.includes('aria-pressed="true"')?section.chips.filter(c=>c.pressed==='true'):section.chips;
  nodes.set(i,section);
 }
 const container={innerHTML:'',addEventListener(type,fn){handlers[type]=fn},querySelector(query){const id=Number(query.match(/\d+/)?.[0]);return nodes.get(id)}};
 const button={disabled:false,addEventListener(type,fn){handlers['accept']=fn}};
 const samples={innerHTML:''};
 const document={
  getElementById(id){return id==='rules-sections'?container:id==='accept-all'?button:id==='overall-status'?status:samples},
  querySelectorAll(){return []}
 };
 let resumeRead;
 const gate=delayRead?new Promise(resolve=>{resumeRead=resolve}):Promise.resolve();
 const db={collection(){return {async get(){await gate;return {docs:Array.from(records,([id,value])=>({id,data:()=>value}))}}}},doc(p){const key=p.split('/').pop();return {async get(){return {exists:records.has(key),data:()=>records.get(key)}},async set(value){records.set(key,value)}}}};
 const context=vm.createContext({document,window:{PikkuIcon:name=>iconSet[name]||''},getDb:async()=>db,console,Date});
 vm.runInContext(src,context);
 return {context,records,handlers,nodes,status,button,container,resumeRead};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('rules review renders eleven sections and all icon candidates',async()=>{
 const p=setup();await flush();
 assert.equal((p.container.innerHTML.match(/data-section="\d+"/g)||[]).length,11);
 assert.match(p.container.innerHTML,/일정 카드와 상태/);
 assert.match(p.container.innerHTML,/AI 캐릭터는 기존 모습을 유지/);
 assert.match(p.container.innerHTML,/기기 크기와 글자 확대/);
 assert.equal(vm.runInContext('iconNames.length',p.context),18);
 assert.equal((vm.runInContext("buttonSamples('sm')",p.context).match(/class="demo-button/g)||[]).length,20);
});
test('saving one section preserves other existing feedback and saves the selected reason',async()=>{
 const prior={unit:'sketch',text:'기존 사용자 의견'};
 const p=setup({'sketch-day':prior});await flush();
 const section=p.nodes.get(1);section.text.value='배경이 너무 진해요';
 const target={dataset:{ruleSave:'1'},disabled:false};
 await p.handlers.click({target:{closest(q){return q==='[data-rule-save]'?target:null}}});
 assert.equal(p.records.get('section-1').text,'배경이 너무 진해요');
 assert.equal(p.records.get('section-1').reaction,'fix');
 assert.equal(p.records.get('sketch-day'),prior);
 assert.equal(section.status.textContent,'저장했어요 ✓');
});
test('bulk acceptance preserves saved corrections and skips unsaved typed text',async()=>{
 const correction={unit:'section',reaction:'fix',marks:['배경'],text:'더 연하게',updatedAt:'old'};
 const p=setup({'section-1':correction,'sketch-day':{text:'원문 유지'}});await flush();
 p.nodes.get(2).text.value='제목 크기는 더 생각해볼게요';
 await p.handlers.accept({currentTarget:p.button});
 assert.equal(p.records.get('section-1'),correction);
 assert.equal(p.records.has('section-2'),false);
 assert.equal(p.records.get('section-3').reaction,'good');
 assert.equal(Array.from(p.records.keys()).filter(k=>k.startsWith('section-')).length,10);
 assert.match(p.status.textContent,/수정 의견 2개/);
});
test('slow feedback restoration does not overwrite an active typed draft',async()=>{
 const p=setup({'section-1':{reaction:'fix',marks:[],text:'이전 의견'}},true);
 const section=p.nodes.get(1);section.text.value='지금 적고 있는 의견';
 p.handlers.input({target:{closest(){return section}}});
 p.resumeRead();await flush();
 assert.equal(section.text.value,'지금 적고 있는 의견');
});

test('clearing an old correction preserves its previous text and allows an explicit later acceptance',async()=>{
 const correction={unit:'section',reaction:'fix',marks:['배경'],text:'더 연하게',updatedAt:'old'};
 const p=setup({'section-1':correction});await flush();
 assert.equal(p.nodes.get(1).clear.hidden,false);
 const clear={dataset:{ruleClear:'1'},disabled:false,hidden:false};
 await p.handlers.click({target:{closest(q){return q==='[data-rule-clear]'?clear:null}}});
 assert.equal(p.records.get('section-1').reaction,'pending');
 assert.equal(p.records.get('section-1').previousFeedback.text,'더 연하게');
 await p.handlers.accept({currentTarget:p.button});
 assert.equal(p.records.get('section-1').reaction,'good');
 assert.equal(p.records.get('section-1').previousFeedback.text,'더 연하게');
});
