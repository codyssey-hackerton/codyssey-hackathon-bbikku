# PIKKU 모바일

Expo + React Native + TypeScript 앱이며, 채팅·월별·하루 일정과 계약 v1 API 경계를 연결한다. 2026-10-31 사용자 지정으로 Aria의 화면 구성을 참고한 첫 디자인을 적용했다. 이 코드만으로 실제 AI 모델·DB·외부 제공자의 연동 성공을 뜻하지 않는다.

## 설치와 실행

통합 저장소 루트에 `packages/domain` 워크스페이스가 있어야 한다. Node.js 22.13 이상과 npm을 사용한다.

```sh
# 통합 저장소 루트에서
npm ci
npm run dev:local
```

API와 Metro를 함께 시작한다. 같은 신뢰 가능한 사설 Wi-Fi의 휴대폰은 `npm run dev:local -- --lan`으로 실행한 뒤 Expo Go에서 QR을 연다. 시뮬레이터/에뮬레이터는 별도 설치가 필요하다. 상세 설정과 LAN 전송 한계는 [루트 실행 안내](../../README.md#로컬-실행)를 따른다.

본 패키지는 Expo SDK **58.0.21**과 공식 blank TypeScript 템플릿의 React/React Native 조합을 고정했다. iPhone 18 Pro / iOS 27 시뮬레이터의 Expo Go SDK 58에서 앱 실행을 확인했다. 기기의 Expo Go와 프로젝트 SDK 버전 일치를 확인해야 하며, iOS·Android 실기기 구동은 아직 검증하지 않았다. 버전이 맞지 않으면 [Expo 안내](https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/)를 따른다.

## 개발 서버와 세션

- `EXPO_PUBLIC_API_URL`의 기본값은 `http://localhost:3001`이다. 같은 Wi-Fi의 실기기에서는 예를 들어 `EXPO_PUBLIC_API_URL=http://192.168.0.10:3001 npm run dev --workspace @pikku/mobile`처럼 개발 PC의 LAN 주소로 바꾼다. 이 주소는 예시다. 실기기의 `localhost`는 개발 PC가 아닌 그 기기다.
- iOS 시뮬레이터의 `localhost`는 보통 개발 Mac을 가리킨다. Android 에뮬레이터에서 호스트 루프백의 네트워크 별칭은 일반적으로 `http://10.0.2.2:3001`이다. 네트워크 접근과 서버 인증 허용은 별개이며 실제 연결을 확인해야 한다.
- 개발 인증의 기본 범위는 루프백이다. 루트 런처의 `--lan`은 현재 컴퓨터에 할당된 사설 IPv4만 API 바인딩에 허용한다. 주소만 변경해서는 서버 바인딩이 달라지지 않는다. LAN은 암호화된 인증 서비스가 아니며 실제 휴대폰 연결은 아직 미검증이다.
- 앱 상단 **설정**의 개발 연결 항목에서 API 주소와 개발용 Bearer 세션 토큰을 입력한다. 토큰은 앱 실행 중 메모리에만 보관하고 자동완성을 비활성화한다. 같은 주소의 후행 `/`·호스트 대소문자 등 표기만 바뀌면 기존 연결과 요청 상태를 유지한다. 실제 서버 변경은 해당 토큰의 재입력이 필요하고, 실제 연결/사용자 전환 시 이전 세션의 화면·대화·제안 상태가 초기화된다. 진행 중/결과 불명 요청이 있으면 결과 확인 전 연결 변경을 차단한다. 인증 제공자 연동은 미구현이다.
- `EXPO_PUBLIC_*` 값은 앱 번들에 포함되므로 토큰·API 키·비밀번호를 넣지 않는다. 공개 서버에 개발 인증 우회를 노출하지 않는다. HTTP는 로컬 개발에만 사용하고 기기·빌드의 평문 HTTP 정책을 확인한다.

## 구현된 클라이언트 범위

- 채팅은 `POST /v1/chat`, 대화 ID, 사용자 명시 공동 조정 대상과 인증·중복 방지 헤더를 사용한다. 채팅 요청 시간 제한은 초기 개발값 180초이며 일반 조회·저장은 20초다. 이는 실제 모델 지연을 측정한 값이나 성능 보장이 아니다. 답변·추가 질문·제안·실패를 구분한다. 하루 화면의 공동 일정 선택은 조정 검토 대상 지정일 뿐 변경·연락 승인이 아니다.
- 월별·하루 화면은 `GET /v1/schedule`의 동일 서버 정본을 조회한다. 하루 화면은 `POST /v1/schedule/commands`로 생성·수정, `POST /v1/schedule/:id/checkin`으로 완료·미완료·미확인을 요청한다. 전체 필드를 확인하며 기존 공동 약속의 개인 전환과 시간·종류 직접 변경은 차단한다.
- 명시 선호·일시 상황은 `GET/POST /v1/memory`와 `contextRevision`을 사용한다. 상황의 만료 시각은 필수이며 관찰·추정을 사용자 명시 선호로 표시하지 않는다.
- 제안 목록·상세에서 변경 전후·이유·검증 결과를 표시하고, 선택한 버전에 대한 승인·거절을 요청한다. 채팅에서 제안이 생성되면 목록도 갱신한다. 개인 제안의 `applied`만 적용 성공으로 표시한다. 공동 제안의 `awaiting_contact`는 기존 일정 유지 및 연락 준비·발송 미구현으로 표시한다. 승인·거절·직접 저장·체크인 뒤 채팅 요약·월별·하루 화면은 서버 정본을 다시 조회한다.
- 저장·대화·승인 오류 후 같은 작업의 재시도는 최초 본문·`requestId`·`Idempotency-Key`를 유지한다. 처리 여부가 불확실한 작업은 결과를 확인하기 전 새 요청으로 바꾸지 않는다. 앱 종료·강제 재로드로 미확정 요청의 재시도 상태가 사라지면 이를 복구하는 영속 기능은 아직 없다.
- 예약 설정, 연락처 등록과 실제 전화·이메일 발송은 아직 연결하지 않았다. 서버의 미구현·미설정은 성공이나 빈 데이터로 바꾸지 않는다.

## 검증

```sh
npm run typecheck --workspace @pikku/mobile
npm run test --workspace @pikku/mobile
npm run export --workspace @pikku/mobile
```

모바일 테스트 72개와 타입 검사, 두 플랫폼 export를 통과했다. 이 테스트는 모의 응답·액션 상태·화면의 경량 렌더링을 사용한다. 별도로 루트 API 테스트에서 실제 HTTP와 모바일 클라이언트 흐름을 확인했다. iOS 시뮬레이터 UI에서는 테스트 세션 인증→일정 직접 저장→세 화면의 표시→완료 체크인을 확인했다. 실제 모델·DB·iOS/Android 실기기 통합 검증을 대체하지 않는다. export는 iOS와 Android JavaScript 번들을 생성하며 설치 가능한 앱 바이너리를 만들지는 않는다.

## 디자인과 글꼴

- 기준: 사용자 확인을 받은 [Aria: AI Task Manager / Lipson](https://apps.apple.com/gb/app/aria-ai-task-manager/id6776524212)의 공식 App Store 화면(2026-10-31 확인). 밝은 바탕·파란 강조색·둥근 일정 카드·간결한 대화 구성을 PIKKU의 채팅/캘린더/하루 일정에 맞췄다. 로고·캐릭터·스크린샷은 복제하거나 앱에 포함하지 않았다. 팀의 최종 와이어프레임에 따라 조정한다.
- 색상 정본: `src/ui/theme.ts`. 본문과 입력은 `src/ui/typography.tsx`의 `Text`·`TextInput`을 사용하며 접근성 글꼴 확대와 native props/ref를 유지한다.
- [Pretendard](https://github.com/orioncactus/pretendard) Regular/Medium/SemiBold/Bold OTF를 `assets/fonts/`에 포함했다. 원본 commit: `7aeb0698819be2b4097dae8ec8fe6a795e5cf3ae`, 원본 경로: `packages/pretendard/dist/public/static/`. SIL OFL 1.1 전문은 같은 폴더의 `LICENSE-Pretendard.txt`에 보존한다. 글꼴은 수정하지 않았다.
- [Expo 공식 방식](https://docs.expo.dev/develop/user-interface/fonts/)의 `useFonts`로 로드하므로 Expo Go에서도 동작하며 실행 중 CDN에 의존하지 않는다. 로딩 중 준비 화면, 실패 시 안내와 시스템 글꼴로 앱 사용을 계속한다. 굵기는 정적 face로 매핑해 합성 bold를 피한다.
- 스타일 변경은 일정/승인/재시도 계약을 바꾸지 않는다. 데이터가 없거나 인증/연결이 실패하면 해당 상태를 표시하며 예시 일정을 실제 데이터처럼 보여주지 않는다.

### 2026-10-31 레이아웃·아이콘 적용

- 색상 변경은 보류하고 기존 팔레트와 Pretendard를 유지했다. 채팅 진입 칩/전송 버튼, 월간 날짜 탐색과 선택일 요약, 하루 완료 현황·시간 표시·체크인 버튼을 정돈했다. 기존 API·승인·재시도 계약은 유지한다.
- 아이콘은 Lucide 1.66.0으로 통일한다. `assets/icons/`에 고정 버전 폰트·글리프 매핑·라이선스를 보관한다. 현재 Expo iOS 런타임에서 SVG 네이티브 뷰 등록 오류가 관찰되어 `expo-font`로 렌더링한다. 폰트 전체 약 956 KiB를 포함하며 아이콘 추가 시 매핑을 같은 버전에서 확인한다.
- 하단 탭바는 반투명 표면이다. 현재 런타임의 Blur 네이티브 뷰 등록 오류로 실제 블러는 포함하지 않는다. iOS 투명도 줄이기 설정에서는 불투명 배경으로 표시한다.
- 모바일 테스트 85개·타입 검사·iOS/Android JavaScript export 통과. iPhone 18 Pro 시뮬레이터에서 세션 복구, 세 화면 빈 상태, 아이콘 렌더링과 탭 이동을 확인했다. Android는 새 채팅 화면과 아이콘 렌더링은 확인했지만 기존 System UI 응답 없음 팝업으로 조작·인증 검증을 완료하지 못했다. 큰 글씨·소프트웨어 키보드·실기기 성능은 추가 확인이 필요하다.
- 루틴 탭·반복 규칙/회차 API는 이번 디자인 작업에 추가하지 않았다. 루틴은 PRD에 있으나 별도 탭과 데이터 계약은 미정이다.
