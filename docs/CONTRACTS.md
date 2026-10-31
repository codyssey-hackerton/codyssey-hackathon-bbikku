# PIKKU 최소 공통 계약 v1

2026-10-31 · 세진님/00 MAIN 개발 기준. **아래 공개 타입·HTTP 경로·승인 규칙을 기준으로 개발을 시작한다. 구현·실제 연동 완료를 뜻하지 않는다.** DB 테이블 이름과 제공자별 내부 구현은 담당자가 정한다. 변경 시 소비자와 맞추고 이 문서를 먼저 갱신한다. 제품 범위는 [PRD §2](PRD.md), 역할은 [ARCHITECTURE](ARCHITECTURE.md)를 따른다.

## 1. 전송·공통 규칙

- JSON HTTP, 기본 경로 `/v1`, 최초 구현은 비스트리밍 요청/응답. 식별자는 불투명한 문자열이다. 엔터티 `revision`은 1부터, 사용자별 `scheduleRevision`·`contextRevision`은 0부터 증가하는 정수다.
- 인증은 `Authorization: Bearer <session token>`. 사용자 범위는 서버가 확인한다. 본문/Tool의 `userId`로 권한을 얻을 수 없다. 인증 제공자는 미정이며 로컬 개발용 단일 사용자 세션은 명시적으로 켠 환경에서만 허용한다. 공개 시연 서버에 무인증 개발 모드를 노출하지 않는다.
- 모든 POST 본문에 `requestId`, 쓰기/승인/대화 재전송에는 `Idempotency-Key` 헤더가 필요하다. 추적 ID와 중복 키는 별개다. 같은 사용자·작업 종류·키에 같은 본문이면 첫 결과를 반환하고, 다른 본문이면 `idempotency_conflict`다. 중복 키 해시에서 `requestId`는 제외한다. 예외: 제안 저장 전의 AI/읽기 Tool 실패처럼 서버가 부작용 없음을 확인한 대화 실패는 같은 키·같은 본문으로 다시 처리할 수 있다. 이때도 다른 본문은 충돌이며 동시 재시도는 하나만 실행한다. 저장/발송 결과 불명은 이 예외가 아니다.
- 시점은 오프셋 포함 ISO 8601, 시간대는 IANA(예: `Asia/Seoul`), 시간 길이는 분이다. 구간은 `[시작, 종료)`. 상대 날짜는 서버 시각·사용자 시간대로 해석한다.
- `?`는 생략 가능, `null`은 명시적 미설정이다. 배열의 빈 값은 `[]`. 조회 실패·미설정과 실제 빈 결과를 구별한다. 샘플을 실제 AI/외부 서비스 성공으로 표시하지 않는다.
- 아래에서 `data`는 성공 응답의 본문이다. 성공: `{requestId, data}`. 오류: `{requestId, error: {code, message, retryable, details?}}`. 비밀값은 반환하지 않는다.

## 2. 공유 데이터 타입

| 타입 | 필수 필드와 선택 필드 | 규칙 |
|---|---|---|
| `TimeSlot` | `startsAt: string`, `endsAt: string`, `timezone: string` | 종료 > 시작. |
| `ScheduleFields` | `kind: event/task`, `title: string`, `timeSlot: TimeSlot/null`, `durationMinutes: number/null`, `deadline: string/null`, `flexibility: fixed/flexible`, `involvement: personal/shared`, `completion: pending/completed/incomplete/unknown`, `category?: personal/work/null`, `attendance?: attended/absent/unknown/null` | event는 시간 필수, task는 양수 소요시간 필수. deadline이 있으면 종료가 마감 이내. 미배치 task는 timeSlot=null. 배치 구간은 durationMinutes 이상이어야 한다. category는 공유 여부와 별도이며 생략/null은 미분류다. attendance는 event 전용이며 완료 상태와 독립이고 생략/null은 미기록이다. 기존 completion을 참석으로 추정하지 않는다. |
| `ScheduleItem` | `ScheduleFields` + `id`, `revision`, `sourceRefs: SourceRef[]` | ID/버전/출처는 서버 소유. 완료 항목과 고정 일정은 AI 변경에서 보호. |
| `SourceRef` | `provider`, `accountRef`, `calendarId`, `externalEventId`, `lastSyncedAt`, `occurrenceKey?`, `sourceVersion?` | 모두 문자열. 계정 참조는 비밀키가 아님. 반복 회차 보존. |
| `MemoryFact` | `id`, `revision`, `kind: preference/situation/observation/inference`, `key: string`, `value: JSON`, `source: {type: user/provider/derived, ref: string}`, `recordedAt`, `validUntil: string/null` | v1 쓰기는 명시적 preference/situation만. situation은 만료 필수. 미확인 상황을 영구 선호로 승격하지 않음. |
| `ContextSnapshot` | `now`, `timezone`, `scheduleRevision`, `contextRevision`, `items: ScheduleItem[]`, `facts: MemoryFact[]`, `missingFields: string[]` | 필요한 범위만 조회. 만료된 사실은 유효한 맥락에서 제외. |
| `ValidationResult` | `valid: boolean`, `conflicts: {targetIds: string[], reason: string, timeSlot?: TimeSlot}[]`, `missingFields: string[]`, `protectedTargets: string[]`, `checkedScheduleRevision`, `checkedContextRevision`, `checkedAt` | 부족 정보/충돌/보호 대상이 있으면 valid=false. |

온보딩·프로필의 계획 선호는 기존 Memory에 사용자별 `kind: preference`, `key: planning_preferences`, `validUntil: null`인 한 fact로 저장한다. 값은 `{version: 1, goals: ('work'|'health'|'life')[], timing: {preparationMinutes: number|null, travelEstimateMinutes: number|null, bufferMinutes: number|null}, preferredPeriod: 'morning'|'afternoon'|'unknown'|null, onboardingStatus: 'completed'|'skipped'}`다. goals는 중복 없는 명시적 선택, 시간은 0~1440 정수이며 null은 미설정이다. 최초 건너뛰기는 빈 goals·null 시간·null 선호시간에 skipped를 기록한다. 기존 값이 있을 때 건너뛰기는 기존 선택을 유지한다. 이 값의 클라이언트 검증과 별개로 공통 Memory API는 일반 JSON을 허용하므로 해당 형태를 서버에서 강제한다고 가정하지 않는다.

계획에 선호가 필요할 때 Agent는 `read_memory`에서 이 키의 사용자 출처 preference와 유효한 버전 1 선택값만 근거로 사용한다. 조회 결과에는 같은 키의 다른 kind도 포함될 수 있다. 미설정·미확인은 추정하지 않으며 `travelEstimateMinutes`는 사용자가 고른 참고값이지 실제 약속 경로 조회 결과가 아니다. 선호 조회·저장은 일정 자동 변경이나 제안 승인이 아니다. 쓰기는 기존 `expectedContextRevision`과 멱등성, 소유 사용자 범위를 따르고 stale 시 기존 값을 다시 조회해 확인한다.

`ChangeSet = {changes: Change[], timingConstraints?: TimingConstraint[]}`. Change는 다음 중 하나다. 빈 변경 묶음은 허용하지 않는다. 서로 의존하는 묶음은 전체 적용 또는 전체 거절한다.

```ts
type Change =
  | { changeId: string; operation: 'create'; after: ScheduleFields }
  | { changeId: string; operation: 'update'; targetId: string; expectedRevision: number; after: ScheduleFields }
  | { changeId: string; operation: 'delete'; targetId: string; expectedRevision: number };
```

update는 사용자에게 보여준 전체 편집 필드를 교체한다. 호환성을 위해 `category`와 `attendance`를 생략하면 기존 값을 보존하고, null을 포함해 명시하면 교체한다. 참석 기록이 있는 event를 task로 바꿀 때는 attendance를 명시적으로 null로 지워야 한다. 제안 검증과 승인에도 같은 보존 규칙을 적용한다. `before`, ID, 출처, 실제 버전은 서버가 조회/부여한다. 클라이언트가 보낸 과거 값은 검증 근거가 아니다. 같은 대상을 한 묶음에서 여러 번 수정하지 않는다.

`TimingConstraint`는 `{appointment: {kind: 'existing', id, expectedRevision} | {kind: 'change', changeId}, preparationMinutes: number/null, travelMinutes: number/null, bufferMinutes: number/null, segments: {preparation: string/null, travel: string/null, buffer: string/null}}`다. 약속은 기존 항목의 ID·버전 또는 같은 변경 묶음의 약속 변경을 참조한다. 각 소요가 0이면 해당 segment는 null이며, 양수 구간은 같은 제안의 create/update task를 changeId로 참조하고 역산한 시작·종료·소요와 정확히 일치해야 한다. 같은 관계 또는 다른 관계 사이의 중복·충돌과 불일치는 거절한다. null 소요는 `missingFields`로 표시해 질문하며 0으로 추정하지 않는다. 저장·승인·연락 반영 시 같은 서버 검증을 적용한다.

이 제약은 제안에 명시된 관계만 검증한다. 소요 숫자는 모델이 제안한 입력일 수 있으므로 사용자 확인 사실이나 실제 경로의 검증 결과로 표현하지 않는다. 제약이 없는 암묵적 관계 전체의 보장도 아니다. 선택 필드가 저장된 데이터는 구버전 strict decoder와 호환되지 않을 수 있으므로 같은 DB의 API·예약 프로세스를 구·신 버전으로 혼용하거나 검토 없이 구버전 코드만 롤백하지 않는다.

`Proposal` 필수 필드: `id`, `revision`, `mode: personal/coordination`, `baseScheduleRevision`, `baseContextRevision`, `changeSet`, `beforeItems: ScheduleItem[]`, `reason`, `evidenceRefs: string[]`, `validation`, `createdAt`, `expiresAt: string/null`, `status: pending/awaiting_contact/applied/rejected/stale/expired/failed`. 대안마다 별도의 Proposal ID를 쓴다. 공동 약속의 시간 변경·취소가 들어가면 coordination이다. v1 연락 조정은 공동 event 한 건만 다룬다. shared task의 시간 변경·삭제·personal 전환은 지원 전이므로 거절하고, 제목 같은 비조정 변경만 해당 권한 범위에서 허용한다. `coordinationTarget: {id, expectedRevision}/null`을 Proposal에 보관하며 personal은 null이다.

`Approval` 필수 필드: `id`, `subjectType: proposal/contact_request`, `subjectId`, `subjectRevision`, `decision: accept/reject`, `decidedAt`, 서버가 확인한 `actorRef`. 서버는 승인 시점의 불변 대상 내용도 보관한다. 연락의 경우 수신자·채널·내용·허용 대안 전체에 승인이 묶인다. 단순 `approvalId` 존재만으로 실행하지 않는다.

다중 캘린더는 확인된 동일성 근거/사용자 확인으로만 연결한다. 제목·시간만으로 합치지 않고 모든 SourceRef와 원본별 값을 보존한다. 원본 충돌은 표시하고 임의 선택하지 않는다. 최초 제공자 이후 추가 캘린더·양방향 전파·반복 편집 전체는 확장 범위다.

### 2026-10-31 최소 기능 보완

- `read_memory`는 유효한 null fact를 반환하되, 요청한 key에 non-null 값이 하나도 없으면 `missingFields`에 포함한다. `0`, `false`, 빈 문자열은 null과 구분한다. key 생략(keys=[])은 전체 유효 fact 조회 의미를 유지한다.
- `ai_proposal`이 동일 내용의 update만 포함하면 `no_effective_change`로 거절한다. 절대시각과 timezone을 포함해 전체 일정 필드의 동일성을 확인한다. 직접 저장(`user_command`)과 실질 변경이 섞인 ChangeSet은 기존 의미를 유지하며 일부 변경을 몰래 제거하지 않는다.
- 수정 요청은 기존 제안을 덮어쓰는 승인이 아니다. 사용자가 편집한 채팅 요청에서 새 제안을 생성하고 전체 변경을 다시 승인한다. 원래 제안은 기존 상태/최신성 규칙을 따른다.

## 3. Agent·Tool 계약

기준은 `gpt-6.1-terra`, `reasoning.effort: high`, Responses API다. 실제 접근 검증 범위는 MODEL_VERIFICATION.md를 따른다. 접근 실패 시 다른 모델/effort로 자동 대체하지 않는다. 한 S LLM이 제출된 대화를 처리하며 “고마워”에 Tool이나 전체 재계획을 강제하지 않는다.

고정 공동 약속도 사용자가 앱에서 조정 검토 대상을 명시적으로 선택하면 `coordinationTarget` 범위에서 **검토용 대안 생성**이 가능하다. 서버가 대상 소유·버전·선택을 확인해 Engine의 coordination 검증 범위에 주입한다. LLM이 이 범위를 만들어 보호를 해제할 수 없다. 완료 항목과 선택 밖 고정 일정은 계속 보호한다. 이 선택은 일정 반영이나 연락 승인이 아니며 실제 반영은 §7을 따른다.

Agent 입력: 인증된 사용자 범위, `requestId`, `conversationId`, `message` 또는 `TriggerEvent`, 선택적인 서버 검증 `coordinationTarget`, `now`, `timezone`, 관련 대화. 필요한 일정/Memory는 Tool로 조회한다. S LLM 내부 `proposalDraft`에는 `changeSet`, `reason`, `evidenceRefs`를 담는다. ID/검증 성공/승인을 모델이 발급하지 않는다.

서버가 앱에 반환하는 `AgentResult`:

```ts
type AgentResult =
  | { kind: 'reply'; message: string; draft?: FormDraft }
  | { kind: 'question'; message: string; missingFields: string[] }
  | { kind: 'proposal'; message: string; proposalIds: string[] }
  | { kind: 'failure'; message: string; code: string; retryable: boolean };
```

서버가 검증하고 저장한 Proposal만 proposalIds로 반환한다. 검증 실패는 질문/실패로 반환한다. 답변에 변경 완료라고 쓰는 것만으로 실행 완료가 되지 않는다.

채팅의 선택적 `entryContext`는 `{kind:'create'}`, `{kind:'item',id,expectedRevision}`, `{kind:'form',draft:FormDraft}` 중 하나다. `coordinationTarget`과 동시에 보낼 수 없다. item은 인증 사용자의 최신 항목과 버전을 서버에서 확인하고 모델에는 서버가 조회한 값만 제공한다. create는 새 입력 작성, item은 선택한 항목의 질문·변경 검토, form은 현재 입력 초안 지원이다.

`FormDraft = {kind:'event'|'task'|'routine',fields:Record<string,string|string[]>}`이며 서버가 종류별 허용 필드·길이·배열을 검증한다. form 응답은 원래 초안의 필드 범위와 종류를 유지해야 하며 Proposal 저장은 허용하지 않는다. reply의 draft는 미반영 입력 제안으로, 앱에서 원래 폼 세션·종류를 확인하고 사용자에게 기존 값과 비교·적용 선택을 제공한다. 실제 저장은 폼의 별도 저장 동작이다. 루틴 규칙 초안도 같은 흐름이며 기존 회차를 변경하는 승인으로 해석하지 않는다. UI 전환용 context key는 서버 권한 근거가 아니다.

| 읽기/계산 Tool | 입력 | 출력 |
|---|---|---|
| `read_schedule` | `{from, to, timezone}` | `{items, scheduleRevision}` |
| `read_memory` | `{keys: string[], at: string}` | `{facts, contextRevision, missingFields}`; keys=[]이면 유효한 사실 전체, 지정하면 해당 키만 |
| `calculate_timing` | `{appointmentStart, preparationMinutes, travelMinutes, bufferMinutes}` | `{ready: true, departureAt, preparationStartAt}` 또는 `{ready: false, missingFields, message}` |
| `validate_changes` | `{changeSet}` | 서버가 최신 snapshot을 조회한 `ValidationResult` |
| `search_places` | `{query}` | 장소 ID·이름·주소, 선택 필요 여부 |
| `estimate_travel` | `{originPlaceId, destinationPlaceId, mode: walk/transit/car}` | 현재 시각 기준 이동 분, 미래 출발 예측 미지원 표시 |
| `get_weather` | `{placeId, at}` | 오프셋 포함 시각의 예보·시간 기준·출처·라이선스 |
| `get_subway_arrivals` | `{stationName}` | 해당 역의 열차 도착·원문 생성시각·오래됨 표시 |
| `list_calendars` | `{}` | 연결된 사용자 Calendar 목록(최대 20개) |
| `read_calendar_events` | `{calendarId, from, to}` | 해당 Calendar의 일정(최대 31일·50개), 미지원 건수 |
| `list_contact_requests` | `{proposalId?}` | 사용자 소유 연락 이력(최대 20개) |
| `read_contact_replies` | `{contactRequestId}` | 발송 완료 이메일의 회신 후보(최대 20개), 사용자 확인 필요 |

Tool 사용자 범위는 실행기가 주입한다. 알 수 없는 Tool/잘못된 인수/권한 밖 조회는 거절한다. 외부 조회 어댑터는 §7 포트로 추가한다. LLM에 쓰기·발송 Executor를 직접 노출하지 않는다. 적용 직전 검증은 Tool 선택과 별개로 필수다. AI가 새로 배치하거나 시간을 바꾸는 일정의 시작이 검증 시점보다 과거이면 거절한다. 사용자 명시적 과거 기록과 시간이 그대로인 메타데이터 편집을 일괄 금지하는 규칙은 아니다.

이동·날씨 도구는 같은 Agent 실행에서 검색된 장소 ID만 사용한다. 검색 결과가 여러 개면 사용자에게 선택을 요청하도록 모델에 안내한다. 좌표는 실행별 서버 메모리에 최대 5분 보관하고 모델에 반환하지 않는다. 성공 응답은 `{ok: true, provider, fetchedAt, expiresAt, data}`이며 데이터는 `untrusted: true`로 표시한다. 장소·이동·날씨 결과의 유효기간은 최대 5분, 역 도착 정보는 최대 15초다. 이동 결과는 현재 시각 기준이며 지하철은 역별 열차 정보이지 전체 여정 ETA가 아니다. 미설정·권한 오류·시간 초과·조회 실패·만료 등은 성공 빈 결과와 구분한다.

계정 조회 도구의 성공은 `{ok: true, provider, fetchedAt, expiresAt, data}`이고 데이터에는 결과 상한 적용 여부 `truncated`와 `untrusted: true`가 있다. 유효기간은 5분이다. 회신은 `outcome: 'unclear'`, `reviewRequired: true`로 반환하며 사용자의 UI 확인 없이 연락 기록·일정·승인을 변경하지 않는다. 다른 사용자의 저장 데이터와 포트는 접근하지 않으며 조회 도중 연락이 바뀌면 `stale`이다. 오류는 `invalid_request/not_configured/not_found/forbidden/provider_unavailable/stale`로 구분하고 제공자 오류 원문·토큰·발송 식별자·연락 수신 주소는 별도 출력하지 않는다. Calendar ID는 이메일 형식일 수 있고 회신 발췌에는 개인정보가 포함될 수 있다. 외부 결과의 텍스트는 모델을 위한 명령이 아니다.

한 실행에서 성공한 외부 도구의 유효한 `expiresAt` 중 가장 이른 값을 채택한다. 빈 결과도 성공이면 포함하고 `ok: false`는 포함하지 않으며, 성공 결과에 만료 시각이 없거나 형식이 잘못되면 실패한다. 앞선 성공 뒤 다른 조회가 실패해도 앞서 관측한 최단 만료는 유지한다. 답변·질문·제안 완료 전 만료되면 재시도 가능한 `external_data_expired`로 차단하고 재조회한다. 제안 저장 시 이 시각과 기존 제안 만료 중 더 이른 값을 쓴다. 이후 승인·연락 반영에도 기존 만료 검사를 적용한다.

외부 조회에 의존한 assistant 대화 기록에는 선택적 `externalExpiresAt`을 함께 보존한다. 다음 실행은 아직 유효한 기록의 만료를 상속하고, 만료됐거나 형식이 잘못된 기록은 재조회 안내로 대체해 모델에 전달한다. 메타데이터 자체는 모델 대화 본문에 전달하지 않는다. 예약 재검토에서 외부 정보가 만료되면 완료로 기록하지 않고 재시도 가능한 실패로 처리한다.

### 준비계획 전용 경로

`POST /v1/preparation-proposals`는 `{requestId, targetId, expectedTargetRevision, expectedScheduleRevision, timezone, preparationMinutes, travelMinutes, bufferMinutes}`와 `Idempotency-Key`를 받는다. 반환은 `{requestId, data: {result: AgentResult}}`다. 시간 있는 미완료 event 한 건을 선택하고 모든 소요시간을 사용자가 입력한다. 0은 허용하되 전부 0은 거절하며 누락 값을 0으로 추측하지 않는다.

서버가 기존 시간 계산 함수로 준비·이동·도착 여유 구간을 만들고 0보다 큰 구간만 개인 task의 변경안으로 구성한다. 일정 충돌·과거 시작·원본 버전·전체 일정/맥락 최신성 검증 후 기존 제안 저장/승인 경로를 이용한다. 약속 자체는 변경하지 않는다. 이 요청은 제안 생성이며 확정 저장이 아니다. 일반 LLM 출력 전체에 준비시간 관계를 강제하는 스키마 확장은 아니다.

## 4. HTTP v1 — 앱·백엔드가 먼저 연결할 경로

본문의 `requestId`와 쓰기의 Idempotency-Key는 §1 공통이다. 표의 응답은 성공 envelope의 `data`다. 미구현 경로는 성공 모의 응답 대신 501 `not_implemented`, 미설정 제공자는 503 `not_configured`로 표시한다.

| 경로 | 입력 | 응답 |
|---|---|---|
| `GET /health` | 없음, 인증 불필요 | `{status: 'ok'}` (프로세스 생존만 뜻함) |
| `GET /v1/capabilities` | 인증 | `{storage: {mode: memory/postgres, durable: boolean}, model: {id, reasoningEffort, status}, integrations: {calendar, email, phone, travel}, scheduler: {status}}`; 각 status는 not_configured/available/degraded. available은 실행 경로 사용 가능이며 이번 호출 성공 보장 아님 |
| `POST /v1/chat` | `{requestId, conversationId: string/null, message: string, timezone, coordinationTarget?: {id, expectedRevision}, entryContext?: ChatContext}` (두 context 동시 사용 불가) | `{conversationId, result: AgentResult}`; 초안은 §3 참고 |
| `GET /v1/schedule` | query `from`, `to`, `timezone`, `includeUnscheduled=true/false` (기본 false) | `{items: ScheduleItem[], scheduleRevision}`; 겹치는 구간 조회, true이면 미배치 task도 포함 |
| `POST /v1/schedule/commands` | `{requestId, expectedScheduleRevision, changeSet}` | `{outcome: 'applied', items: ScheduleItem[], deletedIds: string[], scheduleRevision}` |
| `GET /v1/proposals` | query `status?`, `cursor?`, `limit?` (기본50, 최대100) | `{proposals: Proposal[], nextCursor: string/null}`; 현재 사용자, createdAt·id 내림차순. 예약 생성안도 같은 목록에서 조회 |
| `GET /v1/proposals/:id` | ID | `{proposal: Proposal}` |
| `POST /v1/proposals/:id/decision` | `{requestId, proposalRevision, decision: accept/reject}` | `{outcome: applied/rejected/awaiting_contact, proposal, scheduleRevision}` |
| `POST /v1/schedule/:id/checkin` | `{requestId, expectedRevision, completion: completed/incomplete/unknown}` | `{item, scheduleRevision}`; 상태만 갱신, 이동 없음 |
| `POST /v1/schedule/:id/attendance` | `{requestId, expectedRevision, attendance: attended/absent/unknown}` | `{item, scheduleRevision}`; event의 참석만 갱신 |
| `POST /v1/schedule/:id/undo` | `{requestId, expectedRevision, field: completion/attendance}` | `{item, scheduleRevision}`; 사용자별 해당 상태의 직전 값을 한 번 복원. 이력이 없거나 이미 복원했으면 409 `no_undo` |
| `GET /v1/memory` | query `at` | `{facts, contextRevision}`; 현재 사용자 유효 사실 |
| `POST /v1/memory` | `{requestId, expectedContextRevision, kind: preference/situation, key, value, validUntil: string/null}` | `{fact, contextRevision}`; 같은 kind/key는 새 revision으로 대체, 출처는 서버가 user로 기록 |
| `GET /v1/review-schedule` | 인증 | `{reviewSchedule: ReviewSchedule}` |
| `POST /v1/review-schedule` | `{requestId, expectedRevision, timezone, evening: {enabled, localTime}, morning: {enabled, localTime}}` | `{reviewSchedule}`; 검증·저장하고 이후 예약에 반영 |
| `POST /v1/recipients` | `{requestId, displayName, channel: email/phone, address, confirmed: true}` | `{recipient: {id, displayName, channel, address, confirmedByUserAt}}`; 사용자가 입력·확인한 수신자 참조 생성, 발송 없음 |
| `POST /v1/contact-requests` | `{requestId, recipientRef, channel: email/phone, purpose, messageOrCallBrief, allowedOptions: {optionId, proposalId, proposalRevision}[]}` | `{contactRequest}`; 검증된 초안 저장만, 발송 없음 |
| `GET /v1/contact-requests/:id` | ID | `{contactRequest}` |
| `GET /v1/contact-requests` | 선택 query `proposalId` | `{contactRequests}`; 인증 사용자 최신 생성순 최대 100건, 연락 화면 재진입 복구용 |
| `POST /v1/contact-requests/:id/decision` | `{requestId, contactRevision, decision: accept/reject}` | `{contactRequest}`; accept는 최신 내용 재검증 후 ready, reject는 rejected로 종료, 실행기는 ready만 수신 |
| `GET /v1/email-connection` | 인증 | `{status: available/not_configured, senderAddress: string/null}`; 현재 사용자에게 묶인 Gmail 연결, 토큰 반환 없음 |
| `POST /v1/contact-requests/:id/send` | `{requestId, contactRevision, expectedSenderAddress}` + `Idempotency-Key` | `{contactRequest}`; ready·승인 스냅샷·최신 기준 재검증 후 영속 실행 의도 기록, Gmail 단일 시도 |

일정 commands는 직접 폼 저장 경로이며 AI 추가 변경을 끼워 넣지 않는다. 충돌은 409로 거절하고 해결 선택을 받는다. **이미 존재하는 공동 약속의 시간 변경·취소는 `contact_required`로 분기**하며 직접 저장으로 상대 수락을 우회하지 않는다. 공동 약속 최초 등록은 이미 정해진 약속의 기록이며 연락 승인을 뜻하지 않는다. 메모·제목·본인 체크인 같은 비조정 변경은 해당 권한만 검증한다. 공동 약속의 involvement를 personal로 바꿔 이 경계를 우회할 수 없다. 외부 쓰기 권한은 별도다.

제안 decision의 accept는 **personal이면** 재검증 후 적용한다. **coordination이면** awaiting_contact로 전환하고 기존 일정은 유지한다. 연락 초안과 승인에는 별도 경로를 사용한다. UI는 연락 카드에서 §7의 전체 범위를 한 번 확인받을 수 있으며 일반 proposal accept를 먼저 강제하지 않는다. 연락 승인 자체가 나열된 대안의 조건부 적용 동의를 포함한다.

연락 거절은 발송이나 일정 변경을 허가하지 않는다. 사용자·요청 버전·대기 상태·불변 초안 일치를 확인한 뒤, 대안이 만료되거나 현재 일정·맥락·수신자가 변경되어도 원본 스냅샷을 거절 기록으로 보존하고 종료할 수 있다. accept에는 최신성·만료·수신자·대안 전체 검증을 적용한다.

오류 코드/HTTP: `invalid_request` 400, `unauthenticated` 401, `permission_denied` 403, `not_found` 404, `conflict/stale_proposal/expired_proposal/idempotency_conflict/contact_required/no_undo` 409, `missing_information` 422, `not_implemented` 501, `not_configured/provider_unavailable` 503. `outcome_unknown`은 외부 실행 결과의 상태이며 무조건 재실행 가능한 오류로 반환하지 않는다. 같은 요청이 실행 중이면 409 `operation_in_progress`와 조회 대상 참조를 반환한다. 제안의 business failure는 AgentResult.failure로, 인증/전송/제공자 전체 실패는 HTTP 오류로 구별한다.

## 5. 저장·승인·Scheduler

PostgreSQL을 저장 기준으로 채택한다. 호스팅은 미정이다. Repository 경계는 `readSnapshot`, `saveProposal`, `recordDecision`, `applyChangesIfCurrent`다. 일정·제안·승인·Memory·연락작업·중복 실행 결과를 저장한다. 실제 테이블/마이그레이션은 찬욱님과 맞춘다. 테스트용 memory 어댑터는 durable=false이며 재시작 복구 증거가 아니다.

현재 초기 구현은 [사용자별 영속 JSONB 저장 계약](../apps/api/DATABASE.md)을 사용한다. 상태·승인·멱등 결과는 한 트랜잭션이며, 모델 호출은 그 바깥에서 수행하고 최종 확정 전에 버전을 다시 확인한다. 연락 초안·불변 승인·발송 실행 의도와 결과도 저장한다. 회신과 조건부 반영의 추가 저장 필드·호환성은 §9를 따른다. 운영 정규화 테이블은 이 데이터를 보존하는 마이그레이션으로 담당자와 맞춘다.

반영은 권한·승인 버전·만료·최신 시각·일정/맥락 버전·충돌을 다시 검사한다. `scheduleRevision`/`contextRevision`이 바뀌면 stale 처리하며 **내용이 같더라도 새 기준으로 검증한 제안을 재확인**한다. v1 제안 만료는 생성 후 30분, 판단 snapshot의 유효한 일시 상황 만료, 새로 배치/이동하는 시작 시각 중 가장 이른 값이다. 시간 경과로 Memory가 만료됐는데 revision이 같다는 이유로 오래된 근거를 재사용하지 않는다. 버전 조건부 일정 변경과 결과/중복 기록은 하나의 DB 트랜잭션으로 저장한다. 승인/작업 재전달에는 기존 결과를 돌려주며 이미 반영된 작업을 재실행하지 않는다.

Scheduler는 서버의 pg-boss + PostgreSQL. TriggerEvent 필수: `id`, 서버 사용자 범위, `reason: evening_plan/morning_review/schedule_changed/checkin_changed`, `scheduledFor`, `timezone`, `targetDate`, `idempotencyKey`; 선택: `sourceRevision`. 사용자별 `ReviewSchedule = {revision, timezone, evening: {enabled, localTime}, morning: {enabled, localTime}}`, localTime은 HH:mm 또는 null. enabled=true이면 시각 필수, 초기 revision=0·disabled·localTime=null이다. 21시는 예시이고 기본 고정값이 아니다.

예약 발생 키는 사용자+이유+예약시각을, 상태 이벤트 키는 원본 변경 ID/버전을 포함한다. DB에 실행 상태와 결과를 기록한다. 전날 추천 대상은 다음 날, 아침 검토 대상은 당일. 기한 지난 예약은 무조건 몰아서 실행하지 않는다. **v1은 예정 시각으로부터 60분 초과 지연 시 skipped**, 이내이면 최신 맥락으로 1회 검토한다. 이 수치는 초기 운영값이며 설정 변경 가능하다. 자동 검토는 제안만 만들며 승인/발송 권한이 아니다. 예약 생성 제안은 GET /v1/proposals로 조회하며 앱 진입/새로고침에서 가져온다. 실제 푸시 전달은 별도 미정이다.

## 6. 최소 검증 기준

- “고마워”는 답변만; 오전 휴식/오전 공부 요청은 같은 일정에서 유효한 다른 대안과 근거.
- 15시 약속·이동30분·여유10분이면 출발14:20, 준비15분이면14:05/45분이면13:35.
- 직접 저장 충돌은 다른 일정을 자동 이동하지 않음. 고정/완료 항목 AI 변경 차단.
- 거절·무응답·모델 실패는 기존 일정 유지. 같은 승인 재전달은 같은 결과. 일정/맥락 변경·동시 저장은 stale 차단.
- 미완료 체크인만으로 재배치하지 않음. 유효성을 확인해 별도 제안. 영향 없는 지연은 기존 계획 유지.
- 캘린더 동일성 근거 없는 자동 병합 없음. 서로 다른 반복 회차/원본 시간 충돌 보존.
- 연락 승인 전 발송 없음. 대상/내용/대안 변경은 새 승인. 수락 전 일정 유지. 외부 결과 불명 시 자동 재발송 없음.

이 목록은 통과 결과가 아니다. 실제 검증 환경·명령·관찰·미검증을 PR에 구별해서 기록한다.

## 7. 실제 연락대행·외부 어댑터

`ContactRequest` 필수: `id`, `revision`, `baseScheduleRevision`, `baseContextRevision`, `recipientRef`, `recipientSnapshot: {displayName, channel, address}`, `channel: email/phone`, `purpose`, `messageOrCallBrief`, `allowedOptions: {optionId, proposalId, proposalRevision}[]`, `approvalId: string/null`, `executionKey`, `providerOperationId: string/null`, `deliveryStatus`, `negotiationStatus`, `createdAt`. 수신자 참조는 POST /v1/recipients에서 사용자가 확인한 주소/번호와 연결하며 해당 내용은 승인 시 불변 스냅샷으로 저장한다. 전화는 E.164 형식, 이메일은 유효한 주소 형식을 검사하되 이것만으로 실제 상대 신원/도달 성공을 보장하지 않는다. 수신자 주소 수정은 새 참조를 생성하고 카드에 전체 대상을 다시 표시한다. 연락 내용/대안 수정은 새 revision과 승인, 새 실행 의도를 만든다. 상태 갱신만으로 승인 대상 revision을 바꾸지 않는다.

- deliveryStatus: `pending_approval/rejected/ready/submitting/sent_or_connected/failed/outcome_unknown`.
- negotiationStatus: `not_started/awaiting_response/accepted/declined/alternative_proposed/needs_user_review/applied`.
- `ContactResponse`: `{id, contactRequestId, providerEventId, receivedAt, outcome: accepted/declined/alternative_proposed/unclear, selectedOptionId: string/null, evidenceRef}`. 수신자/스레드 연관을 확인한 서버 어댑터만 생성하며 외부 콜백 서명·권한을 검증한다. 공개 앱 요청으로 상대 수락을 만들어낼 수 없다.

allowedOptions는 같은 공동 약속의 독립적인 검증된 대안들이며 공통 기준 일정/맥락 버전을 가진다. 서버가 생성 시 검사한다. 사용자는 수신자·채널·공유 내용·허용한 시간 대안과 **상대가 그중 하나를 수락하면 현재 상태 재검증 후 적용한다는 범위**를 확인한다. 승인 시/발송 직전에 그 불변 내용과 현재 버전·권한을 검사한다.

상대 수락 전 원래 약속을 유지한다. 발송/연결/통화 종료는 수락이 아니다. accepted라도 선택한 option이 모호하면 needs_user_review다. 수락한 대안이 허용 범위 안이고 최신 일정·맥락·권한이 일치할 때만 조건부 반영한다. 범위 밖 대안, 지연 회신, 새 충돌, 만료는 needs_user_review로 돌려 새 확인을 받는다. 자동 회신 조회 미구현을 수락으로 표시하지 않는다.

| 포트 | 입력 | 출력 |
|---|---|---|
| `CalendarPort.list` | 인증 사용자 연결 참조, calendarId, from/to | SourceRef 포함 원본 일정, 조회시각/오류 |
| `CalendarPort.apply` | 승인된 외부 변경, 원본/회차/기대버전, 실행키 | 원본 버전·작업ID·상태; 쓰기/초대 알림 여부는 실행 계획에서 명시 |
| `TravelPort.estimate` | 출발/도착 좌표, mode, departureAt | `{durationMinutes, provider, fetchedAt, expiresAt}` 또는 unsupported/오류 |
| `ContactPort.dispatch` | 승인된 ContactRequest 불변 내용, executionKey | `{providerOperationId, status: submitted/failed/outcome_unknown}` |
| `ContactPort.lookup` | providerOperationId | 전달 상태, 검증된 ContactResponse 또는 미확인 |

외부 부작용은 로컬 DB와 원자적이지 않다. 실행 의도를 먼저 기록하고 중복 작업/콜백을 식별한다. 타임아웃의 성공 여부를 모르면 outcome_unknown으로 보존하고 제공자 조회/사용자 확인으로 해결한다. 제공자별 보장이 없는 재시도를 정확히 한 번 발송이라고 부르지 않는다. 캘린더 초대 알림과 별도 이메일의 이중 통지는 실행 계획에서 방지한다.

Gmail v1 발송은 PostgreSQL 등 영속 저장이 있어야 한다. send 요청은 화면에서 확인한 `expectedSenderAddress`를 포함하고 멱등 지문에도 묶는다. 현재 연결의 발신 주소가 다르면 무발송 충돌로 거절하고 계정을 다시 확인받는다. API는 `submitting`과 요청 식별을 먼저 확정하고 DB 잠금 밖에서 전송한다. 중복 요청이나 중단된 발송을 자동 재전송하지 않는다. 성공 응답의 메시지 ID는 Gmail 접수 증거이며 상대 수락·실제 수신 확인을 의미하지 않는다. `failed/outcome_unknown`을 새 승인 없이 ready로 되돌리는 경로는 제공하지 않는다. 발송 권한과 회신 읽기 권한은 분리하며 회신 처리·사용자 확인·조건부 반영은 §9를 따른다.

Gmail 우선 연결을 선택했고 Google Calendar 읽기·선택 가져오기와 Twilio 제한 음성 경로를 구현했으며 실제 검증 상태는 PROVIDER_SETUP을 따른다. 지도는 Kakao를 선택했고 장소 검색은 §10, 경로·이동시간은 별도 검증 대상이다. OAuth 접근 동의는 개별 연락 승인이 아니다. Calendar 읽기/쓰기, Gmail 발송/회신 읽기 권한은 구분한다. 개발용 Gmail OAuth 콜백은 PROVIDER_SETUP에 명시하며 그 밖의 제공자 콜백·운영 DB 스키마·음성 모델·푸시 제공자는 미정으로 이 경계를 유지해 병렬 검증한다. 실제 테스트 발신·발송에는 승인된 테스트 상대와 내용이 필요하다.

## 8. 첫 Calendar 읽기·선택 가져오기 / Twilio 전화 증분

이번 API 계약은 구현 증분이며 실제 계정 연결·배포 성공을 뜻하지 않는다. 일반 응답/오류/인증은 §4와 같다.

| API | 입력 | data / 동작 |
|---|---|---|
| `GET /v1/calendar-connection` | 인증 | `{status: available/not_configured, accountLabel: string/null}` |
| `GET /v1/calendar/calendars` | 인증 | `{calendars: [{id, summary, timeZone?}]}` |
| `GET /v1/calendar/events` | query `{calendarId, from, to}` | `{events: [{id, etag, title, startsAt, endsAt, timezone}], unsupportedCount}` |
| `POST /v1/calendar/import` | `{requestId, calendarId, from, to, selectedEvents: [{id, etag}], expectedScheduleRevision}` + Idempotency-Key | `{items, scheduleRevision}`; 선택 전체를 검증 후 원자 저장 |
| `GET /v1/phone-connection` | 인증 | `{status: available/not_configured, senderNumber: string/null, lastRequestId?: string/null, provider?: clawops/twilio, mode?: agent/voiceml}`; 비밀 반환 없음 |
| `POST /v1/phone-connection` | 관리형 `{requestId, provider:"clawops", mode:"agent", accountId, apiKey, agentId, fromNumber}` / ClawOps VoiceML `{requestId, provider:"clawops", mode?:"voiceml", accountId, apiKey, signingSecret, fromNumber}` / 기존 Twilio `{requestId, accountSid, authToken, fromNumber}` | 위 연결 상태. HTTPS 또는 명시적 로컬 개발 loopback만, 사용자별 서버 비밀 저장 |
| `POST /v1/contact-requests/:id/call` | `{requestId, contactRevision, expectedSenderNumber}` + Idempotency-Key | `{contactRequest}`; phone 채널의 승인·최신 상태·영속 실행 의도 확인 후 단일 발신 시도 |

**Calendar:** 개발 사용자에게 바인딩한 별도 OAuth 연결이며 Gmail 발송 동의만으로 접근하지 않는다. 시간형 단일 일정만 가져온다. 종일·반복·취소/기타 미지원 원본은 개수와 미지원 안내로 구분한다. 전체 페이지를 읽지 못하면 빈 결과/부분 성공을 반환하지 않는다. 서버가 선택 원본을 재조회하고 사용자가 본 etag와 일치해야 한다. 원본 출처 키·사용자 범위·일정 revision·충돌을 확인하며 원본 중복은 409다. Google의 전체 동기화·원본 변경·교차 캘린더 중복 병합·삭제 전파 기능이 아니다. Google 재조회와 로컬 커밋은 외부 원본에 대해 원자적이지 않다.

가져오기 준비 조회는 사용자 DB 잠금 밖에서 실행하고 내부 ticket만 생성한다. 최종 저장은 멱등 결과와 같은 트랜잭션에서 재검증한다. ticket을 외부 요청 입력으로 받지 않는다. 프로세스 중단 후 안전한 조회/내부 쓰기 작업의 회복과 실제 외부 발송 재시도는 구분한다.

**전화:** 신규 ClawOps 연결의 기본은 관리형 음성이며 계정 ID·API 키·agent ID와 계정 소유 발신번호를 입력한다. 번호와 agent의 실존을 읽기 전용으로 확인하며 웹훅 서명키는 필요하지 않다. 기존 VoiceML 모드는 별도 서명키를 요구하고, Twilio Account SID/Auth Token 입력과 저장 파일은 보존한다. 번호는 앱·저장소에서 E.164를 유지하고 ClawOps 전송 시 한국 번호를 국내 형식으로 바꾼다. 자격증명은 사용자별 서버 private 디렉터리/0600 파일에 저장하고 일정 JSONB·응답·로그·클라이언트 영속 저장에 넣지 않는다. 연결 확인은 실통화 성공이나 서명키 일치 검증, 발신 승인이 아니다. 계정 설정 POST와 실제 발신 모두 PostgreSQL 등 지속 저장소가 필요하다.

전화 설정 POST는 기존 사용자별 PG 잠금 안에서 제공자 번호 조회(15초 timeout)와 파일 저장을 순서대로 처리한다. 같은 사용자의 다른 쓰기는 그동안 기다릴 수 있으며 다른 사용자와는 분리된다. 다중 인스턴스는 같은 DB와 자격 저장 위치를 전제로 한다. 잠금은 활성 DB 트랜잭션 동안의 순서 제어이며 파일 저장과 DB commit이 원자적이라는 뜻은 아니다. 원자 파일에 저장된 `lastRequestId`와 발신번호가 둘 다 요청과 일치할 때만 클라이언트가 응답 유실을 해소한다. 번호만 같은 이전 연결을 새 설정 성공으로 간주하지 않는다.

기존 승인 경계를 유지해 §9의 제한된 양방향 경로를 연결한다. 발송 채널을 바꾸어 승인 경계를 우회할 수 없고 채널 불일치는 부작용 전에 거절한다. `sent_or_connected`는 선택한 전화 제공자의 API 접수를 의미하며 실제 통화 연결/본문 청취/상대 수락의 증거가 아니다. 실패·결과 불명은 자동 재발신하지 않는다. 불특정 수신 전화에 응대하는 기능은 포함하지 않는다.

**ClawOps 콜백:** `POST /v1/voice/clawops/:token`은 `X-Signature`의 HMAC-SHA256을 신뢰된 공개 URL·원본 form 파라미터·별도 서명키로 검증한 뒤 필드를 정규화한다. `CallId`·계정·발신/수신 번호를 암호화 토큰의 사용자·연락과 결합한다. 최초 요청에는 `AccountId`가 필요하며 후속 action/초기 대기 Redirect에는 없는 것이 공식 계약이다. 단계를 건너뛰거나 다른 통화/계정으로 재사용할 수 없다. VoiceML은 승인된 설명·대안 낭독→키패드 선택→선택 내용 복창→명시적 키패드 재확인만 지원한다. ClawOps에서는 안내를 Gather 밖에서 재생하고 빈 Gather로 입력받는다. 자유 음성 대화나 STT를 지원한다고 표시하지 않으며, 무응답·불명확한 응답은 자동 수락이 아니다. 무응답이면 제공자 action이 호출되지 않아 현재 awaiting_response로 남을 수 있다. 기존 Twilio 경로와 서명은 별개로 유지한다.

발신 직전·동일 콜백 처리 중 자격 변경은 재확인한다. 전체 통화 수명에 최초 자격 fingerprint를 고정하는 정책은 없다. 같은 계정·발신번호·서명키를 유지한 API 키 교체만으로 진행 중 통화를 취소한다고 보장하지 않는다.

## 9. 상대 회신 조회·확인·조건부 일정 반영

2026-10-31 증분 계약. 구현·테스트·실제 제공자 상태는 IMPLEMENTATION_PLAN/PROVIDER_SETUP에 별도로 기록한다. 외부 원본 캘린더 쓰기는 이 범위에 포함하지 않는다.

| 경로 | 요청 | 응답 data / 의미 |
|---|---|---|
| `GET /v1/email-reply-connection` | 인증 | 회신 읽기 연결 상태·발신 계정. 발송 동의만으로 available이 되지 않음 |
| `GET /v1/contact-requests/:id/responses` | 인증 | `{contactRequest, responses}`; 해당 사용자 연락의 서버 저장 회신만 |
| `POST /v1/contact-requests/:id/check-replies` | `{requestId, contactRevision}` + Idempotency-Key | `{contactRequest, responses, checkedCount, unmatchedCount}`; Gmail 조회 뒤 검증한 후보 저장 |
| `POST /v1/contact-requests/:id/check-call` | `{requestId, contactRevision}` + Idempotency-Key | `{contactRequest, responses, checkedCount, unmatchedCount, callStatus, complete, truncated}`; 관리형 통화·전사 조회 및 검토 후보 저장 |
| `POST /v1/contact-requests/:id/responses/:responseId/confirm` | `{requestId, contactRevision, selectedOptionId}` + Idempotency-Key | `{contactRequest, response, scheduleRevision, changed}`; 저장된 최신 회신을 직접 확인하고 허용 대안을 선택한 사용자 승인 |

`ContactResponse`에 `displayText: string/null`, `reviewReason: string/null`을 추가한다. displayText는 서버가 인용·서명 등을 제거한 최대 2,000자의 답변 발췌이며 원본 전체나 상대 신원 인증이 아니다. 자동응답·본문 없음·연관 불명은 수락 증거로 사용할 수 없다. 공개 요청으로 providerEventId, accepted 또는 발췌를 생성/수정하는 API는 제공하지 않는다.

Gmail 어댑터는 별도 `gmail.readonly` 동의, 발송 계정과의 동일성, 전송 메시지 ID·스레드·원본 헤더·이후 회신의 참조 관계를 확인한다. 헤더 일치만으로 실제 상대의 신원을 단정하지 않으므로 이메일 이벤트는 항상 `unclear`이고 `needs_user_review`로 남긴다. 사용자 확인은 실제 저장된 최신 발췌와 `sender_unverified` 후보에만 가능하다. 자동 메일이나 공백 발췌, 이미 확인한 응답, 다른 연락/사용자 응답은 확인 대상이 아니다. 정기 자동 메일 조회는 없으며 회신 확인 버튼으로 조회한다.

기존 VoiceML/Twilio 전화는 공개 HTTPS 웹훅·서명 검증·계정/통화/번호 결합·영속 세션을 통해 서버가 관찰한 응답만 받는다. 음성 모델은 승인된 옵션의 잠정 선택을 해석하며, 선택 내용을 다시 안내한 뒤 명시적 번호 확인을 받아야 accepted가 된다. 모델 timeout·불분명·승인 밖 대안은 일정 변경 권한이 아니다. 콜백 단계와 식별자를 중복 처리하지 않으며 서버 재시작 뒤 저장된 세션/응답을 재사용한다.

**관리형 음성:** 발신 직전 기존 `voiceSessions`의 namespaced 실행 키에 연락·계정·agent·발신번호·모드만 결합한다. 비밀키는 이 상태에 저장하지 않는다. `check-call`은 인증된 사용자의 서버 저장 통화 ID만 사용하고 원래 binding·계정·발신/수신 번호·방향·생성시각을 제공자와 대조한다. 외부 GET은 DB 잠금 밖에서 수행하고 저장 시 연락/자격/binding을 재검증한다. 전사 목록은 최대 100건×4페이지, partial/DTMF는 제외한다. `complete`는 통화 completed·정상 stream 종료·전체 페이지·상대 발화·유효한 전체 전사를 모두 확인한 때만 true다. `상대:`/`AI:` 라벨을 포함한 전체 전사가 2,000자를 넘거나 잘림·미완료·무음이면 검토 응답을 만들지 않는다.

완전한 관리형 전사도 `outcome:"unclear", reviewReason:"voice_transcript_unverified"`로 서버에 한 번만 저장한다. 사용자에게 수락 여부·대안을 직접 확인받고 동일한 `/responses/:responseId/confirm`으로 재승인한다. Gmail의 `sender_unverified` 조건은 그대로 유지하며 전화라는 이유만으로 일반 확인을 허용하지 않는다. 사용자/연락/최신 응답/허용 옵션/불변 승인과 현재 일정 검증은 공통이다. 같은 멱등 키의 조회는 같은 결과를 재사용하며 새 상태 확인은 새 사용자 요청으로 한다. 자동 발신·자동 polling·전사 기반 자동 수락은 없다.

관리형 통화가 접수되면 서버 종료 감시가 시작된다. 종료 감시는 회신 조회/승인과 별개이며 전사 저장이나 일정 변경을 하지 않는다. 본인 연락의 실행 binding과 계정·번호·통화 ID를 확인한 뒤 명확한 상대 종료 발화 또는 시간 한도에서 공식 `POST /calls/{callId}`의 `{Status:"completed"}`를 한 번 시도한다. 부정/인용/AI 발화는 종료 명령이 아니다. 프로세스 로컬 감시·종료 시도 기억은 재시작/다중 인스턴스를 가로지르지 않으며, 제공자 검증 불가·자격 변경 시 fail closed다. 기존 문단의 자동 polling 없음은 사용자 검토용 전사 저장 조회에 관한 것으로, 이 종료 전용 감시에는 해당하지 않는다.

전화 대안은 1~9개이며 시각은 분 단위로 정확히 표현할 수 있어야 한다. 시작/종료의 시간대 이름과 그 순간의 UTC 시차를 함께 안내하여 DST 반복 시각도 구분한다. 초 또는 비0 소수초가 있거나 낭독 문구가 중복되는 대안은 발신 전 거절하며, 이미 접수된 통화에서도 재검증 후 검토 상태로 남긴다. 일반 일정/이메일의 시간 정밀도를 낮추거나 자동 반올림하는 변경은 아니다.

회신 기록·사용자 확인·최종 반영에는 영속 DB가 필요하다. 제공자와 모델 호출은 사용자 DB 잠금 밖에서 수행하며, 최종적으로 승인 스냅샷·수신자·일정/맥락 revision·제안/시간 유효성·충돌을 재검증한다. 적용한 대안은 applied, 같은 연락의 다른 대안은 stale로 바꾸고 결과와 같은 트랜잭션으로 저장한다. 최신성 검사에 실패하면 changed=false/needs_user_review를 반환하며 기존 약속을 유지한다. 전달 성공이나 모호한 회신만으로 적용하지 않는다.

**저장 호환성:** 기존 JSONB에 선택 필드 contactResponses/voiceSessions를 추가하고 과거 row는 빈 Map으로 읽는다. 새 필드가 저장된 row는 이전 서버의 strict decoder와 호환되지 않으므로 같은 DB에 구·신 서버를 혼합 실행하지 않는다. 배포 시 관련 API·예약 프로세스 버전을 함께 맞추고 이전 버전으로 단순 롤백하지 않는다.

## 10. 카카오 장소 검색 읽기 증분

04 어댑터·06 API·00이 합의한 서버 읽기 계약이다. 인증된 `GET /v1/places/search?query=...`는 공백 제거 후 1~100자의 검색어만 받으며 추가/중복 쿼리 항목은 거절한다. 정상 data는 `{places: [{id, name, address, roadAddress, longitude, latitude}]}`다. Kakao 기본 첫 페이지 최대 15개이며 페이지네이션은 제공하지 않는다.

검색어는 Kakao에 전달하고 REST 키는 서버 `PIKKU_KAKAO_REST_API_KEY`에서만 읽는다. 400 `invalid_request`, 미설정 503 `not_configured`, 시간 초과·제공자 오류·잘못된 응답은 503 `provider_unavailable`이며 원문 오류·키를 반환하지 않는다. PostgreSQL 저장이나 일정 변경은 없고 기존 capabilities 형식은 유지한다. 이 결과는 장소·좌표이며 이동시간, 경로, 지도 SDK 화면 또는 일정 장소 저장 계약이 아니다. 준비계획 폼에서 출발/도착 장소를 선택해 §11의 경로를 조회한다. 선택 장소를 일정 자체에 저장하지 않는다.


## 11. 사용자 선택 교통수단과 현재 시점 이동시간

00·02·03·04 합의: 인증된 `POST /v1/travel/estimate`는 읽기 전용이며 `{origin:{longitude,latitude}, destination:{longitude,latitude}, mode:"walk"|"transit"|"car"}`를 받는다. 좌표는 WGS84 범위 내 숫자, 객체는 추가 필드를 허용하지 않는다. 요청 ID·멱등키로 저장/발송하지 않으며 일정 변경도 없다. 미지원 수단이나 `departureAt` 지정은 422 `unsupported`, 잘못된 좌표/본문은 400 `invalid_request`다.

성공 data는 `{durationMinutes, provider:"kakao", fetchedAt, expiresAt, mode}`다. 제공자 초를 정수 분으로 올림한다. 도보/대중교통은 Kakao Map, 자동차는 Kakao Mobility의 현재 시점 경로를 사용하며 미래 출발 시각의 교통/운행을 보장하지 않는다. 응답 expiresAt은 조회 완료 후 5분이라는 앱의 재사용 정책이며 제공자의 정확도 보증이 아니다. 미설정 503 `not_configured`, 경로 없음 404 `no_route`, 제공자/타임아웃/형태 오류는 503 `provider_unavailable`이다. 다른 수단/제공자로 자동 대체하지 않는다.

사용자가 교통수단을 직접 선택하고 결과의 ‘이동시간에 사용’을 눌러야 준비계획 입력에 들어간다. 장소/수단 변경·만료·앱 비활성화는 해당 경로값을 무효화하며 수동 입력은 유지한다. 클라이언트는 서버의 fetchedAt/expiresAt 차이(최대 5분)를 요청 시작의 단조시계 경과시간으로 소비해 기기 wall clock 차이와 응답 지연에 따른 연장을 막는다. 적용과 제안 전송 직전에 다시 확인한다. 검색어와 조회 좌표가 Kakao에 전달됨을 안내한다. 준비 제안 서버는 현재 숫자 입력을 검증하므로 경로 출처/유효기간의 영속 증명이나 전체 일정의 준비·이동 관계 검증을 보장하지 않는다. 서버가 조회해 저장한 경로 제약과 승인 시 재검증은 후속 계약이다.

기존 공개 capabilities의 형태는 유지하고 travel은 서버 어댑터/키가 구성되면 available, 아니면 not_configured다. 이는 개별 호출 성공 증거가 아니다. 모델 내부 `context.capabilities`는 calendar/email/emailReplies/phone/places/travelTime/scheduler의 사용자별 구성 상태를 전달한다. 내부 표현 configured는 앱 실행 경로 구성만 뜻하며 모델 도구나 승인 권한을 추가하지 않는다. chat과 scheduler가 같은 runner를 사용하고 클라이언트가 이 상태를 지정할 수 없다.


## 12. 약속 장소 예보·현재 지하철 도착 조회

01·02·03·04와 MAIN이 합의한 읽기 전용 인증 API다. 일반 응답 `{requestId,data}`를 유지하며 일정 변경·승인·연락 실행을 만들지 않는다. 날씨와 역 도착 정보는 현재 준비계획 화면의 참고 자료이며 LLM의 새 Tool 또는 전체 여정 ETA를 의미하지 않는다.

### 날씨

`POST /v1/weather/forecast` 입력은 `{destination:{latitude,longitude},appointmentAt}`이며 appointmentAt은 UTC offset이 있는 ISO 시각이다. 과거 시각 및 서울 기준 오늘부터 16일 범위 밖은 지원하지 않는다. 성공 data는 `{provider:'open-meteo',timezone:'Asia/Seoul',forecastTime,temperatureC,apparentTemperatureC,precipitationMm,precipitationProbabilityPercent,windSpeedKmh,fetchedAt,expiresAt,remainingTtlMs,sourceUrl,licenseUrl}`다. 기온·체감온도·강수량·강수확률·풍속의 누락은 null이며 0으로 대체하지 않는다. forecastTime은 선택 시각이 속한 정시(+09:00)다. 기온·풍속은 해당 시각, 강수는 앞선 1시간 구간의 값이며 야외 활동 안전 보증이 아니다.

5분 캐시와 동시 요청 합치기를 적용한다. remainingTtlMs는 서버 반환 시 남은 수명(0..300000)이고 캐시 히트에도 expiresAt을 연장하지 않는다. 클라이언트는 요청 시작부터의 단조시계 경과를 차감하며 만료·장소/시각 변경·앱 비활성화 후 이전 결과 사용을 막는다. 오류는 400 invalid_request, 422 unsupported_range, 504 timeout, 503 unavailable, 502 invalid_response다. sourceUrl/표시 출처는 `https://open-meteo.com/`, licenseUrl은 `https://open-meteo.com/en/licence`다.

### 서울 지하철

`POST /v1/subway/arrivals` 입력 `{stationName}`. 성공 data는 `{provider:'seoul',stationName,fetchedAt,arrivals:[{lineId,direction,destination,arrivalSeconds,message,detailMessage,observedAt,stale,staleInMs}]}`다. INFO-200은 정상 빈 배열이다. observedAt은 서울 원본 recptnDt를 한국시간으로 해석한 UTC ISO, fetchedAt은 상류 응답을 읽은 시각이다. arrivalSeconds는 `max(0, 원본 barvlDt - max(0, floor((반환시각-recptnDt)/1000)))`이며 매 반환에 재계산한다. staleInMs는 생성시각 기준 120초까지 남은 값(0..120000), stale은 `staleInMs===0`이다. 캐시 적중은 fetchedAt을 바꾸지 않는다. 클라이언트는 응답 지연/단조시계 경과를 차감하고 15초 표시 유효기간 및 앱 비활성화·입력 변경을 처리한다. 자동 polling은 없다.

15초 메모리 캐시·동시 중복 합치기, 분당 20회/일 900회 호출 제한, 5초 timeout, 원본 선두 100행까지만 조회한다. 한도와 캐시는 프로세스 로컬이며 재시작 후 유지되거나 여러 인스턴스 간 공유되지 않는다. 오류는 400 invalid_request, 503 not_configured/unavailable, 504 timeout, 502 invalid_response, 429 rate_limited다. 이 정보는 현재 역의 열차 도착 안내이며 사용자의 전체 이동시간·환승·약속 시각 예측이 아니다.

상류 transport는 미지정 시 https, 명시 http/https만 허용하고 나머지는 not_configured다. 고정 공식 host만 사용하고 redirect/자동 HTTP 다운그레이드를 하지 않는다. 실제 HTTP 설정의 키·역명은 상류 구간에서 암호화되지 않는다. 서버 키를 앱이나 API 응답으로 보내지 않는다.

## 13. 공개 시연 Google 연결 소유자

신뢰된 서버 설정 `PIKKU_GOOGLE_CONNECTION_USER_ID`와 명시적 절대 자격 디렉터리로 기존 Google 발송·회신·Calendar 포트를 하나의 등록된 preview 멤버에만 연결한다. 소유자는 목록에서 정확히 한 번 존재해야 하며 잘못된 지정은 시작 실패로 처리한다. 다른 멤버에게 기존 소유자의 연결을 공유하지 않으며, 별도의 사용자별 연결은 §14를 따른다. 개발 인증의 기본 local-developer 동작은 유지한다. 이 설정은 정식 다중 사용자 OAuth 가입 기능이 아니다. 기존 `/v1/capabilities` 응답 구조는 유지한다.

## 14. 사용자별 Google OAuth — 통합 중인 계약

인증된 `POST /v1/google/oauth/start`는 `{kind: 'calendar' | 'gmail_send' | 'gmail_read'}`를 받고 `{requestId, data: {authorizationUrl, completionSecret}}`을 반환한다. 앱은 외부 브라우저에서 동의를 열고 `completionSecret`은 앱 메모리에만 보관한다. 서버의 비인증 callback은 일회 state와 PKCE를 검증해 Google 코드를 교환한 뒤, Google 인증코드가 아닌 별도의 일회 **연결 확인 코드**를 브라우저에 표시한다. 이 시점에는 자격 파일을 확정 저장하지 않는다.

사용자가 원래 앱에 확인 코드를 입력하면 인증된 `POST /v1/google/oauth/complete`에 `{completionSecret, confirmationCode}`를 보내고 성공 시 `{requestId, data: {status: 'connected'}}`를 받는다. 두 값은 43자 base64url이며 시작부터 10분 안에 같은 사용자에게서 함께 확인돼야 한다. 만료·불일치·재사용은 일반 400 오류다. 완료 요청은 한 번만 시도한다. 응답을 잃으면 자동 재시도하지 않고 연결 상태를 새로 조회하며, 연결되지 않았다면 처음부터 다시 시작한다. 기존 연결이 이미 있었다면 상태가 연결됨이어도 새 계정으로 변경됐는지는 확인할 수 없다. 취소·화면 이탈·계정 전환 시 앱의 비밀값을 지운다. 재시작 시 진행 중인 상태는 사라진다.

계정·권한 확인 후 사용자별 0700 디렉터리에 자격 파일을 0600으로 저장한다. 진행 중인 OAuth 상태는 단일 프로세스 메모리에 있으며 다중 인스턴스에서 공유되지 않는다. Gmail 회신 계정은 같은 사용자의 발송 계정과 일치해야 한다. 인증코드·access/refresh token은 앱 응답에 반환하지 않으며, OAuth 동의는 메일 발송 승인이 아니다. 이 흐름은 기존 앱 사용자의 외부 Google 연결이며 회원가입이나 Google 계정으로 앱에 로그인하는 기능이 아니다. 실제 Google 동의·공개 배포 검증은 별도로 기록한다.

## 15. 건강 데이터 로컬 전용 계약

00·01~05가 맞춘 모바일 내부 계약이다. **HTTP·DB·Agent Tool 계약은 추가하지 않는다.** 정본 타입은 `apps/mobile/src/health/types.ts`, 동작 의미는 [건강 연결 기록](WEARABLE_INTEGRATION.md)을 따른다.

- `HealthSelection {steps,workouts}`는 각각 boolean, 초기값 false다. `HealthAdapter`의 `availability()`는 지원 여부만, `connect(selection)`은 선택 항목의 읽기 권한 요청, `read({now,timezone,selection})`은 수동 조회, `openSettings()`는 사용자 설정 이동이다. iOS 설정 이동은 건강 권한 화면 직행이 아니다.
- `HealthReadResult`는 `source:'apple_health'|'health_connect'`, `lastSyncedAt`, `timezone`, `selection`, `status:'ok'|'partial'|'no_data_or_access'`, `truncated`, `workoutsAvailability`, `stepsByDay`, `workouts`를 제공한다. 날짜별 걸음 `null`은 미확인이다. iOS 읽기 권한은 `unknown`이며 빈 결과로 거부를 단정하지 않는다.
- 운동은 `{source,id,startAt,endAt,kind}`다. 출처+ID로 중복을 제거하고 충돌·불완전·잘림을 표시한다. `summarizeHealth`는 선택 시간대의 오늘 포함 7일로 자르고 겹치는 기록 구간을 한 번만 더한다. `exerciseMinutes`는 일시정지 포함 기록 구간 시간이며 활동 시간 보증이 아니다.
- `HealthSummary`는 출처·조회시각·상태·선택·날짜별 값·기록·`signals`·`stale`을 갖는다. 신호 `{kind,value,sampleDays,source,calculatedAt,expiresAt}`는 완전한 결과에서만 생성하고 마지막 조회부터 5분 뒤 만료한다. 장기 선호/건강 판단을 생성하지 않는다.
- 결과는 화면 메모리에만 보관한다. 선택/시간대 변경 시 이전 결과를 폐기하며 연결해제·앱 프로세스 종료 시 지운다. 화면만 숨긴 동안은 메모리에 유지하고 복귀 시 만료를 확인한다. OS 권한 철회와 앱 연결해제는 별개다. 서버/AI 활용을 원하는 후속 단계에서는 별도 전송·동의·삭제 계약부터 합의한다.

## 16. Google 회원 인증

`POST /v1/auth/google/start {}`는 공개 경로이며 `{authorizationUrl,completionSecret}`을 반환한다. 기존 `/v1/google/oauth/callback`에서 `member_` state만 회원 흐름으로 전달한다. ID token 서명·aud/iss/exp·nonce·sub·email_verified와 PKCE/state를 검증한다. `POST /v1/auth/google/complete {completionSecret,confirmationCode}`는 `{sessionToken,expiresAt,member:{id,email,displayName}}`을 반환한다. 두 앱 확인 값은 43자 base64url, 10분 이내 일회용이다. 토큰 원문은 앱 메모리에만 두고 서버는 해시/7일 만료/취소 상태를 보관한다.

Bearer `GET /v1/auth/me`는 `{member}`, `POST /v1/auth/logout {}`은 `{status:'logged_out'}`이다. 기존 preview/개발 세션은 별도 resolver로 유지하고 회원 오류가 유효 preview 인증을 대신 취소하지 않는다. 모든 응답은 기존 `{requestId,data}`/error 봉투, TLS·no-store·IP 제한을 따른다. 앱 인증은 Google 외부 서비스 권한 동의가 아니다.

## 17. 반복 루틴과 회차

`Routine={id,revision,title,weekdays:number[],timezone,startDate,localTime,durationMinutes,active,category?:personal/work/null}`. weekdays는 월1~일7, 시작일은 YYYY-MM-DD, 현지시각 HH:mm, 소요시간 1~1440분이다. `GET /v1/routines` → `{routines}`; `POST /v1/routines {requestId,title,weekdays,timezone,startDate,localTime,durationMinutes,category?}` → `{routine}`; `PATCH /v1/routines/:id {requestId,expectedRevision,...수정값}` → `{routine}`. mutation은 Idempotency-Key를 요구한다.

`POST /v1/routines/materialize {requestId,fromDate,toDate}`는 양끝 포함 최대31일의 활성 규칙을 기존 개인 고정 task 회차로 생성하고 `{createdCount,existingCount,conflicts:[{routineId,date,code:'schedule_conflict'|'invalid_local_time'}],scheduleRevision}`을 반환한다. 기본 UI 범위는 선택일 하루다. 생성 시점의 category를 회차에 기록하며 규칙의 이후 변경은 기존 회차를 바꾸지 않는다. 이미 생성/삭제한 회차는 재생성하지 않으며 existingCount는 이전 생성 이력이다. 규칙 변경/비활성은 기존 회차를 바꾸지 않는다. 사용자·루틴·날짜 unique와 일정/sourceRef/멱등 기록은 같은 DB transaction이다. 회차 완료는 기존 checkin을 사용한다.

## 18. Calendar 원본 쓰기와 수동 양방향 동기화

§14 OAuth kind에 `calendar_write`를 추가한다. 별도 `calendar-write-connection.json`, `calendar.events`+calendarlist readonly/openid/email 권한을 쓰며 기존 readonly 자격은 보존한다. `GET /v1/calendar-write-connection` → `{status:'available'|'not_configured',accountLabel:string|null}`은 본인 연결만 표시한다.

`GET /v1/calendar-sync` → `{connections}`; `GET /v1/calendar-sync/calendars` → `{calendars:[{id,summary,accessRole}]}`. `POST /v1/calendar-sync/connect {requestId,calendarId,allowDeletes?:boolean,exportItemIds?:string[]}` → `{connection}`이며 최대100개의 직접 선택한 개인 이벤트만 신규 export한다. 삭제 동의는 기본 false다. `POST /v1/calendar-sync/:id/run {requestId,expectedRevision}` → `{connection,imported,exported,deleted,conflicts:[{reason,itemId?,eventId?}],unsupportedCount}`. 같은 버전의 선택 연결만 동기화한다. `POST /v1/calendar-sync/:id/disconnect {requestId,expectedRevision}` → `{disconnected:true}`는 원본/내부 일정을 삭제하지 않는다. mutation은 멱등키를 요구하고 성공/오류 봉투는 동일하다.

증분 token/410 전체 조회, ETag/If-Match, 계정/원본 바인딩을 검증한다. 양쪽 변경·승인 증거 없는 공유 약속·미지원 형식은 충돌/지원불가로 남긴다. 삭제 전파는 동의 및 baseline 다음 revision의 개인 일정 tombstone 증거가 있어야 한다. 서버 사용자 state의 optional `tombstones`는 구 문서에서 빈 Map으로 읽으며 일정 삭제와 원자 저장한다.

디자인 접합 전 보완: `POST /v1/calendar-sync/:id/exports {requestId,expectedRevision,exportItemIds}` → `{connection}`은 기존 연결에 새로 선택한 원본 없는 개인 이벤트를 추가한다. 비어 있는 선택은 거부하고 기존 대기열·매핑을 보존한다. 최대100개, 사용자/현재 revision·계정·activeRun·종류/소유를 검증하며 Idempotency-Key를 요구한다. 추가 선택 자체는 외부 쓰기가 아니다.

공유 약속의 일반 변경/삭제는 계속 차단하되, 적용 완료된 정확한 연락 변경 증거가 있는 기존 공동 약속의 시간 update만 허용한다. `findCalendarContactAuthorization`의 사용자 승인/응답·current item/원본 identity/sourceVersion 증거와, Google Calendar owner·주최 계정·원본 ETag·변경 전 제목/시간을 쓰기 직전 락 안에서 확인한다. 원문 주최자 이메일은 응답에 추가하지 않고 provider는 `organizerSelf?`/`organizerIsAccount?` boolean만 제공한다. 전자는 이벤트 사본 Calendar 기준이지 로그인 사용자의 주최자 증명이 아니다. 빈 delta 뒤 새로 합의된 미매핑 후보는 유효한 증거의 원본만 최대100개 재조회하고 초과 시 candidate_limit 충돌을 표시한다.

`calendar_sync_run`은 영속 멱등 예약 후 자신의 DB 트랜잭션/효과 ledger를 사용하고 바깥 finalize 트랜잭션에서 실행하지 않는다. 요청 결과는 별도로 영속 확정하며, lease 만료 자동 회수·외부 쓰기 재전송은 허용하지 않는다.

`GET /v1/calendar-sync/operations/:requestId` → `{operation:{state:'running'|'completed'|'uncertain',result?:SyncResult}}`는 본인 작업만 조회하고 외부 쓰기를 하지 않는다. 완료 result를 확인한 경우에만 유실 응답을 성공으로 복구한다. 결과 불명/중단 상태는 자동 해제·재전송하지 않는다. Calendar ID는 이메일 형식일 수 있으며 토큰·내부 fingerprint는 반환하지 않는다. 전체 의미/제한과 DB 업그레이드 경계는 [사용 안내](MEMBER_ROUTINE_CALENDAR.md)를 따른다.
