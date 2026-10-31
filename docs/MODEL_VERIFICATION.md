# 모델 연결 검증

## 현재 상태

2026-10-31 프로젝트 `.env.local` 키로 실제 `gpt-6.1-terra` / `high` 검증을 완료했다. `verify:model --live`는 HTTP 2회, `calculate_timing` 1회 후 `verified`였다. 원본 함수 호출과 같은 `call_id`의 실행 결과를 다음 요청에 전달하는 경로를 확인했다. 키나 응답 본문은 기록하지 않았다.

도구 실행 결과를 일반 사용자 메시지로 넘기던 부분을 Responses의 `function_call_output`으로 수정했다. 요청별 원본 output을 보존하고 `store:false`에서 암호화 reasoning 반환을 요청한다. 실제 응답의 reasoning 항목 개수는 기록하지 않았으므로 존재 여부를 검증했다고 표현하지 않는다.

## 준비와 실행

1. 이 프로젝트용 OpenAI API 키를 로컬 `.env.local`의 `PIKKU_OPENAI_API_KEY` 또는 현재 셸의 같은 이름의 환경변수로 설정한다. 키 값을 채팅·문서·코드에 붙이지 않는다. 현재 프로세스에 설정된 값이 파일보다 우선한다.
2. 프로젝트 루트에서 `npm run verify:model`을 실행하면 호출 없이 사용법만 표시한다.
3. 실제 호출은 명시적으로 `npm run verify:model -- --live`를 실행한다. 최대 두 번의 API 요청이 발생하며 제공자 사용 요금이 적용될 수 있다.

이 명령은 실제 `createResponsesModel`과 Agent의 `calculate_timing` 경로에 고정된 합성 시간·소요시간만 전달한다. 정확히 `gpt-6.1-terra`, `reasoning.effort: high`, `store: false`로 요청하며 다른 모델로 대체하거나 자동 재시도하지 않는다. API 응답의 모델·effort 메타데이터, 한 번의 함수 호출과 인수, 로컬 계산 결과, 최종 답변 수신을 확인한다. 실제 일정 변경이나 연락은 수행하지 않으며, 최종 답변의 자연어 정확도 전체를 평가하는 검증은 아니다.

결과는 키나 API 응답 본문 없이 JSON 상태만 출력한다. `verified`는 위 두 단계가 모두 통과한 경우, `not_configured`는 키가 없는 경우, `failed`는 호출·응답·함수 검증이 실패한 경우다. `response_metadata`는 반환된 모델 ID나 effort가 정확히 일치하지 않거나 확인되지 않는 경우이며, 무조건 다른 모델로 바꾸지 않고 원인을 확인한다.

스텁 테스트: `./node_modules/.bin/tsx --test apps/api/test/verify-model.test.ts`.

## PostgreSQL·예약을 포함한 실제 모델 검증

DB를 켠 상태에서 `npm run verify:planning -- --live`로 실행한다. 일반 `npm run verify:planning`은 도움말만 출력한다. 프로젝트 키와 `.local/postgres-url.txt` 또는 **테스트 전용** `PIKKU_TEST_DATABASE_URL`을 사용한다. 사용자 자료 대신 합성 일정·선호만 전달하며 최대 24번의 제공자 요청으로 제한한다. 실행마다 별도 상태/큐 schema를 만들고 증거를 보존한다. 완료 시 합성 사용자의 미래 자동 검토 설정을 끈다.

2026-10-31 실행 `f267c3a6873647d484ad`: **8개 검증 통과, 실제 모델 HTTP 8회**. 각 추천에서 `read_schedule` → `read_memory` → `validate_changes` → 제안 경로가 실행됐다.

- 실제 HTTP 인증과 PostgreSQL 저장, 직접 추천의 승인 전 일정 미변경.
- API 인스턴스·DB 연결 풀을 닫고 다시 연 뒤 대기 중 제안 복구.
- 승인 재전송 시 한 번 반영하고 고정 일정 유지.
- 18:54 KST 실제 pg-boss 예약 도래 → 실제 모델 제안 생성.
- 같은 예약 재전달 시 추가 모델 호출·제안 생성 없음.
- 예약 제안 승인 중복 방지와 적용 결과·승인·실행 기록 재연결 후 복구.

로컬 증거는 `.local/live-planning/f267c3a6873647d484ad.json`에 있다(키·모델 응답 본문 제외, Git 미포함). 이는 합성 사례 두 건의 실제 제공자 연결 검증이며 추천 품질 전반, OS 프로세스 강제 종료·DB 장애, 모바일 UI 경유 검증이나 메일 발송을 뜻하지 않는다.

공식 근거: [GPT-6.1 Terra 모델](https://developers.openai.com/api/docs/models/gpt-6.1-terra), [Responses 함수 호출](https://developers.openai.com/api/docs/guides/function-calling), [API 키 보안](https://developers.openai.com/api/docs/guides/production-best-practices).
