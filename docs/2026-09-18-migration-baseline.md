# Spring 전환 P0: 현재 동작 기준

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-18 로컬 검증. P0 기준 확보 완료, 기존 패키징 테스트 실패 1건은 잔여 이슈로 유지한다. 제품 코드와 패키지 이름은 변경하지 않았다.

## 기준 소스와 환경

- 작업 경로: `/Users/idonghyeon/projects/ttyroom/main`
- Node v26.3.1, pnpm 10.10.0, macOS arm64. CI의 Node 22 검증과 동일한 환경이라고 주장하지 않는다.
- 기존 서버·웹 수정 및 미추적 소스를 포함한 코드/설정/문서 스냅샷: `artifacts/migration-baseline/p0/source-before.tar.gz`.
- 파일별 SHA-256: 같은 폴더의 `source-manifest.json`. 기준 HEAD와 Git 상태는 `head.txt`, `git-status-before.txt`에 보존.
- 스냅샷은 Git tracked 및 untracked non-ignored 파일 중 artifacts를 제외한다. node_modules, 무시된 로컬 DB·비밀 설정, 기존 산출물 전체 백업은 아니다. 기존 파일을 되돌리거나 Git 커밋하지 않았다.

## 실행 결과

모든 명령은 작업 경로에서 실행한다. 로그는 `artifacts/migration-baseline/p0/`에 있다.

| 명령                                             | 결과                                                  | 로그                           |
| ------------------------------------------------ | ----------------------------------------------------- | ------------------------------ |
| `pnpm typecheck`                                 | 통과, fixture 추가 후에도 통과                        | 01.log, 16-typecheck-final.log |
| `pnpm depcruise`                                 | 통과                                                  | 02.log                         |
| `pnpm test`                                      | 기존 단위 테스트 473개 통과                           | 03.log                         |
| `pnpm -r --if-present run build`                 | 통과                                                  | 04.log                         |
| `pnpm test:integration`                          | Agent 15개 통과, 패키징 1개 실패; recursive 실행 중단 | 05.log                         |
| `pnpm --filter @ttyroom/server test:integration` | 별도 실행 20개 통과                                   | 11-server-integration.log      |
| `pnpm test:e2e`                                  | 실제 PTY 포함 19개 통과                               | 06.log                         |
| `pnpm test:browser`                              | Chromium 설치 후 30개 통과                            | 14-browser-retry.log           |
| `pnpm --filter @ttyroom/protocol test`           | 기존 34개 + 새 fixture 검증 61개 = 95개 통과          | 15-fixtures-final.log          |

초기 브라우저 실행은 Playwright Chromium 1234 미설치로 전부 시작 전에 실패했다. `pnpm --filter @ttyroom/web exec playwright install chromium` 후 재실행하여 통과했다. 초기 format 검사는 앞서 작성한 전환 계획 문서 한 파일 때문에 실패했고 해당 문서와 이번 추가 파일만 포맷한다. 최종 `pnpm format`은 통과했다(17-format-final.log). 초기 결과는 results.json에 그대로 남기며 재검증 로그와 구분한다.

### 남아 있는 패키징 이슈

`packages/agent/src/package.integration.spec.ts`는 pack 자식 프로세스에 `COREPACK_ENABLE_PROJECT_SPEC=0`을 설정한다. 로컬에서 이 프로세스가 pnpm 11.24.0을 선택해 프로젝트 pin 10.10.0과 충돌한다. PTY 기능 실패와 구분해야 한다. 전역 pnpm 설정이나 기존 테스트 코드는 P0에서 변경하지 않았다. P1의 패키지 경로·이름 변경 시 프로젝트에 고정된 도구로 pack을 실행하도록 함께 수정하고 통합 테스트 전체를 다시 통과시켜야 한다.

## 전환 시 보존할 계약

| 경계      | 고정 대상                                                                                                                | 코드 기준                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| HTTP      | POST /api/rooms, 선택적 name, 201 roomId/name/token/joinUrl, 이름 trim·길이 검증, 16KiB body 상한, /healthz 및 오류 응답 | packages/server/src/http/http-api.ts                       |
| 정적 웹   | SPA 경로와 빌드 파일 제공, API/WS 라우팅과 구분                                                                          | packages/server/src/http/static-web-app.ts                 |
| 연결      | /ws, hello role participant/host, protocolVersion 7, 링크 토큰, welcome, 잘못된 버전 거절                                | adapters/ws, usecases/control-plane.ts, adapters/link-auth |
| JSON      | 클라이언트 18종, 서버 13종, 모든 room-event 종류의 형태·기본값·검증                                                      | packages/protocol/src/messages.ts, PROTOCOL.md             |
| 바이너리  | 출력 헤더 9바이트, 입력 헤더 13바이트, uint32 big-endian, 불투명 payload, malformed 거절                                 | packages/protocol/src/data-frame.ts                        |
| 입력      | 현재 권한·mode·Host 상태·차단 상태 검사, 잘못된 lease 거절. input seq의 중복 제거를 새로 보장한다고 주장하지 않음        | usecases/route-terminal-input.ts                           |
| 출력      | source seq 중복 제거와 서버 seq 부여, 터미널별 보관, gap 통지와 resync                                                   | usecases/broadcast-terminal-output.ts                      |
| 상태 변경 | 같은 방의 변경 직렬화, 저장 실패 시 live state에 미반영, 저장 후 commit                                                  | usecases/room-registry.ts                                  |
| 복구      | 같은 clientId 재접속과 유예, Host inventory/runtimeId 확인, 출력 replay, 서버 재시작 뒤 살아 있는 PTY 복원               | packages/e2e/src/resilience.e2e.ts                         |
| 로컬 실행 | ttyroom join 문법, PTY 생성/종료/resize, Kill Switch, clientId 보존                                                      | packages/agent/src                                         |

정책 기본값은 participant 유예 15초, host 유예 30초, 터미널 scrollback 1MiB, 송신 drop threshold 1MiB, 연결 data queue 1MiB, 출력 rate limit 4MiB/s다. 설정 키와 기본값을 이식할 때 `ports/policy.ts`와 `config.ts`를 함께 비교한다.

### 저장 계약은 wire와 별도

- SQLite STRICT 테이블 `rooms(room_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)`.
- 저장 JSON schemaVersion=1. roomId, tokenHash, name, nextTerminalId, hosts, terminals를 보관한다.
- tokenHash는 64자리 소문자 hex. terminal은 view와 nullable runtimeId를 보관한다.
- 최상위 및 host/terminal wrapper는 strict schema다. Wire의 unknown-field 처리와 혼동하지 않는다.
- 참가자 연결·lease·cursor 및 PTY 출력 전체가 이 DB에 보존되는 것은 아니다.
- Java 이식 시 복사 DB로 양방향 읽기/쓰기 호환을 검증한다. 이번 단계는 DB 교차 구현 검증을 수행한 것이 아니다.

## 추가한 언어 중립 검증 자료

`packages/protocol/fixtures/wire-v7.json`에는 문서 예시 기반 JSON 48건, 잘못된 메시지 4건, 독립 구성한 바이너리 3건, 잘못된 바이너리 4건을 저장했다. 바이너리는 빈 payload, UTF-8, signed int 경계를 넘는 값과 uint32 최댓값을 포함한다.

`packages/protocol/src/wire-fixtures.spec.ts`가 구조 비교, encode/decode 바이트 일치, 모든 message type과 room-event kind의 fixture 존재를 검증한다. Java는 같은 JSON 파일을 읽어 검증할 수 있다. 모든 필드 조합과 권한 규칙을 포괄하는 테스트는 아니며 기존 단위·E2E와 함께 사용한다.

## 다음 단계

P1에서 Agent를 Connector로 변경한다. CLI 문법·wire host 역할·로컬 식별자 경로를 보존하고 package 이름·CI·문서·테스트를 함께 바꾼다. 위 패키징 도구 선택 이슈를 해결한 뒤 통합 및 브라우저 테스트를 재실행한다. Spring 애플리케이션 추가는 P2 테스트 실행기 분리 이후다.
