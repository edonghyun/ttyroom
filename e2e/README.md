# TTYRoom backend acceptance E2E

이 패키지는 실제 서버 프로세스, 실제 Connector 배포 코드와 PTY, HTTP/WebSocket 클라이언트로 백엔드 협업 동작을 검증한다. 브라우저 UI 테스트는 `web/e2e`에 별도로 있다. 서버 내부 함수나 타입은 import하지 않는다.

작성·리뷰 기준은 [코드·테스트 작성 가이드](../docs/CODE_STYLE.md)를 따른다.
`policy.e2e.ts`와 `policy-scenario.ts`는 행동·관찰·자원 수명을 분리한 예시다.

## 실행

저장소 루트에서 Spring 제품을 빌드한 뒤 실행한다. 생성된 배포물이 검증 대상이므로
코드 수정 후 다시 빌드해야 한다. Java 21, Node.js 22 이상과 pnpm 설치는
[루트 빠른 시작](../README.md)을 따른다.

```sh
./scripts/build-spring.sh
./scripts/test-spring.sh protocol
# 특정 계약만 검사
./scripts/test-spring.sh protocol src/persistence.e2e.ts
```

Spring과 Node에 같은 제품 시나리오를 실행한다. `static-web.e2e.ts`는 웹 포함 JAR가
필요하다. Java 단독 API-only JAR를 검사하려면 `--exclude src/static-web.e2e.ts`를
추가한다. CI의 spring-contract job은 이 방식으로 전체 파일을 자동 수집하고,
웹 정적 파일 계약은 browser job에서 검사한다. 새로운 계약 파일을 추가할 때 CI의
파일 목록을 따로 수정할 필요가 없다.

Node 비교 구현은 다음과 같이 실행한다. 기존 pnpm 명령의 기본 대상은 Node다.

```sh
pnpm -r --if-present run build
pnpm test:e2e
```

다른 실행 파일은 shell 문자열이 아닌 JSON argv 배열로 지정한다. 실행기의 cwd가
임시 디렉터리이므로 경로 인자는 절대 경로를 사용한다. Spring 스크립트는 이 설정을
자동 구성하며 빌드를 대신 실행하지 않는다.

```sh
TTYROOM_E2E_SERVER_COMMAND='["java","-jar","/absolute/path/to/ttyroom.jar"]' pnpm test:e2e
```

테스트 실행기의 오류·cleanup 테스트는 별도의 Node probe 프로세스를 사용한다.

## 실행 파일 계약

`server-process.ts`가 테스트마다 임시 작업 디렉터리를 만들고 다음을 제공한다.

- cwd의 `ttyroom.config.json`: port, statePath, policy overrides. 기존 Node CLI가 읽는 공개 설정 형식이다.
- `TTYROOM_CONFIG_PATH`: 위 파일의 절대 경로. Spring은 이 경로를 읽는다. Node 비교 구현은 cwd의 기본 파일을 읽으며 실행기는 두 경로를 같은 파일로 제공한다.
- `TTYROOM_PORT`: 최초에는 0, 재시작에는 이전 포트.
- `TTYROOM_STATE_PATH`: 테스트 전용 SQLite 경로. 재시작 동안 같은 파일을 사용한다.
- 다른 TTYROOM 환경변수는 자식 환경에서 제거해 개인 설정이 테스트에 섞이지 않게 한다.

서버는 listen 후 stdout에 `TTYRoom server listening at http://127.0.0.1:PORT`를 출력한다. 실행기는 이 주소에서 GET /healthz가 200/ok를 반환할 때까지 기다린다. 시작 제한시간은 기본 10초다. 이 로그 한 줄은 프로세스 실행 어댑터의 계약이며 협업 프로토콜의 일부는 아니다. Spring의 시작 로그 전체를 Node와 같게 만들 필요는 없다.

재시작은 기존 프로세스에 SIGTERM을 보내고, 종료 후 같은 디렉터리·포트로 새 프로세스를 실행한다. 250ms 내 종료하지 않는 자식은 SIGKILL로 정리한다. 따라서 이 테스트의 restart는 프로세스 교체·상태 복구 검증이며 graceful drain 검증이라고 주장하지 않는다. 실행 명령은 서버를 직접 실행해야 하며 background/daemon wrapper는 지원하지 않는다.

## 시나리오 작성 원칙

1. 각 테스트가 자신의 서버·방을 소유한다. `await using server = await given.server()`로 assertion 실패 시에도 정리한다. 공유 DB·고정 포트·이전 테스트의 상태에 의존하지 않는다.
2. 준비를 기다릴 때 sleep 대신 welcome, room-event, sync, 실제 출력 같은 의미 있는 조건을 사용한다. 장애 복구 테스트의 downtime은 명시적으로 주입한 장애 시간이다.
3. 구현이 아니라 참여자가 관찰하는 결과를 검증한다. 한 참여자의 변경은 다른 참여자의 화면 모델 또는 새 입장자의 welcome에서도 확인한다.
4. 입력 문자열이 단순히 echo된 것으로 통과하지 않게 한다. `printf '%s%s\n' 'collab-' 'ok'`의 결과 `collab-ok`처럼 입력 원문에 없는 실행 결과를 검사한다. 셸 환경변수 보존 검사도 할당 명령의 echo에 기대 결과가 포함되지 않게 한다.
5. 수신 프레임은 도착 순서 그대로 보관한다. 테스트 도우미에서 정렬·중복 제거하지 않는다. replay 테스트가 raw sequence의 중복과 역순을 검사한다. welcome과 명시적 resync 시에만 해당 projection을 초기화한다.
6. 없음을 검증할 때 임의 지연 후 부재만 보지 않는다. 예를 들어 방 격리는 각 방의 실행 결과와 replay/sync 완료를 확인한 후 교차 출력을 검사한다.
7. 패턴·비공개 메서드 호출 횟수를 검증하는 테스트는 단위 테스트에 둔다. 실제 slow consumer를 만들지 않은 테스트를 output-gap E2E라고 부르지 않는다.

## 가독성 기준

테스트는 fixture 준비 → 이름 있는 액션 → 명시적인 assert 순서로 읽히게 한다. 기대값과 검증 대상 참여자는 본문에 남긴다.

```ts
await using fixture = await controlledTerminalFixture(["alice", "bob"]);
const { terminalId } = fixture;
const { alice, bob } = fixture.participants;

printOutput(alice, terminalId, "collab-ok");

await assertOutputContains(bob, terminalId, "collab-ok");
await assertOutputContains(alice, terminalId, "collab-ok");
```

- `fixtures.ts`: `roomFixture({ name, policy })`는 서버와 방을 준비한다. `terminalFixture(["alice", "bob"], options)`는 Connector, 지정한 참여자, 첫 참여자가 연 터미널 하나를 추가한다. 입력권 획득·명령 실행은 하지 않는다. 각 fixture는 `await using`으로 정리하며 준비 도중 실패해도 생성된 자원을 닫는다. 참여자 이름은 고유해야 한다.
- `connectedRoomFixture`: 참여자와 컴퓨터만 연결한다. 터미널 생성 자체를 검사하는 케이스에서 사용한다.
- `outputHistoryFixture`: 이미 출력이 존재하는 터미널을 준비한다. 늦은 입장·replay 케이스가 기존 출력 생성 검증을 반복하지 않게 한다.
- `controlledTerminalFixture`: 첫 참여자가 입력권을 가진 상태까지 준비한다. 출력·재접속 등 입력권 획득 자체가 검증 대상이 아닌 경우 사용한다. 준비 실패는 fixture 오류로 보고한다.
- `isolatedRoomsFixture`: 같은 서버의 서로 다른 방에 같은 terminalId를 가진 두 터미널과 입력권을 준비한다. 본문에서는 방 사이 출력 격리만 검증한다.
- `harness.ts`: `requestControl`, `renameTerminal`, `changeTerminalMode`, `sendInput` 등 참여자의 액션과 읽기 전용 상태 조회를 제공한다. 재접속은 같은 참여자 객체의 clientId를 재사용한다.
- `actions.ts`: `runUntilOutput`은 셸 준비 명령을 실행하고 준비 완료 표식을 기다린다. 준비 실패는 진단과 함께 오류로 보고한다. `printOutput`은 입력 echo와 구분되는 셸 명령을 만들어 실행한다. 결과 대기나 성공 검증까지 대신하지 않는다.
- `assertions.ts`: 입력권 승인·거절, 소유자, 터미널 상태, 출력, replay 완료·중복·순서를 이름으로 표현한다. 비동기 상태 검증의 polling을 소유하며 기본 제한시간 10초·간격 10ms는 Vitest 설정에 둔다. `assertReplayExactlyOnce`가 replay 완료 대기까지 담당하므로 호출 순서 전제가 없다. `assertRoomOutputIsolated`는 `captureOutputReplay` 액션이 반환한 완료된 출력만 검사하며 상태를 변경하지 않는다. Host 단절은 잠깐 나타나는 snapshot 대신 수신한 `host-offline` 이벤트로 확인한다.

동시 연결·동시 터미널 생성처럼 준비 자체가 검증 대상인 경우 `roomFixture`에서 시작해 해당 액션을 본문에 남긴다. 두 방 격리는 동일 서버 사용이 중요하므로 서버 하나에서 두 방을 명시적으로 만든다. 테스트 간 실행 순서나 자원은 공유하지 않는다. 다른 케이스에서 검증한 동작은 현재 케이스의 사전 조건으로 준비하고, 같은 검증을 본문에서 반복하지 않는다. 준비 완료 대기와 해당 케이스의 결과 검증을 구분한다. 단순한 값 비교와 요청 완료 직후의 snapshot 검증은 직접 `expect`를 써도 된다. 모든 expect를 의미 없는 래퍼로 옮기지는 않는다.

## 현재 범위

| 파일                     | 검증                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| terminal-creation.e2e.ts | 생성 예약/확인, 중복 억제, 복구 ID/동시 발급/u32 소진, 역할·방·host 검증, 생성 실패/종료 보고                                           |
| terminal-metadata.e2e.ts | 메타데이터 변경/중복/null/역할/소유권/종료 후 보고, 실제 Connector의 첫 PTY 보고 후 두 번째 PTY 생성                                    |
| protocol-fixture.e2e.ts  | 입력 상태가 이미 허용된 host의 반복 관찰, 다른 host 알림과 대상 host 완료 구분                                                          |
| terminal-input.e2e.ts    | exclusive lease 획득/반납/재접속, 입력 권한·방 격리·Kill Switch·binary 전달, 실제 셸 명령 실행                                          |
| terminal-recovery.e2e.ts | protocol peer의 inventory 조정, runtime 충돌, source 중복 제거, 출력/late join/resync, 방 격리, 큰 ID 좌표; 실제 PTY 재시작 검증은 아님 |
| host-session.e2e.ts      | 빈 inventory, host-ready, 입력 상태 보고·중복 억제, 재접속 초기화, 역할·입장 전 검증, 실제 Connector 초기 연결                          |
| collab.e2e.ts            | 방 이름, 토큰 거절, 협업 출력, 늦은 입장, 명시적 resync, 모드, 종료, 동시 권한, 이름·위치 전파, 방 격리, 동시 Host/터미널 요청          |
| resilience.e2e.ts        | 새 서버 PID와 저장 상태/PTY 복구, 재접속 lease, Connector 종료, 셸 상태 보존, replay 중복·순서                                          |
| harness-lifecycle.e2e.ts | 시작 오류 진단, readiness timeout cleanup, 중첩 서버 ownership, 정지된 자식 정리                                                        |

WebSocket handshake와 close 대기도 제한시간을 갖는다. 시작 실패는 pid/종료 상태와 최근 16K자 stdout/stderr를 보여주고, 응답 timeout은 최근 제어 메시지를 제공한다. 연결 실패·잘못된 프레임·명시적 error 응답은 조용히 무시하지 않는다.

## 아직 별도 검증인 것

- 현재 브라우저 테스트 실행기는 Node 서버를 직접 import하며 drop threshold를 직접 조정하는 테스트가 있다. 이를 Java 공통 브라우저 E2E로 이식하려면 공개 실행 경계와 네트워크 장애 주입 방식으로 바꿔야 한다.
- 이 프로토콜 E2E에서 실제 slow-consumer output-gap을 유도하거나 부하/soak 테스트를 수행하지 않는다. 관련 단위·브라우저 검증과 구분한다.
- 호스트와 참여자는 테스트용 신뢰된 로컬 환경이다. 보안 침투 테스트나 운영 환경 검증은 아니다.
- macOS에서 검증했고 CI는 Linux에서 같은 빌드·통합·E2E를 실행한다. SIGSTOP 등 POSIX 수명 검증을 Windows 지원 증거로 사용하지 않는다.
- 테스트 Connector는 `/bin/sh`를 사용하고 ENV/BASH_ENV를 비워 개인 셸 초기화 설정을 배제한다. 사용자별 zsh/bash 설정 호환성 전체를 검증하는 것은 아니다.

## 순서 의존 검증

```bash
pnpm --filter @ttyroom/e2e test:e2e --sequence.shuffle --sequence.seed=42
```

테스트 실패를 retry로 숨기지 않는다. CI의 full job은 PR과 main push에서 모두 빌드·통합·E2E를 실행한다.

`protocol-fixture.ts`는 Host·복구·생성·메타데이터 계약의 실제 서버와 raw 소켓을 함께 소유한다.
`protocolRoomFixture()`는 연결만 준비하고, `protocolWorkspaceFixture([7, 8])`는 지정한 ID의 runtime과
초기 inventory 완료까지 준비한다. fixture는 준비 이벤트의 종류·ID를 확인하되 제품 결과 assert는 각 테스트에 둔다.

생성 확인 전 부재·중복 억제는 fixture의 `captureThroughInputCycle()`로 관찰한다. 같은 host 소켓에
입력 차단 → 허용을 보내 최종 허용 알림까지 도착 순서 그대로 반환한다. 다른 host의 알림도 버리지 않는다.
이 동작은 입력 권한을 바꾸므로 lease 유지나 Kill Switch 자체 검증의 일반 대기 도구로 쓰지 않는다.
fixture 기본 host의 이전 입력 상태 알림은 먼저 소비한 상태에서 호출한다. pending terminal을 변경하는
inventory를 단순 대기 장치로 쓰지 않는다.

메타데이터의 실제 Connector 시나리오는 기본 5초 수집 주기를 유지하고 관찰 가능한 cwd 갱신을 기다린다.
그 뒤 두 번째 생성 요청을 완료해야 통과한다. 준비와 행동 도중 assert를 넣지 않으며 고정 sleep도 사용하지 않는다.
macOS에서는 lsof, Linux에서는 /proc를 통해 수집하는 작업 경로가 검증 대상이다. 전체 셸 명령 입력,
장시간 연결 유지나 Java 서버 재시작 복구를 증명하는 테스트는 아니다.

`terminal-input.e2e.ts`는 실제 셸에서 printf를 실행한 결과를 두 참여자가 받는 것까지 검사한다.
shared 모드나 전체 브라우저 협업 검증과는 구분한다. Java JAR의 E2E는 `bootJar` 완료 후 실행하고,
프로세스 테스트가 끝날 때까지 같은 JAR 파일을 다시 생성하지 않는다.

Shared 입력 계약은 `terminal-mode.e2e.ts`에 있다. `protocol-input-fixture.ts`는 독립 방·입력 허용 host·
exclusive lease를 준비하고, 모드 전환은 테스트의 행동 또는 shared fixture가 수행한다. 실제 Connector
셸 검증에서 WsParticipant는 shared snapshot일 때 lease 없이 입력할 수 있다.

`terminal-control.e2e.ts`는 종료 요청과 resize를 검증한다. 테스트 클라이언트의 `requestResize`는
응답을 기다리지 않고 전송하며, 실제 적용은 후속 셸 출력으로 확인한다. `closeTerminal`은 host의 종료
이벤트까지 기다린다. PTY 행/열 변경과 workspace 창 geometry 변경을 구분한다.

`terminal-view.e2e.ts`는 제목·창 geometry의 변경/반복 요청/없는 ID, Unicode trim·UTF-16 길이,
좌표·창 크기 범위와 역할·방 격리를 검증한다. viewFixture는 Alice의 실제 lease, 입력 차단 host와
Bob을 준비한다. Bob의 변경 전후 lease·terminal snapshot을 비교하고 요청자/관찰자/후속 입장자에
값이 반영되는지 확인한다. pending·종료·offline 상태도 같은 계약을 적용한다.

`participant-presence.e2e.ts`는 focus/blur의 알림·중복 억제·후속 snapshot·교체/재접속 복원과
cursor의 발신자 제외·반복/null 전달·비저장·방 격리를 검사한다. 활성 cursor 상태에서 늦은 입장과
수신자 재접속을 검증하며, 화면 포인터 애니메이션이나 부하 검증과는 구분한다.

`persistence.e2e.ts`는 Node·Spring 공통 영속 저장 계약이다. Spring도 `TTYROOM_STATE_PATH`를 읽어
실제 SQLite 모드에서 실행하며 새 PID의 복원을 검증한다. 초대·terminal view·runtime·
미확인 예약·다음 ID 복원 및 lease/focus/출력 초기화를 검증하며, raw host는 자동 재접속하지 않는다.
실제 살아 있는 PTY와 Connector replay는 기존 `resilience.e2e.ts`가 담당한다.
저장 실패·확정·알림 순서는 Node의 `persistence-contract.spec.ts`와 Java의
`RoomPersistenceTests`에서 저장소 gate로 검증한다.

`policy.e2e.ts`는 유예 0, history 보관량, live 드롭과 replay 분리, header를 포함한 수신 binary 한도를
검증한다. 누적 큐의 내부 동작이 두 서버에서 같다는 뜻은 아니다. [설정 차이](../docs/WORK_LOG.md#sqlite와-실행-설정)를 따른다.

브라우저 UI 검증은 [web/e2e와 Spring 실행 안내](../docs/WORK_LOG.md#실제-프로세스와-브라우저-검증)를 따른다.
Browser TestSystem도 같은 ServerProcess 실행 경계를 사용한다.

## Spring 등록 계약

`./scripts/test-spring.sh registration`은 실제 JAR의 관리·참가자·host 등록과 재시작 후 관리 권한을
검증한다. 먼저 JAR를 빌드하며 Java 21의 `JAVA_HOME`을 사용한다. 이 Spring 전용 계약은
`vitest.registration.config.ts`로 실행하고 v7 Node/Spring 공통 E2E에 섞지 않는다.
CI의 `spring-contract` 작업에서도 실행한다. WebSocket v8 인증을 검증하는 테스트는 아니다.

## Spring v8 입장 계약

`./scripts/test-spring.sh authentication`은 `vitest.authentication.config.ts`로
[admission.spring.ts](src/admission.spring.ts)를 실행한다. 현재 13개 사례가 실제 JAR의
credential 인증·신원 필드 거절·버전 격리·동일 주체 교체·새 PID의 host credential 복원을 검증한다.
HTTP 등록 fixture가 서버·소켓·임시 SQLite 수명을 소유하며 서버 설정에 버전을 명시한다.
프로세스 하나에서 두 버전을 함께 허용하지 않는다. CI의 `spring-contract`에서도 실행한다.

protocol·Connector와 JAR를 먼저 빌드하고, 테스트가 끝날 때까지 산출물을 다시 쓰지 않는다.
이 검사는 현재 v7 React·Connector의 v8 연동이나 공개 취소 API를 검증하지 않는다.
