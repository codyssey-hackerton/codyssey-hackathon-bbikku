/* Design-system review: local candidate examples; saved product feedback is never overwritten. */
const icon=(name)=>typeof window.PikkuIcon==='function'?window.PikkuIcon(name):'';
const safe=(value)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iconNames=[
 ['home','홈'],['calendar','캘린더'],['spark','AI 제안'],['plus','추가'],['routine','루틴'],
 ['more','더보기'],['check','완료'],['close','닫기'],['search','검색'],['clock','시간'],
 ['send','보내기'],['profile','프로필'],['bell','알림'],['settings','설정'],['alert','오류'],
 ['wifi','오프라인'],['help','도움말'],['trash','삭제']
];
function buttonSamples(size){
 const kinds=[['primary','강조'],['secondary','보조'],['ghost','간단'],['danger','삭제']];
 const states=[['default','기본'],['pressed','눌림'],['selected','선택'],['disabled','비활성'],['loading','로딩']];
 return kinds.map(([kind,label])=>'<div class="demo-row"><span class="demo-label">'+label+'</span>'+states.map(([state,text])=>'<span class="demo-button '+kind+' '+size+' '+state+'">'+(state==='loading'?'◌':text)+'</span>').join('')+'</div>').join('');
}
const iconsDemo=iconNames.map(([key,label])=>'<div class="icon-sample">'+icon(key)+'<span>'+label+'</span></div>').join('');
const sections=[
 {id:1,title:'색상과 배경',desc:'첨부 이미지의 연한 라일락·블루와 흰 카드, 일정 구분색을 이어가요.',chips:['배경','카드','파란 강조','일정 색상'],
  visual:'<p class="sample-title">삐꾸의 색상 제안</p><div class="swatches">'+[
   ['① 배경','#E2E8FF'],['카드','#FFFFFF'],['보조 면','#F3F5FC'],['글자','#14151A'],['보조 글자','#626B80'],['테두리','#E5EAF4'],
   ['강조','#6986FC'],['진한 강조','#5369CA'],['오류','#C54343'],['민트','#7EDDA9'],['주황','#FF805A'],['보라','#AD67F2']
  ].map(([label,color])=>'<div class="swatch"><i style="background:'+color+'"></i><b>'+label+'</b><small>'+color+'</small></div>').join('')+'</div><div class="gradient-samples"><div class="gradient-sample home">홈 · 캘린더 · 루틴<small>#E2E8FF → #F2F4FC</small></div><div class="gradient-sample ai">AI 비서<small>#FDEAE2 → #F1E6ED → #E0E2FE</small></div></div>'},
 {id:2,title:'글자의 크기와 읽기',desc:'프리텐다드로 제목은 선명하게, 설명은 편하게 읽도록 크기를 나눠요.',chips:['제목 크기','본문 크기','보조 글자','줄 간격'],
  visual:'<div class="sample-card">'+[
   ['display','② 화면 인사','좋은 아침, 지은님 👋'],['h1','큰 제목','나의 캘린더'],['h2','섹션 제목','오늘의 일정'],['h3','카드 제목','삐꾸의 추천'],['body','본문','오후에 여유 시간이 있어요.'],['body-sm','보조 본문','준비할 시간을 함께 찾아볼까요?'],['caption','작은 안내','오늘 · 서울'],['label','버튼과 라벨','일정에 추가']
  ].map(([css,label,text])=>'<div class="type-row"><small>'+label+'</small><span class="size-'+css+'">'+text+'</span></div>').join('')+'</div>'},
 {id:3,title:'버튼의 모양과 상태',desc:'눌렀을 때와 선택·비활성 상태를 구분하고, 작은 버튼도 누르기 편하게 만들어요.',chips:['모양','크기','색상','상태 구분'],
  visual:'<div class="sample-card"><p class="sample-title">③ 버튼 크기와 상태</p><div class="size-picker" aria-label="버튼 크기"><button type="button" data-rule-size="sm" aria-pressed="false">작게</button><button type="button" data-rule-size="md" aria-pressed="true">보통</button><button type="button" data-rule-size="lg" aria-pressed="false">크게</button></div><div class="button-demo" id="button-samples">'+buttonSamples('md')+'</div><p class="notice-small">시각적인 작은 버튼도 누르는 영역은 44×44 이상을 목표로 해요.</p></div>'},
 {id:4,title:'아이콘 후보',desc:'지정해 주신 Figma의 Streamline Core 라인 아이콘이에요. 가운데 AI 캐릭터는 기존 모습을 유지해요.',chips:['하단 메뉴','더보기','AI 제안','아이콘 선'],
  visual:'<p class="sample-title">④ 아이콘 후보</p><div class="icon-grid">'+iconsDemo+'</div><p class="notice-small">더보기는 원본을 세로로 회전했어요. 날짜 탐색 화살표는 알맞은 원본을 찾는 동안 기존 시안을 유지해요.</p>'},
 {id:5,title:'이미지 선택 카드',desc:'현재 삐꾸의 주요 흐름에서는 사용하지 않는 부품이에요. 필요해질 때 다시 확인해요.',chips:['이미지 모양','선택 표시'],
  visual:'<div class="sample-card"><p class="sample-title">⑤ 현재 사용하지 않는 예시</p><div class="thumb-grid"><div class="thumb">기본</div><div class="thumb pressed">눌림</div><div class="thumb selected">선택 ✓</div></div></div>'},
 {id:6,title:'일정 카드와 상태',desc:'흰 카드와 색상 구분선을 유지하고, 진행 중인 일간 일정은 색상 카드로 보여줘요.',chips:['카드 크기','제목','상태 버튼','진행 중 색상'],
  visual:'<div class="sample-card event-demo"><span class="event-line"></span><div class="event-copy"><strong>앨리스와 브런치</strong><small>고정 약속 · 예정</small></div><span class="event-pill">참석 확인</span><span class="event-more">'+icon('more')+'</span></div><div class="sample-card event-demo current-demo"><span class="event-line"></span><div class="event-copy"><strong>데일리 미팅 준비</strong><small>할 일 · 진행 중</small></div><span class="event-pill">완료</span><span class="event-more">'+icon('more')+'</span></div><div class="sample-card event-demo"><span class="event-line"></span><div class="event-copy"><strong>제목이 조금 길어져도 내용과 버튼을 함께 볼 수 있어요</strong><small>루틴 · 예정</small></div><span class="event-pill">완료</span><span class="event-more">'+icon('more')+'</span></div>'},
 {id:7,title:'직접 입력과 오류 안내',desc:'일정을 직접 적을 수 있고, 빠진 내용은 해당 입력 아래에서 알려줘요.',chips:['입력창','라벨','오류 표시','AI 작성'],
  visual:'<div class="sample-card input-demo"><div class="sheet-ai">'+icon('spark')+' AI로 작성하기</div><label>일정 이름</label><div class="input-box">데일리 미팅 준비</div><label>시작 시간</label><div class="input-box error">시간을 선택해 주세요</div><span class="error-text">시작 시간을 알려 주세요.</span><label>종류</label><div class="input-box">할 일　⌄</div></div>'},
 {id:8,title:'아래에서 열리는 선택 화면',desc:'추가와 더보기는 바텀시트로 보여주고, AI 기능을 맨 위에서 쉽게 찾을 수 있어요.',chips:['시트 모양','AI 강조','메뉴 간격','닫기'],
  visual:'<div class="sheet-demo"><div class="sheet-grab"></div><h3>무엇을 추가할까요?</h3><div class="sheet-ai">'+icon('spark')+' 삐꾸에게 부탁하기<br><small>AI에게 말하면 일정과 계획을 만들어요.</small></div><div class="sheet-choice">일정 추가</div><div class="sheet-choice">할 일 추가</div><div class="sheet-choice">루틴 추가</div></div><p class="notice-small">시트 크기와 안전 영역은 실제 기기에서 확인해요.</p>'},
 {id:9,title:'하단 메뉴와 알림',desc:'홈 이미지의 메뉴 순서를 유지하고 가운데 AI 비서를 강조해요.',chips:['메뉴 순서','AI 버튼','아이콘','안내 알림'],
  visual:'<div class="appbar-demo"><span>'+'‹'+'</span><span>4월 17일</span><span>'+icon('search')+'</span></div><div style="height:38px"></div><div class="nav-demo"><div class="nav-item active">'+icon('home')+'홈</div><div class="nav-item">'+icon('calendar')+'캘린더</div><div class="nav-item active"><span class="nav-ai">'+icon('spark')+'</span>AI 비서</div><div class="nav-item">'+icon('plus')+'추가</div><div class="nav-item">'+icon('routine')+'루틴</div></div><div class="toast-demo">예시 일정에 반영했어요</div>'},
 {id:10,title:'일정이 없거나 불러오지 못했을 때',desc:'빈 화면과 대기·실패 상황에서도 다음 행동을 알 수 있도록 준비하는 초안이에요.',chips:['빈 화면','불러오는 중','오류','다시 시도'],
  visual:'<div class="sample-card"><strong>오늘은 예정된 일정이 없어요</strong><p class="notice-small">하고 싶은 일을 하나 추가해 볼까요?</p><span class="demo-button primary md" style="margin-top:8px">일정 추가</span></div><div class="sample-card"><strong>일정을 불러오는 중이에요</strong><div class="skeleton"></div><div class="skeleton short"></div></div><div class="sample-card"><strong>일정을 불러오지 못했어요</strong><p class="notice-small">연결을 확인한 뒤 다시 시도해 주세요.</p><span class="demo-button secondary md" style="margin-top:8px">다시 시도</span></div>'},
 {id:11,title:'기기 크기와 글자 확대',desc:'작은 화면과 큰 글자에서도 내용과 조작이 겹치지 않도록 확인할 예정이에요.',chips:['작은 화면','넓은 화면','큰 글자','안전 영역'],
  visual:'<div class="device-row">'+[['360','작은 화면'],['390','기준 화면'],['430','넓은 화면'],['120%','글자 확대']].map(([v,label])=>'<div><div class="device"><div class="device-top"></div><div class="device-content"><b>오늘의 일정</b><span>데일리 미팅 준비</span><span>완료</span></div></div><div class="device-label">'+v+'<br>'+label+'</div></div>').join('')+'</div><p class="notice-small">축소한 설명 그림이에요. 실제 기기 검증은 아직 하지 않았어요.</p>'}
];
function sectionHtml(s){
 const chips=s.chips.map(label=>'<button type="button" class="chip" data-rule-chip="'+safe(label)+'" aria-pressed="false">'+safe(label)+'</button>').join('');
 return '<section class="rule-section" data-section="'+s.id+'"><div class="rule-visual">'+s.visual+'</div><div class="rule-info"><div class="rule-kicker">DESIGN RULE '+String(s.id).padStart(2,'0')+'</div><h2>'+safe(s.title)+'</h2><p>'+safe(s.desc)+'</p><span class="recommend">추천 · 이미지 방향 유지</span><div class="feedback-area" data-feedback-path="feedback/section-'+s.id+'"><label for="rule-text-'+s.id+'">어색한 부분이 있다면 골라 주세요</label><div class="chips">'+chips+'</div><textarea id="rule-text-'+s.id+'" placeholder="바꾸고 싶은 점을 적어 주세요"></textarea><div class="feedback-row"><button type="button" class="feedback-save" data-rule-save="'+s.id+'">의견 저장</button><button type="button" class="feedback-clear" data-rule-clear="'+s.id+'" hidden>수정 의견 해제</button><span class="feedback-status" role="status"></span></div></div></div></section>';
}
const container=document.getElementById('rules-sections');
container.innerHTML=sections.map(sectionHtml).join('');
const sectionsById=new Map(sections.map(section=>[section.id,section]));
const dirtySections=new Set();let writesInProgress=false;
function sectionNode(id){return container.querySelector('[data-section="'+id+'"]')}
function readCurrent(id){
 const node=sectionNode(id),chosen=Array.from(node.querySelectorAll('[data-rule-chip][aria-pressed="true"]')).map(chip=>chip.dataset.ruleChip);
 return {marks:chosen,text:node.querySelector('textarea').value.trim()};
}
function recordFor(id,reaction,parts){
 return {unit:'section',n:id,label:sectionsById.get(id).title,reaction,marks:parts.marks,markNames:parts.marks.slice(),text:parts.text,updatedAt:new Date().toISOString()};
}
function showStatus(id,message){sectionNode(id).querySelector('.feedback-status').textContent=message}
function restoreRecord(id,record){
 const node=sectionNode(id);if(!node||dirtySections.has(id))return;
 const marks=Array.isArray(record.marks)?record.marks:[];
 node.querySelectorAll('[data-rule-chip]').forEach(chip=>chip.setAttribute('aria-pressed',String(marks.includes(chip.dataset.ruleChip))));
 node.querySelector('textarea').value=typeof record.text==='string'?record.text:'';
 node.querySelector('[data-rule-clear]').hidden=record.reaction!=='fix';
 showStatus(id,record.reaction==='fix'?'저장한 수정 의견이 있어요':record.reaction==='good'?'추천대로 저장했어요':'다시 선택할 수 있어요');
}
async function loadRules(){
 try{
  const db=await getDb();if(!db)throw Error('not available');
  const snapshot=await db.collection('feedback').get();
  for(const doc of snapshot.docs){
   const match=/^section-(\d+)$/.exec(doc.id);
   if(match&&sectionsById.has(Number(match[1])))restoreRecord(Number(match[1]),doc.data()||{});
  }
 }catch(error){document.getElementById('overall-status').textContent='저장된 의견을 불러오지 못했어요.'}
}
container.addEventListener('input',event=>{const section=event.target.closest('[data-section]');if(section)dirtySections.add(Number(section.dataset.section))});
container.addEventListener('click',async event=>{
 const chip=event.target.closest('[data-rule-chip]');
 if(chip){const section=chip.closest('[data-section]');if(section)dirtySections.add(Number(section.dataset.section));chip.setAttribute('aria-pressed',String(chip.getAttribute('aria-pressed')!=='true'));return}
 const clear=event.target.closest('[data-rule-clear]');
 if(clear){
  const id=Number(clear.dataset.ruleClear),node=sectionNode(id);
  if(writesInProgress){showStatus(id,'다른 의견을 저장 중이에요.');return}
  writesInProgress=true;clear.disabled=true;
  try{
   const db=await getDb();if(!db)throw Error('not available');
   const ref=db.doc('feedback/section-'+id),snapshot=await ref.get(),previous=snapshot.exists?snapshot.data():null;
   const record=recordFor(id,'pending',{marks:[],text:''});if(previous)record.previousFeedback=previous;
   await ref.set(record);dirtySections.add(id);
   node.querySelectorAll('[data-rule-chip]').forEach(chip=>chip.setAttribute('aria-pressed','false'));
   node.querySelector('textarea').value='';clear.hidden=true;showStatus(id,'의견을 해제했어요. 다시 선택할 수 있어요.');
  }catch(error){showStatus(id,'해제하지 못했어요. 다시 시도해 주세요.')}
  finally{clear.disabled=false;writesInProgress=false}
  return;
 }
 const size=event.target.closest('[data-rule-size]');
 if(size){
  document.querySelectorAll('[data-rule-size]').forEach(button=>button.setAttribute('aria-pressed',String(button===size)));
  document.getElementById('button-samples').innerHTML=buttonSamples(size.dataset.ruleSize);return;
 }
 const button=event.target.closest('[data-rule-save]');if(!button)return;
 const id=Number(button.dataset.ruleSave),parts=readCurrent(id);
 if(writesInProgress){showStatus(id,'다른 의견을 저장 중이에요.');return}
 if(!parts.marks.length&&!parts.text){showStatus(id,'바꾸고 싶은 부분을 고르거나 적어 주세요.');return}
 button.disabled=true;writesInProgress=true;
 try{const db=await getDb();if(!db)throw Error('not available');await db.doc('feedback/section-'+id).set(recordFor(id,'fix',parts));sectionNode(id).querySelector('[data-rule-clear]').hidden=false;showStatus(id,'저장했어요 ✓')}
 catch(error){showStatus(id,'저장하지 못했어요. 다시 시도해 주세요.')}
 finally{button.disabled=false;writesInProgress=false}
});
document.getElementById('accept-all').addEventListener('click',async event=>{
 const button=event.currentTarget,status=document.getElementById('overall-status');if(writesInProgress){status.textContent='다른 의견을 저장 중이에요.';return}button.disabled=true;writesInProgress=true;status.textContent='저장 중이에요…';
 let saved=0,kept=0;
 try{
  const db=await getDb();if(!db)throw Error('not available');
  const snapshot=await db.collection('feedback').get();
  const existing=new Map(snapshot.docs.map(doc=>[doc.id,doc.data()||{}]));
  for(const section of sections){
   const current=readCurrent(section.id),previous=existing.get('section-'+section.id);
   if(current.marks.length||current.text||previous?.reaction==='fix'){kept++;continue}
   const record=recordFor(section.id,'good',{marks:[],text:''});if(previous?.previousFeedback)record.previousFeedback=previous.previousFeedback;
   await db.doc('feedback/section-'+section.id).set(record);saved++;showStatus(section.id,'추천대로 저장했어요');
  }
  status.textContent='저장했어요 ✓'+(kept?' · 수정 의견 '+kept+'개는 그대로 뒀어요':'');
 }catch(error){status.textContent='일부 의견을 저장하지 못했어요. 다시 시도해 주세요. ('+saved+'개 저장됨)'}
 finally{button.disabled=false;writesInProgress=false}
});
loadRules();
