# PIKKU 앱·웹

Expo + React Native + TypeScript로 홈·캘린더·PIKKU 대화·추가·루틴을 연결합니다. 제출용 기능·환경설정·제한의 기준은 [루트 README](../../README.md), 세부 연결은 [디자인 통합 기록](../../docs/DESIGN_INTEGRATION.md)입니다.

## 실행

Node.js 22.13 이상과 npm이 필요합니다. `packages/domain`을 포함한 전체 저장소 루트에서 실행합니다.

```sh
npm ci
cp .env.example .env.local
npm run dev:local
```

Metro에서 `w`를 눌러 웹을 엽니다. 로컬 개발 인증은 Welcome의 **개발 연결 설정**에서 API 주소와 런처가 만든 `.local/dev-session-3001.txt`의 토큰을 사용합니다. 공개 앱은 Google 회원 로그인을 사용하며, Calendar/Gmail/연락처 권한은 별도 동의합니다. 개발 토큰과 모델 API 키는 서로 다릅니다.

PostgreSQL이 필요한 회원·루틴·동기화·예약은 별도 터미널에서 `npm run dev:db`, 이어서 `npm run dev:local -- --postgres --scheduler`로 실행합니다. 외부 제공자 기능에는 별도 서버 설정이 필요합니다.

## API 주소와 네이티브 실행

- 런처는 `EXPO_PUBLIC_API_URL`을 앱에 전달합니다. 직접 웹 서버를 실행한다면 접근 가능한 API 주소를 지정합니다. `EXPO_PUBLIC_*`는 공개 번들 값이므로 비밀값을 넣지 않습니다.
- 서버의 `PIKKU_WEB_ORIGINS`에는 웹 Origin을 정확히 설정합니다. 운영은 HTTPS를 사용하고 로컬 개발 인증을 외부에 노출하지 않습니다.
- 실제 휴대폰의 `localhost`는 개발 컴퓨터가 아닙니다. 통제된 사설 네트워크의 개발 환경에서는 `npm run dev:local -- --lan`을 사용할 수 있으나 HTTP 전송·Metro 노출을 고려해 테스트 데이터만 사용합니다.
- Expo 58.0.21 / React Native 0.88.1 / React 19.3.0을 사용합니다. HealthKit·Health Connect 등 네이티브 모듈 때문에 Expo Go를 전체 기능 실행 경로로 보장하지 않습니다. 네이티브 개발 빌드에는 Xcode 또는 Android 개발 도구·서명·기기 권한이 별도로 필요합니다.
- 알림 권한·실제 울림과 양 플랫폼 건강 데이터 검증은 보류 상태입니다. 웹 예약 알림은 미지원입니다. 기기 내 저장과 서버 예약을 동일 기능으로 취급하지 않습니다.

## 연결된 사용자 흐름

- 채팅의 답변·질문·추천 선택지·제안 수락/거절·자유 입력 수정. 선택지 클릭 자체는 승인이나 외부 실행이 아닙니다.
- 홈·월간·일간의 동일 일정 정본, 수행·참석 기록, 상태 취소, 일자별 루틴 회차.
- 온보딩·프로필의 명시 선호와 일시 상황 카드. 필요에 따라 서버 읽기 Tool로 조회합니다.
- 사용자별 Google OAuth, 월 범위 새 Calendar 일정 자동 가져오기와 별도 수동 동기화.
- 연락처 선택·전화/Gmail 승인 경로, 위치 공유·이동수단·경로 조회, 서버 계산 알림 후보.
- 온보딩 09:00/21:00 검토 시간 제안, 사용자가 저장한 설정에 따른 아침 브리핑·저녁 회고.

불명 요청 재시도는 원래 본문과 멱등 키를 유지합니다. 저장·승인 후 화면은 서버 정본을 다시 조회하며, 연결되지 않은 기능을 성공으로 표시하지 않습니다. 실제 연락·Google 원본 쓰기·알림은 별도 조건과 승인을 따릅니다.

## 검사와 빌드

```sh
npm run typecheck --workspace @pikku/mobile
npm run test --workspace @pikku/mobile
npm run export:web --workspace @pikku/mobile
npm run export --workspace @pikku/mobile
```

최근 main 통합 검사에서 모바일 548건이 통과했습니다. 모의 테스트·타입 검사·JS export는 실기기 설치·실제 알림·외부 제공자 전체 연동을 대신하지 않습니다. `export`는 iOS/Android JavaScript 번들이며 설치용 바이너리가 아닙니다. [검증 기록](../../docs/IMPLEMENTATION_PLAN.md)
