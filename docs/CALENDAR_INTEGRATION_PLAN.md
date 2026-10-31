# Google Calendar 읽기 동기화 구현 준비

기준: 2026-10-31, `baaa29a`. **제한된 로컬 읽기·수동 가져오기 구현과 모의 검증 단계이며 실제 계정 연결 완료가 아니다.** Google Calendar 읽기만 다룬다. 쓰기·초대 발송·Gmail 권한과 설정은 범위 밖이다.

현재 `google-calendar.ts`/`calendar-import.ts`는 단일 개발 사용자 연결, 기간 조회와 사용자가 선택한 시간형 단일 일정의 수동 가져오기를 구현한다. 선택 당시 `etag`와 재조회 결과가 다르거나 버전·중복·충돌 검사를 통과하지 못하면 전체를 저장하지 않는다. 외부 재조회는 `prepareSelected`에서, 로컬 버전 재검증과 저장은 `commitPrepared`에서 수행한다. Google 재조회 직후 원본 변경과 내부 저장은 서로 원자적이지 않다. `scripts/connect-calendar.mjs`는 별도 Calendar 읽기 동의와 `.local/calendar-connection.json`을 사용한다. 종일·반복·취소·일부 불명확한 원본은 미지원이며 범위 밖의 취소 항목은 목록 응답에 없을 수 있다. 범위 조회를 전체 동기화 완료로 표현하지 않는다. 연결·실제 Google 응답은 검증되지 않았다.

**최소 연결 추천안:** 단일 Google 계정에서 사용자가 선택한 캘린더의 읽기 동기화부터 검토한다. 이는 팀 확정안이 아니다. 종일·반복·취소 중 지원하지 못한 항목이나 페이지 오류가 있으면 조용히 제외하고 `동기화 완료`로 표시하지 않는다. 누락 유형과 불완전 상태를 구분해 알리고, 완전한 판단 근거가 필요한 계획·승인을 차단한다.

## 현재 계약과 구현

- [CONTRACTS §2·§7](CONTRACTS.md)은 `SourceRef`의 제공자·계정 참조·캘린더·원본 ID·조회 시각과 선택적인 회차 키·원본 버전, `CalendarPort.list(accountRef, calendarId, from/to)`의 개념을 정의한다. 현재 코드의 [`SourceRef`/`ScheduleItem`](../packages/domain/src/contracts.ts)은 이 형태를 담고, 별도 Google 모듈은 제한된 수동 가져오기를 제공한다.
- [`v1.ts`](../packages/domain/src/v1.ts)의 출처 검사는 필드 형식 확인이다. [`planning-service.ts`](../apps/api/src/planning-service.ts)는 직접 생성 시 빈 `sourceRefs`를 넣고 수정 시 기존 값을 유지한다. Google 수동 가져오기는 같은 원본 키 중복을 거절하며, 외부 일정의 지속 동기화·서로 다른 출처의 동일성 판정은 구현되지 않았다.
- 같은 서비스는 `scheduleRevision`을 기준으로 제안을 만들고, 승인 시 현재 일정·맥락 revision을 다시 비교해 다르면 `stale`로 바꾼다. **현재 pending 목록에서 동기화 직후 자동으로 stale 표시되는 기능은 없다.** [`PostgresPlanningStore`](../apps/api/src/postgres-store.ts)는 엄격한 사용자별 JSONB 상태를 사용하며 현재 커서·원본별 스냅샷 저장 필드는 없다.
- 현재 `TimeSlot`은 오프셋이 있는 시작·종료와 IANA 시간대 하나를 요구하고, `ScheduleItem`은 대표 값 하나만 보유한다. 종일 원본 날짜, 원본별 상충 값·접근 불가 상태, 불확실한 개인/공동 여부를 충실히 표현하는 방식은 미정이다. `ContextSnapshot.missingFields` 타입은 있지만 현재 `snapshot()`은 빈 배열을 생성하므로 소스 불완전 차단이 이미 구현된 것은 아니다.

## 공식 API 확인과 SourceRef 매핑 제안

| Google 응답·요청 | 기존 계약에 넣을 값 또는 처리 제안 |
|---|---|
| 사용자별 연결, 선택한 calendar ID | `provider='google_calendar'`, `accountRef`는 **비밀이 아닌 내부 연결 참조**, `calendarId`는 선택한 실제 캘린더 ID. Google 토큰·이메일을 계정 참조로 쓰지 않는다. |
| `event.id`, `etag` | `externalEventId=id`, `sourceVersion=etag`(있으면 원문 그대로 비교), `lastSyncedAt`은 해당 원본을 성공 반영한 시각. ID의 유일성 범위는 캘린더별이므로 계정·캘린더를 함께 키로 쓴다. |
| 반복 회차 `recurringEventId`, `originalStartTime` | `occurrenceKey`의 직렬화 형식은 합의 후 고정한다. 원본 시리즈 ID와 **이동 전 회차 시각 또는 종일 날짜**를 보존한다. 회차를 옮겨도 현재 `start` 대신 `originalStartTime`으로 식별한다. `iCalUID`는 한 반복 시리즈의 여러 회차가 공유하므로 단독 회차 키로 쓰지 않는다. [이벤트](https://developers.google.com/workspace/calendar/api/v3/reference/events) · [반복 회차](https://developers.google.com/workspace/calendar/api/guides/recurringevents) |
| `summary`, `start/end.dateTime`, `timeZone` | 제목과 오프셋이 있는 실제 시각을 `title`/`TimeSlot`에 매핑할 수 있다. IANA 시간대가 없으면 캘린더 기본 시간대를 확인한다. 시작·종료 시간대가 서로 다른 경우 원본 두 값을 별도 보존한다. 제목·시간·접근 정보가 부족한 항목은 임의의 사실을 채우지 않고 미확인으로 둔다. |
| `start.date`, `end.date` | 종일은 **날짜**이며 종료일은 배타적이다. 예: `11-01`~`11-02`는 11월 1일 하루. Google은 종일 이벤트 자체에 시간대 의미를 부여하지 않으며 기간 필터 판정에 캘린더 기본 시간대를 사용한다. 날짜와 종일 여부를 보존할 저장·표현 합의 전에는 임의로 UTC 자정 일정으로 확정하지 않는다. [시간대](https://developers.google.com/workspace/calendar/api/concepts/events-calendars) · [종료 시각](https://developers.google.com/workspace/calendar/api/v3/reference/events) |
| `status=cancelled` | 취소된 반복 **예외 회차**는 부모가 살아 있는 동안 `id`·`recurringEventId`·`originalStartTime`만으로 보존한다. 다른 삭제 항목은 `id`만 있을 수 있으므로 기존 원본 키로 해당 소스만 제거/무효화한다. 다른 출처나 사용자가 만든 일정을 일괄 삭제하지 않는다. [취소 이벤트](https://developers.google.com/workspace/calendar/api/v3/reference/events) |

`flexibility`, `involvement`, `completion`, 비공개/상세 미제공·`endTimeUnspecified` 및 비어 있는 제목의 변환은 팀 합의가 필요하다. 참가자 정보가 없다고 개인 일정으로 단정하지 않는다. Google 시간대·반복·가용 상태와 충돌 여부를 손실 없이 저장할 최소 원본 스냅샷은 아직 계약에 없다.

## 조회·동기화 순서 제안

1. **최소 읽기:** 인증 연결과 사용자가 선택한 캘린더를 확인한다. 상세 일정에는 `calendar.events.readonly`를 검토하고, 캘린더 선택 목록이 필요할 때만 `calendar.calendarlist.readonly`를 별도 검토한다. 소유 캘린더만 필요하면 더 좁은 `calendar.events.owned.readonly`도 후보지만 공유 캘린더는 제외된다. 실제 권한 부여는 별도 작업이다. [Google 범위](https://developers.google.com/workspace/calendar/api/auth) · [목록 권한](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)
2. **범위 조회:** 우선 `events.list(singleEvents=true, timeMin=from, timeMax=to)`로 선택 범위의 개별 회차를 읽는 방안을 권장한다. 빈 페이지라도 `nextPageToken`이 있으면 끝까지 읽는다. Google의 조건은 `end > timeMin`, `start < timeMax`이며 밀리초는 무시된다. 이 조회의 성공은 선택 범위의 조회 성공일 뿐 삭제·반복 원본까지 추적한 전체 동기화 완료가 아니다. 취소 회차 반환을 위해 `showDeleted`를 검토하되 `singleEvents=true`에서는 취소된 반복 원본이 빠질 수 있다. 부분 실패나 조회 범위에서 사라진 것만으로 삭제라고 단정하지 않는다. [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
3. **지속 동기화는 후속 구현:** 계정·캘린더별로 최초 전체 동기화, 이후 마지막 `nextSyncToken`을 이용한 증분 동기화를 한다. 증분 결과는 삭제를 포함하고 `showDeleted=false`는 허용되지 않는다. 마지막 페이지에만 `nextSyncToken`이 있으며, 증분 페이지들은 기존 `syncToken`과 같은 조건에 `pageToken`만 추가한다. `syncToken`과 `timeMin/timeMax`, `iCalUID`, `orderBy`, `q`, `updatedMin`, extended-property 필터는 함께 쓸 수 없다. 적용 가능한 나머지 조건은 일관되게 유지한다. [동기화 가이드](https://developers.google.com/workspace/calendar/api/guides/sync) · [요청 제약](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
4. **반복·범위 결합:** 후속 동기화의 설계 후보는 `singleEvents=false`로 원본 반복 규칙·예외를 동기화하고, 필요한 기간의 회차는 별도 [`events.instances`](https://developers.google.com/workspace/calendar/api/v3/reference/events/instances)로 페이지별 조회하는 것이다. `singleEvents=true`는 회차를 반환하지만 반복 원본을 제외한다. `events.instances`의 `timeMin`은 `list`와 달리 종료시각 경계를 포함하므로 앱의 반열린 범위에 맞춰 결과를 다시 거른다. 시간 범위를 옮기면 이전에 범위 밖이던 미변경 일정이 증분 결과에 나타난다고 보장할 수 없으므로 별도 범위 조회가 필요하다. 전체 캘린더 읽기·보관 범위와 원본/회차 조회 사이 일관성은 구현 전 합의·검증한다. [반복 이벤트](https://developers.google.com/workspace/calendar/api/guides/recurringevents)
5. **원자적 반영·복구:** 페이지 전체를 소스별로 임시 수집한 뒤 원본 미러·일정 변경·새 토큰을 함께 반영한다. 실패·재시작 시 이전 유효 토큰을 유지하고 재처리는 같은 원본 키로 멱등 처리한다. 증분 `410`으로 토큰이 무효화되면 **해당 계정·캘린더의 동기화 미러와 토큰만** 무효화해 전체 재조회한다. 재구축 중의 빈 미러를 일정 없음으로 판단하거나 AI 추천 근거로 사용하지 않는다. 이전 표시는 오래된 데이터로 구분하고, 내부 일정·사용자 편집·다른 계정/캘린더는 보존한다. [410 복구](https://developers.google.com/workspace/calendar/api/guides/sync)

## 동일성·승인 경계

- 같은 `(provider, accountRef, calendarId, externalEventId)`는 **같은 원본**의 갱신으로 처리한다. 원본 ID가 같아도 다른 계정·캘린더이면 자동으로 같은 원본이라 가정하지 않는다.
- 서로 다른 출처의 연결은 확인된 공통 식별 근거와 같은 반복 회차를 증명하거나 사용자가 확인한 경우에만 한다. `iCalUID`와 원래 회차가 일치하는 경우도 제공자·복제 경로의 동일성 보장이 확인되기 전에는 후보로 남긴다. **제목과 시간만 같은 항목은 병합하지 않는다.** 서로 다른 회차와 상충하는 원본 시각을 보존하고 어느 쪽을 우선할지 임의로 정하지 않는다.
- 실제 원본 변경·삭제·복원이나 충돌 상태 변경이 일정 판단에 영향을 주면 사용자 상태 트랜잭션에서 해당 항목 revision과 `scheduleRevision`을 갱신한다. 같은 데이터 재조회나 `lastSyncedAt`만 바뀐 경우에는 불필요하게 기준을 바꾸지 않는다. 기존 승인 경로는 revision 차이를 감지해 pending 제안을 **승인 시** stale로 거절한다. 동기화 직후 상태를 미리 stale로 표시하는 방식은 별도 합의·구현이 필요하다.
- 원본 간 충돌, 권한 상실, 부분 실패 또는 410 복구 중인 데이터를 Agent·승인의 확정 근거로 쓰지 않기 위한 상태 전달/차단도 미구현이며 공통 계약 검토가 필요하다. **제안 방향:** 소스가 불완전해지는 전환도 일정 판단 기준 변경으로 기록해 기존 pending 제안이 최신성 검사를 통과하지 못하게 하고, 전체 재구축 성공 전에는 새 추천·승인을 차단한다. 기존 코드가 이미 이 게이트를 제공한다고 가정하지 않는다.

## 다음 구현 범위와 검증

1. **구현된 독립 내부 로직:** Google 원본 응답 파싱과 페이지 반복, 원본 키 계산, 별도 OAuth CLI 및 선택 가져오기는 합성 fixture로 검증한다. 지속 동기화 토큰 상태 전이와 실제 계정 연결은 아직 검증하지 않았다.
2. **합의가 필요한 저장·표시 계약:** 종일 date-only와 배타적 종료일, 원본별 값·충돌/미확인 상태, 계정·캘린더별 cursor와 재동기화 상태가 필요하다. 동일성 근거, 삭제·범위·보관·권한상실 정책, AI/승인 차단과 사용자 편집 보존을 함께 정하고 필요 시 `CONTRACTS.md`와 소비자를 갱신한다. 기존 계약 변경 전 담당자에게 공유한다.
3. 후속 합의 시 `apps/api/src/calendar-sync.ts`(정규화·원본 병합), `planning-store.ts`/`postgres-store.ts`와 `apps/api/DATABASE.md`(저장·마이그레이션), `apps/api/test/calendar-*.test.ts`를 검토한다. 외부 공개 타입·상태 UI가 필요한 경우 `packages/domain/src/contracts.ts`와 소비자도 함께 갱신한다. 파일명은 제안이다.
4. 합성 응답으로 빈 중간 페이지·증분 페이지·토큰 저장 실패·410 소스 격리, 다른 캘린더 보존, 반복 이동/취소·최소 삭제 필드, 종일 종료일·DST, 같은 제목/시간과 다른 반복 회차의 비병합을 검증한다. 실제 변경과 불완전 상태 전환은 revision/승인에 반영하고 단순 재조회는 불필요하게 기준을 바꾸지 않는지, 기존 pending 승인과 경합 시 stale이 되는지 PostgreSQL 트랜잭션 테스트도 추가한다. 권한 상실·불완전 조회 시 오류/미확인 처리와 실계정 검증 여부를 따로 기록한다.

공개 문서와 합성 fixture를 확인했다. 실제 Google API 호출·OAuth 동의·토큰 접근·지속 동기화는 수행하지 않았다.
