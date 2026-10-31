# 외부 제공자 연결 준비 — 서연님 인계

기준일: 2026-10-31. **Google Calendar/Gmail, Twilio, Kakao/TMAP은 후보이며 채택·실제 연결 성공은 미확인**이다. 우선 Calendar/Gmail과 서버 실제 전화를 검토하고 지도는 후순위로 둔다.

## 이번 확인 범위

- 프로젝트 루트 `.env.local`은 존재하지 않았다. 이 경로 외의 환경·계정·다른 프로젝트 자격증명은 확인하지 않았으므로 전체 자격증명 부재로 단정하지 않는다.
- 제공자 기능은 공식 문서로 확인했다. 인증된 API 조회, OAuth 권한 추가, 실제 메일 발송·전화는 수행하지 않았다. 아래 계정별 상태와 실제 연결성은 **미검증**이다.

## 1. Google Calendar·Gmail

1. 프로젝트용 Google Cloud에서 Calendar API와 Gmail API 각각의 활성화, OAuth 동의 화면과 테스트 계정을 확인한다. 선택한 인증 흐름에 맞춰 OAuth 클라이언트 ID·리디렉션, 필요시 서버 클라이언트 비밀, Android 패키지명·서명 SHA-1, iOS Bundle ID를 준비한다. 생성 시 AI agent용 클라이언트 선택과 일반 기능의 클라이언트 분리 조건도 검토한다. 클라이언트 비밀과 사용자 토큰은 서버의 비밀 저장소에서 관리한다. [OAuth 준비](https://developers.google.com/workspace/guides/configure-oauth-consent) · [클라이언트 생성](https://developers.google.com/workspace/guides/create-credentials) · [서버 인증](https://developers.google.com/workspace/gmail/api/auth/web-server)
2. 필요한 범위만 선택한다. 아래 이름 앞에는 `https://www.googleapis.com/auth/`가 붙는다.
   - Calendar 목록: `calendar.calendarlist.readonly`; 일정 조회: `calendar.events.readonly`. 일정 수정이 필요하면 `calendar.events` 또는 소유 일정만 허용하는 `calendar.events.owned`를 별도 검토한다. 실제 캘린더의 수정 권한도 필요하다. [Calendar 범위](https://developers.google.com/workspace/calendar/api/auth)
   - Gmail 실제 발송: `gmail.send`는 **민감** 범위다. 회신 본문 조회의 `gmail.readonly`는 별도의 **제한** 범위다. 발송 권한만으로 회신을 읽을 수 없다. 제한 범위 사용 시 Google의 검증·서버 보안평가 요건과 사용 사례 적합성을 확인한다. [Gmail 범위](https://developers.google.com/workspace/gmail/api/auth/scopes) · [사용 정책](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
3. 외부 앱의 Testing 상태는 등록한 테스트 사용자만 접근하며 Calendar/Gmail 범위의 테스트 동의·refresh token은 7일 만료 조건을 확인한다. **Expo Go는 OAuth 리디렉션 로컬 테스트에 사용할 수 없으므로 개발 빌드를 검토**한다. Google Android 클라이언트의 임의 custom URI scheme과 모바일 loopback 제한도 있어 개발 빌드만으로 인증 호환을 단정하지 않는다. [테스트 사용자](https://support.google.com/cloud/answer/15549945?hl=en) · [Expo OAuth](https://docs.expo.dev/guides/authentication/) · [Google 리디렉션](https://developers.google.com/identity/protocols/oauth2/native-app) · [모바일 loopback](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration)
4. 이미 부여된 읽기 권한이 있는 경우에만 테스트 계정의 Calendar 목록/일정을 최소 조회하고 결과 상태만 기록한다. Gmail `users.getProfile`은 `gmail.send`만으로 조회할 수 없으므로 확인을 위해 읽기 권한을 임의로 추가하지 않는다. 실제 발송·수정과 회신 검증은 별도 승인된 테스트에서 다룬다. [Gmail 프로필의 허용 범위](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)

## 2. 실제 AI 전화 — Twilio 검토 후보

1. 프로젝트 계정의 Account SID와 서버용 API Key SID/Secret 또는 Auth Token, 서명 검증용 Auth Token, 사용 가능한 발신번호와 한국 목적지·번호 대역의 발신 권한·요금을 확인한다. 전화번호 발신자는 Twilio 번호 또는 계정에서 검증된 발신자 ID여야 하며, 한국 발신 가능 목록이 특정 계정의 성공을 보장하지는 않는다. [API 인증](https://www.twilio.com/docs/usage/requests-to-twilio) · [Calls API](https://www.twilio.com/docs/voice/api/call-resource) · [한국 Voice 안내](https://static1.twilio.com/en-us/guidelines/kr/south-korea-voice-guidelines---twilio)
2. 서버 발신 뒤 양방향 음성 후보는 `<Connect><Stream>`과 별도 STT/TTS 또는 `ConversationRelay`다. 두 방식의 `wss://` 서버, 서명 검증, 한국어 음성·지연·비용을 검토한다. Webhook을 사용하는 구성이라면 Twilio가 접근 가능한 HTTPS 주소도 필요하다. ConversationRelay는 AI/ML 추가 약관 수락 여부를 확인한다. 모델·음성 제공자는 미정이다. [Media Streams](https://www.twilio.com/docs/voice/media-streams) · [ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay/onboarding)
3. **현재 Twilio Voice trial 문서는 `<Stream>`과 `<ConversationRelay>`를 차단 목록에 둔다.** 시험 계정의 검증된 번호·국가 제한과 업그레이드 필요 여부를 먼저 확인한다. 테스트 자격증명은 실제 음성·Webhook 연결 성공의 증거가 아니다. [Voice trial](https://www.twilio.com/docs/usage/trials/try-out-voice) · [테스트 자격증명](https://www.twilio.com/docs/iam/test-credentials)
4. 실제 통화는 승인된 상대·내용으로만 별도 실행한다. 접수·연결·통화 종료를 상대 수락으로 표시하지 않으며, 수락 후 최신 일정·권한 검증을 거쳐 변경한다. 전화 앱 열기는 서버 실제 발신을 대체하지 않는다.

## 3. 지도·이동시간 — 후순위 후보

- Kakao Local은 프로젝트 앱의 카카오맵 API 활성화와 REST API 키가 필요하다. 2026-07-21부터 무료 쿼터는 개발자 계정의 최초 활성화 앱 등에 조건이 있으므로 해당 앱·과금 상태를 확인한다. 지도 SDK의 플랫폼 키는 REST 키와 구분한다. [활성화·쿼터](https://developers.kakao.com/docs/ko/kakaomap/common) · [Local API](https://developers.kakao.com/docs/ko/local/dev-guide)
- TMAP은 프로젝트 앱과 `appKey`, 선택한 자동차·도보·대중교통 상품별 이용 조건을 확인한다. 실제 계정의 활성화·가격·이동수단 지원은 미검증이다. [앱키 안내](https://openapi.sk.com/products/detail?menuSeq=126&svcSeq=60) · [대중교통 상품](https://openapi.sk.com/products/detail?menuSeq=492&svcSeq=59)

서연님은 각 후보의 **프로젝트 계정 접근·활성화·테스트 사용자/번호·권한·제약·비용·읽기 전용 확인 결과와 미확인 사항**을 세진님에게 전달한다. 비밀값·개인 이메일 주소·전화번호·메일 내용은 문서나 로그에 기록하지 않는다. 제공자 확정과 실제 발송·발신은 이 조사로 완료된 것이 아니다.
