# 외부 제공자 연결 준비 — 서연님 인계

기준일: 2026-10-31. **사용자 결정으로 연락대행은 Gmail부터 연결한다.** Google Calendar, 전화·음성, Kakao/TMAP은 후속 검토다. Gmail을 선택한 것과 실제 OAuth·발송 연결 성공은 구분한다.

## 이번 확인 범위

- 프로젝트 루트 `.env.local`에 AI 키가 설정되어 실제 모델 호출을 확인했다. 프로젝트 설정에서 Google OAuth 값은 아직 확인되지 않았다. 다른 프로젝트나 개인 계정의 자격증명을 가져오지 않는다.
- 제공자 기능은 공식 문서로 확인했다. 인증된 API 조회, OAuth 권한 추가, 실제 메일 발송·전화는 수행하지 않았다. 아래 계정별 상태와 실제 연결성은 **미검증**이다.

## 1. Google Calendar·Gmail

1. 프로젝트용 Google Cloud에서 Calendar API와 Gmail API 각각의 활성화, OAuth 동의 화면과 테스트 계정을 확인한다. 선택한 인증 흐름에 맞춰 OAuth 클라이언트 ID·리디렉션, 필요시 서버 클라이언트 비밀, Android 패키지명·서명 SHA-1, iOS Bundle ID를 준비한다. 생성 시 AI agent용 클라이언트 선택과 일반 기능의 클라이언트 분리 조건도 검토한다. 클라이언트 비밀과 사용자 토큰은 서버의 비밀 저장소에서 관리한다. [OAuth 준비](https://developers.google.com/workspace/guides/configure-oauth-consent) · [클라이언트 생성](https://developers.google.com/workspace/guides/create-credentials) · [서버 인증](https://developers.google.com/workspace/gmail/api/auth/web-server)
2. 필요한 범위만 선택한다. 아래 이름 앞에는 `https://www.googleapis.com/auth/`가 붙는다.
   - Calendar 목록: `calendar.calendarlist.readonly`; 일정 조회: `calendar.events.readonly`. 일정 수정이 필요하면 `calendar.events` 또는 소유 일정만 허용하는 `calendar.events.owned`를 별도 검토한다. 실제 캘린더의 수정 권한도 필요하다. [Calendar 범위](https://developers.google.com/workspace/calendar/api/auth)
   - Gmail 실제 발송: `gmail.send`는 **민감** 범위다. 회신 본문 조회의 `gmail.readonly`는 별도의 **제한** 범위다. 발송 권한만으로 회신을 읽을 수 없다. 제한 범위 사용 시 Google의 검증·서버 보안평가 요건과 사용 사례 적합성을 확인한다. [Gmail 범위](https://developers.google.com/workspace/gmail/api/auth/scopes) · [사용 정책](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
3. 외부 앱의 Testing 상태는 등록한 테스트 사용자만 접근하며 Calendar/Gmail 범위의 테스트 동의·refresh token은 7일 만료 조건을 확인한다. **Expo Go는 OAuth 리디렉션 로컬 테스트에 사용할 수 없으므로 개발 빌드를 검토**한다. Google Android 클라이언트의 임의 custom URI scheme과 모바일 loopback 제한도 있어 개발 빌드만으로 인증 호환을 단정하지 않는다. [테스트 사용자](https://support.google.com/cloud/answer/15549945?hl=en) · [Expo OAuth](https://docs.expo.dev/guides/authentication/) · [Google 리디렉션](https://developers.google.com/identity/protocols/oauth2/native-app) · [모바일 loopback](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration)
4. 이미 부여된 읽기 권한이 있는 경우에만 테스트 계정의 Calendar 목록/일정을 최소 조회하고 결과 상태만 기록한다. Gmail `users.getProfile`은 `gmail.send`만으로 조회할 수 없으므로 확인을 위해 읽기 권한을 임의로 추가하지 않는다. 실제 발송·수정과 회신 검증은 별도 승인된 테스트에서 다룬다. [Gmail 프로필의 허용 범위](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)

### Gmail 로컬 개발 연결

이번 구현은 현재 개발 인증의 `local-developer` 한 사용자에게 Gmail 계정을 묶는다. 일반 사용자용 모바일 OAuth 온보딩이나 운영 비밀 저장소를 구현한 것이 아니다. 브라우저 OAuth는 개발 컴퓨터에서 수행하고 앱은 인증된 서버의 발송 경로를 사용하므로, 이 로컬 경로에는 Expo Go의 OAuth 리디렉션이 필요하지 않다.

1. 프로젝트 Google Cloud에서 **Gmail API**를 활성화한다.
2. Google Auth Platform의 Branding과 Audience를 설정하고, 테스트 사용자에 **발신할 Gmail 계정**을 추가한다.
3. OAuth 클라이언트를 **웹 애플리케이션**으로 생성한다. 승인된 리디렉션 URI는 정확히 `http://127.0.0.1:53682/oauth/google/callback`이다.
4. 프로젝트 `.env.local`에 `PIKKU_GOOGLE_OAUTH_CLIENT_ID`와 `PIKKU_GOOGLE_OAUTH_CLIENT_SECRET`을 넣는다. 서버용 값이며 앱·Git·채팅에 넣지 않는다.
5. 프로젝트 루트에서 `npm run connect:gmail`을 실행하고 출력된 URL을 개발 컴퓨터의 브라우저에서 연다. 연결할 계정으로 `gmail.send`, `openid`, `email`에 동의한다. 발송 내용 승인과 계정 접근 동의는 별개다.
6. 성공하면 `.local/gmail-connection.json`에 refresh token과 검증된 발신 계정 식별을 `0600`으로 저장한다. API 서버를 재시작하고 PostgreSQL 모드로 연결한다. 명령은 `npm run dev:local -- --postgres --scheduler`이며 실행 중인 서버의 포트와 중복 기동하지 않는다.

CLI는 state·PKCE·고정 리디렉션을 검증한다. 서버는 발송 전 토큰 갱신의 범위, Google userinfo의 verified email/sub, 저장된 계정 일치를 확인한다. refresh token 회전·계정/파일 변경·손상은 재연결이 필요하다. 이 개발용 파일은 사용자만 읽을 수 있는 로컬 비밀 저장이며 운영 다중 사용자 저장 방식이 아니다. [Google 웹 서버 OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) · [클라이언트 설정](https://developers.google.com/workspace/guides/create-credentials)

### 앱에서 승인하고 발송하기

공동 일정의 조정 제안 상세 → **연락 준비** → 수신자 이름·이메일 확인 → 제안 기반 정형 초안 편집·저장 → 수신자/본문/허용 대안 전체 미리보기 → **연락 내용 승인** → 발신 계정 확인 → **Gmail 발송** 순서다. 정형 초안은 일정 제목과 시간만 사용하며 개인 Memory나 제안 이유를 자동 공유하지 않는다.

- 승인만 하면 `ready`이며 발송하지 않는다. 발송 버튼은 별도 `POST /v1/contact-requests/:id/send`를 호출한다. 메모리 저장 모드나 계정 미설정이면 발송할 수 없다.
- 화면에서 확인한 발신 주소가 현재 연결과 일치하는지 확인한다. 승인 스냅샷·수신자·일정/맥락·대안 유효성을 재검증하고 `submitting`과 멱등 기록을 같은 DB 트랜잭션에 저장한다. 외부 요청은 잠금을 해제한 뒤 한 번 시도한다. 토큰 갱신·계정 확인 뒤 Gmail 호출 바로 전에도 최신 상태를 재검증한다. 최종 검사 뒤의 동시 변경과 외부 발송은 원자적으로 묶이지 않는다.
- Gmail [messages.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)에 RFC From/Date·한글 MIME을 전달한다. 현재 일반 ASCII 단일 주소만 지원한다. 성공 식별자 수신은 `sent_or_connected/awaiting_response`, 확실한 실패는 `failed`, 불명은 `outcome_unknown`이다.
- 30초 발송 예산의 취소 신호를 토큰 갱신·계정 확인·메일 요청까지 전달한다. 기한 이후 새 메일 요청을 시작하지 않지만 이미 서버에 전달된 요청의 취소는 미발송 증거가 아니다.
- 중단된 `submitting`은 30초 이후 조회 시 보수적으로 `outcome_unknown`으로 보이고 자동 재발송하지 않는다. Gmail에는 실행 키 기반 중복 방지 보장이 없으므로 제공자 수준의 정확히 한 번 전달이라고 부르지 않는다.
- 결과 불명·진행 중이면 기존 상태를 조회한다. 통신 오류 뒤 서버 상태가 여전히 ready일 때에만 기존 요청 키로 명시 재시도한다. 새 키로 같은 발송을 반복하지 않는다.
- Gmail 접수는 상대 수락·수신 확인이 아니다. 원래 약속은 유지하며, **회신 읽기·상대 수락 검증·일정 반영은 후속 미구현**이다.

### 검증 경계

실제 로컬 PostgreSQL·HTTP·모바일 연락 클라이언트·Gmail MIME 어댑터를 함께 실행하고 발송 fetch만 모의로 주입해 초안→승인→발송·중복 방지·재조회·사용자 격리를 검증한다. OAuth/취소/입력 및 오류 분류도 합성 테스트로 확인한다. Google 자격증명·사용자 동의가 준비되기 전에는 실제 계정 연결이나 발송 성공으로 표시하지 않는다. 공개 문서·테스트에는 실제 수신자 주소나 메일 내용·토큰을 기록하지 않는다.

## 2. 실제 AI 전화 — Twilio 검토 후보

1. 프로젝트 계정의 Account SID와 서버용 API Key SID/Secret 또는 Auth Token, 서명 검증용 Auth Token, 사용 가능한 발신번호와 한국 목적지·번호 대역의 발신 권한·요금을 확인한다. 전화번호 발신자는 Twilio 번호 또는 계정에서 검증된 발신자 ID여야 하며, 한국 발신 가능 목록이 특정 계정의 성공을 보장하지는 않는다. [API 인증](https://www.twilio.com/docs/usage/requests-to-twilio) · [Calls API](https://www.twilio.com/docs/voice/api/call-resource) · [한국 Voice 안내](https://static1.twilio.com/en-us/guidelines/kr/south-korea-voice-guidelines---twilio)
2. 서버 발신 뒤 양방향 음성 후보는 `<Connect><Stream>`과 별도 STT/TTS 또는 `ConversationRelay`다. 두 방식의 `wss://` 서버, 서명 검증, 한국어 음성·지연·비용을 검토한다. Webhook을 사용하는 구성이라면 Twilio가 접근 가능한 HTTPS 주소도 필요하다. ConversationRelay는 AI/ML 추가 약관 수락 여부를 확인한다. 모델·음성 제공자는 미정이다. [Media Streams](https://www.twilio.com/docs/voice/media-streams) · [ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay/onboarding)
3. **현재 Twilio Voice trial 문서는 `<Stream>`과 `<ConversationRelay>`를 차단 목록에 둔다.** 시험 계정의 검증된 번호·국가 제한과 업그레이드 필요 여부를 먼저 확인한다. 테스트 자격증명은 실제 음성·Webhook 연결 성공의 증거가 아니다. [Voice trial](https://www.twilio.com/docs/usage/trials/try-out-voice) · [테스트 자격증명](https://www.twilio.com/docs/iam/test-credentials)
4. 실제 통화는 승인된 상대·내용으로만 별도 실행한다. 접수·연결·통화 종료를 상대 수락으로 표시하지 않으며, 수락 후 최신 일정·권한 검증을 거쳐 변경한다. 전화 앱 열기는 서버 실제 발신을 대체하지 않는다.

## 3. 지도·이동시간 — 후순위 후보

- Kakao Local은 프로젝트 앱의 카카오맵 API 활성화와 REST API 키가 필요하다. 2026-07-21부터 무료 쿼터는 개발자 계정의 최초 활성화 앱 등에 조건이 있으므로 해당 앱·과금 상태를 확인한다. 지도 SDK의 플랫폼 키는 REST 키와 구분한다. [활성화·쿼터](https://developers.kakao.com/docs/ko/kakaomap/common) · [Local API](https://developers.kakao.com/docs/ko/local/dev-guide)
- TMAP은 프로젝트 앱과 `appKey`, 선택한 자동차·도보·대중교통 상품별 이용 조건을 확인한다. 실제 계정의 활성화·가격·이동수단 지원은 미검증이다. [앱키 안내](https://openapi.sk.com/products/detail?menuSeq=126&svcSeq=60) · [대중교통 상품](https://openapi.sk.com/products/detail?menuSeq=492&svcSeq=59)

서연님은 각 후보의 **프로젝트 계정 접근·활성화·테스트 사용자/번호·권한·제약·비용·읽기 전용 확인 결과와 미확인 사항**을 세진님에게 전달한다. 비밀값·개인 이메일 주소·전화번호·메일 내용은 문서나 로그에 기록하지 않는다. 제공자 확정과 실제 발송·발신은 이 조사로 완료된 것이 아니다.
