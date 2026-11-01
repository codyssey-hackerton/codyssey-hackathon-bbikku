# 외부 자원 활용 내역 — 제출 검토 초안

팀명: **시계는 워치**. 기준: `docs/hackathon-submission` 작업 트리, main 기반 `2fbc0c8` 및 작업 트리의 `package-lock.json`·소스·자산 출처 문서. 이 문서는 발표자료용 정리 초안이며, 최종 제출 커밋과 팀 전체 사용 내역을 대조해야 한다. 표의 용도는 코드·자산상 사용 또는 연결 경로를 뜻하며, 외부 서비스의 현재 연결·실행 성공을 뜻하지 않는다.

주최 가이드는 발표자료에 **구분 | 명칭 | 용도 | 라이선스** 표를 요구한다. 외부 자원 미기재에 관한 감점·실격 문구가 함께 있으므로 실제 사용한 항목을 빠짐없이 확인한다. 사전 보유 코드는 주제 공개 전에 팀원이 작성하거나 보유한 코드다. **팀 확인 전이므로 ‘해당 없음’으로 확정하지 않는다.**

## 실행 코드 및 번들 자산

| 구분 | 명칭 | 용도 | 라이선스 |
|---|---|---|---|
| 오픈소스 | Expo 58.0.21, React 19.3.0, React Native 0.88.1, React DOM 19.3.0, React Native Web 0.21.4 | 앱·웹 UI와 실행 | 각 패키지 MIT |
| 오픈소스 | `@expo/metro-runtime` 58.0.15, `expo-font` 58.0.11, `expo-status-bar` 58.0.4, `expo-contacts` 58.0.10, `expo-location` 58.0.20, `expo-notifications` 58.1.7 | 앱 런타임·글꼴·상태 표시·연락처·위치·알림 | 각 패키지 MIT |
| 오픈소스 | `@react-native-community/datetimepicker` 9.2.1, `react-native-safe-area-context` 5.10.1 | 날짜 선택·안전 영역 | 각 패키지 MIT |
| 오픈소스 | `@kingstinct/react-native-healthkit` 16.2.0, `react-native-health-connect` 4.1.3, `react-native-nitro-modules` 0.37.1 | 기기 건강 데이터 연결 경로 | 각 패키지 MIT; 플랫폼 제공 조건 별도 확인 |
| 오픈소스 | Fastify 5.12.7, `@fastify/cors` 11.3.1, `@fastify/rate-limit` 11.2.1 | API 서버·접근 제어·요청 제한 | 각 패키지 MIT |
| 오픈소스 | Node.js | 서버 런타임 | [Node.js 라이선스 원문](https://github.com/nodejs/node/blob/main/LICENSE): 본체 MIT, 포함 구성요소별 조건 별도; 배포 버전 확인 필요 |
| 오픈소스 | PostgreSQL | 일정·Memory 데이터 저장소 | [PostgreSQL License](https://www.postgresql.org/about/licence/); 배포 버전 확인 필요 |
| 오픈소스 | `@langchain/core` 1.3.2, `@langchain/langgraph` 1.6.0 | 에이전트 실행 흐름 | 각 패키지 MIT |
| 오픈소스 | `google-auth-library` 11.3.2 | Google 인증 보조 | Apache-2.0 |
| 오픈소스 | `pg` 8.23.1, `pg-boss` 12.38.0 | PostgreSQL 연결과 예약 작업 | 각 패키지 MIT; PostgreSQL 자체 라이선스는 위 항목 참조 |
| 오픈소스 | `zod` 4.6.7 | 요청·응답 스키마 검증 | MIT |
| 오픈소스 | `twilio` 6.2.0 | 기존 Twilio 음성 웹훅 서명 검증 경로에 잔존 | MIT; Twilio API 이용 조건 별도 |
| 글꼴 | Pretendard | 앱 글꼴 | SIL OFL 1.1. [라이선스 전문](../apps/mobile/assets/fonts/LICENSE-Pretendard.txt) |
| 아이콘 | Lucide static 1.66.0 | 앱 아이콘 글꼴 | ISC; 일부 Feather 유래 아이콘은 MIT 표기 포함. [원문](../apps/mobile/assets/icons/LICENSE) |
| 아이콘 | Streamline Core | 앱 아이콘. 원본 SVG를 PNG로 변환하고 크기·색상 변경, 더보기 90도 회전 | CC BY 4.0. [출처·변경 기록](../apps/mobile/assets/streamline-core/ATTRIBUTION.md); 앱 설정의 출처 표시 유지 |
| 디자인 | Figma 메인·온보딩 시안 및 프로필 그림 | 화면 설계 참고·프로필 자산 | Figma 도구와 디자인 원본은 별개; 디자인 저작권·사용 허락 **팀 확인 필요**. [프로필 출처](../apps/mobile/assets/profile-avatar/README.md) |
| 디자인 참고 | Aria UI | 화면·사용 흐름 참고 | 원본 이용 조건 **확인 필요**. [관찰 및 제한](DESIGN_INTEGRATION.md); 코드 복제나 성능 우위를 주장하지 않음 |
| 디자인 | 삐꾸 캐릭터 | 화면 캐릭터 | 자산 README는 디자인 정본에서 유래했다고 기록; 원본 제작자·이용 권리 **팀 확인 필요**. [자산 설명](../apps/mobile/assets/pikku-character/README.md) |

## 외부 API 및 플랫폼 — 코드상 연결 경로

| 구분 | 명칭 | 용도 | 라이선스 |
|---|---|---|---|
| 외부 API | OpenAI Responses API, `gpt-6.1-terra` | 일정 관련 AI 판단·자연어 응답 | 제공자 서비스 약관 적용; 세부 이용 조건 확인 필요 |
| 외부 API | Google OAuth / Calendar / Gmail / People API | Google 로그인·일정·메일·연락처 연동 | 제공자 API 이용 약관 적용; 권한 및 세부 조건 확인 필요. [OAuth](https://developers.google.com/workspace/guides/configure-oauth-consent) · [Calendar](https://developers.google.com/workspace/calendar/api/auth) · [Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes) |
| 외부 API | Kakao Local / Kakao Map 경로 / Kakao Mobility | 장소 검색과 도보·대중교통·자동차 이동시간 조회 | 제공자 API 이용 약관 적용; 세부 조건 확인 필요. [Local](https://developers.kakao.com/docs/ko/local/dev-guide) |
| 외부 API | [Open-Meteo](https://open-meteo.com/) | 시간별 날씨 예보 | 예보 데이터 CC BY 4.0 출처 표시; [API 이용 조건](https://open-meteo.com/en/terms) 별도. [라이선스](https://open-meteo.com/en/licence) |
| 외부 API | [서울 열린데이터광장 실시간 지하철 도착정보](https://data.seoul.go.kr/dataList/OA-12764/A/1/datasetView.do) | 역별 현재 도착 정보 | 데이터 이용·출처 조건 **확인 필요** |
| 외부 API | ClawOps | 관리형 AI 전화·통화 결과 조회 경로 | 제공자 서비스 약관 **확인 필요**. 실제 연결·통화 성공은 별도 검증 기록을 따른다 |
| 외부 API | Twilio Voice | 기존 별도 전화·웹훅 경로가 소스에 남아 있음 | 제공자 서비스 약관 **확인 필요**. 현재 관리형 ClawOps 경로와 구분 |
| 플랫폼 | Apple HealthKit / Android Health Connect | 권한을 받은 기기 건강 데이터 접근 | 각 플랫폼·데이터 제공 조건 **확인 필요** |
| 플랫폼 | NAVER Cloud VM / Vercel | README에 기록된 API·DB/웹 시연 호스팅 | 각 서비스 이용 약관 적용; 현재 배포 상태는 별도 확인 |
| 플랫폼 | Cloudflare HTTPS Quick Tunnel | 시연 API의 HTTPS 터널; 임시 주소 사용 기록 | 서비스 이용 약관 **확인 필요**. [배포 인계](ADR.md) · [연결 안내](PROVIDER_SETUP.md) |

## 개발·검증, 참고 및 보류

| 구분 | 명칭 | 용도 | 라이선스 |
|---|---|---|---|
| 개발·검증 | TypeScript 5.9.3 / 모바일 6.0.3 | 타입 검사·개발 | Apache-2.0 |
| 개발·검증 | `tsx` 4.23.15, `embedded-postgres` 18.6.0-beta.19, `@types/node` 22.20.5, `@types/pg` 8.23.1, `@types/react` 19.3.0 | 실행·로컬 DB 검증·타입 정의 | 각 패키지 MIT; embedded-postgres는 래퍼 패키지 라이선스 |
| 개발·검증 | `esbuild` 0.28.2 | 모바일 테스트 번들. 직접 테스트 import, lockfile 전이 의존성 | MIT |
| 개발·검증 | `expo-dev-client` 58.0.18 | 개발 빌드 | MIT |
| 개발 도구 | OpenAI Codex, Ponytail 스킬 | 코드·문서 개발 보조 | Codex 서비스·스킬 이용 조건 **별도 확인 필요**; 팀의 다른 AI 도구 사용 여부도 확인 |
| 디자인 도구 | Figma | 디자인 열람·자산 내보내기 | 서비스 이용 약관 적용; 개별 디자인·자산 권리와 구분 |
| 설계 참고 | Hermes | 구조 설계 참고 | 프로젝트 의존성 설치·포크 없음; 코드 재사용 여부는 팀 확인 |
| 사전 보유 코드 | **미확인** | 주제 공개 전 팀원 보유·작성 코드 여부 | 팀 확인 대기. 확인 전 ‘해당 없음’ 기재 금지 |
| 기타 | 팀원의 추가 도구·이미지·데이터·외부 소스 | 위 목록 외 실제 사용 여부 | **팀 확인 필요** |

패키지 버전·라이선스는 현재 [`package-lock.json`](../package-lock.json) 및 각 workspace manifest의 직접 의존성을 기준으로 했다. `@pikku/domain`은 저장소 내부 workspace이므로 외부 패키지로 집계하지 않았다. npm 전이 의존성 전체와 그 NOTICE·라이선스 의무, 최종 배포 번들 포함 여부는 이 표만으로 완전 검증되지 않았다. 버전·번들이 바뀌면 다시 확인한다.

Open-Meteo와 Streamline의 출처 표시 및 라이선스 문서를 배포물에서 유지한다. 디자인·사전 보유 코드·팀원별 개발 도구·API 이용 조건은 실제 권리자와 팀 확인 뒤 최종 발표자료에 반영한다. 이 문서 작성 중 자격정보·환경값 조회나 실 API 호출은 하지 않았다.
