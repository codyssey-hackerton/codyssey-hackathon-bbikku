/* Screen-by-screen review. Samples are local and never mutate the interactive preview. */
const reviews=[
 {slug:'home',title:'홈',description:'오늘의 현황과 다음 행동을 확인해요.',parts:['인사와 프로필','오늘의 일정 현황','삐꾸의 추천','일정 카드와 지난 일정','하단 메뉴'],states:['일정이 없어요','불러오는 중','불러오기 실패']},
 {slug:'month',title:'월간 캘린더',description:'날짜를 고르고 해당 날짜의 일간 일정으로 이동해요.',parts:['월 탐색','날짜 그리드','일정 표시 점','다가오는 주요 일정','하단 메뉴'],states:['일정이 없는 달','불러오는 중','불러오기 실패']},
 {slug:'day',title:'일간 캘린더',description:'시작·종료 시각과 진행 중인 일정을 살펴봐요.',parts:['날짜 탐색','7일 날짜 선택','시작·종료 시간축','일정 카드와 지난 일정','하단 메뉴'],states:['일정이 없는 날','지난 일정 펼침','시간 겹침']},
 {slug:'assistant',title:'AI 비서',description:'일정에 관해 묻고 저장 전 제안을 확인해요.',parts:['AI 비서와 선택 맥락','대화 내용','제안과 사용자 승인','메시지 입력','하단 메뉴'],states:['대화 시작','답변 대기','응답 실패']},
 {slug:'add',title:'일정 추가',description:'직접 입력하거나 AI와 함께 작성해요.',parts:['AI로 작성하기','제목·날짜·시간','종류와 참여자','추가와 취소','하단 메뉴'],states:['처음 입력','입력 확인','저장 실패']},
 {slug:'routine',title:'루틴',description:'반복하는 일과 날짜별 수행 상태를 살펴봐요.',parts:['루틴 현황','7일 날짜 선택','오늘과 전체','루틴 카드와 기록','하단 메뉴'],states:['등록된 루틴 없음','미완료 기록','다시 계획 제안']},
 {slug:'recommendation',title:'추천 확인',description:'아직 반영되지 않은 제안과 이유를 읽어요.',parts:['미반영 안내','추천 시간','제안 이유','기존 일정 유지','내용 확인'],states:['제안 없음','제안 확인 중','제안 확인 실패']},
 {slug:'contact',title:'공동 일정 연락 승인',description:'상대방에게 보내는 내용과 승인 화면은 아직 정해지지 않았어요.',parts:['연락 대상','연락 내용','사용자 승인','연락 진행 상태','기존 일정 유지'],states:['대상 없음','연락 중','연락 실패'],pending:true},
 {slug:'approval',title:'추천 승인 확인',description:'변경 전 내용을 확인한 뒤 직접 승인해요.',parts:['제안 내용','날짜와 시간','변경 전 상태','일정에 추가','돌아가기'],states:['변경 사항 없음','확인 중','다시 확인 필요']},
 {slug:'result',title:'일정 추가 결과',description:'승인한 일정이 예시에 추가된 결과를 살펴봐요.',parts:['결과 안내','추가된 일정','날짜와 시간','일정 확인','하단 메뉴'],states:['결과 없음','저장 중','저장 실패']}
];
const reviewMap=new Map(reviews.map((item,index)=>[item.slug,{...item,n:index+1}]));
const reviewEsc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=['①','②','③','④','⑤'];
const reviewRoot=document.getElementById('screen-reviews'),reviewScreen=document.getElementById('screen'),reviewNav=document.getElementById('nav');
const reviewSaved=new Map(),reviewDirty=new Set();
/* Only these saved revisions have been implemented; newer feedback remains pending. */
const appliedReviewUpdates={day:'2026-10-31T18:20:00.344Z',routine:'2026-10-31T18:20:30.960Z'};
function reviewWasApplied(slug,record){return record?.reaction==='fix'&&record.updatedAt===appliedReviewUpdates[slug]}
let reviewBusy=false;
function reviewToast(){}
function savePreview(){return false}
const modal=document.getElementById('modal'),sheet=document.getElementById('sheet'),nav=reviewNav;
function reviewPhoneMarkup(content,nav,kind='',overlay=''){
 const dots='<span class="status-icons"><svg viewBox="0 0 20 15" fill="currentColor"><rect x="1" y="10" width="3" height="4" rx="1"/><rect x="6" y="7" width="3" height="7" rx="1"/><rect x="11" y="4" width="3" height="10" rx="1"/><rect x="16" y="1" width="3" height="13" rx="1"/></svg><svg viewBox="0 0 20 15" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 5c5-5 13-5 18 0M4 8c4-4 8-4 12 0M7 11c2-2 4-2 6 0"/><circle cx="10" cy="13" r="1" fill="currentColor"/></svg></span>';
 return '<section class="phone '+kind+(overlay?' preview-modal-open':'')+'" aria-label="화면 구성 예시"><div class="notch"></div><div class="status"><span>11:01</span>'+dots+'</div><div class="scroll'+(kind==='chat-bg'?' chat-scroll':'')+'">'+content+'</div><nav class="nav">'+nav+'</nav><div class="home-bar"></div>'+overlay+num.map((n,i)=>'<span class="review-screen-label preview-number-'+(i+1)+'" aria-hidden="true">'+n+'</span>').join('')+'</section>';
}
function navMarkup(screenName){
 state.screen=screenName;navigation();return reviewNav.innerHTML;
}
function flowCard(title,body){return '<div class="review-flow-card"><h3>'+title+'</h3><p>'+body+'</p></div>'}
function visualFor(slug){
 state.selectedDate=R.parseDate('2025-04-17');
 if(slug==='contact')return '<div class="contact-placeholder"><strong>연락 승인 화면은 미정이에요</strong><p>상대방에게 어떤 내용을 보낼지와 승인·결과 표현은 별도로 설계해야 해요.</p></div>';
 if(slug==='home')return reviewPhoneMarkup(home(),navMarkup('home'));
 if(slug==='month')return reviewPhoneMarkup(month(),navMarkup('calendar'));
 if(slug==='day'){state.screen='day';return reviewPhoneMarkup(day(),navMarkup('day'))}
 if(slug==='routine'){state.screen='routine';return reviewPhoneMarkup(routineView(),navMarkup('routine'))}
 if(slug==='assistant'){
  const chat='<div class="chat-header"><div class="bot-icon">'+svg('bot')+'</div>AI 비서</div><div class="chat-date">오늘, 오전 8:20</div><div class="bubble">무엇을 도와드릴까요?<br>일정에서 좋은 시간을 함께 찾아드릴게요!</div><div class="bubble user">내일 오후 3시에 회의 잡아줘.</div><div class="bubble">회의를 얼마나 진행할까요?</div><div class="chat-spacer"></div><form class="composer"><input aria-label="메시지" placeholder="메시지를 입력하세요..." disabled><button class="send" aria-label="메시지 보내기" disabled>'+svg('send')+'</button></form>';
  return reviewPhoneMarkup(chat,navMarkup('chat'),'chat-bg');
 }
 if(slug==='add'){
  state.screen='home';showAddForm('appointment',{name:'데일리 미팅 준비',time:'오후 3:00 - 3:30',date:'2025-04-17',eventType:'appointment',involvement:'personal'});
  return reviewPhoneMarkup(home(),navMarkup('home'),'', '<div class="modal-layer"><div class="sheet">'+document.getElementById('sheet').innerHTML+'</div></div>');
 }
 if(slug==='recommendation'){
  const page='<div class="review-flow-content"><div class="date">2025년 4월 17일 목요일</div><h2>삐꾸의 추천</h2>'+flowCard('① 아직 일정에 반영되지 않았어요','11:30에 30분 산책 어때요?')+flowCard('② 추천 시간','4월 17일 목요일 · 오전 11:30–12:00')+flowCard('③ 이렇게 생각했어요','데일리 미팅 준비가 끝난 뒤, 오후 일정이 시작되기 전까지 여유가 있어요.')+flowCard('④ 기존 일정은 그대로예요','아직 어떤 일정도 바뀌지 않았어요.')+'<button class="review-flow-button">내용 확인</button></div>';
  return reviewPhoneMarkup(page,navMarkup('home'));
 }
 if(slug==='approval'){
  const page='<div class="review-flow-content"><div class="date">확인 후에만 반영돼요</div><h2>일정을 추가할까요?</h2>'+flowCard('① 새 일정','30분 산책')+flowCard('② 날짜와 시간','4월 17일 목요일 · 오전 11:30–12:00')+flowCard('③ 변경 전','산책은 아직 일정에 없어요.')+flowCard('④ 변경 후','11시 30분에 산책 일정 한 건을 추가해요.')+'<button class="review-flow-button">일정에 추가</button></div>';
  return reviewPhoneMarkup(page,navMarkup('home'));
 }
 const page='<div class="review-flow-center"><div class="status-bubble">✓</div><h2>일정이 추가됐어요</h2><p>4월 17일 목요일<br><b>오전 11:30 · 30분 산책</b></p>'+flowCard('기존 일정은 그대로예요','산책 한 건만 예시에 추가됐어요.')+'<button class="review-flow-button">일정 확인</button></div>';
 return reviewPhoneMarkup(page,navMarkup('home'));
}
function stateVisualFor(item,index){
 const slug=item.slug,title=item.states[index];
 const navScreen=slug==='month'?'calendar':slug==='day'?'day':slug==='routine'?'routine':slug==='assistant'?'chat':'home';
 const nav=navMarkup(navScreen),kind=slug==='assistant'?'chat-bg':'';
 if(slug==='day'&&index===1){
  state.selectedDate=R.parseDate('2025-04-17');state.pastStacks.days['2025-04-17']=true;state.screen='day';
  const content=day();state.pastStacks.days['2025-04-17']=false;return reviewPhoneMarkup(content,nav);
 }
 if(slug==='day'&&index===2){
  const added={id:'review-overlap',name:'자료 확인',time:'오전 11:05 - 11:25',date:'2025-04-17',type:'task',status:'pending',color:'#7894ff',kind:'work',show:true};
  state.events.push(added);state.selectedDate=R.parseDate('2025-04-17');state.screen='day';
  const content=day();state.events.pop();return reviewPhoneMarkup(content,nav);
 }
 if(slug==='routine'&&index===1){
  state.selectedDate=R.parseDate('2025-04-17');state.screen='routine';return reviewPhoneMarkup(routineView(),nav);
 }
 if(slug==='add'&&index===0){
  state.screen='home';showAddForm('appointment',{name:'',time:'',date:'2025-04-17',eventType:'appointment',involvement:'personal'});
  return reviewPhoneMarkup(home(),nav,'','<div class="modal-layer"><div class="sheet">'+sheet.innerHTML+'</div></div>');
 }
 if(slug==='assistant'&&index===0){
  const content='<div class="chat-header"><div class="bot-icon">'+svg('bot')+'</div>AI 비서</div><div class="chat-date">오늘, 오전 8:20</div><div class="bubble">무엇을 도와드릴까요?<br>일정에서 좋은 시간을 함께 찾아드릴게요!</div><div class="chat-spacer"></div><form class="composer"><input placeholder="메시지를 입력하세요..." disabled><button class="send" disabled>'+svg('send')+'</button></form>';
  return reviewPhoneMarkup(content,nav,kind);
 }
 const text=index===0?'아직 보여줄 내용이 없어요.':index===1?'내용을 확인하고 있어요.':'다시 확인한 뒤 시도해 주세요.';
 const content='<div class="screen-phone-empty"><div class="status-bubble">'+(index===1?'◌':index===2?'!':'')+'</div><h3>'+reviewEsc(title)+'</h3><p>'+text+'</p><p>상태 표현을 살펴보기 위한 예시예요.</p></div>';
 return reviewPhoneMarkup(content,nav,kind);
}
function partOptions(index){
 if(index===0)return ['현재 구성','제목 영역을 간결하게'];
 if(index===4)return ['현재 구성','하단 안내를 간결하게'];
 return ['현재 구성','더 간결한 카드','분리된 목록'];
}
function partsHtml(item){
 return item.parts.map((name,index)=>{
  const options=partOptions(index).map((label,i)=>'<option value="'+(i?reviewEsc(label):'')+'">'+reviewEsc(label)+'</option>').join('');
  const controls=item.pending?'':'<div class="part-controls"><label><input type="checkbox" data-part-remove="'+index+'"> 빼요</label><select aria-label="'+reviewEsc(name)+' 다른 구성" data-part-swap="'+index+'">'+options+'</select></div>';
  return '<li class="part-row"><span>'+num[index]+' '+reviewEsc(name)+'</span>'+controls+'</li>';
 }).join('');
}
function stateHtml(item){
 return item.states.map((name,index)=>'<button type="button" class="state-example" data-state-choice="'+index+'" '+(item.pending?'disabled':'')+'><strong>'+reviewEsc(name)+'</strong><span>'+(item.pending?'아직 정하지 않았어요':index===0?'예시로 확인해요':'후속 상태 검토')+'</span></button>').join('');
}
function sectionHtml(item){
 const pending=item.pending,visual=visualFor(item.slug);state.screen='home';
 const marks=item.parts.map((part,index)=>'<button type="button" class="review-mark" data-review-mark="'+index+'" aria-pressed="false">'+num[index]+' '+reviewEsc(part)+'</button>').join('');
 const controls=pending?'<p class="pending-explanation">화면이 제작되기 전이라 확정 대상으로 표시하지 않았어요.</p>':
  '<div class="review-actions"><button type="button" class="review-good" data-review-good="'+item.slug+'">괜찮아요</button><button type="button" class="review-fix" data-review-fix="'+item.slug+'">고칠 게 있어요</button></div><div class="review-editor" hidden><label for="review-text-'+item.slug+'">바꾸고 싶은 부분</label><div class="review-marks">'+marks+'</div><textarea id="review-text-'+item.slug+'" placeholder="어떤 점을 바꾸고 싶은지 적어 주세요"></textarea><div class="feedback-row"><button type="button" class="feedback-save" data-review-save="'+item.slug+'">의견 저장</button><button type="button" class="feedback-clear" data-review-clear="'+item.slug+'">수정 의견 해제</button></div></div><p class="feedback-status" role="status"></p>';
 return '<section class="screen-review" data-screen="'+item.slug+'"><div class="screen-visual">'+visual+'</div><div class="screen-info"><div class="review-kicker">SCREEN '+String(item.n).padStart(2,'0')+'</div><h2>'+reviewEsc(item.title)+'</h2><p>'+reviewEsc(item.description)+'</p><span class="status-tag '+(pending?'pending':'')+'">'+(pending?'미정 · 화면 미제작':'검토용 화면')+'</span><ol class="parts-list">'+partsHtml(item)+'</ol><div class="state-examples">'+stateHtml(item)+'</div>'+(pending?'':'<button type="button" class="state-default" data-state-default>기본 화면 보기</button>')+'<p class="state-selected" aria-live="polite">상태를 선택하면 예시 화면이 바뀌어요. 실제 기능 연결을 뜻하지 않아요.</p>'+controls+'</div></section>';
}
function buildReview(){reviewRoot.innerHTML=reviews.map((item,index)=>sectionHtml({...item,n:index+1})).join('')}
function reviewNode(slug){return reviewRoot.querySelector('[data-screen="'+slug+'"]')}
function setReviewStatus(slug,message){const node=reviewNode(slug);if(node)node.querySelector('.feedback-status').textContent=message}
function updatePreviewGo(){
 const required=reviews.filter(item=>!item.pending);
 const ready=reviews.every(item=>!item.pending)&&required.every(item=>reviewSaved.get(item.slug)?.reaction==='ok')&&required.every(item=>!reviewDirty.has(item.slug));
 document.getElementById('preview-go').disabled=!ready;
 document.getElementById('preview-go-status').textContent=ready?'확인한 화면을 Figma 제작 요청으로 넘길 수 있어요.':'검토할 수 있는 화면 '+required.filter(item=>reviewSaved.get(item.slug)?.reaction==='ok'&&!reviewDirty.has(item.slug)).length+'/'+required.length+'개를 확인했어요. 연락 승인 화면은 아직 준비 중이에요.';
}
function restoreReview(slug,record){
 const node=reviewNode(slug);if(!node||reviewDirty.has(slug))return;
 reviewSaved.set(slug,record);
 const editor=node.querySelector('.review-editor');if(!editor)return;
 editor.hidden=record.reaction!=='fix';node.classList.toggle('review-editing',record.reaction==='fix');editor.querySelector('textarea').value=typeof record.text==='string'?record.text:'';
 const marks=Array.isArray(record.marks)?record.marks:[];
 editor.querySelectorAll('[data-review-mark]').forEach(button=>button.setAttribute('aria-pressed',String(marks.includes(num[Number(button.dataset.reviewMark)]))));
 const remove=Array.isArray(record.remove)?record.remove:[];
 node.querySelectorAll('[data-part-remove]').forEach(input=>{input.checked=remove.includes('part-'+input.dataset.partRemove)});
 const swap=record.swap&&typeof record.swap==='object'?record.swap:{};
 node.querySelectorAll('[data-part-swap]').forEach(select=>{select.value=swap['part-'+select.dataset.partSwap]||''});
 setReviewStatus(slug,record.reaction==='ok'?'괜찮아요로 저장했어요':reviewWasApplied(slug,record)?'수정 의견을 반영했어요. 화면을 확인한 뒤 괜찮아요를 눌러 주세요.':record.reaction==='fix'?'수정 의견이 저장되어 있어요':'');
}
async function loadScreenReviews(){
 try{
  const db=await getDb();if(!db)throw Error('unavailable');
  const result=await db.collection('feedback').get();
  for(const doc of result.docs){const match=/^screen-(.+)$/.exec(doc.id);if(match&&reviewMap.has(match[1]))restoreReview(match[1],doc.data()||{})}
  updatePreviewGo();
 }catch(error){document.getElementById('preview-go-status').textContent='저장된 화면 의견을 불러오지 못했어요.'}
}
function reviewParts(slug){
 const node=reviewNode(slug),marks=Array.from(node.querySelectorAll('[data-review-mark][aria-pressed="true"]')).map(button=>num[Number(button.dataset.reviewMark)]);
 const remove=Array.from(node.querySelectorAll('[data-part-remove]:checked')).map(input=>'part-'+input.dataset.partRemove);
 const swap=Object.fromEntries(Array.from(node.querySelectorAll('[data-part-swap]')).filter(select=>select.value).map(select=>['part-'+select.dataset.partSwap,select.value]));
 return {marks,remove,swap,text:node.querySelector('.review-editor textarea').value.trim()};
}
async function storeReview(slug,reaction){
 const item=reviewMap.get(slug);if(!item||item.pending||reviewBusy)return;
 const parts=reviewParts(slug);
 const saved=reviewSaved.get(slug),acceptingApplied=reaction==='ok'&&reviewWasApplied(slug,saved)&&!reviewDirty.has(slug);
 if(reaction==='fix'&&!parts.marks.length&&!parts.remove.length&&!Object.keys(parts.swap).length&&!parts.text){setReviewStatus(slug,'바꿀 부분을 고르거나 적어 주세요.');return}
 if(reaction==='ok'&&!acceptingApplied&&(parts.marks.length||parts.remove.length||Object.keys(parts.swap).length||parts.text)){setReviewStatus(slug,'작성 중인 수정 의견이 있어요. 의견을 저장하거나 내용을 지워 주세요.');return}
 reviewBusy=true;
 try{
  const db=await getDb();if(!db)throw Error('unavailable');
  const ref=db.doc('feedback/screen-'+slug),snapshot=await ref.get(),previous=snapshot.exists?snapshot.data():null;
  if(acceptingApplied&&(!previous||previous.updatedAt!==saved.updatedAt)){
   if(previous)restoreReview(slug,previous);
   setReviewStatus(slug,'다른 창에서 의견이 변경됐어요. 새 의견을 확인해 주세요.');return;
  }
  const stored=acceptingApplied?{marks:[],remove:[],swap:{},text:''}:parts;
  const record={unit:'screen',n:item.n,label:item.title,reaction,remove:stored.remove,swap:stored.swap,marks:stored.marks,markNames:stored.marks.map(mark=>item.parts[num.indexOf(mark)]),text:stored.text,updatedAt:new Date().toISOString()};
  if(previous&&(previous.reaction!==reaction||previous.previousFeedback))record.previousFeedback=previous;
  await ref.set(record);reviewDirty.delete(slug);reviewSaved.set(slug,record);
  if(acceptingApplied)restoreReview(slug,record);
  else{reviewNode(slug).querySelector('.review-editor').hidden=reaction!=='fix';reviewNode(slug).classList.toggle('review-editing',reaction==='fix')}
  setReviewStatus(slug,reaction==='ok'?'괜찮아요로 저장했어요 ✓':'수정 의견을 저장했어요 ✓');updatePreviewGo();
 }catch(error){setReviewStatus(slug,'저장하지 못했어요. 다시 시도해 주세요.')}
 finally{reviewBusy=false}
}
async function clearReview(slug){
 const item=reviewMap.get(slug);if(!item||item.pending||reviewBusy)return;
 reviewBusy=true;
 try{
  const db=await getDb();if(!db)throw Error('unavailable');
  const ref=db.doc('feedback/screen-'+slug),snapshot=await ref.get(),previous=snapshot.exists?snapshot.data():null;
  const record={unit:'screen',n:item.n,label:item.title,reaction:'pending',remove:[],swap:{},marks:[],markNames:[],text:'',updatedAt:new Date().toISOString()};
  if(previous)record.previousFeedback=previous;
  await ref.set(record);
  const node=reviewNode(slug),editor=node.querySelector('.review-editor');
  editor.querySelector('textarea').value='';
  editor.querySelectorAll('[data-review-mark]').forEach(button=>button.setAttribute('aria-pressed','false'));
  node.querySelectorAll('[data-part-remove]').forEach(input=>{input.checked=false});
  node.querySelectorAll('[data-part-swap]').forEach(select=>{select.value=''});
  editor.hidden=true;node.classList.remove('review-editing');reviewSaved.set(slug,record);reviewDirty.delete(slug);
  setReviewStatus(slug,'수정 의견을 해제했어요. 다시 확인해 주세요.');updatePreviewGo();
 }catch(error){setReviewStatus(slug,'해제하지 못했어요. 다시 시도해 주세요.')}
 finally{reviewBusy=false}
}
function markDirty(target){
 const node=target.closest('[data-screen]');if(!node)return;
 reviewDirty.add(node.dataset.screen);updatePreviewGo();
}
reviewRoot.addEventListener('input',event=>{if(event.target.closest('.review-editor'))markDirty(event.target)});
reviewRoot.addEventListener('change',event=>{if(event.target.closest('.part-controls'))markDirty(event.target)});
reviewRoot.addEventListener('click',async event=>{
 const node=event.target.closest('[data-screen]');if(!node)return;
 const slug=node.dataset.screen;
 const stateButton=event.target.closest('[data-state-choice]');
 if(stateButton){const item=reviewMap.get(slug),index=Number(stateButton.dataset.stateChoice),choice=item.states[index];node.querySelector('.screen-visual').innerHTML=stateVisualFor(item,index);node.querySelector('.state-selected').textContent=choice+' 상태를 예시 화면으로 보고 있어요. 실제 연결 여부와 세부 표현은 후속 확인이 필요해요.';return}
 if(event.target.closest('[data-state-default]')){node.querySelector('.screen-visual').innerHTML=visualFor(slug);node.querySelector('.state-selected').textContent='기본 화면을 보고 있어요.';return}
 const mark=event.target.closest('[data-review-mark]');
 if(mark){mark.setAttribute('aria-pressed',String(mark.getAttribute('aria-pressed')!=='true'));markDirty(mark);return}
 if(event.target.closest('[data-review-fix]')){node.querySelector('.review-editor').hidden=false;node.classList.add('review-editing');return}
 if(event.target.closest('[data-review-good]')){await storeReview(slug,'ok');return}
 if(event.target.closest('[data-review-clear]')){await clearReview(slug);return}
 if(event.target.closest('[data-review-save]')){await storeReview(slug,'fix')}
});
document.getElementById('preview-go').addEventListener('click',async event=>{
 const button=event.currentTarget,status=document.getElementById('preview-go-status');
 if(button.disabled||reviewBusy)return;reviewBusy=true;button.disabled=true;let completed=false;
 try{
  const db=await getDb();if(!db)throw Error('unavailable');
  if(reviews.some(item=>item.pending)){status.textContent='미정 화면이 있어 아직 제작 요청을 보낼 수 없어요.';return}
  const required=reviews.filter(item=>!item.pending),snapshot=await db.collection('feedback').get();
  const saved=new Map(snapshot.docs.map(doc=>[doc.id,doc.data()||{}]));
  if(required.some(item=>saved.get('screen-'+item.slug)?.reaction!=='ok'||reviewDirty.has(item.slug))){status.textContent='화면별 저장 상태를 다시 확인해 주세요.';return}
  await db.doc('feedback/preview-go').set({unit:'preview',n:0,label:'확정',text:'go',screens:required.map(item=>item.slug),updatedAt:new Date().toISOString()});
  completed=true;status.textContent='Figma 제작 요청을 저장했어요.';
 }catch(error){status.textContent='요청을 저장하지 못했어요. 다시 시도해 주세요.'}
 finally{reviewBusy=false;updatePreviewGo();if(completed)status.textContent='Figma 제작 요청을 저장했어요.'}
});
buildReview();updatePreviewGo();loadScreenReviews();
