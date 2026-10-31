const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assets=path.resolve(__dirname,'../probes/assets');
test('a scoped chat confirmation does not display an old fixed comment as a new pending issue',async()=>{
 const els={};
 function element(){return {innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,scrollTop:0,classList:{add(){},toggle(){}},addEventListener(){},querySelector(){return element()},focus(){}}}
 const document={getElementById(id){return els[id] ||= element()},querySelectorAll(){return []},addEventListener(){},activeElement:{tagName:'BODY'}};
 const record={reaction:'fix',text:'프로필이 사라졌어요',resolution:{status:'resolved',scope:'첫 장면의 프로필과 홈 배치',source:'chat'}};
 const getDb=async()=>({doc(){return {async get(){return {exists:true,data:()=>record}}}}});
 const context=vm.createContext({document,window:{},Date,console,getDb,feedbackPath:'feedback/scene-'});
 for(const name of ['routine-model.js','shared-home.js','routine-ui.js','flow.js'])vm.runInContext(fs.readFileSync(path.join(assets,name),'utf8'),context,{filename:name});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(els['feedback-detail'].hidden,true);
 assert.equal(els.comment.value,'');
 assert.match(els['feedback-status'].textContent,/확인/);
});

test('the guided recommendation still uses the shared home and advances through approval scenes',async()=>{
 const els={},listeners={};
 function element(){return {innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,scrollTop:0,classList:{add(){},toggle(){}},addEventListener(){},querySelector(){return element()},focus(){}}}
 const document={getElementById(id){return els[id] ||= element()},querySelectorAll(){return []},addEventListener(k,fn){listeners[k]=fn},activeElement:{tagName:'BODY'}};
 const getDb=async()=>null;
 const context=vm.createContext({document,window:{},Date,console,getDb,feedbackPath:'feedback/scene-'});
 for(const name of ['routine-model.js','shared-home.js','routine-ui.js','flow.js'])vm.runInContext(fs.readFileSync(path.join(assets,name),'utf8'),context,{filename:name});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(els['flow-screen'].innerHTML,vm.runInContext('home()',context));
 function click(selector){listeners.click({target:{closest(query){return query===selector?{}:null}}})}
 click('[data-action="proposal"]');assert.equal(els['scene-title'].textContent,'이유를 살펴봐요');
 click('[data-forward]');assert.equal(els['scene-title'].textContent,'추가할 내용을 확인해요');
 click('[data-forward]');assert.equal(els['scene-title'].textContent,'추가 결과를 확인해요');
 click('[data-forward]');assert.equal(els['scene-title'].textContent,'일정에서 다시 살펴봐요');
});
