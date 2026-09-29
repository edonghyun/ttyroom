# P1: TTYRoom Connector 명칭 변경

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-18 완료. Spring 백엔드 구현은 다음 단계이며 이번 변경은 로컬 프로그램 명칭과 패키징 검증에 한정한다.

## 변경

- 사용자 이름: Agent → **TTYRoom Connector**. Add Host 안내, 대기 상태, 빈 터미널 화면, Room Gone 설명, CLI 시작 메시지를 갱신했다.
- 패키지/폴더: `@ttyroom/agent`, `packages/agent` → `@ttyroom/connector`, `packages/connector`.
- 클래스와 파일: ConnectorApp, ConnectorSession, ConnectorTransport, ConnectorConnection, ConnectorClock, WsConnectorTransport 및 관련 테스트 이름을 일치시켰다.
- 서버 내부 reconciliation 결과와 테스트의 Connector 표현, E2E 실행기, 브라우저 fixture, CI, 의존성 경계 검사, lockfile 및 현재 기술 문서를 갱신했다.
- 기존 PTY 실행·재접속·종료·Kill Switch 동작은 유지했다. 공개 wire의 host/hostId, protocolVersion=7, CLI ttyroom join, 로컬 설정 키는 변경하지 않았다.
- clientId는 파일 보관 값이 아니라 프로세스마다 생성되는 UUID다. 같은 실행 중 재접속에 유지되는 기존 수명을 보존하고 계획 문서의 잘못된 가정을 정정했다.

## 패키징 실패 해결

기존 통합 테스트는 COREPACK_ENABLE_PROJECT_SPEC=0으로 실행하여 프로젝트의 pnpm 10.10.0 대신 전역 기본 버전 11.24.0을 선택했다. 패키징 자식 프로세스에 값을 1로 지정해 workspace의 packageManager pin을 따르도록 수정했다. 전역 Corepack 설정은 변경하지 않았다.

이름 변경 전 generated dist에는 예전 파일 이름이 남을 수 있으므로 이동한 Connector의 생성 산출물을 지운 뒤 재빌드했다. 별도 임시 디렉터리에 protocol과 connector tarball을 함께 설치하고 `npm exec --offline -- ttyroom` 실행 파일 해석과 사용법 출력을 검증했다. 설치 패키지에 예전 agent 이름의 dist 파일이 없음을 확인했다.

공개 npm 조회에서 @ttyroom/agent와 @ttyroom/connector 모두 E404를 반환했다. 공개 배포를 확인하지 못한 것이며 비공개 배포의 부재까지 증명하지 않는다. 이번 작업에서 패키지를 게시하지 않았다. 기존 source checkout 사용자는 pnpm install 후 재빌드한다. 루트 README는 로컬 실행과 현재 명칭을 안내한다.

## 검증 결과

| 검증                                | 결과                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| frozen lockfile 설치                | 통과                                                       |
| 타입 검사·의존성 경계 검사          | 통과                                                       |
| 단위 테스트                         | 534개 통과: protocol 95, connector 56, web 173, server 210 |
| 전체 빌드                           | 통과                                                       |
| 통합 테스트                         | 36개 통과: connector 16, server 20                         |
| 실제 PTY 협업·복구 E2E              | 19개 통과                                                  |
| Chromium 브라우저 인수 테스트       | 30개 통과                                                  |
| 별도 디렉터리 tarball 설치·CLI 실행 | 통과                                                       |
| protocol v7 golden fixture          | 변경 전후 SHA-256 동일                                     |

`pnpm format`과 `git diff --check`도 통과했다.

실행 환경은 P0와 동일한 macOS arm64, Node 26.3.1, pnpm 10.10.0이다. Linux/Windows 배포 검증을 수행한 것은 아니다. 브라우저 Add Host 화면도 캡처해 Connector 문구를 확인했다.

## 증거와 기존 변경 보존

`artifacts/migration-baseline/p1/`에 변경 전 source-before.tar.gz, source-manifest.json, 실행별 로그와 results.json을 보관했다. P0의 과거 로그·계약 fixture는 수정하지 않았다. 사용자의 기존 서버·웹 변경을 되돌리거나 커밋하지 않았다.

과거 specs/plans와 P0 기록은 당시 이름을 유지한다. 기존 visual reference의 agent-host-01은 프로그램 이름이 아닌 고정된 샘플 컴퓨터 ID/이름이므로 유지한다. 현재 실행 코드·CI·패키지 경로의 프로그램 이름은 Connector다.

## 다음 단계

P2: E2E 실행기가 Node 함수를 직접 호출하는 의존을 제거하고, Node/Java 서버 프로세스를 같은 HTTP/WS 시나리오로 검증할 수 있도록 준비한다.
