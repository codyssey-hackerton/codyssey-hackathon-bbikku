const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assets=path.resolve(__dirname,'../probes/assets');
function board(saved=null){
 const els={},writes=[];
 const make=(data={})=>({innerHTML:'',textContent:'',value:'',hidden:true,dataset:data,attrs:{},events:{},
   addEventListener(type,fn){this.events[type]=fn},setAttribute(k,v){this.attrs[k]=v},
   querySelectorAll(){return []},focus(){},showModal(){this.opened=true},close(){this.opened=false}});
 const chips=['색감','카드와 간격','글자','하단 메뉴','달력과 루틴'].map(mark=>make({mark}));
 const originals=['1','4','3','2'].map(original=>make({original}));
 const document={getElementById(id){return els[id] ||= make()},querySelector(){return {dataset:{feedbackPath:'feedback/style-reference'}}},querySelectorAll(selector){return selector==='[data-mark]'?chips:selector==='[data-original]'?originals:[]}};
 const getDb=async()=>({doc(){return {async get(){return {exists:!!saved,data:()=>saved}},async set(value){writes.push(value)}}}});
 const context=vm.createContext({document,window:{},Date,console,getDb});
 for(const name of ['routine-model.js','pikku-icons.js','shared-home.js','routine-ui.js','style-review.js'])vm.runInContext(fs.readFileSync(path.join(assets,name),'utf8'),context,{filename:name});
 return {els,chips,originals,writes,context};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('style review displays the same home markup and saves agreement only on request',async()=>{
 const p=board();await settle();
 assert.equal(p.els.screen.innerHTML,vm.runInContext('home()',p.context));
 assert.equal(p.writes.length,0);
 await p.els['style-good'].events.click();
 assert.equal(p.writes[0].reaction,'good');
 assert.equal(p.els['style-status'].textContent,'저장했어요 ✓');
});
test('style review restores prior fix feedback and keeps the previous selection visible',async()=>{
 const p=board({reaction:'fix',marks:['색감'],text:'배경을 더 연하게'});await settle();
 assert.equal(p.els['style-detail'].hidden,false);
 assert.equal(p.els['style-text'].value,'배경을 더 연하게');
 assert.equal(p.chips[0].attrs['aria-pressed'],'true');
});
test('style review requires a selected issue or written feedback before saving a fix',async()=>{
 const p=board();await settle();
 await p.els['style-save'].events.click();
 assert.equal(p.writes.length,0);
 assert.match(p.els['style-status'].textContent,/부분을 고르거나/);
 p.chips[2].events.click();
 await p.els['style-save'].events.click();
 assert.equal(p.writes[0].reaction,'fix');
 assert.equal(p.writes[0].marks[0],'글자');
});

test('each of the four supplied images can be opened from the style board',async()=>{
 const p=board();await settle();
 for(const button of p.originals){
  button.events.click();
  assert.equal(p.els['original-image'].src,`assets/${button.dataset.original}.png`);
  assert.equal(p.els['original-dialog'].opened,true);
 }
 p.els['close-original'].events.click();
 assert.equal(p.els['original-dialog'].opened,false);
});
