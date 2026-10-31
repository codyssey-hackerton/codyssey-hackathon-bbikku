# 워치 건강 데이터 — 로컬 읽기 1단계

2026-11-01. 설정의 **건강 데이터**에서 선택한 최근 7일의 걸음 수·운동 기록을 읽고 표시한다. 선택 기능이며 가입·일정·채팅 이용의 필수 조건이 아니다. 수면·심박·진단, 백그라운드 수집과 AI 개인화는 이번 범위에 포함하지 않는다.

## 연결 경로와 데이터 경계

| 기기 | 조회 경로 | 준비 |
|---|---|---|
| Apple Watch + iPhone | Watch → Apple 건강 → iPhone HealthKit | iPhone에 기록 동기화, 설치용 개발 빌드, 사용자 읽기 동의 |
| Galaxy Watch + Android | Watch → Samsung Health → Health Connect | Samsung Health의 Health Connect 공유 설정, 지원 OS/제공자, 설치용 개발 빌드, 사용자 읽기 동의 |

워치에 직접 설치하는 앱이나 Bluetooth 연결은 만들지 않았다. 휴대폰 건강 저장소에 기록이 없으면 워치에 기록이 있어도 읽히지 않을 수 있다. [Samsung 공식 안내](https://developer.samsung.com/health/health-connect-faq.html)

데이터는 건강 화면의 메모리에만 보관한다. 서버 API·DB·Memory·Agent Tool·LLM·연락대행에 보내지 않으며 파일·로그에 저장하지 않는다. 연결해제는 앱 내 결과와 선택을 지우며 OS 권한 철회와 다르다. Apple 건강 또는 Health Connect에서 권한을 따로 관리한다. 권한과 선택은 앱 재실행 때 자동 복구하지 않는다.

## 사용 흐름과 표시 의미

1. 설정 → 건강 데이터에서 걸음 수·운동 기록을 각각 선택한다. 초기값은 둘 다 꺼짐이다.
2. 연결 버튼을 누르면 선택 항목의 OS 읽기 권한만 요청하고 조회한다. 화면을 열었다는 이유로 권한을 요청하거나 기록을 읽지 않는다.
3. 출처·마지막 조회·최근 7일 결과를 확인한다. 이후 갱신은 **다시 동기화**를 눌러 실행한다. 자동/백그라운드 조회는 없다.
4. 연결해제 또는 앱 프로세스 종료 시 메모리 결과를 지운다. ‘나중에’로 화면만 숨기면 결과는 메모리에 유지하되 복귀 시 만료를 다시 확인한다. 선택·시간대 변경 중 도착한 이전 조회 결과는 버린다.

- 7일은 앱에서 선택한 시간대의 오늘을 포함한다. 시작일 자정부터 조회 시작 시각까지이며 DST와 날짜 경계를 반영한다.
- `null`은 미확인이다. 데이터 없음·권한 불명확을 관측된 0으로 바꾸지 않는다. iOS는 읽기 거부와 빈 데이터를 구분할 수 없어 권한을 `unknown`, 빈 결과를 `no_data_or_access`로 표시한다. [Apple 권한 안내](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)
- **운동 기록 구간**은 기록된 start/end 구간의 합집합이다. 일시정지를 포함하며 실제 활동 시간이나 소비 칼로리가 아니다. 겹친 구간은 두 번 더하지 않는다.
- 동일 출처·ID를 중복 제거한다. 충돌·불완전한 운동 조회 또는 잘린 결과는 운동시간을 미확인으로 둔다. 걸음 조회만 실패해도 완전한 운동 기록은 표시할 수 있다.
- 걸음이 기록된 날 수·운동 세션 수 신호에는 표본일수·출처·산출/만료시각을 붙인다. 완전한 결과에만 만들며 마지막 조회 후 5분에 만료한다. 만료된 신호는 사용하지 않는다. 장기 선호나 건강 상태를 추정하지 않는다.
- iOS 걸음 일별 통계는 기기 시간대와 앱 시간대가 같을 때만 표시한다. 다르면 걸음은 미확인으로 두며 유효한 운동 조회는 유지한다.
- iOS 운동 조회는 최대 501건으로 초과 여부를 확인해 500건까지 취급한다. Android는 100건씩 최대 5페이지이며 잘림을 표시한다.

## 개발 빌드와 설치

Expo Go·웹은 네이티브 건강 모듈을 사용할 수 없다. 공개 웹에서는 미지원 안내를 제공한다. [Expo 개발 빌드](https://docs.expo.dev/develop/development-builds/introduction/)

고정 의존성은 HealthKit `16.2.0`, Nitro `0.37.1`, Health Connect `4.1.3`, Expo dev-client `58.0.18`이다. Expo `58.0.21` / React Native `0.88.1`은 유지한다. 개발용 앱 ID는 양쪽 모두 `com.codyssey.pikku.dev`이며 운영 배포 ID 확정은 아니다. 네이티브 생성물은 Git에서 제외하고 `app.json`과 config plugin을 정본으로 관리한다.

```sh
npm ci
cd apps/mobile
# 한 플랫폼을 선택한다. 네이티브 생성·빌드·설치를 수행한다.
npx expo run:android --device
# 또는 iPhone을 연결하고 Xcode 서명을 준비한 뒤
npx expo run:ios --device
# 이미 개발 빌드가 설치돼 있다면
npx expo start --dev-client
```

Android 앱 최소 버전은 의존성 요구에 따라 **Android 8 / API 26**으로 올렸다. 기존 API 24~25 기기에는 설치할 수 없다. **건강 연결은 Android 9 / API 28 이상**이며 Android 13 이하는 Health Connect 앱 설치/업데이트가 필요할 수 있다. Android 14 이상은 OS 제공자를 사용한다. 건강 권한은 `READ_STEPS`·`READ_EXERCISE`만 선언했다. [Android 공식 설정](https://developer.android.com/health-and-fitness/health-connect/get-started)

iPhone 로컬 테스트는 유료 멤버십 없이 무료 Apple 계정의 **Personal Team**으로 가능하다. Xcode Settings → Accounts에 로그인하고 Signing & Capabilities에서 Team을 선택한다. 연결된 iPhone의 신뢰·개발자 모드와 읽기 동의는 사용자가 진행한다. 무료 서명은 7일 뒤 재설치가 필요하며, HealthKit도 무료 계정 지원 항목이다. 시뮬레이터 빌드 성공은 실제 Watch 데이터 연결 성공을 뜻하지 않는다. [계정 안내](https://developer.apple.com/help/account/basics/about-your-developer-account) · [지원 Capability](https://developer.apple.com/help/account/reference/supported-capabilities-ios)

## 확인한 것과 남은 것

- 공통 집계·플랫폼 어댑터·권한/화면 흐름 5개 파일의 합성 테스트 55/55(fail/skip 0), 전체 workspace typecheck와 웹 export를 통과했다. 실제 건강 수치를 테스트나 모델 입력으로 사용하지 않았다.
- Android 격리 prebuild·Manifest 병합·Kotlin 컴파일·Debug APK 조립에 성공했다. 최종 APK의 최소 API 26과 건강 읽기 권한 2개를 확인했다. Debug APK는 Metro가 필요하다.
- iOS 최종 의존성으로 fresh prebuild·Pods·서명 없는 simulator Debug 빌드에 성공했다. 개발 URL scheme·Health 읽기 설명·HealthKit entitlement를 확인했으며 쓰기 설명과 백그라운드 entitlement는 없다.
- **미검증:** 실기기 설치, 실제 OS 동의·철회, Watch → 휴대폰 동기화, 실제 7일 데이터 조회. 현재 Mac에 iOS 개발 서명/연결된 iPhone이 없어 실제 iPhone 빌드는 하지 않았다. Android도 아직 설치하지 않았다.
- 실기기 확인은 사용자가 선택 항목 허용 → 조회 → 한 항목 권한 철회 후 수동 재조회 → 연결해제만 우선 확인한다. 값·화면 캡처를 AI나 공개 문서에 전달할 필요는 없다. 허용/거절/미확인/부분 결과와 앱 오류 여부만 보고한다.

후속 서버 저장·AI 추천 활용은 별도 동의·전송 최소화·보관/삭제 계약을 정한 뒤 구현한다. 현재 메인 Agent의 시스템 프롬프트나 Tool에는 건강 데이터를 추가하지 않았다.
