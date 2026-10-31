# 삐꾸 PIKKU

삐꾸(가칭)는 사용자의 일정과 개인 맥락을 바탕으로 실행 가능한 계획, 다음 행동, 계획 변경 후 복구를 돕고자 하는 AI 서비스다. 사용자에게 제안하고 선택을 받는 경험을 지향한다. Plan / Act / Recover는 현재 기획을 설명하는 가치 체계이며 공식 슬로건은 미정이다.

## 현재 상태

현재는 **v1 아키텍처·최소 계약을 공유하고 개발과 제공자 검증을 병렬 진행하는 단계**다. 기준은 **Expo + React Native + TypeScript / Node.js·Fastify / LangGraph JS / PostgreSQL·pg-boss / gpt-6.1-terra(high), Responses API**다. Hermes는 설계 참고이며 설치·포크하지 않는다. DB/서버 호스팅과 외부 제공자는 미정 또는 검증 후보다.

시연 목표는 개인화 추천→코드 검증→사용자 승인→반영, 실제 전화/이메일 연락대행, 전날/아침 서버 검토와 단일 지연·복구 사례다. 공동 약속은 연락 승인·상대 수락·최신 검증 후 변경한다. [PRD §2](docs/PRD.md)에 구현 순서·완료 기준·제외 범위를 정리했다.

현재 코드는 세 화면, 직접 일정 입력·체크인, 명시 Memory, AI Tool 경계와 제안 검증·저장·승인, PostgreSQL 저장과 저녁/아침 서버 예약을 연결한다. 앱의 자동 검토 설정에서 시각·시간대를 지정한다. **실제 Terra 추천→승인과 PostgreSQL·pg-boss 예약 경로는 합성 사례로 검증했다.** Gmail 연락 초안·승인·발송 UI와 서버 실행기, 로컬 OAuth 연결 도구를 구현했다. 실제 Gmail 발송·수신과 Calendar 읽기, Kakao 장소/도보·대중교통·자동차 조회를 확인했다. 사용자 교통수단 선택과 이동시간 확인 입력, 팀원 프롬프트 기반 실행 지침을 연결했다. Open-Meteo 예보·서울 지하철 도착 정보 패널도 연결했다. 실제 Gmail 답장→사용자 확인→격리 가상 일정 반영과 Google 테스트 일정 1건 가져오기, 중복 재반영 방지를 확인했다. 최종 자동 검사 657건과 typecheck·web/iOS/Android export가 통과했다. [공개 시연 웹](https://pikku-bbikku-web-preview.vercel.app)에 최신 코드를 반영하고 실제 API smoke를 확인했다. Google 연결은 전용 참여 계정 한 명에게만 제공된다. 실물 휴대폰 검증은 남아 있으며 정확한 버전·제한은 구현 계획의 배포 기록을 따른다. DB URL 없이 실행하는 메모리 모드는 서버 재시작 시 초기화되며 전체 MVP 완료나 운영 배포 상태가 아니다. [구현 계획](docs/IMPLEMENTATION_PLAN.md)에서 검증 근거와 남은 범위를 확인한다.

코디세이 AI 해커톤 2026의 AI 기반 추천 서비스 주제를 대상으로 한다. 제공된 프로젝트 요약에는 최종 제출 시각이 **2026년 11월 1일 13:00 KST**로 기재돼 있으나, 공식 가이드 원문은 아직 확인하지 못했다. 제출물·기한은 공식 안내와 대조해야 한다.

## 문서

- [실행 Agent 프롬프트](docs/AGENT_PROMPT.md): 팀원 원문을 현재 계약/실제 기능에 맞게 반영한 한국어 정본.

- [회의 맥락 정렬](docs/MEETING_ALIGNMENT.md): 자료 출처, 논의와 미결정 사항.
- [제품 요구사항 PRD](docs/PRD.md): 사용자 흐름, 기능 후보와 인수 기준.
- [팀 역할과 준비](docs/TEAM_PLAN.md): 다섯 명의 역할, 인계와 검증.
- [아키텍처](docs/ARCHITECTURE.md): S LLM·Tool·Schedule Engine·승인·Memory·Scheduler의 책임과 연결.
- [결정 기록 ADR](docs/ADR.md): 채택 기술·승인 원칙의 이유, 대안·남은 결정.
- [최소 공통 계약](docs/CONTRACTS.md): 공유 데이터·Tool·HTTP v1·승인·오류 규격.
- [구현 계획과 검증](docs/IMPLEMENTATION_PLAN.md): 단계별 완료 조건, 병렬 작업 경계와 현재 결과.
- [AI 작업 공통 규칙](AGENTS.md): 문서 정본과 협업·검증 원칙.

처음에는 README → PRD §2 → TEAM_PLAN의 인계 표를 읽고, 구현에는 ARCHITECTURE → ADR → CONTRACTS를 참고한다. v1은 이번 개발 기준이며 팀 전체 검토 완료·실제 연동 성공과 구분한다. 기존 전체 백로그를 한꺼번에 구현하는 계약이 아니다.

## 팀

PM은 제품 기획·PRD·UX/UI 시안·일정과 QA를 총괄한다. 세진님은 앱·백엔드 구현, 아키텍처와 통합을 주도한다. 찬욱님은 DB·Long-term Memory·제공 VM, 영휘님은 시스템 프롬프트·AI 가이드라인, 서연님은 외부 API·음성·실제 전화 기능 검토를 담당한다. 자세한 인계와 경계는 [팀 역할과 준비](docs/TEAM_PLAN.md)를 따른다.

## 로컬 실행

Node.js 22.13 이상과 npm을 사용한다. 저장소 루트에서 실행한다.

```sh
npm ci
npm run dev:local
```

PostgreSQL과 시간 트리거를 사용하려면 두 터미널에서 다음 순서로 실행한다. 처음 실행 시 프로젝트 내부에 로컬 DB가 만들어지며 이후에는 데이터가 유지된다. 클라우드 DB 키나 Docker는 필요하지 않다.

```sh
# 터미널 1: DB 유지
npm run dev:db
# 터미널 2: API + Expo + 서버 예약 실행기
npm run dev:local -- --postgres --scheduler
```

앱의 **AI 채팅 → 자동 검토 설정**에서 저녁/아침을 켜고 시각을 저장한다. 초기값은 모두 꺼짐이며 예약은 제안 생성까지만 수행한다. 모델 키가 없으면 설정·저장은 가능하지만 실제 추천은 생성하지 못한다. 설치·권한·종료·실DB 검사 방법은 [로컬 PostgreSQL 안내](docs/LOCAL_POSTGRES.md)를 따른다. `--postgres`와 명시적 `PIKKU_DATABASE_URL`은 동시에 사용하지 않는다.

API와 Expo Metro가 함께 시작된다. 앱 코드 변경은 Metro, 서버 코드 변경은 Node watch에 반영된다. **메모리 모드는 서버 재시작 시 데이터가 사라지고 PostgreSQL 모드는 유지한다.** 기본 모드는 이 컴퓨터의 루프백에만 연결한다. iOS 시뮬레이터를 사용할 수 있고, Android 에뮬레이터는 앱의 API 주소를 `http://10.0.2.2:3001`로 설정한다. 시뮬레이터 설치·기동 자체는 별도 준비가 필요하다.

시작 로그에 표시되는 `.local/dev-session-3001.txt`를 로컬 편집기로 열어 앱 상단 **개발 연결 설정**의 토큰 칸에 넣는다. 이 파일은 AI 키가 아닌 임시 개발 세션이며 Git에서 제외되고 정상 종료 시 삭제된다. `PORT`를 바꾸면 파일명도 달라진다. 종료는 `Ctrl+C`다.

같은 신뢰 가능한 사설 Wi-Fi의 실제 휴대폰에서 확인하려면 다음처럼 실행하고 Expo QR을 연다. 앱과 Expo Go의 SDK 버전이 일치해야 하며 설치용 빌드·실기기 확인은 후속 검증이다.

```sh
npm run dev:local -- --lan
```

LAN 모드는 이 컴퓨터의 사설 IPv4에 API를 열고 Expo 개발 서버도 네트워크에 노출한다. **HTTP 토큰·데이터는 암호화되지 않으며 Metro에는 앱 API의 인증이 적용되지 않는다.** 공용 해커톤 Wi-Fi·포트 포워딩·외부 공개에 사용하지 않고, 개인 핫스팟 등 통제한 네트워크에서 테스트 데이터로만 사용한다. 외부 시연 배포에는 HTTPS·실제 사용자 인증과 개발 서버를 제외한 빌드가 필요하다.

실제 AI 연결 시 `.env.example`을 `.env.local`로 복사한 후 프로젝트용 `PIKKU_OPENAI_API_KEY`를 로컬에서 설정한다. 모델은 `gpt-6.1-terra`, 추론 강도는 `high`이며 다른 모델로 자동 대체하지 않는다. API 접근 가능 여부는 별도 확인 대상이다. 키가 없으면 직접 입력·조회는 가능하고 채팅은 `not_configured`를 반환한다. 키를 앱 토큰 칸이나 `EXPO_PUBLIC_*`에 넣지 않는다.

```sh
npm run typecheck
npm test
npm run export:mobile
npm run dev:local -- --smoke
npm run test:postgres
npm run verify:model -- --live
npm run verify:planning -- --live
```

`test:postgres`는 실행 중인 로컬 DB를 사용해 실제 영속 저장 테스트까지 실행한다. `verify:planning -- --live`는 격리된 합성 데이터로 실제 모델·예약·승인·재연결 복구를 확인한다(최대 24회 호출). `verify:model -- --live`는 프로젝트 키가 있을 때만 합성 입력으로 최대 두 번 실제 모델을 호출한다. [모델 검증 안내](docs/MODEL_VERIFICATION.md)와 [외부 API 준비](docs/PROVIDER_SETUP.md)에 필요한 설정과 미검증 항목을 기록한다.

`export:mobile`은 iOS·Android JavaScript 번들을 만들며 설치용 바이너리를 만들지는 않는다. `--smoke`는 로컬 서버·개발 인증·종료를 확인하고 실제 모델을 호출하지 않는다. 모바일 세부 동작은 [모바일 안내](apps/mobile/README.md)를 참고한다.

## Gmail 연락대행

Google Cloud의 웹 OAuth 클라이언트 ID/비밀을 `.env.local`에 설정한 뒤 `npm run connect:gmail`로 개발용 Gmail 계정을 연결한다. PostgreSQL 모드에서 공동 일정 조정 제안의 **연락 준비 → 초안 저장 → 연락 내용 승인 → Gmail 발송**을 사용한다. 계정 미설정이나 메모리 저장 모드에서는 발송하지 않는다. 발송 성공은 상대의 일정 변경 수락이 아니다.

등록 리디렉션과 상세 설정·실제 검증 여부는 [Gmail 연결 안내](docs/PROVIDER_SETUP.md)를 참고한다. 이 연결 도구는 현재 개발 사용자 한 명을 위한 것이며 운영 로그인 방식은 아니다.

## 다음 진행 순서

1. [문서 PR #1](https://github.com/codyssey-hackerton/codyssey-hackathon-bbikku/pull/1)은 병합됐으며, 구현과 계약 보완은 별도 PR로 공유해 검토한다.
2. PostgreSQL·시간 트리거 검증을 유지하면서 프로젝트용 키로 실제 모델/외부 제공자 연결을 확인한다. 구현의 다음 경계는 [구현 계획](docs/IMPLEMENTATION_PLAN.md)을 따른다.
3. 실제 연락대행을 통합하고 시연 기기·채널·QA 범위를 검증 결과로 확정한다.
4. 팀 디자인·최종 대본·공식 제출 규정을 확인한다. 미설정·모의 결과를 실연동 성공으로 표시하지 않는다.
