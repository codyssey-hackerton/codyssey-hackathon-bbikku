<!--
4단계 산출물. 프로젝트의 design/design-rules.md로 복사해서 채운다.
값 열은 ../references/design-rules.md의 기본값에서 시작한다.
덮어쓴 항목은 출처 열에 "축 2: '빡빡해요'"처럼 단계와 원문을 적는다.
figma-builder는 status: confirmed 가 없으면 시작하지 않는다.
-->

status: confirmed
confirmed_at: 2026-11-01
preview: design/probes/rules-preview.html

# Design Rules

> 확인 범위: 사용자가 2026-11-01에 색상·아이콘 수정 결과를 확인하고 다음 진행을 요청했다. 이에 현재 규칙으로 화면별 검토를 진행한다. 글자·간격의 세부 수치, 실제 기기 360/390/430·120% 확대 검증, AI 캐릭터 최종 형상, 탐색 화살표 원본, 연락 승인 상세는 미정 또는 검토 대상이다. 각 규칙 항목을 개별 승인한 것으로 표시하지 않는다.


## A. 토큰

| 키 | 값 | 출처 |
|---|---|---|
| color.bg | #E2E8FF | 3단계 레퍼런스와 현재 시안 |
| color.surface-1 | #FFFFFF | 3단계 레퍼런스와 현재 시안 |
| color.surface-2 | #F3F5FC | 3단계 레퍼런스와 현재 시안 |
| color.text | #14151A | 3단계 레퍼런스와 현재 시안 |
| color.text-muted | #626B80 | 3단계 레퍼런스와 현재 시안 |
| color.border | #E5EAF4 | 3단계 레퍼런스와 현재 시안 |
| color.accent | #6986FC | 3단계 레퍼런스와 현재 시안 |
| color.accent-pressed | #5369CA | 기본값 |
| color.accent-soft | rgba(105, 134, 252, 0.12) | 기본값 |
| color.success | #7EDDA9 | 3단계 사용자 색상 의견 |
| color.schedule | #FF805A | 3단계 사용자 색상 의견 |
| color.routine | #AD67F2 | 3단계 사용자 색상 의견 |
| color.text-on-tint | #5D677B | 3단계 대비 검토 |
| color.danger | #C54343 | 고정 |
| color.overlay | rgba(27, 32, 50, 0.45) | 고정 |
| space.scale | 4 / 8 / 12 / 16 / 24 / 32 / 48 | 3단계 레퍼런스와 현재 시안 |
| space.screen-padding | 16 | 3단계 레퍼런스와 현재 시안 |
| space.section | 24 | 3단계 레퍼런스와 현재 시안 |
| space.card-padding | 16 | 3단계 레퍼런스와 현재 시안 |
| radius | sm 8 / md 12 / lg 16 / xl 24 / full 9999 | 3단계 레퍼런스와 현재 시안 |
| shadow | sm 0 3px 10px rgba(113,130,155,0.06) / md 0 8px 24px rgba(113,130,155,0.12) | 3단계 레퍼런스와 현재 시안 |
| font.family | Pretendard, -apple-system, Roboto, sans-serif | 3단계 레퍼런스와 현재 시안 |
| type.roles | display 28/700 · h1 24/700 · h2 20/700 · h3 17/600 · body 15/400 · body-sm 14/400 · caption 12/500 · label 13/600 · 본문 줄간격 1.5 | 3단계 레퍼런스와 현재 시안 |
| z.scale | base 0 · sticky 100 · app-bar 200 · tab-bar 200 · overlay 300 · sheet 400 · dialog 500 · snackbar 600 | 고정 |
| motion | 200ms ease-out · 시트 250ms · 카드 스택 300ms · 동작 줄이기 지원 | 3단계 레퍼런스와 현재 시안 |
| device.frame | 390×844 · 360 / 390 / 430 검토 | 3단계 레퍼런스와 현재 시안 |
| safe-area | iOS·Android 기기별 시스템 inset 적용 · 콘텐츠 가림 방지 | 고정 |
| tap.min | 44×44 | 고정 |
| platform | iOS·Android 공통 디자인 · 시스템 제스처와 뒤로 가기 확인 | 3단계 레퍼런스와 현재 시안 |

## B. 컴포넌트 규칙

| 키 | 값 | 출처 | 사용 여부 |
|---|---|---|---|
| button.sizes | sm 36h / 탭 영역 44 · md 44h · lg 52h | 3단계 레퍼런스와 현재 시안 | 사용 |
| button.radius | 12 · 강조 행동과 상태에 따라 full | 3단계 레퍼런스와 현재 시안 | 사용 |
| button.variants | primary(진한 파랑과 흰 글자) · secondary(흰 면과 파랑 글자) · ghost · danger | 3단계 레퍼런스와 현재 시안 | 사용 |
| button.states | default · pressed · selected · disabled · loading · 상태를 색과 글자로 함께 구분 | 3단계 레퍼런스와 현재 시안 | 사용 |
| button.row-rule | 같은 줄의 버튼은 같은 size·radius. 두 개면 secondary 왼쪽, primary 오른쪽 | 기본값 | 사용 |
| button.text | 한 줄. 넘치면 문구를 줄인다. 줄바꿈 금지 | 기본값 | 사용 |
| button.primary-per-screen | 주요 선택은 화면마다 하나를 우선하고 AI 보조 진입은 별도 계층으로 구분 | 3단계 레퍼런스와 현재 시안 | 사용 |
| button.duplicate | 같은 동작의 버튼을 앱바와 본문에 이중 배치하지 않는다. 범위가 다르면 라벨에 범위를 쓴다 | 기본값 | 사용 |
| icon.set | Streamline Core Line · 중앙 AI 캐릭터는 기존 시안 유지 · 날짜 화살표 원본은 추가 확인 | 3단계 사용자 지정 Figma | 사용 |
| icon.sizes | 16 / 20 / 24 | 3단계 레퍼런스와 현재 시안 | 사용 |
| icon.stroke | Streamline Core 14px 원본 비율을 유지하며 20~24px에 표시 · 일관성 검토 | 3단계 사용자 지정 Figma | 사용 |
| icon.gap | 텍스트와 8px, 수직 중앙 정렬 | 기본값 | 사용 |
| icon-button.hit | 탭 영역 44×44 정사각. 그림은 icon.sizes. 앱바 아이콘 버튼은 시각 24 / 탭 44 | 기본값 | 사용 |
| icon-button.name | 아이콘만 있는 버튼은 접근성 라벨 필수. 탭바 아이콘은 텍스트 라벨 동반 | 기본값 | 사용 |
| icon.state | 버튼 상태 색을 아이콘도 따른다 | 기본값 | 사용 |
| icon.overflow-menu | 자주 쓰는 액션은 점 세 개 뒤에 숨기지 않는다. 앱바 액션은 최대 2개 노출 | 기본값 | 사용 |
| icon.proximity | 액션 아이콘은 대상 제목·내용 바로 옆. 목록 행의 액션은 우측 끝 | 기본값 | 사용 |
| tap.feedback | 탭 가능한 모든 요소에 pressed 시각 반응. 반응 없는 탭 가능 요소 금지 | 기본값 | 사용 |
| tap.long-press | 롱프레스는 보조 액션에만. 유일한 진입 경로로 쓰지 않는다 | 기본값 | 사용 |
| image.fit-by-purpose | 상세·미리보기(전체가 보여야 함) = contain + surface-2 배경 · 목록 카드(채워야 함) = cover, 중심 피사체 잘림은 C단계에서 확인 | 기본값 | 사용 |
| image.aspect | 컨테이너에 비율 고정. 로딩 전에도 높이 유지 (레이아웃 이동 금지) | 기본값 | 사용 |
| thumbnail.spec |  | 기본값 | (미사용) |
| thumbnail.strip |  | 기본값 | (미사용) |
| thumbnail.title |  | 기본값 | (미사용) |
| thumbnail.pressed |  | 기본값 | (미사용) |
| thumbnail.selected |  | 기본값 | (미사용) |
| thumbnail.selected-visible |  | 기본값 | (미사용) |
| image.transition | 다음 이미지가 준비될 때까지 이전 이미지 유지, crossfade 150ms. 영역 크기 불변 | 기본값 | 사용 |
| image.placeholder | 로딩 = surface-2 스켈레톤, 실패 = surface-2 + 아이콘 image-off 24 | 기본값 | 사용 |
| text.role-lock | 같은 역할 = 같은 type.role. 화면마다 임의 크기 금지 | 기본값 | 사용 |
| text.truncate | 제목은 최대 2줄 · 시간과 상태·필수 동작 가림 방지 | 3단계 레퍼런스와 현재 시안 | 사용 |
| text.short-copy | 버튼·짧은 안내는 한 줄. 넘치면 문구를 줄인다 | 기본값 | 사용 |
| text.long-copy | 긴 안내는 body-sm, 별도 행, 화면 패딩 안에서 자동 줄바꿈 | 기본값 | 사용 |
| text.scale | 시스템 글자 120% 확대에서도 읽고 누를 수 있도록 검토 | 3단계 레퍼런스와 현재 시안 | 사용 |
| copy.user-language | 내부 화면 명칭 금지. "상세 뷰에서 확인" 대신 "이미지를 탭하면 자세히 볼 수 있어요" | 기본값 | 사용 |
| copy.error | 실패 문구는 이유 + 다시 할 수 있는 조건 | 기본값 | 사용 |
| copy.i18n | 다국어면 가장 긴 언어 기준으로 폭 검증 | 기본값 | 사용 |
| layout.left-edge | 한 화면의 모든 섹션 좌측 시작선 = space.screen-padding | 기본값 | 사용 |
| layout.section-gap | 기본 24 · 일정 목록과 타임라인은 8~24 범위 제안 | 3단계 레퍼런스와 현재 시안 | 사용 |
| layout.surface-tiers | 라일락 배경 → 흰 카드 → 연한 AI 강조면 | 3단계 레퍼런스와 현재 시안 | 사용 |
| layout.device-widths | 360 / 390 / 430에서 같은 레이아웃. 열 수 고정, 폭만 늘어남 | 기본값 | 사용 |
| layout.tablet | 기본 미지원. 지원 시 §C에 별도 규칙 | 기본값 | 사용 |
| layout.thumb-zone | primary CTA·자주 쓰는 액션은 화면 하단 1/3. 앱바 우측 액션은 보조에만 | 기본값 | 사용 |
| scroll.single | 세로 스크롤 컨테이너 화면당 1개. 중첩 세로 스크롤 금지. 가로 스트립은 허용 | 기본값 | 사용 |
| scroll.last-item | 스크롤 영역 하단 여백 = 고정 바 높이 + safe-area 하단 + 16 | 기본값 | 사용 |
| fixed.bottom-cta | 높이 56 + safe-area 34, 배경 bg, 상단 border. 본문 하단 여백 106 | 기본값 | 사용 |
| fixed.tab-bar | 홈 · 캘린더 · AI 비서 · 추가 · 루틴 · 안전 영역 고려 | 3단계 레퍼런스와 현재 시안 | 사용 |
| fixed.no-clip | 고정 바·탭바가 마지막 항목·옵션을 가리지 않음을 C단계에서 확인 | 기본값 | 사용 |
| keyboard | 입력 화면은 키보드 높이(약 300)만큼 본문이 올라오고 primary CTA는 키보드 위에 붙는다 | 기본값 | 사용 |
| sheet.sizes | half(화면 50%) / full(safe-area 상단까지). 상단 그랩바 36×4 | 기본값 | 사용 |
| sheet.structure | 헤더 56(제목 + 닫기) · 본문 스크롤 · 푸터 CTA 56 + safe-area. 조작부는 푸터에 고정, 본문 아래로 밀리지 않는다 | 기본값 | 사용 |
| sheet.use | 추가 선택과 상세·상태·더보기는 바텀시트 · 수락 전 원본 보존 | 3단계 레퍼런스와 현재 시안 | 사용 |
| dialog | 확인·경고만. 폭 화면-48, 가운데, 제목 h3 + 본문 body + 버튼 2개(취소 왼쪽) | 기본값 | 사용 |
| dialog.dismiss | 시트는 오버레이 탭·아래로 드래그로 닫힘. 다이얼로그는 버튼으로만 | 기본값 | 사용 |
| app-bar | 높이 56. 뒤로(24) · 제목 h3 · 우측 액션 최대 2개 | 기본값 | 사용 |
| help.inline | 툴팁 없음. 설명은 필드 아래 caption 또는 정보 아이콘 탭 → 바텀시트 | 기본값 | 사용 |
| snackbar | 하단 고정 바 위 16. 높이 48, 4초, 액션 1개 | 기본값 | 사용 |
| layer.order | z.scale 준수. 스낵바(600) > 다이얼로그(500) > 시트(400). 시트 위 다이얼로그 허용, 시트 위 시트 금지 | 기본값 | 사용 |
| state.required | 예정 · 진행 중 · 완료 · 미완료 · 확인 필요와 빈 · 로딩 · 실패 · 오프라인 검토 | 3단계 레퍼런스와 현재 시안 | 사용 |
| state.empty | 안내 문구와 필요한 다음 행동 · 구체 시안 확인 필요 | 3단계 레퍼런스와 현재 시안 | 사용 |
| state.loading | 스켈레톤 후보 · 실제 연동 전 검토 필요 | 3단계 레퍼런스와 현재 시안 | 사용 |
| state.error | 문제와 다시 시도할 수 있는 조건을 안내 | 3단계 레퍼런스와 현재 시안 | 사용 |
| state.offline | 앱바 아래 배너 1줄 | 기본값 | 사용 |
| data.range | 제목 짧음/김, 이미지 세로/가로/정사각, 항목 0/1/많음, 글자 확대 120% — 이 조합으로 C단계 검증 | 기본값 | 사용 |
| data.ownership | 상세·정보 시트는 현재 선택 대상의 정보만 표시 | 기본값 | 사용 |
| change.scope | 요청된 결함만 고친다. 기본 상태 변경 ≠ 조작 제거. 닫기·취소·뒤로·재선택은 유지 | 고정 | 사용 |
| change.relation | 위치 요청은 대상·기준·순서로 확인된 문장만 실행 | 고정 | 사용 |
| change.propagate | 컴포넌트를 고치면 그 인스턴스가 있는 모든 화면을 다시 스크린샷 | 고정 | 사용 |
| change.no-dup | 새 공통 요소 추가 전 같은 액션이 이미 있는지 확인 | 고정 | 사용 |

## C. 프로젝트 전용 규칙

도메인에만 있는 기준(플랫폼 차이, 태블릿, 제스처 등). 인터뷰에서 새로 정의된 것.

| 키 | 값 | 출처 |
|---|---|---|
| screen.home-background | #E2E8FF → #F2F4FC, 홈·캘린더·루틴 | 3단계 사용자 색상 의견 |
| screen.ai-background | #FDEAE2 → #F1E6ED → #E0E2FE, AI 비서 | 3단계 사용자 색상 의견 |
| icon.license | Streamline Core · CC BY 4.0 · 제작자·출처·라이선스·크기 및 색상 변경 표시 | 3단계 Figma 원본 라이선스 |
| icon.navigation | 날짜 탐색의 단순 화살표는 원본 확인 전 기존 시안을 보존 | 3단계 사용자 이미지 |
| calendar.timeline | 일간 시작·종료 축, 시간 겹침 표시, 진행 중 색상 카드 | 3단계 일간 의견 |
| calendar.past-stack | 오늘은 현재·다음 카드 뒤에 실제 지난 카드 최대 3장, 펼치고 접기 | 3단계 사용자 의견 |
| item.actions | 할 일·루틴 완료, 고정 약속 참석 확인과 더보기 | 3단계 사용자 의견 |
| item.temporal-status | 시간 경과와 사용자가 기록한 완료·미완료를 분리 | 3단계 사용자 의견 |
| ai.approval | 변경 제안은 사용자 승인 전 원본 보존, 공동 일정은 상대방 확인 전 기존 일정 유지 | 3단계 사용자 의견 |
| ai.identity | 이미지 기준 친근한 캐릭터, 정확한 형상은 미정 | 3단계 사용자 의견 |
| ai.example | 현재 시안은 실제 AI·계정·캘린더 미연결 | 3단계 현재 시안 |
| rule.scope | 색상·문구 및 크기는 검토용 제안, 현재 화면 구현과 차이가 있을 수 있음 | 3단계 현재 시안 |
