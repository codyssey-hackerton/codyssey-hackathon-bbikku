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
| `ScheduleFields` | `kind: event/task`, `title: string`, `timeSlot: TimeSlot/null`, `durationMinutes: number/null`, `deadline: string/null`, `flexibility: fixed/flexible`, `involvement: personal/shared`, `completion: pending/completed/incomplete/unknown` | event는 시간 필수, task는 양수 소요시간 필수. deadline이 있으면 종료가 마감 이내. 미배치 task는 timeSlot=null. 배치 구간은 durationMinutes 이상이어야 한다. 무응답은 incomplete가 아니다. |
| `ScheduleItem` | `ScheduleFields` + `id`, `revision`, `sourceRefs: SourceRef[]` | ID/버전/출처는 서버 소유. 완료 항목과 고정 일정은 AI 변경에서 보호. |
| `SourceRef` | `provider`, `accountRef`, `calendarId`, `externalEventId`, `lastSyncedAt`, `occurrenceKey?`, `sourceVersion?` | 모두 문자열. 계정 참조는 비밀키가 아님. 반복 회차 보존. |
| `MemoryFact` | `id`, `revision`, `kind: preference/situation/observation/inference`, `key: string`, `value: JSON`, `source: {type: user/provider/derived, ref: string}`, `recordedAt`, `validUntil: string/null` | v1 쓰기는 명시적 preference/situation만. situation은 만료 필수. 미확인 상황을 영구 선호로 승격하지 않음. |
| `ContextSnapshot` | `now`, `timezone`, `scheduleRevision`, `contextRevision`, `items: ScheduleItem[]`, `facts: MemoryFact[]`, `missingFields: string[]` | 필요한 범위만 조회. 만료된 사실은 유효한 맥락에서 제외. |
| `ValidationResult` | `valid: boolean`, `conflicts: {targetIds: string[], reason: string, timeSlot?: TimeSlot}[]`, `missingFields: string[]`, `protectedTargets: string[]`, `checkedScheduleRevision`, `checkedContextRevision`, `checkedAt` | 부족 정보/충돌/보호 대상이 있으면 valid=false. |

`ChangeSet = {changes: Change[]}`. Change는 다음 중 하나다. 빈 변경 묶음은 허용하지 않는다. 서로 의존하는 묶음은 전체 적용 또는 전체 거절한다.

```ts
type Change =
  | { changeId: string; operation: 'create'; after: ScheduleFields }
  | { changeId: string; operation: 'update'; targetId: string; expectedRevision: number; after: ScheduleFields }
  | { changeId: string; operation: 'delete'; targetId: string; expectedRevision: number };
```

update는 사용자에게 보여준 전체 편집 필드를 교체한다. `before`, ID, 출처, 실제 버전은 서버가 조회/부여한다. 클라이언트가 보낸 과거 값은 검증 근거가 아니다. 같은 대상을 한 묶음에서 여러 번 수정하지 않는다.

`Proposal` 필수 필드: `id`, `revision`, `mode: personal/coordination`, `baseScheduleRevision`, `baseContextRevision`, `changeSet`, `beforeItems: ScheduleItem[]`, `reason`, `evidenceRefs: string[]`, `validation`, `createdAt`, `expiresAt: string/null`, `status: pending/awaiting_contact/applied/rejected/stale/expired/failed`. 대안마다 별도의 Proposal ID를 쓴다. 공동 약속의 시간 변경·취소가 들어가면 coordination이다. v1 연락 조정은 공동 event 한 건만 다룬다. shared task의 시간 변경·삭제·personal 전환은 지원 전이므로 거절하고, 제목 같은 비조정 변경만 해당 권한 범위에서 허용한다. `coordinationTarget: {id, expectedRevision}/null`을 Proposal에 보관하며 personal은 null이다.

`Approval` 필수 필드: `id`, `subjectType: proposal/contact_request`, `subjectId`, `subjectRevision`, `decision: accept/reject`, `decidedAt`, 서버가 확인한 `actorRef`. 서버는 승인 시점의 불변 대상 내용도 보관한다. 연락의 경우 수신자·채널·내용·허용 대안 전체에 승인이 묶인다. 단순 `approvalId` 존재만으로 실행하지 않는다.

다중 캘린더는 확인된 동일성 근거/사용자 확인으로만 연결한다. 제목·시간만으로 합치지 않고 모든 SourceRef와 원본별 값을 보존한다. 원본 충돌은 표시하고 임의 선택하지 않는다. 최초 제공자 이후 추가 캘린더·양방향 전파·반복 편집 전체는 확장 범위다.

## 3. Agent·Tool 계약

기준은 `gpt-6.1-terra`, `reasoning.effort: high`, Responses API다. 실제 접근은 미검증이다. 접근 실패 시 다른 모델/effort로 자동 대체하지 않는다. 한 S LLM이 제출된 대화를 처리하며 “고마워”에 Tool이나 전체 재계획을 강제하지 않는다.

고정 공동 약속도 사용자가 앱에서 조정 검토 대상을 명시적으로 선택하면 `coordinationTarget` 범위에서 **검토용 대안 생성**이 가능하다. 서버가 대상 소유·버전·선택을 확인해 Engine의 coordination 검증 범위에 주입한다. LLM이 이 범위를 만들어 보호를 해제할 수 없다. 완료 항목과 선택 밖 고정 일정은 계속 보호한다. 이 선택은 일정 반영이나 연락 승인이 아니며 실제 반영은 §7을 따른다.

Agent 입력: 인증된 사용자 범위, `requestId`, `conversationId`, `message` 또는 `TriggerEvent`, 선택적인 서버 검증 `coordinationTarget`, `now`, `timezone`, 관련 대화. 필요한 일정/Memory는 Tool로 조회한다. S LLM 내부 `proposalDraft`에는 `changeSet`, `reason`, `evidenceRefs`를 담는다. ID/검증 성공/승인을 모델이 발급하지 않는다.

서버가 앱에 반환하는 `AgentResult`:

```ts
type AgentResult =
  | { kind: 'reply'; message: string }
  | { kind: 'question'; message: string; missingFields: string[] }
  | { kind: 'proposal'; message: string; proposalIds: string[] }
  | { kind: 'failure'; message: string; code: string; retryable: boolean };
```

서버가 검증하고 저장한 Proposal만 proposalIds로 반환한다. 검증 실패는 질문/실패로 반환한다. 답변에 변경 완료라고 쓰는 것만으로 실행 완료가 되지 않는다.

| 읽기/계산 Tool | 입력 | 출력 |
|---|---|---|
| `read_schedule` | `{from, to, timezone}` | `{items, scheduleRevision}` |
| `read_memory` | `{keys: string[], at: string}` | `{facts, contextRevision, missingFields}`; keys=[]이면 유효한 사실 전체, 지정하면 해당 키만 |
| `calculate_timing` | `{appointmentStart, preparationMinutes, travelMinutes, bufferMinutes}` | `{ready: true, departureAt, preparationStartAt}` 또는 `{ready: false, missingFields, message}` |
| `validate_changes` | `{changeSet}` | 서버가 최신 snapshot을 조회한 `ValidationResult` |

Tool 사용자 범위는 실행기가 주입한다. 알 수 없는 Tool/잘못된 인수/권한 밖 조회는 거절한다. 외부 조회 어댑터는 §7 포트로 추가한다. LLM에 쓰기·발송 Executor를 직접 노출하지 않는다. 적용 직전 검증은 Tool 선택과 별개로 필수다. AI가 새로 배치하거나 시간을 바꾸는 일정의 시작이 검증 시점보다 과거이면 거절한다. 사용자 명시적 과거 기록과 시간이 그대로인 메타데이터 편집을 일괄 금지하는 규칙은 아니다.

## 4. HTTP v1 — 앱·백엔드가 먼저 연결할 경로

본문의 `requestId`와 쓰기의 Idempotency-Key는 §1 공통이다. 표의 응답은 성공 envelope의 `data`다. 미구현 경로는 성공 모의 응답 대신 501 `not_implemented`, 미설정 제공자는 503 `not_configured`로 표시한다.

| 경로 | 입력 | 응답 |
|---|---|---|
| `GET /health` | 없음, 인증 불필요 | `{status: 'ok'}` (프로세스 생존만 뜻함) |
| `GET /v1/capabilities` | 인증 | `{storage: {mode: memory/postgres, durable: boolean}, model: {id, reasoningEffort, status}, integrations: {calendar, email, phone, travel}, scheduler: {status}}`; 각 status는 not_configured/available/degraded. available은 실행 경로 사용 가능이며 이번 호출 성공 보장 아님 |
| `POST /v1/chat` | `{requestId, conversationId: string/null, message: string, timezone, coordinationTarget?: {id, expectedRevision}}` | `{conversationId, result: AgentResult}` |
| `GET /v1/schedule` | query `from`, `to`, `timezone`, `includeUnscheduled=true/false` (기본 false) | `{items: ScheduleItem[], scheduleRevision}`; 겹치는 구간 조회, true이면 미배치 task도 포함 |
| `POST /v1/schedule/commands` | `{requestId, expectedScheduleRevision, changeSet}` | `{outcome: 'applied', items: ScheduleItem[], deletedIds: string[], scheduleRevision}` |
| `GET /v1/proposals` | query `status?`, `cursor?`, `limit?` (기본50, 최대100) | `{proposals: Proposal[], nextCursor: string/null}`; 현재 사용자, createdAt·id 내림차순. 예약 생성안도 같은 목록에서 조회 |
| `GET /v1/proposals/:id` | ID | `{proposal: Proposal}` |
| `POST /v1/proposals/:id/decision` | `{requestId, proposalRevision, decision: accept/reject}` | `{outcome: applied/rejected/awaiting_contact, proposal, scheduleRevision}` |
| `POST /v1/schedule/:id/checkin` | `{requestId, expectedRevision, completion: completed/incomplete/unknown}` | `{item, scheduleRevision}`; 상태만 갱신, 이동 없음 |
| `GET /v1/memory` | query `at` | `{facts, contextRevision}`; 현재 사용자 유효 사실 |
| `POST /v1/memory` | `{requestId, expectedContextRevision, kind: preference/situation, key, value, validUntil: string/null}` | `{fact, contextRevision}`; 같은 kind/key는 새 revision으로 대체, 출처는 서버가 user로 기록 |
| `GET /v1/review-schedule` | 인증 | `{reviewSchedule: ReviewSchedule}` |
| `POST /v1/review-schedule` | `{requestId, expectedRevision, timezone, evening: {enabled, localTime}, morning: {enabled, localTime}}` | `{reviewSchedule}`; 검증·저장하고 이후 예약에 반영 |
| `POST /v1/recipients` | `{requestId, displayName, channel: email/phone, address, confirmed: true}` | `{recipient: {id, displayName, channel, address, confirmedByUserAt}}`; 사용자가 입력·확인한 수신자 참조 생성, 발송 없음 |
| `POST /v1/contact-requests` | `{requestId, recipientRef, channel: email/phone, purpose, messageOrCallBrief, allowedOptions: {optionId, proposalId, proposalRevision}[]}` | `{contactRequest}`; 검증된 초안 저장만, 발송 없음 |
| `GET /v1/contact-requests/:id` | ID | `{contactRequest}` |
| `POST /v1/contact-requests/:id/decision` | `{requestId, contactRevision, decision: accept/reject}` | `{contactRequest}`; 승인 내용 재검증 후 ready 또는 rejected, 실행기는 ready만 수신 |

일정 commands는 직접 폼 저장 경로이며 AI 추가 변경을 끼워 넣지 않는다. 충돌은 409로 거절하고 해결 선택을 받는다. **이미 존재하는 공동 약속의 시간 변경·취소는 `contact_required`로 분기**하며 직접 저장으로 상대 수락을 우회하지 않는다. 공동 약속 최초 등록은 이미 정해진 약속의 기록이며 연락 승인을 뜻하지 않는다. 메모·제목·본인 체크인 같은 비조정 변경은 해당 권한만 검증한다. 공동 약속의 involvement를 personal로 바꿔 이 경계를 우회할 수 없다. 외부 쓰기 권한은 별도다.

제안 decision의 accept는 **personal이면** 재검증 후 적용한다. **coordination이면** awaiting_contact로 전환하고 기존 일정은 유지한다. 연락 초안과 승인에는 별도 경로를 사용한다. UI는 연락 카드에서 §7의 전체 범위를 한 번 확인받을 수 있으며 일반 proposal accept를 먼저 강제하지 않는다. 연락 승인 자체가 나열된 대안의 조건부 적용 동의를 포함한다.

오류 코드/HTTP: `invalid_request` 400, `unauthenticated` 401, `permission_denied` 403, `not_found` 404, `conflict/stale_proposal/expired_proposal/idempotency_conflict/contact_required` 409, `missing_information` 422, `not_implemented` 501, `not_configured/provider_unavailable` 503. `outcome_unknown`은 외부 실행 결과의 상태이며 무조건 재실행 가능한 오류로 반환하지 않는다. 같은 요청이 실행 중이면 409 `operation_in_progress`와 조회 대상 참조를 반환한다. 제안의 business failure는 AgentResult.failure로, 인증/전송/제공자 전체 실패는 HTTP 오류로 구별한다.

## 5. 저장·승인·Scheduler

PostgreSQL을 저장 기준으로 채택한다. 호스팅은 미정이다. Repository 경계는 `readSnapshot`, `saveProposal`, `recordDecision`, `applyChangesIfCurrent`다. 일정·제안·승인·Memory·연락작업·중복 실행 결과를 저장한다. 실제 테이블/마이그레이션은 찬욱님과 맞춘다. 테스트용 memory 어댑터는 durable=false이며 재시작 복구 증거가 아니다.

현재 초기 구현은 [사용자별 영속 JSONB 저장 계약](../apps/api/DATABASE.md)을 사용한다. 상태·승인·멱등 결과는 한 트랜잭션이며, 모델 호출은 그 바깥에서 수행하고 최종 확정 전에 버전을 다시 확인한다. 연락 작업은 아직 미구현이다. 운영 정규화 테이블은 이 데이터를 보존하는 마이그레이션으로 담당자와 맞춘다.

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

Google Calendar/Gmail, Twilio+음성, Kakao/TMAP은 검증 후보다. OAuth 접근 동의는 개별 연락 승인이 아니다. Calendar 읽기/쓰기, Gmail 발송/회신 읽기 권한은 구분한다. 제공자별 콜백 URL·DB 스키마·음성 모델·푸시 제공자는 미정이며 이 경계를 유지해 병렬 검증한다. 실제 테스트 발신·발송에는 승인된 테스트 상대와 내용이 필요하다.
