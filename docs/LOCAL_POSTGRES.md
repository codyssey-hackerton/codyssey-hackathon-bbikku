# 로컬 PostgreSQL

`embedded-postgres`로 현재 사용자 계정에서 PostgreSQL을 실행한다. 시스템 PostgreSQL, Docker, 전역 서비스나 외부 API 키는 필요하지 않다. 처음 실행할 때 로컬 클러스터와 무작위 비밀번호를 만들며, 이후에는 같은 데이터와 비밀번호를 사용한다.

```sh
npm install --ignore-scripts
npm run dev:db
```

실행 창을 유지하면 `127.0.0.1:55432`에서 접속할 수 있다. 준비 메시지에는 접속 파일 경로만 표시하며 비밀번호나 URL은 출력하지 않는다. `Ctrl+C` 또는 `SIGTERM`으로 종료하고 같은 명령으로 다시 시작할 수 있다. PostgreSQL은 로컬 IPv4에서만 대기한다.

- 데이터: `.local/postgres/data`
- 접속 정보: `.local/postgres-url.txt` (권한 `0600`, 비밀 파일)
- 실행 잠금: `.local/postgres/launcher.lock`

`.local/`은 Git에서 제외된다. 데이터와 접속 정보 파일은 함께 보관해야 한다. 기존 데이터의 접속 파일이 없거나 데이터 디렉터리가 불완전하면 실행기는 이를 지우거나 새로 초기화하지 않고 오류를 표시한다. 접속 URL을 로그, 이슈 또는 저장소에 남기지 않는다.

개발 서버는 다른 터미널에서 다음과 같이 실행한다. `--postgres`는 접속 파일을 읽어 API 서버의 `PIKKU_DATABASE_URL`에만 전달한다. 스케줄러까지 명시적으로 켜려면 `--scheduler`를 추가한다.

```sh
npm run dev:local -- --postgres
npm run dev:local -- --postgres --scheduler
```

실제 PostgreSQL 테스트는 다음 명령이 접속 파일을 비공개로 읽어 테스트 전용 `PIKKU_TEST_DATABASE_URL`에 전달한다. 일반 `npm test`는 이 테스트 변수가 없으면 DB 테스트를 건너뛰므로 영속 저장 검증과 구별한다. 외부 테스트 DB를 쓰는 경우 이 테스트 변수만 명시하며 운영 DB를 사용하지 않는다.

```sh
npm run test:postgres
```

실행 중 포트 또는 잠금 충돌이 발생하면 기존 실행기를 먼저 확인한다. 강제 종료로 잠금이 남은 경우에는 잠금 파일에 기록된 PID와 PostgreSQL 프로세스가 모두 종료되었는지 확인한 뒤 잠금 파일만 수동으로 제거한다. 데이터 디렉터리나 접속 정보 파일은 삭제하지 않는다.

실행기 검증에는 `npm run dev:db -- --test`를 사용할 수 있다. 이 모드는 `127.0.0.1:55433`, `.local/postgres/test/data`, `.local/postgres/test/postgres-url.txt`를 사용하며, 검증 데이터도 종료 후 보존한다.

설치 스크립트가 비활성화되어 있어도 실행기가 패키지의 `autoRehydrateSymlinks` 옵션으로 필요한 심볼릭 링크를 복구한다. 자세한 옵션은 [embedded-postgres 공식 README](https://github.com/leinelissen/embedded-postgres)를 참고한다.
