# PIKKU — 시계는 워치

**일정과 개인 선호를 바탕으로 다음 행동을 추천하고, 사용자가 승인한 변경만 반영하는 AI 개인 비서입니다.** 일정·할 일·루틴을 함께 관리하며, 계획이 겹치거나 늦어졌을 때 가능한 대안을 제시합니다.

코디세이 AI 해커톤 2026 · 팀 **시계는 워치**

- **[웹앱 실행](https://pikku-bbikku-web-preview.vercel.app/)**
- **[제출 체크리스트 및 시연 안내](docs/SUBMISSION.md)**
- **[외부 자원 활용 내역](docs/EXTERNAL_RESOURCES.md)**
- 제출 기준은 `main`에서 선정해 `시계는 워치_소스코드.txt`에 기록한 **전체 커밋 해시**입니다. 이후 브랜치 변경과 심사 대상 커밋은 구분합니다.

## 해결하려는 문제

학생·직장인처럼 약속과 개인 작업을 병행하는 사용자는 일정을 기록한 뒤에도 준비·이동·우선순위를 계산하고 지연된 계획을 다시 정리해야 합니다. PIKKU는 저장된 일정과 사용자가 명시한 선호·일시 상황을 필요한 만큼 조회해 구체적인 대안을 추천합니다. AI가 제안하더라도 실제 저장·연락은 별도의 검증과 사용자 승인을 거칩니다. 생산성 개선 효과는 아직 정량 측정하지 않았습니다.

## 주요 기능과 현재 범위

| 기능 | 구현한 흐름 | 사용 조건·제한 |
|---|---|---|
| PIKKU 대화와 추천 | 조회·계산 Tool, 짧은 추천 선택지, 변경 제안, 수락·거절 및 대화로 수정 | 실제 모델 키 필요. 선택지 클릭 자체가 저장 승인은 아님 |
| 일정·할 일·루틴 | 홈·월간·일간 조회, 직접 입력, 수행/참석 기록, 한 단계 상태 취소, 반복 규칙과 회차 분리 | 루틴은 지정 범위 최대 31일 회차 생성. 기존 생성 회차는 규칙 수정으로 일괄 변경하지 않음 |
| 개인화 | 온보딩·선호/상황 카드와 사용자별 Memory | 모델은 필요한 키를 조회. 모든 선호를 항상 적용하거나 환각을 제거한다고 보장하지 않음 |
| Google 연결 | Google 회원 로그인, Calendar·Gmail·연락처별 OAuth 동의 | 회원 로그인과 서비스 권한은 별도. 테스트 OAuth 앱이면 허용된 테스트 계정 필요 |
| Calendar 가져오기 | 화면의 월 범위에서 기본 또는 사용자가 선택한 캘린더의 새 일정 자동 가져오기, 종일·투명·반복 회차 처리, 중복 방지 | 이미 가져온 원본의 수정·삭제는 자동 전파하지 않음. 원본 쓰기는 별도의 제한된 수동 동기화 |
| 경로·날씨 | 위치 공유/출발지와 이동수단 선택 후 장소·도보·대중교통·자동차 이동시간 조회 | 현재 교통 기준 추정. 미래 교통 예측 아님. Google/지도 등 각 계정·권한·키 필요 |
| 연락대행 | 승인 기반 Gmail 발송·회신 확인, ClawOps 전화 요청·승인·통화 결과 검토 | 서버에 등록된 사용자별 제공자 설정 필요. 통화 전사만으로 자동 일정 확정하지 않음 |
| 아침·저녁 검토 | 온보딩 기본 제안 09:00/21:00, 저장한 시간대로 서버 예약·브리핑/회고 | PostgreSQL·Scheduler·모델 필요. 설정 저장 전 자동 활성화하지 않음 |
| 기기 알림·건강 데이터 | 네이티브 알림 및 Apple HealthKit/Android Health Connect 어댑터 | 설치형 앱·기기 권한 필요. 실제 알림 울림·건강 데이터 양 플랫폼 검증은 보류. 웹 예약 알림은 미지원 |

전화·메일·Calendar 연결은 사용자별입니다. 다른 사용자의 계정이나 자격을 자동 공유하지 않습니다. 미설정·권한 거부·결과 불명은 성공으로 표시하지 않으며, 자세한 구현/실사용 증거는 [구현 기록](docs/IMPLEMENTATION_PLAN.md)을 따릅니다.

## AI 기술과 직접 개발한 부분

```mermaid
flowchart LR
  U[Expo 앱 · 웹] --> A[Fastify API · 회원 인증]
  A --> L[LangGraph · 단일 계획 LLM]
  L --> T[읽기·계산 Tool]
  T --> D[(PostgreSQL · 일정/Memory)]
  T --> E[외부 API]
  L --> V[Schedule Engine 검증]
  V --> P[변경 제안]
  P --> C[사용자 승인 · 최신 상태 재검증]
  C --> D
  D --> S[pg-boss 예약]
  S --> L
```

- **모델:** `gpt-6.1-terra` / 추론 `high`, Responses API의 함수 호출을 사용합니다. 모델 학습이나 자체 기반 모델 개발은 하지 않았습니다.
- **직접 개발:** 사용자별 일정·Memory 구조, 도구 권한과 조회 범위, 빈 시간/시간 역산/충돌 검사, 버전·만료·멱등성에 결속된 제안 승인, 공동 연락과 결과 검토, 외부 캘린더 원본 연결, 앱 화면·상태·API 연결입니다.
- **실행 경계:** 모델이 직접 DB를 변경하거나 전화·메일을 발송하지 않습니다. 서버가 검증하고 사용자 승인 후 해당 실행 경로를 호출합니다.
- **설계 참고:** Hermes의 책임 분리를 참고했으며 Hermes를 설치하거나 포크하지 않았습니다. 실행 흐름은 LangGraph JS입니다.

| 영역 | 기술 |
|---|---|
| 앱·웹 | Expo 58, React Native 0.88, React 19, TypeScript, Pretendard |
| API·Agent | Node.js 22.13 이상, Fastify, LangGraph JS, Zod |
| 저장·예약 | PostgreSQL, pg-boss |
| 배포 | Vercel 웹, NAVER Cloud VM API·PostgreSQL, HTTPS 터널 |
| 외부 연동 | Google OAuth/Calendar/Gmail/People, Kakao, Open-Meteo, 서울 지하철, ClawOps |

정확한 패키지 버전은 `package-lock.json`, 자원·라이선스·보류 항목은 [외부 자원 표](docs/EXTERNAL_RESOURCES.md)를 확인하세요.

## 웹앱 사용과 2분 시연

1. [웹앱](https://pikku-bbikku-web-preview.vercel.app/)에서 Google 로그인 후 선호를 입력하거나 건너뜁니다. Google 서비스 연결은 계정 설정에서 별도로 동의합니다. 일반 사용자는 개발 토큰을 입력하지 않습니다.
2. 할 일 하나와 고정 일정 하나를 등록하고, PIKKU에 계획 조정을 요청합니다.
3. 추천 이유와 변경 시각을 확인합니다. **수락 전 원래 일정 유지 → 수락 → 홈/캘린더 반영**을 보여줍니다.
4. 수행 기록을 변경하고 화면 간 같은 기록이 보이는지 확인합니다. 외부 연락은 준비된 계정·동의한 수신자가 있을 때만 별도로 시연합니다.

공개 OAuth가 테스트 계정 제한으로 거절되면 운영 담당자에게 등록을 요청하거나 아래 로컬 개발 경로를 사용합니다. 서버/API 키/외부 계정이 없는 상태에서 AI·외부 연동이 실행됐다고 표시하지 않습니다. 영상은 실제 앱의 입력→결과를 녹화해야 합니다.

## 로컬 실행

### 1. 설치와 환경설정

Node.js **22.13 이상**, npm, Git이 필요합니다. macOS에서 로컬 실행과 검사를 수행했으며 다른 OS 전체 조합을 검증하지는 않았습니다.

```sh
git clone https://github.com/codyssey-hackerton/codyssey-hackathon-bbikku.git
cd codyssey-hackathon-bbikku
# 제출물을 재현하려면 제공된 전체 커밋 해시로 git checkout <최종-커밋-해시>
npm ci
cp .env.example .env.local
```

`.env.local`의 `PIKKU_OPENAI_API_KEY`에 서버용 프로젝트 키를 입력합니다. 지정 모델 접근 권한이 있어야 하며 다른 모델로 자동 대체하지 않습니다. 키가 없어도 직접 일정 입력·조회는 가능하고 AI 요청은 미설정으로 응답합니다. 키·DB URL·OAuth 비밀값은 Git이나 `EXPO_PUBLIC_*`에 넣지 않습니다.

### 2. 가장 빠른 개발 실행

```sh
npm run dev:local
```

API(기본 `http://127.0.0.1:3001`)와 Expo Metro가 시작됩니다. Metro 터미널에서 `w`를 눌러 웹앱을 엽니다. 첫 화면 **개발 연결 설정**에서 API 주소와 로그에 표시된 `.local/dev-session-3001.txt`의 개발 토큰을 입력하고 적용합니다. 이는 Google 회원 로그인과 별개인 **로컬 개발 전용 경로**입니다. 토큰은 정상 종료 시 삭제되며, 포트가 다르면 파일명도 바뀝니다. 종료는 `Ctrl+C`입니다.

기본 메모리 모드는 서버 재시작 시 일정이 사라집니다. 보존 및 회원·루틴·동기화·예약 기능에는 PostgreSQL이 필요합니다.

### 3. PostgreSQL과 시간 예약

```sh
# 터미널 1 — 로컬 DB 시작 및 유지
npm run dev:db
# 터미널 2 — DB·예약을 사용하는 API와 Expo
npm run dev:local -- --postgres --scheduler
```

로컬 DB는 `.local/`에 유지되며 Docker는 필수가 아닙니다. 외부 PostgreSQL을 쓸 때는 `PIKKU_DATABASE_URL`을 설정하고 `--postgres`를 생략합니다. `--postgres`와 명시 DB URL을 동시에 쓰지 않습니다. 앱에서 아침/저녁 설정을 저장해야 해당 사용자의 예약이 활성화됩니다. 서버 예약과 기기 알림 전달은 별도 기능입니다. [DB 상세](docs/LOCAL_POSTGRES.md)

### 4. 선택 연동 설정

| 기능 | 서버 설정·준비 |
|---|---|
| Google 회원 로그인 | PostgreSQL, `PIKKU_GOOGLE_OAUTH_CLIENT_ID`, `PIKKU_GOOGLE_OAUTH_CLIENT_SECRET`, `PIKKU_GOOGLE_OAUTH_REDIRECT_URI` |
| Calendar·Gmail·Google 연락처 | 위 설정 + `PIKKU_GOOGLE_USER_CREDENTIAL_DIR` 절대경로, 해당 Google API 활성화, 사용자별 OAuth 동의 |
| 지도·이동시간 | `PIKKU_KAKAO_REST_API_KEY`, 제공자 API별 사용 권한 |
| 날씨 | Open-Meteo 사용, 별도 API 키 없음 |
| 지하철 | `SEOUL_SUBWAY_API_KEY`; 기본 HTTPS, 임의 HTTP 우회 없음 |
| 전화 | `PIKKU_PHONE_CREDENTIAL_DIR`의 사용자별 서버 자격 설정. 앱에 제공자 비밀값을 넣지 않음 |
| 웹 API 접근 | API의 `PIKKU_WEB_ORIGINS`에 정확한 웹 Origin, 웹 빌드의 `EXPO_PUBLIC_API_URL`에 접근 가능한 API 주소 |

OAuth 콜백은 공개 **HTTPS** 주소의 `/v1/google/oauth/callback`이며 Google Cloud 등록값과 정확히 일치해야 합니다. 로컬 회원 로그인 테스트도 API에 도달하는 HTTPS 콜백과 테스트 사용자 설정이 필요합니다. Calendar/Gmail/People 동의와 전화 제공자 설정은 [제공자 안내](docs/PROVIDER_SETUP.md), [회원·루틴·동기화 안내](docs/MEMBER_ROUTINE_CALENDAR.md)를 참고하세요. 기존 단일 개발 계정 이관 설정은 새 회원의 권한을 대체하지 않습니다.

### 5. 앱 빌드와 검사

```sh
npm run typecheck
npm test
npm run export:web --workspace @pikku/mobile
npm run export:mobile
npm run dev:local -- --smoke
```

`npm test`는 테스트 DB 미설정 시 일부 PostgreSQL 검사를 건너뜁니다. 별도 테스트 전용 로컬 DB를 시작한 뒤 `npm run test:postgres`로 확인하며 운영 DB를 사용하지 않습니다. 실제 모델 검사는 키가 있을 때만 `npm run verify:model -- --live`로 수행합니다(합성 입력, 최대 두 번 모델 요청). [모델 검사 안내](docs/MODEL_VERIFICATION.md)

JS export는 설치용 바이너리가 아닙니다. HealthKit·Health Connect 등 네이티브 모듈을 사용하는 앱은 Expo Go만으로 검증할 수 없고 development build, 플랫폼 도구 및 서명이 필요합니다. 설치·알림·건강 권한의 실기기 검증은 별도입니다. [모바일 안내](apps/mobile/README.md)

## 확인한 검증과 한계

- `main` 통합 때 전체 workspace 타입 검사, 모바일 548건, 도메인 44건, API 승인·저장·Calendar 집중 56건이 통과했습니다. DB 미설정 5건은 skip이며, 별도 임시 PostgreSQL의 회원 분리·저장/복구 2건은 통과했습니다.
- 이후 추천 우선 프롬프트 변경은 문서 동일성·추천 선택지·승인 전 불변을 포함한 5건과 API 타입 검사를 통과했습니다. 최신 프롬프트의 실제 모델 응답 품질을 별도로 측정한 것은 아닙니다.
- `2fbc0c8` 프롬프트 배포 때 공개 웹 HTML/JS와 API health 응답, 두 API의 프롬프트 소스 일치를 확인했습니다. 이것을 신규 사용자의 Google 동의·전체 E2E 성공으로 확대하지 않습니다.
- 실제 모델/외부 API 일부 실연결 기록과 모의 검증을 구분해 [구현 기록](docs/IMPLEMENTATION_PLAN.md)에 보존했습니다. 실기기 알림 울림, 워치 건강 데이터, 모든 계정·외부 제공자 조합은 검증하지 않았습니다.

## 팀과 문서

| 팀원 | 담당 범위 |
|---|---|
| 세진 | 전체 아키텍처, 앱·백엔드 구현, API 계약, 통합 |
| 찬욱 | DB·사용자 Memory 구조, VM 검토 |
| 영휘 | 시스템 프롬프트, AI 질문·추천·승인 가이드라인 |
| 서연 | Calendar·지도·교통·음성/전화 API 검토 |
| 홍빈 | 기획·PRD, UX/UI, 시연·QA·제출 총괄 |

역할은 [팀 계획](docs/TEAM_PLAN.md) 기준이며 최종 발표의 개인별 실제 기여는 팀에서 확인합니다.

- [PRD](docs/PRD.md) · [아키텍처](docs/ARCHITECTURE.md) · [ADR](docs/ADR.md) · [공통 계약](docs/CONTRACTS.md)
- [시스템 프롬프트](docs/AGENT_PROMPT.md) · [디자인 연결](docs/DESIGN_INTEGRATION.md) · [건강 데이터](docs/WEARABLE_INTEGRATION.md)
- [구현·검증 기록](docs/IMPLEMENTATION_PLAN.md) · [제출 체크리스트](docs/SUBMISSION.md) · [외부 자원·출처](docs/EXTERNAL_RESOURCES.md)

## 출처와 공개 범위

Pretendard(SIL OFL 1.1), Streamline Core(CC BY 4.0), Lucide/Feather(ISC/MIT) 등의 출처와 라이선스를 [외부 자원 표](docs/EXTERNAL_RESOURCES.md)에 정리했습니다. 공개 저장소라고 해서 모든 코드·디자인에 일괄적인 재사용 라이선스를 부여한 것은 아닙니다. 사전 보유 코드·디자인 권리·팀의 추가 사용 자원은 제출 전 팀 확인이 필요합니다.
