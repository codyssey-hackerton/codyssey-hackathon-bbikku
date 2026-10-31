# 모델 연결 검증

## 현재 상태

2026-10-31 확인: 프로젝트 루트 `.env.local`이 없고 현재 프로세스에도 `PIKKU_OPENAI_API_KEY`가 없어 `not_configured`다. `npm run verify:model -- --live`는 키가 없는 상태에서 요청 0건으로 종료했으며, 실제 모델 연결·응답은 **미검증**이다. 테스트 스텁의 성공은 실제 API 성공이 아니다.

## 준비와 실행

1. 이 프로젝트용 OpenAI API 키를 로컬 `.env.local`의 `PIKKU_OPENAI_API_KEY` 또는 현재 셸의 같은 이름의 환경변수로 설정한다. 키 값을 채팅·문서·코드에 붙이지 않는다. 현재 프로세스에 설정된 값이 파일보다 우선한다.
2. 프로젝트 루트에서 `npm run verify:model`을 실행하면 호출 없이 사용법만 표시한다.
3. 실제 호출은 명시적으로 `npm run verify:model -- --live`를 실행한다. 최대 두 번의 API 요청이 발생하며 제공자 사용 요금이 적용될 수 있다.

이 명령은 실제 `createResponsesModel`과 Agent의 `calculate_timing` 경로에 고정된 합성 시간·소요시간만 전달한다. 정확히 `gpt-6.1-terra`, `reasoning.effort: high`, `store: false`로 요청하며 다른 모델로 대체하거나 자동 재시도하지 않는다. API 응답의 모델·effort 메타데이터, 한 번의 함수 호출과 인수, 로컬 계산 결과, 최종 답변 수신을 확인한다. 실제 일정 변경이나 연락은 수행하지 않으며, 최종 답변의 자연어 정확도 전체를 평가하는 검증은 아니다.

결과는 키나 API 응답 본문 없이 JSON 상태만 출력한다. `verified`는 위 두 단계가 모두 통과한 경우, `not_configured`는 키가 없는 경우, `failed`는 호출·응답·함수 검증이 실패한 경우다. `response_metadata`는 반환된 모델 ID나 effort가 정확히 일치하지 않거나 확인되지 않는 경우이며, 무조건 다른 모델로 바꾸지 않고 원인을 확인한다.

스텁 테스트: `./node_modules/.bin/tsx --test apps/api/test/verify-model.test.ts`.

공식 근거: [GPT-6.1 Terra 모델](https://developers.openai.com/api/docs/models/gpt-6.1-terra), [Responses 함수 호출](https://developers.openai.com/api/docs/guides/function-calling), [API 키 보안](https://developers.openai.com/api/docs/guides/production-best-practices).
