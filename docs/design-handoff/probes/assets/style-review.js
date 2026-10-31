const $=id=>document.getElementById(id);
const nav=$('nav');
$('screen').innerHTML=home();
navigation();
$('phone').querySelectorAll('button').forEach(button=>{button.setAttribute('tabindex','-1');button.setAttribute('aria-disabled','true')});
const selected=new Set();
const feedbackPath=document.querySelector('.style-feedback').dataset.feedbackPath;
const chips=Array.from(document.querySelectorAll('[data-mark]'));
function updateChips(){chips.forEach(chip=>chip.setAttribute('aria-pressed',selected.has(chip.dataset.mark)?'true':'false'))}
chips.forEach(chip=>chip.addEventListener('click',()=>{selected.has(chip.dataset.mark)?selected.delete(chip.dataset.mark):selected.add(chip.dataset.mark);updateChips()}));
document.querySelectorAll('[data-original]').forEach(button=>button.addEventListener('click',()=>{const labels={'1':'홈','2':'AI 비서','3':'일간 캘린더','4':'월간 캘린더'},label=labels[button.dataset.original];$('original-title').textContent=`첨부한 ${label} 이미지`;$('original-image').src=`assets/${button.dataset.original}.png`;$('original-image').alt=`사용자가 첨부한 ${label} 이미지`;$('original-dialog').showModal()}));
$('close-original').addEventListener('click',()=>$('original-dialog').close());
$('style-fix').addEventListener('click',()=>{$('style-detail').hidden=false;$('style-text').focus()});
async function saveStyle(reaction){
 const text=reaction==='fix'?$('style-text').value.trim():'';
 const marks=reaction==='fix'?Array.from(selected):[];
 if(reaction==='fix'&&!text&&!marks.length){$('style-status').textContent='바꾸고 싶은 부분을 고르거나 적어 주세요.';return}
 try{
  const db=await getDb();if(!db)throw Error('feedback unavailable');
  await db.doc(feedbackPath).set({unit:'style',label:'사용자 제공 이미지 디자인 기준',reaction,marks,text,updatedAt:new Date().toISOString()});
  $('style-detail').hidden=reaction!=='fix';
  $('style-status').textContent='저장했어요 ✓';
 }catch(error){$('style-status').textContent='저장하지 못했어요. 다시 눌러 주세요.'}
}
$('style-good').addEventListener('click',()=>saveStyle('good'));
$('style-save').addEventListener('click',()=>saveStyle('fix'));
async function loadStyle(){
 try{
  const db=await getDb();if(!db)return;
  const snapshot=await db.doc(feedbackPath).get();if(!snapshot.exists)return;
  const record=snapshot.data();
  if(record.reaction==='fix'){
   (record.marks||[]).forEach(mark=>selected.add(mark));updateChips();
   $('style-text').value=record.text||'';$('style-detail').hidden=false;
  }
  $('style-status').textContent='저장한 의견이 있어요';
 }catch(error){$('style-status').textContent='의견을 불러오지 못했어요'}
}
loadStyle();
