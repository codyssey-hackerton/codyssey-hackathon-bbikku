# 외부 제공자 연결 준비 — 서연님 인계

기준일: 2026-10-31. **Gmail 발송 이후 회신 조회·사용자 확인·최종 반영과 제한된 양방향 음성 통화를 연결한다.** Calendar 읽기와 Kakao 장소·현재 시점 경로 조회를 연결한다. 구현·계정 연결·실제 통화·배포 성공은 구분한다.

## 이번 확인 범위

- 실제 모델 호출 검증 기록이 있다. 사용자는 Gmail 작업·확인을 **로컬에서 완료**했다고 보고했다. 이번 병렬 증분은 그 계정이나 기존 토큰을 변경하지 않았다. 공개 환경 Gmail 연결은 별도다.
- Calendar·전화 전체 흐름 구현 검증은 합성 제공자를 사용한다. 실제 Twilio 읽기 전용 계정 조회는 §2의 결과를 확인했지만 발신번호 연결·통화는 미완료다. 실제 Calendar 동의·목록/일정 조회와 Gmail 읽기 동의·profile/테스트 스레드 조회는 성공했다. 테스트 메일 수신은 사용자 확인, 실제 회신·일정 반영은 대기 중이다. 아래 후속 결과와 합성 검증을 구분한다.

## 1. Google Calendar·Gmail

1. 프로젝트용 Google Cloud에서 Calendar API와 Gmail API 각각의 활성화, OAuth 동의 화면과 테스트 계정을 확인한다. 선택한 인증 흐름에 맞춰 OAuth 클라이언트 ID·리디렉션, 필요시 서버 클라이언트 비밀, Android 패키지명·서명 SHA-1, iOS Bundle ID를 준비한다. 생성 시 AI agent용 클라이언트 선택과 일반 기능의 클라이언트 분리 조건도 검토한다. 클라이언트 비밀과 사용자 토큰은 서버의 비밀 저장소에서 관리한다. [OAuth 준비](https://developers.google.com/workspace/guides/configure-oauth-consent) · [클라이언트 생성](https://developers.google.com/workspace/guides/create-credentials) · [서버 인증](https://developers.google.com/workspace/gmail/api/auth/web-server)
2. 필요한 범위만 선택한다. 아래 이름 앞에는 `https://www.googleapis.com/auth/`가 붙는다.
   - Calendar 목록: `calendar.calendarlist.readonly`; 일정 조회: `calendar.events.readonly`. 일정 수정이 필요하면 `calendar.events` 또는 소유 일정만 허용하는 `calendar.events.owned`를 별도 검토한다. 실제 캘린더의 수정 권한도 필요하다. [Calendar 범위](https://developers.google.com/workspace/calendar/api/auth)
   - Gmail 실제 발송: `gmail.send`는 **민감** 범위다. 회신 본문 조회의 `gmail.readonly`는 별도의 **제한** 범위다. 발송 권한만으로 회신을 읽을 수 없다. 제한 범위 사용 시 Google의 검증·서버 보안평가 요건과 사용 사례 적합성을 확인한다. [Gmail 범위](https://developers.google.com/workspace/gmail/api/auth/scopes) · [사용 정책](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
3. 외부 앱의 Testing 상태는 등록한 테스트 사용자만 접근하며 Calendar/Gmail 범위의 테스트 동의·refresh token은 7일 만료 조건을 확인한다. **Expo Go는 OAuth 리디렉션 로컬 테스트에 사용할 수 없으므로 개발 빌드를 검토**한다. Google Android 클라이언트의 임의 custom URI scheme과 모바일 loopback 제한도 있어 개발 빌드만으로 인증 호환을 단정하지 않는다. [테스트 사용자](https://support.google.com/cloud/answer/15549945?hl=en) · [Expo OAuth](https://docs.expo.dev/guides/authentication/) · [Google 리디렉션](https://developers.google.com/identity/protocols/oauth2/native-app) · [모바일 loopback](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration)
4. 이미 부여된 읽기 권한이 있는 경우에만 테스트 계정의 Calendar 목록/일정을 최소 조회하고 결과 상태만 기록한다. Gmail `users.getProfile`은 `gmail.send`만으로 조회할 수 없으므로 확인을 위해 읽기 권한을 임의로 추가하지 않는다. 실제 발송·수정과 회신 검증은 별도 승인된 테스트에서 다룬다. [Gmail 프로필의 허용 범위](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)

### 사용자별 수동 확인 코드 연결 — 통합 중

서버에는 `PIKKU_GOOGLE_OAUTH_CLIENT_ID`, `PIKKU_GOOGLE_OAUTH_CLIENT_SECRET`, `PIKKU_GOOGLE_USER_CREDENTIAL_DIR`, `PIKKU_GOOGLE_OAUTH_REDIRECT_URI`를 비밀 설정으로 제공한다. 자격 디렉터리는 서버 프로세스 소유의 절대 경로·0700이어야 한다. 현재 기존 Quick Tunnel의 등록 대상 URI는 `https://establish-cause-transcript-floor.trycloudflare.com/v1/google/oauth/callback`이며 `PIKKU_GOOGLE_OAUTH_REDIRECT_URI`와 Google Cloud 웹 OAuth 클라이언트에 정확히 같은 URI를 설정해야 한다. Quick Tunnel 주소는 영구 고정이 아니므로 변경 시 두 설정을 함께 갱신한다. 설정 이름이나 파일 준비만으로 동의·연결 성공을 뜻하지 않는다.

인증된 사용자가 앱에서 Calendar, Gmail 발송 또는 Gmail 회신 읽기를 선택해 외부 브라우저의 Google 동의를 진행한다. 동의 후 브라우저에 표시되는 별도 **연결 확인 코드**를 원래 앱에 입력해야 서버가 앱 메모리의 일회 비밀값과 사용자 세션을 함께 확인하고 자격을 저장한다. 인증코드·토큰을 앱에 복사하거나 공유하지 않는다. Gmail 회신 읽기는 같은 사용자의 발송 Google 계정과 일치해야 한다. 완료 결과를 받지 못하면 자동 재전송하지 않고 연결 상태를 확인한 뒤, 연결되지 않았다면 처음부터 다시 시작한다. 기존 연결이 있었다면 연결 상태만으로 새 계정으로 바뀌었는지는 알 수 없다. 취소·계정 전환·연결 화면 이탈 또는 서버 재시작 후에도 다시 시작한다. 이 수동 브라우저 복귀 방식과 위의 네이티브 리디렉션 제약은 구분하며, 실제 기기 호환성은 별도 확인이 필요하다.

사용자별 파일은 0600으로 저장하며 OAuth 진행 상태는 단일 프로세스 메모리에서만 유지된다. 필수 설정이 없으면 새 연결은 사용할 수 없고 기존 시연 소유자 연결은 유지된다. 구현·설정·합성 테스트·실제 사용자 Google 동의 및 공개 배포 검증은 별개다. 기존 공개 시연 소유자 연결은 새 사용자별 연결 검증을 대신하지 않는다. Google 계정 접근 동의만으로 메일 발송이 승인되는 것은 아니다. 구체적인 통합 계약은 [CONTRACTS §14](CONTRACTS.md#14-사용자별-google-oauth--통합-중인-계약)를 따른다.

### Calendar 로컬 개발 연결

2026-10-31 실제 진행: Gmail과 같은 계정의 Calendar 목록/일정 읽기 동의를 완료하고 원본 로컬 프로젝트의 별도 0600 파일에 저장했다. 토큰 갱신과 계정 확인은 HTTP200이었다. 초기 Calendar 목록 조회 HTTP403 `accessNotConfigured`/`SERVICE_DISABLED`는 API 활성화 후 해소됐으며 목록 HTTP200·3개, 2026-10-31 00:00~11-07 00:00 한국시간의 일정 조회 성공(지원 일정 0건·미지원 0건)을 확인했다. 실제 항목 가져오기와 외부 쓰기는 실행하지 않았다.

1. 기존 프로젝트의 Google Cloud에서 Calendar API 활성화 및 테스트 사용자를 확인한다. 기존 웹 OAuth 클라이언트 설정을 사용하되 Gmail 발송 동의와 Calendar 읽기 동의는 구분한다.
2. 클라이언트 ID/Secret을 현재 작업 환경의 비밀 설정으로 제공하고 프로젝트 루트에서 `node --env-file-if-exists=.env.local scripts/connect-calendar.mjs`를 실행한다. `.env.local`이 없는 별도 worktree는 자동으로 원본 환경이나 키를 검색하지 않는다.
3. 출력된 인증 URL을 같은 컴퓨터의 브라우저에서 열고 Calendar 목록/일정 읽기에 동의한다. 콜백은 `http://127.0.0.1:53682/oauth/google/callback`이다. Gmail 연결 CLI와 같은 포트를 쓰므로 동시에 실행하지 않는다.
4. 성공하면 `.local/calendar-connection.json`에 별도 0600 자격 파일을 저장한다. Gmail 파일을 덮어쓰지 않는다. 개발 인증의 `local-developer` 사용자만 이 연결을 사용하며 공개 참여 코드 사용자에게 공유하지 않는다.
5. 해당 작업 트리의 개발 API를 설정하여 앱의 **캘린더 일정 가져오기**에서 연결 조회 → 기간 조회 → 항목 선택 → 가져오기를 수행한다. 기존 서버를 무작정 재시작하지 말고 코드·설정 경로와 포트를 확인한다.

지원은 시간형 단일 일정의 명시적 가져오기까지다. 종일·반복·취소 원본은 미지원 안내, 페이지 실패는 오류, 원본 버전/중복/시간 충돌은 재확인 대상으로 둔다. 자동 동기화나 외부 캘린더 수정으로 표시하지 않는다. [Google Calendar 연결 계획](CALENDAR_INTEGRATION_PLAN.md).

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
- Gmail 접수는 상대 수락·수신 확인이 아니다. 원래 약속은 유지하며 회신 읽기와 사용자 확인은 아래 별도 연결 절차를 따른다.

### 검증 경계

실제 로컬 PostgreSQL·HTTP·모바일 연락 클라이언트·Gmail MIME 어댑터를 함께 실행하고 발송 fetch만 모의로 주입해 초안→승인→발송·중복 방지·재조회·사용자 격리를 검증한다. OAuth/취소/입력 및 오류 분류도 합성 테스트로 확인한다. Google 자격증명·사용자 동의가 준비되기 전에는 실제 계정 연결이나 발송 성공으로 표시하지 않는다. 공개 문서·테스트에는 실제 수신자 주소나 메일 내용·토큰을 기록하지 않는다.

### Gmail 회신 읽기 연결

기존 발송 연결을 유지한 채 `node --env-file-if-exists=.env.local scripts/connect-gmail-replies.mjs`를 실행하고 같은 Google 계정의 `gmail.readonly`·openid·email에 별도로 동의한다. 기존과 같은 로컬 콜백 포트를 사용하므로 Calendar/Gmail 연결 CLI를 동시에 실행하지 않는다. 별도 `.local/gmail-replies-connection.json`에 0600으로 저장하며 기존 발송 자격 파일을 덮어쓰지 않는다. 두 파일의 Google 사용자·이메일·OAuth client가 같아야 한다. 이 도구는 개발 사용자 연결이며 공개 참여 코드 계정의 정식 OAuth 흐름은 아니다.

API를 해당 코드·설정으로 실행한 후 연락 화면의 **회신 확인**으로 조회한다. 전송 메시지/스레드와 연결된 답변 발췌를 보여주고 사용자가 허용 대안을 재승인하면 현재 일정 검증 후 삐꾸 내부 일정에 적용한다. 이메일 헤더는 상대 신원 인증이 아니므로 자동 수락으로 표시하지 않는다. 주기적 자동 조회·외부 캘린더 수정은 포함하지 않는다.

**2026-10-31 실제 동의 완료:** 기존 발송과 같은 계정의 Gmail readonly 동의·토큰 갱신·scope 확인·`users.getProfile` HTTP200·계정 일치를 확인했다. 원본 로컬 프로젝트의 별도 0600 파일에 저장했고 기존 발송 자격 파일은 그대로다. 개발본 어댑터도 해당 파일을 명시적으로 지정해 초기화 확인했다. 이후 사용자 승인된 별도 수신 계정에 격리 PostgreSQL 테스트로 1회 발송 HTTP200, 사용자가 수신을 확인했다. 실제 테스트 스레드 조회는 성공했으며 회신·일정 반영은 대기 중이다. 공개 환경에 반영하지 않았다. 별도 worktree는 원본의 설정/파일을 자동 탐색하지 않으므로 실제 실행 환경에 승인된 로컬 경로/연결을 구성한 뒤 E2E를 진행한다.

Twilio 추가 작업은 사용자의 요청으로 보류한다. 아래 계정 확인 이력과 구현 설명은 보존한다.

## ClawOps 전화 전환 — 2026-11-01

사용자 요청에 따라 신규 전화 연결 화면의 기본 제공자를 ClawOps로 바꾼다. 기존 Twilio 경로와 저장 자격은 보존한다. 현재 제공된 계정·키로 공식 번호 목록 API HTTP200과 보유 발신번호 1개를 확인했으며 실제 발신은 하지 않았다. 이는 API 인증·번호 조회 성공이며 웹훅이나 실통화 성공은 아니다.

앱의 **전화 외부 연결**에서 ClawOps 계정 ID, API 키, 별도 Webhook Signing Secret, 계정 소유 발신번호(E.164)를 입력한다. API 키와 서명키는 서로 다르며, 서명키는 ClawOps 대시보드의 개발자 → 웹훅에서 확인한다. 사용자별 서버 private 자격 디렉터리에 0600으로 저장하고 브라우저 영속 저장·Git·공개 로그에 남기지 않는다. 번호 조회로 API 키·소유권을 확인할 수 있지만 입력한 서명키의 실제 일치는 서명된 제공자 콜백으로 별도 검증해야 한다.

전화는 기존과 같이 제안 기반 연락 초안 → 내용·수신자·허용 대안 승인 → 발신번호 확인 → **전화 발신** 단계에서만 시도한다. 서버는 `https://api.claw-ops.com/v1/accounts/{accountId}/calls`에 Bearer 인증과 `To/From/Url/Timeout` JSON을 보낸다. 국내 번호는 제공자 전송 시에만 한국 국내 형식으로 바꾸고 앱·DB는 E.164를 유지한다. `201/callId`는 접수 증거이며 연결·청취·수락 증거가 아니다. 불명·timeout 뒤 자동 재발신하지 않는다.

콜백은 기존 `PIKKU_VOICE_PUBLIC_BASE_URL`과 `PIKKU_VOICE_SESSION_KEY` 설정을 재사용하는 `/v1/voice/clawops/:token`이다. 원본 form의 HMAC-SHA256 서명, 토큰, 통화·계정·연락·번호와 최신 승인 대안을 확인한다. VoiceML은 설명·대안 낭독과 키패드 선택·명시적 재확인을 지원한다. **자유로운 양방향 음성 대화는 이 증분에 포함하지 않는다.** 무응답은 자동 수락하지 않으며 기존 상대 회신/최신 일정 검증 경계를 유지한다. 안내는 Gather 밖에서 재생하나 선입력 버퍼·빈 Gather의 실제 서비스 동작과 서명키 일치는 실통화 미검증이다. 무응답 action이 없어 현재 연락 상태가 awaiting_response로 남을 수 있다.

Managed Agent는 별도 agent ID·음성 모델·이벤트 권한 및 통화별 CallContext가 필요하고 VoiceML과 발신 모드가 다르다. 계정 설정이나 동작을 실제 확인하기 전 사용 가능하다고 단정하지 않는다. 현재 전화의 사람 확인 후 적용 경로는 Gmail 전용 confirm API와 같지 않으며 음성 결과를 이메일 응답으로 위장해 통과시키지 않는다.

공식 근거: [발신](https://docs.claw-ops.com/api-reference/claw-ops-api/calls/create-call), [번호 조회](https://docs.claw-ops.com/api-reference/claw-ops-api/numbers/list-numbers), [VoiceML 지원 범위](https://platform.claw-ops.com/docs/build/voiceml), [서명 검증](https://platform.claw-ops.com/docs/webhooks/signature-verification).

## 2. Twilio 계정 연결·전화

### 실제 자격 확인 — 2026-10-31

사용자가 입력한 Git 제외 로컬 `.local/twilio.env`에서 비밀값을 출력하지 않고 읽기 전용 REST 조회를 수행했다. Account 조회 HTTP 200, `active`/`Trial`을 확인했다. IncomingPhoneNumbers와 OutgoingCallerIds 조회도 HTTP 200이지만 각각 0건이며 입력한 발신번호는 두 목록 모두에 없었다. 앱의 현재 연결 정책은 **소유 Voice 번호 확인**이므로 앱 연결 완료로 등록하지 않았다. 실제 통화는 하지 않았다.

새 Trial의 공유 번호는 계정 소유 번호와 다를 수 있으므로 위 결과를 Twilio 계정 전체의 발신 불가능 판정으로 해석하지 않는다. 공유 Trial 번호·외부 verified caller ID는 현재 앱 연결 지원 범위 밖이다. Voice 설정, 앱이 지원하는 발신번호, 수신자 검증과 국가별 권한, 공개 HTTPS callback 준비 후 재확인한다. [Trial 안내](https://www.twilio.com/docs/usage/trials/try-out-voice)

로컬 확인 입력은 `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`이며 이 파일을 두는 것만으로 실행 중 앱에 자동 연결되지 않는다. 서버는 기존 사용자별 `PhoneConnections` 저장과 인증된 연결 API를 사용한다. 번호 준비 후 읽기 검증·연결 등록을 거친다. 비밀값은 이 문서·Git·프론트엔드 번들에 넣지 않는다.

사용자는 입력한 번호가 본인 휴대폰이라고 확인했다. 현재 앱에서는 그 번호를 테스트 수신자(`To`)로 사용하고, `TWILIO_FROM_NUMBER`에는 같은 계정이 소유한 Voice 지원 번호를 넣는다. 새 Console은 **Communications → Numbers & senders → Set up a new phone number**, 기존 Console은 **Develop → Phone Numbers → Manage → Buy a Number**에서 번호를 준비한다. 계정 업그레이드·번호 구매가 필요한 경우 표시된 비용/조건을 확인하며 이 작업에서 구매나 결제는 수행하지 않았다. Trial 수신자는 별도 검증이 필요하다. [번호 준비 메뉴](https://www.twilio.com/docs/usage/how-do-i) · [Trial 수신자](https://www.twilio.com/docs/usage/trials)

### 기존 단방향 구현 이력

2026-10-31 증분은 사용자별 계정 입력 → 승인된 전화 초안 → 별도 발신을 구현한다. 비밀값은 채팅/문서에 붙이지 않고 앱의 안전한 연결 화면에 입력한다. 채팅 등에 노출한 토큰은 공급자에서 교체한다.

- PostgreSQL 모드의 서버에 해당 프로세스 소유 mode 0700 디렉터리를 준비하고 `PIKKU_PHONE_CREDENTIAL_DIR`로 지정한다. 사용자별 파일은 0600으로 저장하며 서버 내부 경로를 공개하지 않는다. 비영속 모드·디렉터리 없음·권한 불일치에서는 계정 설정을 거절한다.
- 앱에서 Account SID, Auth Token, 계정이 소유한 voice 발신번호(E.164)를 입력한다. API Key SID/Secret 입력 및 verified caller ID는 이번 최소 연결에서 지원하지 않는다. 번호 조회 성공과 실제 발신·한국어 음성 성공은 별도다.
- 브라우저/앱은 원격 HTTP에 비밀값을 보내지 않는다. HTTPS 종단을 로컬 프록시가 담당하면 `PIKKU_TRUST_PROXY=loopback`과 서버 `HOST`의 loopback 바인딩을 함께 사용한다. 기본값은 프록시 비신뢰이며 임의 외부 클라이언트의 forwarded 헤더를 신뢰하지 않는다. 실제 배포 설정은 별도로 적용·확인해야 한다.
- 전화 요청의 수신자·본문·허용 변경안을 승인한 뒤 별도 발신 버튼을 누른다. Twilio 접수 결과를 실제 연결·상대 수락으로 표시하지 않는다. 실제 테스트에는 발신번호와 승인한 수신번호·본문이 필요하다.
- 이 최초 증분은 단방향 한국어 TTS였다. 현재 계정 조회 결과는 위 기록, 양방향 증분은 아래 실행 설정을 따른다. 실제 발신·수신 음성은 여전히 미검증이다. [Calls API](https://www.twilio.com/docs/voice/api/call-resource) · [TTS 지원 목록](https://www.twilio.com/docs/voice/twiml/say/text-speech).

### 양방향 전화 실행 설정

- `PIKKU_DATABASE_URL`과 `PIKKU_PHONE_CREDENTIAL_DIR`(0700 디렉터리), 연결된 사용자별 0600 자격 파일이 필요하다.
- `PIKKU_VOICE_PUBLIC_BASE_URL`: Twilio에서 접근 가능한 HTTPS origin. 해당 개발본이 실제 배포된 주소여야 한다. 예전 API나 웹 프론트 주소를 넣는 것으로 연결되지 않는다.
- `PIKKU_VOICE_SESSION_KEY`: 서버에서 생성한 임의 32바이트의 표준 base64. 인스턴스·재시작 사이 유지하고 비밀 저장소에만 저장한다. 교체 시 진행 중 세션을 해독할 수 없게 된다.
- `PIKKU_OPENAI_API_KEY`: 기존 프로젝트 모델 키. `gpt-6.1-terra/high`를 그대로 사용하며 별도 STT/TTS 모델 키는 요구하지 않는다.
- `POST /v1/voice/twilio/:token`에 접근 가능한 배포·정확한 URL·Twilio 서명 검증이 필요하다. 세션 인증 대신 제공자 서명을 검증하는 유일한 경로이며 앱의 연락·승인 API는 계속 사용자 인증을 요구한다.

Gather/Say 턴 대화는 승인된 시간 대안 선택에 한정한다. 선택을 다시 읽은 뒤 번호 1로 확인받으며 모델 지연/해석 불명 시 번호 선택 또는 사용자 검토로 전환한다. 자유로운 음성 상담, 임의 시간 협상, 불특정 수신 전화 응대는 구현 범위가 아니다. 영속 DB·voice 설정이 없으면 `/call`은 `not_configured`로 거절하고 단방향 발신으로 조용히 바꾸지 않는다. 실제 전화·한국어 음성·네트워크 지연 검증은 남아 있다.

전화로 확정할 대안은 분 단위 시각만 지원하며 시간대·UTC 시차를 함께 읽는다. 초 이하의 의미 있는 차이나 중복 안내 문구가 있으면 전화 발신 전에 거절하고 사용자가 내용을 다시 확인하게 한다. 해당 검증은 일반 일정의 정밀도를 변경하지 않는다.

### 음성 제공자 제약과 향후 확장

1. 프로젝트 계정의 Account SID와 서버용 API Key SID/Secret 또는 Auth Token, 서명 검증용 Auth Token, 사용 가능한 발신번호와 한국 목적지·번호 대역의 발신 권한·요금을 확인한다. 전화번호 발신자는 Twilio 번호 또는 계정에서 검증된 발신자 ID여야 하며, 한국 발신 가능 목록이 특정 계정의 성공을 보장하지는 않는다. [API 인증](https://www.twilio.com/docs/usage/requests-to-twilio) · [Calls API](https://www.twilio.com/docs/voice/api/call-resource) · [한국 Voice 안내](https://static1.twilio.com/en-us/guidelines/kr/south-korea-voice-guidelines---twilio)
2. 서버 발신 뒤 양방향 음성 후보는 `<Connect><Stream>`과 별도 STT/TTS 또는 `ConversationRelay`다. 두 방식의 `wss://` 서버, 서명 검증, 한국어 음성·지연·비용을 검토한다. Webhook을 사용하는 구성이라면 Twilio가 접근 가능한 HTTPS 주소도 필요하다. ConversationRelay는 AI/ML 추가 약관 수락 여부를 확인한다. 모델·음성 제공자는 미정이다. [Media Streams](https://www.twilio.com/docs/voice/media-streams) · [ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay/onboarding)
3. **현재 Twilio Voice trial 문서는 `<Stream>`과 `<ConversationRelay>`를 차단 목록에 둔다.** 시험 계정의 검증된 번호·국가 제한과 업그레이드 필요 여부를 먼저 확인한다. 테스트 자격증명은 실제 음성·Webhook 연결 성공의 증거가 아니다. [Voice trial](https://www.twilio.com/docs/usage/trials/try-out-voice) · [테스트 자격증명](https://www.twilio.com/docs/iam/test-credentials)
4. 실제 통화는 승인된 상대·내용으로만 별도 실행한다. 접수·연결·통화 종료를 상대 수락으로 표시하지 않으며, 수락 후 최신 일정·권한 검증을 거쳐 변경한다. 전화 앱 열기는 서버 실제 발신을 대체하지 않는다.

## 3. 지도·이동시간 — 카카오 계열 선택

- **선택 상태:** 사용자는 지도 제공자로 카카오 계열을 선택했다. 장소 검색·지도 표시·길찾기는 서로 다른 기능이며 교통수단은 사용자가 도보·대중교통·자동차를 직접 선택한다. 경로 API는 아래 구현을 사용하며 지도 SDK 화면은 별도다. 카카오톡 공유·메시지 API와 구분한다. 입력된 REST 키의 직접 검색 HTTP200·1건과 신규 인증 API의 실제 검색 HTTP200·15개 및 좌표 정규화를 확인했다. 세 수단의 경로 API를 실제 키와 독립 API 서버에서 검증했다. 지도 화면·실측 이동시간 정확도와 공개 서버 설정은 미검증이다.
- **장소 검색:** Kakao Local의 키워드·카테고리 장소 검색과 주소/좌표 변환은 카카오디벨로퍼스 앱의 카카오맵 API 활성화와 REST API 키를 사용한다. 검색 결과만으로 이동시간을 산출하지 않는다. 앱별 활성화, 쿼터·과금 조건은 해당 프로젝트에서 확인한다. [카카오맵 사용 방법](https://developers.kakao.com/docs/ko/kakaomap/common) · [REST API](https://developers.kakao.com/docs/ko/kakaomap/rest-api)
- **지도 화면과 설정:** 지도 Web SDK는 JavaScript 키와 해당 키의 JavaScript SDK 도메인을 사용한다. Android/iOS SDK는 네이티브 앱 키와 각 플랫폼 앱 정보가 필요하다. REST API 키는 지도 SDK 키가 아니다. REST 키에 호출 허용 IP를 설정하는 경우 실제 서버의 외부 출발 IP를 등록하고, 변경 가능성과 환경별 값을 확인한다. IP 제한은 설정 시에만 적용되므로 무조건 필수라고 가정하지 않는다. REST API 키는 서버 설정에서만 관리한다. [카카오맵 플랫폼 키](https://developers.kakao.com/docs/ko/kakaomap/common) · [앱 키와 IP 설정](https://developers.kakao.com/docs/ko/app-setting/app)
- **경로와 이동시간:** 현재 공식 카카오맵 REST 문서는 도보·자전거·대중교통 경로 조회를 별도로 안내한다. 카카오모빌리티는 별도의 자동차 길찾기 API를 안내하며, 제휴 API 목록의 도보·자전거·대중교통 등은 별도 제휴 계약이 필요하다고 명시한다. 이들은 서로 다른 상품이므로 같은 이용 조건으로 단정하지 않는다. 이번 구현은 사용자가 선택한 도보·대중교통·자동차만 다룬다. 문서상의 지원과 개별 계정 권한은 구분하며 실검증 결과는 아래에 기록한다. [카카오맵 경로 REST](https://developers.kakao.com/docs/ko/kakaomap/rest-api) · [모빌리티 자동차 길찾기](https://developers.kakaomobility.com/guide/navi-api/directions) · [모빌리티 제휴 API](https://developers.kakaomobility.com/affiliate/)

서연님은 각 후보의 **프로젝트 계정 접근·활성화·테스트 사용자/번호·권한·제약·비용·읽기 전용 확인 결과와 미확인 사항**을 세진님에게 전달한다. 비밀값·개인 이메일 주소·전화번호·메일 내용은 문서나 로그에 기록하지 않는다. 제공자 확정과 실제 발송·발신은 이 조사로 완료된 것이 아니다.

### 카카오 검색 서버 설정

서버 환경에 `PIKKU_KAKAO_REST_API_KEY`를 제공하면 `GET /v1/places/search?query=...`가 활성화된다. 값은 `EXPO_PUBLIC_*`나 모바일 코드에 넣지 않는다. 로컬 `.local/kakao.env`에 입력한 값은 서버가 자동으로 읽지 않으므로 실행 시 명시적으로 환경 파일을 로드하거나 서버 비밀 설정으로 주입한다. 예: 새 코드를 실행하는 프로젝트 루트에서 `node --env-file-if-exists=.env.local --env-file=.local/kakao.env scripts/dev.mjs --api-only`를 사용하며 기존 프로세스의 포트·DB·세션과 충돌하지 않게 실행 환경을 먼저 확인한다. 별도 worktree는 원본의 파일을 자동으로 찾지 않는다. 이번 검증은 키를 명시 주입한 격리 API 검사이며 기존 실행 서버나 공개 배포를 변경한 것이 아니다.

장소 검색은 첫 페이지 최대 15개이고 검색어가 Kakao에 전달된다. 준비계획 폼에 출발/도착 장소 선택과 교통수단 선택을 연결했다. 지도 SDK 표시는 미구현이다. `integrations.travel`은 키와 어댑터가 구성되면 available이며 해당 호출 성공을 보장하지 않는다.


### 경로 API와 실제 서버 검증 — 2026-10-31

`GET https://dapi.kakao.com/v2/routing/walk` 및 `/v2/routing/publictraffic`, `GET https://apis-navi.kakaomobility.com/v1/directions`를 서버 REST 키로 호출한다. 현재 시점 조회이며 출발시각 지정은 지원하지 않는다. 사용자는 수단을 선택하고 조회된 분 수를 확인한 뒤 입력에 적용한다. [Kakao Map 공식 REST](https://developers.kakao.com/docs/ko/kakaomap/rest-api) · [자동차 공식 API](https://developers.kakaomobility.com/guide/navi-api/directions)

공식 문서의 예제 좌표로 실제 3종 직접 호출과 어댑터를 확인했다. 이어서 별도 임시 PostgreSQL·임의 loopback 포트에서 실제 server.ts를 시작하고 인증 HTTP 경유 도보 67분·대중교통 38분·자동차 12분(각 HTTP200)을 확인했다. 직접 호출 때 자동차 13분과 차이가 있어 현재 교통에 따라 변하는 값임을 보존한다. 장소 검색 15건, Calendar 목록 3개/기간 일정 0건 HTTP200, Gmail 발송·회신 경로 구성 상태를 확인했다. 별도 실제 Gmail 스레드 재조회는 회신 0건이다. 메일 재발송·캘린더 쓰기·기존 서버 변경은 없었고 검사 서버와 임시 DB만 정리했다.

### 별도 worktree의 Google 자격 경로

신뢰된 서버 환경의 `PIKKU_GOOGLE_CREDENTIAL_DIR`에 기존 개인 자격 디렉터리의 절대경로를 명시하면 `gmail-connection.json`, `gmail-replies-connection.json`, `calendar-connection.json`을 그곳에서 읽는다. 미지정/빈 값은 기존 worktree 상대 기본 경로를 유지하며 상대경로는 거절한다. 파일을 복제하거나 토큰 내용을 출력하지 않는다. 기존 파일 owner·디렉터리 권한·0600·O_NOFOLLOW 검사 및 발송/회신 계정 일치는 그대로 적용한다. Google client ID/secret은 서버 env에 별도로 제공한다. 기본은 로컬 개발 사용자 연결이다. 공개 preview의 제한된 소유자 바인딩은 아래 §5를 따르며 정식 다중 사용자 OAuth를 구현한 것은 아니다. 실행 중 서버에는 자동 적용되지 않는다.


## 4. Open-Meteo·서울 지하철 — 2026-10-31 추가

Open-Meteo는 키 없이 목적지 좌표와 서울 기준 날짜(start_date/end_date)를 상류에 전달해 시간별 예보를 읽고, 약속 시각에 해당하는 예보는 삐꾸 서버에서 선택한다. `Asia/Seoul`, 섭씨·mm·km/h를 사용한다. 무료 API는 비상업적 용도이며 일 10,000회 미만·시간 5,000회·분 600회 한도와 CC BY 4.0 출처 표시 조건을 확인했다. 화면에서 Open-Meteo/라이선스를 연결한다. 앱 캐시는 한도 준수 보조이며 여러 프로세스를 합친 전역 quota 보장은 없다. 상업적 사용 전 별도 플랜/조건 확인이 필요하다. [예보 공식 문서](https://open-meteo.com/en/docs) · [이용 조건](https://open-meteo.com/en/terms) · [라이선스](https://open-meteo.com/en/licence)

서울 OA-12764 realtimeStationArrival은 서버 비밀 `SEOUL_SUBWAY_API_KEY`를 사용한다. `SEOUL_SUBWAY_TRANSPORT` 미지정은 https, 명시 http/https 외 값은 not_configured다. 공식 예제는 HTTP이며 이 환경의 HTTPS 공개 sample은 timeout, HTTP sample과 실키 어댑터는 성공했다. HTTPS 미지원으로 확정하지 않는다. 이번 연결은 **명시 http**로 검증했다. 이 상류 구간의 키·역명은 암호화되지 않으며 도청·변조 위험이 있다. 앱→삐꾸 공개 API의 HTTPS와 구분한다. 자동 다운그레이드/redirect는 없다. [서울 공식 API](https://data.seoul.go.kr/dataList/openApiView.do?infId=OA-12764&srvType=A)

실제 인증 API 경유 날씨 HTTP200·시간별 예보, 지하철 HTTP200·도착 목록을 확인했다. 역 도착 정보는 여정 ETA가 아니며 응답이 오래됐으면 표시한다. 구현된 한도·캐시·TTL·오류 계약은 CONTRACTS §12를 따른다. 키 값은 문서·앱·저장소에 넣지 않는다.

## 5. 실제 회신·Calendar 가져오기 및 공개 연결 준비

승인된 테스트 계정 사이에서 원본 메일에 실제 답장한 뒤 앱의 스레드/참조 검증으로 회신을 읽었다. 30분이 지난 최초 제안은 changed=false/needs_user_review로 차단했다. 새 승인 테스트의 실제 회신을 확인하고 허용 대안을 선택하자 격리 PostgreSQL의 가상 약속만 변경됐다(HTTP200, applied, revision2). 저장된 성공 응답 재조회와 추가 반복 요청에서 의미상 동일한 결과·일정 버전 유지가 확인됐다. 바이트 문자열 비교는 JSONB 필드 순서에 영향을 받으므로 파싱된 JSON 전체를 비교한다. 기존 사용자 일정·Google 원본은 변경하지 않았다.

사용자 승인으로 참석자 없는 비공개 Google 테스트 일정 1건을 생성하고, 실제 앱 어댑터로 읽어 격리 DB에 선택 가져오기 HTTP200을 확인했다. 같은 멱등키 재요청은 같은 결과이며 중복 추가되지 않았다. 최종 격리 DB는 가상 약속+가져온 일정 2건/revision3이다. 원본 테스트 일정은 캘린더에 남겨뒀다. 일반 종일/반복 일정이나 연속 동기화 검증은 아니다.

공개 시연은 `PIKKU_GOOGLE_CONNECTION_USER_ID`에 지정된 등록 멤버 한 명과 서버 private 자격 디렉터리에만 Google 연결을 바인딩한다. 다른 멤버의 연결 상태는 not_configured이며 포트 접근을 거절한다. 파일 0600·디렉터리 0700·서비스 사용자 소유 및 기존 자격 검사를 유지한다. 발송/읽기/Calendar 권한을 합치거나 정식 다중 사용자 OAuth로 설명하지 않는다. 최신 배포 완료 여부는 IMPLEMENTATION_PLAN의 배포 기록을 확인한다.
