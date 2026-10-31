# PIKKU 디자인 구현 인계
이 폴더는 기존 앱에 적용할 디자인 참고 자료입니다. 앱 소스와 독립된 HTML 목업이며 실제 AI·서버·데이터 연동 구현이 아닙니다.

## 먼저 읽기
1. [구현 요청 프롬프트](IMPLEMENTATION_PROMPT.md)
2. [최신 개발 전달 메모](developer-handoff.md)
3. [디자인 규칙](design-rules.md), [사용자 요구 원문](feedback-original.md)
4. [조작 가능한 목업](probes/reference-wireframe.html), [화면별 검토](probes/final-preview.html)

## 실행
저장소 루트에서 Python 3로 실행합니다. 추가 Python 패키지는 필요 없습니다.

```sh
python docs/design-handoff/preview_server.py --port 4186
```

http://127.0.0.1:4186/ 에서 허브를 열고 화면 미리보기 탭을 선택하세요. 이 주소는 실행한 컴퓨터에서만 접근 가능합니다. 다른 서버가 쓰는 포트면 다른 번호를 지정하세요. HTML만 분리하지 말고 probes/assets를 포함해 폴더를 유지하세요.

의견은 실행 시 이 폴더의 feedback.json에 새로 생성됩니다. 제공된 원문은 feedback-original.md이며, 개인 브라우저 기록과 기존 feedback.json은 공유하지 않습니다.

## Figma
- 원본: https://www.figma.com/design/YpAuzE5kCYzo6AQ3a59jmE
- 복제본: 아직 제공되지 않았습니다. 팀에서 복제본을 만들면 링크와 기준 시점을 여기에 기록하세요.
- 03 Screens: 기본 화면 및 모달·완료·복구 예시. 프레임마다 별도 라우트를 만들지 않습니다.
- 02 Components: 일정 카드 8종, 상태 버튼 5종, 행동 버튼 3종과 사용 예시.
- 기존 화면의 카드 59개는 새 공통 컴포넌트와 아직 연결되지 않았습니다. 부품 정리와 화면 전체 교체를 구분하세요.
- Noto Sans KR과 임시 프로필은 Figma 환경의 대체 표현입니다. 실제 앱에는 HTML의 Pretendard와 기존 프로필 표현을 사용하세요.

## 자료 우선순위와 한계
최신 제품·아키텍처 정본은 저장소 docs/PRD.md, MEETING_ALIGNMENT.md, ARCHITECTURE.md, ADR.md, CONTRACTS.md 및 AGENTS.md를 확인하세요. 이 폴더의 brief.md·screens.md·decisions.md·figma-build-log.md는 제작 당시 기록이며 현재 제품 정본을 덮어쓰지 않습니다. 과거 사용자 재확인 대기 문구와 절대 로컬 경로가 남아 있을 수 있습니다. 실제 사용자 추가 요구와 최신 PRD가 충돌하면 차이를 명시하세요.

연락 승인 화면은 사용자 요청으로 보류했습니다. 빈·로딩·오류·장문·기기별 검증은 추가 보완 대상입니다. Figma 자동 디자인 시스템 검수는 통과하지 않았으며 공통 부품 정리 이후 전체 재검수 결과도 없습니다. 과거 대용량 스냅샷과 검수 로그는 이번 묶음에서 제외했습니다.

## 검증
Node.js가 있으면 저장소 루트에서 실행하세요.

```sh
node --test docs/design-handoff/tests/*.test.cjs
```

이는 목업 로직 검증이며 실제 앱의 API·인증·저장·기기 검증을 대신하지 않습니다. 전달 묶음 검증 결과는 VALIDATION.md를 참고하세요.

## 자산과 라이선스
프리텐다드는 probes/assets/LICENSE-Pretendard.txt, Streamline은 probes/assets/streamline-core/ATTRIBUTION.md, 기존 Lucide 관련 자료는 probes/assets/LUCIDE-LICENSE.txt를 확인하세요. 1~4.png 및 stack-reference.jpg는 사용자가 제공한 디자인 레퍼런스입니다. 제3자 재배포 권리를 별도 보증하지 않으며 프로젝트 디자인 참고 용도입니다.

현재 앱 코드는 이 자료 업로드 PR에서 변경하지 않습니다. 실제 적용은 별도 구현 브랜치·PR로 진행합니다.
