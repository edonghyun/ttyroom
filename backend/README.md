# Spring backend — 단계별 이식 중

React 화면과 Connector를 포함한 기본 실행은 [루트 빠른 시작](../README.md#빠른-시작--spring--react--connector)을
따른다. 아래 명령은 Node 설치 없이 사용하는 Java 단독 개발 경로다.

Java 21 + Spring Boot 4.0.8 + Gradle Wrapper 9.7.1. 버전은 고정하며 Wrapper 다운로드의 SHA-256도 검사한다. [Spring 공식 호환 범위](https://docs.spring.io/spring-boot/4.0/system-requirements.html)를 기준으로 선택했다.

```sh
cd backend
./gradlew bootRun       # 개발 실행
./gradlew test          # Java 동작 + 계층 의존성 테스트
./gradlew test bootJar  # 테스트 + 실행 JAR 생성

# 빌드된 JAR 실행
TTYROOM_PORT=3000 TTYROOM_STATE_PATH=.ttyroom/rooms.sqlite \
  java -jar build/libs/ttyroom-backend.jar
```

Java 21 JDK가 필요하다. `JAVA_HOME`을 해당 JDK 경로로 지정한다. 이 프로젝트의 빌드·실행에는 pnpm이 필요하지 않다. 루트 pnpm workspace와 독립적으로 Gradle Wrapper를 사용한다.

현재 구현은 HTTP 방 생성·WebSocket 입장, Host inventory와 출력 replay, 터미널 생성·종료·resize·메타데이터·제목·창 배치, exclusive/shared 입력, 참여자 focus/cursor 동기화다. 다음 기능과 리팩터링은 [기존 설계를 이어가는 기준](ARCHITECTURE.md)에 따라 검토한다.

- `127.0.0.1`에만 bind하며 `TTYROOM_PORT`를 읽는다. 기본 3000, 0은 임의 포트다. 외부 노출 정책은 후속 단계에서 정한다.
- `GET /healthz`는 200, plain text `ok`를 반환한다.
- 초기화가 끝나면 `TTYRoom server listening at http://127.0.0.1:PORT`를 출력한다.
- 잘못된 포트 설정은 Spring 시작 오류로 처리한다.
- Spring 종료 유예는 5초다. 기존 E2E 실행기는 250ms 후 강제 종료할 수 있으므로 프로세스 smoke는 graceful drain 보장이 아니다.

`POST /api/rooms`는 기존 Node와 같은 이름 검증·초대 URL·오류 응답을 제공한다. 방과 토큰 SHA-256 해시는 메모리 또는 설정한 SQLite 파일에 보관한다. 토큰 원문은 초대 응답에만 사용하며 인증 비교는 고정 길이 digest의 constant-time 비교를 사용한다.

`TTYROOM_STATE_PATH`가 없거나 빈 문자열이면 기존 메모리 모드다. 경로를 지정하면 부모 디렉터리를
생성하고 SQLite 파일에서 모든 방을 복원한 뒤 readiness를 알린다. 상대 경로는 실행 디렉터리 기준이다.
저장소 열기·레코드 복원 실패는 시작 오류로 처리하며 메모리로 대체하지 않는다. 같은 파일은 한 서버가
소유하는 구성으로 사용한다. Node는 기본 SQLite 경로를 사용하므로 기본 저장 설정까지 같은 것은 아니다.

새 프로세스에서도 초대·host 식별·terminal 상태와 다음 ID를 복원한다. 연결·lease·focus·출력 history는
초기화한다. 살아 있는 Connector가 재접속하여 PTY inventory와 단절 중 출력을 다시 전달한다.
[부팅 연결·재시작 검증](../docs/2026-09-28-sqlite-startup.md)에 근거와 한계를 기록했다.

`TTYROOM_CONFIG_PATH`로 JSON 설정을 선택하며, 생략하면 실행 디렉터리의 `ttyroom.config.json`을
읽는다. 기본 파일이 없을 때만 기본값을 쓴다. `TTYROOM_*` 값이 파일보다 우선한다. 유예·출력 보관량·
송신 드롭·수신 바이너리 한도를 적용하며 잘못된 값은 시작 오류로 처리한다.
[설정 키·우선순위·Node와의 차이](../docs/2026-09-28-server-settings.md)를 참고한다.
출력 속도 변경은 Connector 협상이 없어 아직 지원하지 않는다.

웹 빌드 결과를 `bootJar -PwebDist=../web/dist`로 묶으면 Spring에서 React 화면도 제공한다. 기본
Java 빌드와 bootRun은 API-only이며 Node를 호출하지 않는다. 실제 Chromium·Connector로 검사하는
[Node/Spring 공통 브라우저 E2E](../docs/2026-09-28-spring-browser-e2e.md)도 연결했다.

## 실제 JAR 프로세스 검사

저장소 루트에서 실행한다. JSON argv에는 실제 Java 경로와 JAR의 **절대 경로**를 넣는다. 실행기가 임시 디렉터리를 cwd로 사용하기 때문이다.

```sh
TTYROOM_E2E_SERVER_COMMAND='["java","-jar","/absolute/path/to/main/backend/build/libs/ttyroom-backend.jar"]' \
  pnpm --filter @ttyroom/e2e exec tsx src/backend-smoke.ts
```

시작 로그와 HTTP readiness, 새 PID로 재시작, 기존 포트 재사용을 검사하고 프로세스를 정리한다. 구현한 기능의 공통 프로토콜 계약은 같은 실행 경계로 검증하며 목록은 [E2E 안내](../e2e/README.md)를 따른다.

## Java 계층 의존성 검사

`./gradlew test`에 [ArchitectureTests](src/test/java/dev/ttyroom/architecture/ArchitectureTests.java)가
포함된다. 계층 검사만 실행하려면 `./gradlew test --tests dev.ttyroom.architecture.ArchitectureTests`를
사용한다. ArchUnit은 테스트 의존성이며 실행 JAR에는 들어가지 않는다.
[허용 의존성·탐지 범위·위반 주입 검증](../docs/2026-09-22-java-architecture-tests.md)을 함께 기록했다.
기존 Java CI도 같은 test 작업을 실행하므로 별도 실행 단계를 요구하지 않는다.

아래 검증 기록은 각 이식 단계 당시의 결과다. 현재 구현 범위는 위 설명과 ARCHITECTURE.md를 따른다.

## P3a 검증 결과

2026-09-18, macOS arm64 / Temurin 21.0.12.1:

- `./gradlew test bootJar`: 성공, 실제 HTTP 통합 테스트 1개 통과.
- `backend-smoke.ts`: 실제 JAR 시작·HTTP readiness·새 PID 재시작·포트 재사용 통과.
- `TTYROOM_PORT=invalid`: 비정상 종료 및 readiness 미출력 확인.
- E2E TypeScript 타입 검사 통과. 기존 협업 25개를 Java에 실행한 결과는 아니다.

## 방 생성 HTTP 계약 검사

Node 기준 구현과 Java에 동일한 `e2e/src/http-api.e2e.ts`를 실행한다. 이름 생략·공백·UTF-16 길이, JSON 오류, 본문 16KiB 경계, 방/토큰 고유성, 미지원 API 오류 형식을 검사한다.

```sh
# 저장소 루트 — 빌드된 Node 서버
pnpm --filter @ttyroom/e2e test:e2e src/http-api.e2e.ts

# Java 21을 PATH에 지정하고 JAR 절대 경로 사용
TTYROOM_E2E_SERVER_COMMAND='["java","-jar","/absolute/path/to/main/backend/build/libs/ttyroom-backend.jar"]' \
  pnpm --filter @ttyroom/e2e test:e2e src/http-api.e2e.ts
```

## P3b 검증 결과

2026-09-19, macOS arm64 / Java 21:

- Gradle 테스트 2개와 JAR 빌드 통과.
- 같은 HTTP 계약 23개를 Node와 Java 각각 통과.
- Node 전체 프로세스 E2E 48개 통과(기존 25개 + HTTP 23개).
- TypeScript 타입·의존성 검사 통과.
- 로그: `artifacts/migration-baseline/p3b/`. WebSocket 인증과 영속 복구의 Java 검증 결과는 아니다.

## P3c — WebSocket 입장

`/ws`는 프로토콜 v7 hello를 받아 방/토큰을 확인하고 welcome snapshot을 보낸다. participant 입장 알림, 중복 hello 거절, 같은 역할·clientId의 연결 대체를 처리한다. 역할별 identity를 분리하며, 이전 연결의 close는 새 연결을 제거하지 않는다. host는 목록 동기화 전이므로 offline·입력 차단 상태로 welcome을 받는다.

[Spring WebSocket API](https://docs.spring.io/spring-framework/reference/web/websocket/server.html)를 사용하며, Node와 같이 origin을 입장 인증 수단으로 사용하지 않는다. 초대 토큰이 인증 경계다. 토큰 소지자의 clientId를 신뢰하는 기존 모델도 유지한다. 서버 bind는 여전히 loopback이다.

참여자 15초·host 30초의 기본 종료 유예를 적용한다. 설정 파일의 policy override, 기존 PTY inventory/replay, 저장, 제한된 방 작업 큐·터미널 출력 정책은 후속 작업이다. 입장 상태 변경은 방별 monitor로 직렬화하고 WebSocket 텍스트 송신은 아래의 연결별 큐로 격리한다. 이것이 터미널 바이너리 출력·재전송 정책의 완성 구현을 뜻하지 않는다. 텍스트 메시지 한도는 Node ws 기본값과 같은 100MiB로 명시하고 UTF-8 바이트 크기도 검사한다. 공통 테스트는 9,000자 hello를 검증하며 100MiB 경계 부하 검증 전체를 대신하지 않는다.

공통 입장 계약은 위 Java 실행 환경변수를 지정하고 다음으로 검증한다.

```sh
pnpm --filter @ttyroom/e2e test:e2e src/admission.e2e.ts src/http-api.e2e.ts src/host-session.e2e.ts
```

이 입장 단계에서는 빈 inventory와 입력 상태 보고만 처리했다. 기존 PTY inventory·바이너리 출력·replay는 아래 P3g 단계에서 추가했다. 생성 요청/확인과 host 종료 보고는 P3i, exclusive 입력 권한/전달은 P3k에서 추가했다.

P3c 검증(2026-09-21, macOS arm64 / Java 21): HTTP 23개와 WS 입장 12개의 공통 계약을 Java에서 35개 통과했고, Node 전체 E2E는 60개 통과했다. Gradle 테스트·JAR 빌드, E2E 타입·포맷·의존성 검사도 통과했다. 로그는 `artifacts/migration-baseline/p3c/`에 보관한다. 종료 유예 만료·부하·전체 Connector 복구는 이번 공통 입장 테스트의 검증 범위가 아니다.

## P3c 리뷰 수정 — 2026-09-21

- welcome 송신 실패 시 새 참여자 등록을 되돌린다. 교체 중 실패한 경우 이전 연결을 유지한다. 다른 참여자의 이벤트 송신 실패는 그 연결만 종료·유예 처리하고 새 입장을 중단시키지 않는다.
- welcome이 송신 계층에 수락된 다음 기존 연결을 대체하고 다른 참여자에게 joined를 알린다. 실패한 입장을 알리는 이벤트가 먼저 발행되지 않도록 했다. 서로 다른 소켓 사이 수신 순서나 실제 전달 완료를 보장한다는 뜻은 아니다.
- 방별 잠금 안에서 인증을 다시 확인하며 마지막 유예가 만료되면 방·토큰·presence를 제거한다. 재접속은 이전 만료 작업을 취소한다. 이미 실행되던 이전 콜백도 교체 세션을 제거할 수 없다.
- Host 단절은 즉시 `host-offline`을 발행한다. 유예 만료 후 `host-removed`를 발행한다.
- 큰 양의 정수 버전을 long으로 변환하지 않고 기존 JS 숫자 의미에 맞춰 비교해 `unsupported-protocol-version`으로 응답한다.
- 연결 정리 콜백 등록 전에 소켓이 닫혀도 등록 직후 한 번 실행하며 연결 잠금을 잡은 채 방 상태를 호출하지 않는다.

수정 전 실패: Java 송신 실패 테스트 2개, 공통 WS 회귀 5개. 수정 후 Java 테스트 9개, Java HTTP/WS 계약 40개, Node 전체 E2E 65개 통과. 결과는 `artifacts/migration-baseline/p3c-review/`에 보관한다. 공통 만료 테스트는 기본 15초 유예를 실제 시간으로 확인하며 Java 단위 테스트는 수동 만료 콜백으로 재접속 경합을 결정적으로 검증한다.

## P3c 코드 품질 정리 — 2026-09-21

- 예상된 송신 실패는 `PeerUnavailable`, 초대 거절은 `InvitationRejected`로 표현한다. 직렬화 등 프로그래밍 오류를 일반 연결 실패로 삼키지 않는다. 입장 도중 예외가 나면 등록을 되돌리거나 종료 유예를 예약한 뒤 오류를 전파한다.
- 세션은 역할·clientId·이름과 연결 상태만 보관한다. 토큰을 빈 문자열로 바꾼 `Hello`를 세션 정보로 재사용하지 않는다.
- Java 입장 테스트는 방·초대·수동 만료 실행기를 fixture가 소유한다. 준비·행동·검증을 나누고 snapshot을 문자열로 비교하는 대신 참여자 목록과 이벤트 필드를 검증한다.
- Java 소스에 google-java-format 1.28.0의 AOSP 형식을 적용했다. 포맷 검사 도구를 CI에 추가한 것은 아니다.

Java 테스트 11개, 실제 JAR의 HTTP/WS 공통 계약 40개, `bootJar` 빌드 및 Java 포맷 검사 통과. 실행 로그는 `artifacts/migration-baseline/p3c-quality/`에 보관한다. 이번 변경은 Java에 한정되어 Node 전체 E2E는 다시 실행하지 않았다. 이 정리 시점에는 방 잠금 안의 동기 송신과 `Map` 기반 프로토콜 표현이 남아 있었다. 동기 송신은 아래 단계에서 개선했다.

## 연결별 송신 격리 — 2026-09-21

기존에는 한 소켓의 `sendMessage`가 멈추면 방 잠금을 유지한 채 다른 참여자의 입장도 막았다. 느린 송신을 latch로 멈춘 회귀 테스트로 이를 재현한 뒤 `SocketSender`로 네트워크 I/O를 분리했다.

- `Peer.send`는 직렬화된 메시지를 연결별 FIFO에 넣는다. 전용 virtual thread가 순서대로 송신하며, 실제 소켓 쓰기·닫기는 방 잠금을 보유한 호출 스레드에서 실행하지 않는다. 큐 수락은 실제 전달 확인이 아니다.
- 큐 한도는 **UTF-8 payload 1MiB·256개**이며 송신 중인 메시지도 포함한다. 초과 시 대기 메시지를 버리고 그 연결만 종료한다(1008). 큰 snapshot 하나가 한도를 넘는 경우도 동일하다. 이는 기존 Node의 송신 정책과 완전히 같다는 의미가 아니다.
- 개별 송신은 **5초** 제한을 둔다. 추가 메시지가 없어도 시간 초과를 감지해 연결을 종료한다(1011). 이미 실행 중인 이전 타이머는 다음 송신을 종료할 수 없다.
- 정상 종료는 수락된 메시지를 순서대로 보낸 뒤 닫으므로 인증 오류 응답이 close보다 먼저 나간다. 원격 단절·실패·서버 종료는 큐를 폐기한다. 비동기 실패가 입장 정리 콜백 등록보다 먼저 발생해도 콜백을 한 번 실행한다.
- Spring 종료 시 handler가 큐와 deadline executor를 정리한다. 소켓 종료 시도 자체가 막혀도 논리적 연결 정리는 먼저 수행한다. OS/Tomcat의 실제 I/O 취소 완료 시간을 보장하지는 않는다.

검증 범위는 같은 방의 느린 송신·종료 격리, FIFO/오류 후 종료, UTF-8 용량·메시지 수 제한, 송신 시간 초과, 이전 deadline 경합, 비동기 입장 실패 정리다. 테스트는 latch와 수동 deadline 실행으로 조건을 만든다. Java 테스트 21개, 실제 JAR HTTP/WS 공통 계약 40개, `bootJar` 빌드 및 Java 포맷 검사를 통과했다. 수정 전 느린 소켓 회귀 테스트는 입장 시간 초과로 실패했다. 결과는 `artifacts/migration-baseline/p3d-outbound/`의 `red.log`, `green.log`, `contracts.log`에 보관한다. Java 변경만 있어 Node 전체 E2E는 재실행하지 않았다.

현재 한도는 연결별 payload 기준이다. 전체 연결 수·프로세스 전체 메모리 상한, CPU를 쓰는 JSON 직렬화의 방 잠금 분리, 터미널 바이너리 송신과 replay는 이번 범위에 포함하지 않는다.

## 입장 결과와 wire 변환 분리 — 2026-09-21

기존 Node의 `room-protocol`/`RoomEventPublisher` 경계를 따라 입장 결과를 `AdmissionNotice`로 표현하고,
`AdmissionProtocol`이 protocol v7 JSON을 만든다. application은 wire `Map` 조립을 하지 않고, 테스트도
결과 타입을 직접 검증한다. sealed 결과와 exhaustive switch로 변환 누락을 컴파일 시 확인한다.
동기화·실패 처리·송신 정책은 유지했다. 자세한 비교와 다음 단계의 리뷰 기준은 [ARCHITECTURE.md](ARCHITECTURE.md)에 있다.

검증 로그: `artifacts/migration-baseline/p3e-boundaries/`. Java 테스트에는 기존 공통 wire fixture의
입장 결과 6개와 Welcome snapshot 독립성 검증을 추가했다. 공통 fixture를 Gradle 테스트 리소스로
복사하며 Java 실행/빌드에 Node 의존성을 추가하지 않는다.

2026-09-21 검증: Java 테스트 28개(공통 wire fixture 6개 포함), 실제 JAR HTTP/WS 계약 40개, `bootJar` 빌드와 Java·문서 포맷 검사 통과. Node 구현은 변경하지 않아 Node 전체 E2E는 재실행하지 않았다.

## Host 초기 연결 — 2026-09-21

빈 `host-inventory`에 `host-ready`와 `host-connected`를 발행하고, `host-input-state`가 실제로 변한 경우만
알린다. 새 host 연결은 offline·입력 차단에서 시작하며 inventory 완료도 입력 권한을 자동 허용하지
않는다. Connector는 준비 완료 후 실제 로컬 Kill Switch 상태를 보고한다.

연결의 역할과 현재 identity는 `RoomSessions.Session`, host 상태 규칙은 `domain/HostPresence`, wire
변환은 `RoomProtocol`이 소유한다. 기존 이름 `RoomAdmission/AdmissionNotice/AdmissionProtocol`은 각각
`RoomSessions/RoomNotice/RoomProtocol`로 변경했다. 교체·단절·만료와 host 보고는 같은 방 잠금에서 처리한다.

[기존 문서 기준, Node 비교와 남은 복구 계약](../docs/2026-09-21-host-inventory-contract.md)을 참고한다.
이번 단계는 서버 재시작 후 PTY 복구나 터미널 입력 제어의 검증 결과가 아니다.

검증: Java 테스트 39개, 실제 Spring JAR의 HTTP/입장/Host 초기 연결 계약 55개, Node 전체 프로세스 E2E 80개 통과. 실제 Connector 프로세스 초기 연결을 포함하며 터미널 생성·입출력은 포함하지 않는다. `bootJar`, E2E 타입 검사와 포맷 검사를 통과했다. 로그는 `artifacts/migration-baseline/p3f-host/`에 보관한다.

## P3g — Terminal inventory와 출력 복구 — 2026-09-21

기존 PTY의 runtime 일치·누락·충돌·소유 host를 조정하고 `host-ready`에 서버가 수신/acknowledge한
source sequence를 보낸다. 참여자 출력은 별도의 연속 sequence로 중계한다. 늦은 입장과
`resync-output-request`에는 보관된 출력 뒤 `sync`를 보낸다. 큰 terminalId의 초기 좌표가 protocol
범위를 벗어나던 문제는 Node와 Java 모두 수정했다.

- `TerminalWorkspace`: 터미널 상태와 inventory 조정. `TerminalOutput`: 출력 보관·중복 제거·수신자별 gap.
- `RoomSessions`: 같은 방 monitor에서 identity/역할/소유권과 변경·알림 순서를 조정한다. binary는 JSON
  명령 경로를 거치지 않지만 짧은 방 잠금은 사용한다. 소켓 I/O는 여전히 별도 writer가 실행한다.
- 보관 한도: terminal당 payload 1MiB 및 16,384 frame. 전송 큐는 control/binary를 합쳐 1MiB·256개다.
  live output은 큐가 찼을 때 수신자별로 drop하고, 재개 시 `sync → output-gap → output`을 함께
  수락시킨다. 이 단계의 replay 큐 초과 문제는 아래 P3h에서 보강했다. sync는 전달 완료 확인이 아니다.

현재 공통 범위 실행(JAR 빌드 후 앞의 `TTYROOM_E2E_SERVER_COMMAND` 설정 사용):

```sh
pnpm --filter @ttyroom/e2e test:e2e src/http-api.e2e.ts src/admission.e2e.ts src/host-session.e2e.ts src/terminal-recovery.e2e.ts src/terminal-creation.e2e.ts src/terminal-metadata.e2e.ts src/protocol-fixture.e2e.ts src/terminal-input.e2e.ts
```

계약, 리뷰 중 재현한 결함, Node와 다른 용량/실패 정책 및 검증 결과는
[Terminal 복구 계약](../docs/2026-09-21-terminal-recovery-contract.md)에 기록한다.
로그: `artifacts/migration-baseline/p3g-recovery/`. 새 복구 계약은 프로토콜 peer와 실제 서버를 연결한다.
실제 셸 실행·서버 재시작·DB 복구를 Java에서 검증한 결과는 아니다.

최종 검증: Java 63개, 실제 Spring JAR 공통 계약 64개, Node 서버 단위 210개, Node 전체 프로세스
E2E 89개 통과. Java/Node 빌드, 타입·의존성·포맷 검사도 통과했다.

## P3h — 대량 replay 송신 — 2026-09-21

일반 송신 큐보다 많은 보관 프레임을 late join/resync할 때 연결이 종료되던 문제를 수정했다.
replay는 스냅샷과 마지막 sync를 한 번에 예약하고, 연결별 writer가 한 프레임씩 encode·송신한다.
방 잠금에서 송신 완료나 큐 여유를 기다리지 않는다. 이전 메시지 → replay → sync → 이후 메시지 순서다.

예약 상한은 연결별 **4MiB(출력 header와 sync 포함)·65,536 frames·16 requests**이며 전송 중인 예약도
계산한다. 일반 live/control 큐의 1MiB·256개, 개별 쓰기 5초 deadline, live output drop/gap 정책은 유지한다.
예약 상한 초과는 해당 연결 종료(1008), 쓰기 timeout은 종료(1011)로 처리한다. 마지막 sync의 쓰기가 끝나야
예약 용량을 반환한다. 메모리 전체 상한이나 무제한 다중 터미널 replay를 보장하지 않는다.

[재현·설계·검증과 남은 한계](../docs/2026-09-21-bounded-replay.md)를 참고한다.

P3h 검증: Java 73개, 실제 Spring JAR 공통 계약 65개, Node 복구 계약 10개 통과.
JAR 빌드·타입·의존성·포맷 검사 통과. 로그는 `artifacts/migration-baseline/p3h-replay/`에 보관한다.

## P3i — 터미널 생성과 ID 발급 — 2026-09-21

`open-terminal-request`는 같은 방의 연결된 host에 기본 80×24 생성 명령을 보낸다. 먼저 ID와 open 상태를
예약하며 `terminal-opened` 확인 후 참여자에게 알린다. 확인 전 재접속 inventory는 예약에 runtime을 연결한다.
`terminal-closed`는 생성 실패·Kill Switch 거절·실제 종료를 반영하고, 중복 보고와 늦은 확인은 무시한다.

ID는 방 단위로 발급하고 복구된 ID 이후로 전진한다. uint32 마지막 ID까지 발급하며 소진 뒤에는 상태를
변경하지 않고 `bad-message`로 거절한다. 기존 Node의 overflow 연결 종료 문제도 같은 계약으로 수정했다.

`ParticipantCommand`로 생성/resync를 묶었으며 `HostCommand`와 역할별 경계를 유지한다.
세 프로토콜 테스트의 서버·소켓 fixture를 `protocol-fixture.ts`로 합쳤다.
[계약·리뷰·검증 범위](../docs/2026-09-21-terminal-creation-contract.md)를 참고한다.

이번 생성 테스트는 protocol peer와 실제 서버를 연결한다. 실제 Connector의 셸 생성/지속 연결 전체를
검증한 결과는 아니다. 이 단계에 미지원이던 `terminal-meta` 보고와 실제 Connector 검증은 아래 P3j에서 추가했다.

P3i 검증: Java 87개, 실제 Spring JAR 공통 계약 81개, Node 서버 단위 211개,
Node 전체 프로세스 E2E 106개 통과. 빌드·타입·의존성·포맷 검사 통과.
로그는 `artifacts/migration-baseline/p3i-creation/`에 보관한다.

## P3j — 메타데이터와 실제 Connector 생성 — 2026-09-21

`terminal-meta`는 같은 방의 현재 host 세션과 terminal 소유권을 확인한 뒤 변경된 값만 알린다.
세 필드의 null/빈 문자열을 보존하고 같은 값의 중복 보고는 생략한다. 기존 Node처럼 종료된 terminal의
늦은 보고도 수락하되 runtime·종료 상태·exitCode는 변경하지 않는다. 새 입장자도 최신 값을 받는다.

실제 Connector가 PTY를 열고 작업 경로를 보고한 뒤 두 번째 PTY를 여는 흐름을 Node와 Spring에서
검증했다. 최초 보고 이후 연결 사용 가능성을 확인한 것이며 장시간 연결·셸 명령 입력·전체 협업 검증은 아니다.
입력 권한/전달과 참여자의 close/resize, 영속 저장·재시작 복구는 남아 있다.

[메타데이터 계약·리뷰·검증](../docs/2026-09-21-terminal-metadata-contract.md)을 참고한다.
로그는 `artifacts/migration-baseline/p3j-metadata/`에 보관한다.

P3j 검증: Java 91개, 실제 Spring JAR 공통 계약 95개, Node 전체 프로세스 E2E 120개 통과.
JAR 빌드·E2E 타입·의존성·포맷 검사도 통과했다.

### P3j 후속 리뷰

생성 확인·종료·메타데이터의 소유권 검사를 `TerminalWorkspace` 내부 한 곳으로 모으고,
`TerminalNotOwned`의 오류 응답 변환은 host 명령 진입 경계에서 처리한다. 오류 응답을 보낼 수 없으면
해당 host만 정리하고, 예상하지 못한 프로그래밍 오류는 전파하는 기존 의미를 보존한다.
네 공통 계약 파일의 초기 inventory 준비도 `protocolWorkspaceFixture`로 모았다.
대기 helper의 반복 호출 timeout과 다른 host 알림 오인은 재현 후 수정했다.
검증 근거는 [메타데이터 후속 리뷰](../docs/2026-09-21-terminal-metadata-contract.md#후속-리뷰와-리팩터링)에 기록한다.

후속 검증: Java 95개, Spring 공통 계약 97개, Node 전체 프로세스 E2E 122개 및 빌드·타입·의존성·포맷 검사 통과.

## P3k — Exclusive 입력 권한·전달 — 2026-09-21

lease 획득·반납, 참여자당 한 lease, 같은 보유자의 재획득, 다른 참여자에 대한 거절을 구현했다.
현재 세션·열린 terminal·host 연결·입력 허용 보고·lease를 확인한 뒤 binary input을 그대로 전달한다.
Kill Switch는 lease를 유지하며 입력만 막는다. 참여자 유예 만료는 lease를 해제하고 host 만료는
terminal과 lease를 함께 제거한다. 이전 연결의 늦은 입력은 새 세션에 영향을 주지 않는다.

실제 Connector에서 입력 echo와 구분되는 셸 실행 결과를 두 참여자가 받는 흐름까지 검증한다.
송신 큐 실패 시 host만 정리하며 명령을 자동 재전송하지 않는다. shared 모드·close/resize·영속 저장은 후속이다.
[계약·설계 리뷰·검증 경계](../docs/2026-09-21-exclusive-input-contract.md)를 참고한다.

P3k 검증: Java 118개, 실제 Spring JAR 공통 계약 111개, Node 전체 프로세스 E2E 136개 통과.
JAR 빌드·E2E 타입·의존성·포맷 검사 통과. 로그는 `artifacts/migration-baseline/p3k-input/`에 보관한다.
