# Spring 이식에서 유지할 설계 기준

기존 Node 구현의 파일·클래스 수가 아니라 **불변식, 책임 소유자, 실패 의미와 검증 방식**을 이어간다.
기준은 [기존 리팩터링 로드맵](../docs/2026-08-14-backend-refactoring-roadmap.md)이며, 아래 내용은
2026-09-24 현재 소스와 Spring 구현을 비교해 정리했다. 아직 이식하지 않은 기능을 완료로 취급하지 않는다.

## 기존 코드와 연결되는 기준

| 유지할 가치                                      | Node 근거                                                     | Spring 적용 및 다음 변경의 조건                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 한 방의 제어 상태 변경은 한 경계에서 직렬화      | `legacy/node-server/src/usecases/room-registry.ts`의 `change` | 입장·제어·만료는 방별 명령 lock으로 직렬화한다. Presence monitor는 상태 접근/확정에만 사용하며 저장 대기 중 해제한다. 단절·binary·cursor는 짧은 상태 잠금으로 처리한다.                        |
| 저장 성공 → 메모리 확정 → 외부 알림              | 같은 파일의 staged change와 repository save                   | RoomStore 대역으로 save → commit → effects, 실패 비노출과 live-only 저장 생략을 검증했다. SQLite adapter의 파일 재열기는 구현했다. 환경변수로 SQLite를 선택하고 새 프로세스 복구까지 검증한다. |
| 상태와 업무 결과가 wire DTO를 모르게 함          | `usecases/room-protocol.ts`, `room-event-publisher.ts`        | `RoomSessions`는 불변 `RoomNotice`를 발행하고 WS의 `RoomProtocol`이 envelope와 필드명을 만든다. application에 Spring/Jackson/JSON DTO를 넣지 않는다.                                           |
| 역할별 명령과 데이터 경로를 분리                 | `usecases/control-plane.ts`, `server-core.ts`                 | 연결에 결합된 Session, Role enum과 sealed HostCommand를 분기한다. binary relay는 JSON command 경로를 거치지 않으며 향후 저장 큐에도 넣지 않는다.                                               |
| 포트가 실제 실패·교체 경계를 숨김                | `ports/transport.ts`, `room-repository.ts`, `clock.ts`        | `Peer`가 송신 수락·연결 실패 의미를 소유하고 `SocketSender`가 큐·deadline·I/O를 숨긴다. 함수마다 인터페이스나 pass-through service를 만들지 않는다.                                            |
| 수락·전달·저장·재전송은 서로 다른 보장           | output replay와 transport 계약                                | source/browser seq를 분리하고 중복을 제거한다. live 출력의 backpressure는 수신자별 gap, replay 수락 실패는 종료/유예로 처리한다. 큐 수락·sync는 전달 확인이 아니다.                            |
| 진단이 사용자 동작을 깨거나 비밀을 노출하지 않음 | `usecases/operational-diagnostics.ts` 및 테스트               | structured diagnostics는 아직 미이식. 도입 시 sink 실패 격리, token·PTY payload 제외를 함께 검증한다.                                                                                          |
| 테스트가 사용자 의도와 결과를 드러냄             | `e2e/src/fixtures.ts`, `actions.ts`, `assertions.ts`          | fixture는 준비/자원 정리, action은 행동/완료 대기, assert는 결과 검증을 담당한다. 테스트 간 상태 의존은 두지 않으며 준비 단계의 기능 검증을 매번 반복하지 않는다.                              |

위 Node 경로의 `usecases/`, `ports/`는 모두 `legacy/node-server/src/` 아래다.

## 리뷰와 리팩터링 순서

테스트 작성과 변경에는 [테스트 컨벤션](TESTING.md)을 적용한다. 기능 변경의 RED→GREEN과
동작 보존 리팩터링의 GREEN 유지를 구분해 기록하고 fixture·행동·검증의 책임을 유지한다.

1. 이식할 Node 기능의 구현과 테스트를 읽고 입력·역할·상태 변경·부수효과·실패 결과를 정리한다.
2. 공통 프로세스 계약으로 기존 행동을 고정한다. 새 버그 수정은 먼저 실패를 재현한다.
3. 다음 기능을 방해하는 책임 혼합만 먼저 리팩터링한다. 이 단계에서는 wire 의미나 정책을 바꾸지 않는다.
4. 기능을 작은 단위로 구현하고 실패·재접속·경합을 검증한다. 동시성 테스트는 latch/수동 실행으로 조건을 만들고 대기는 제한한다.
5. 변경 결과를 기존 코드의 기준과 다시 비교한다. 새 클래스가 어떤 복잡성을 숨기는지, 상태·실패 지식이 중복됐는지 확인한다.
6. 관련 Java 테스트와 실제 JAR의 공통 계약을 실행하고 검증 범위·남은 차이를 기록한다.

타입에 따라 처리하는 곳은 가능한 경우 exhaustive switch를 사용한다. 새 결과가 추가됐는데 변환이
빠진 경우 조용히 무시하거나 문자열 분기로 흘려보내지 않는다. 도메인/업무 테스트가 wire 필드명에
의존하지 않도록 하고, wire 검증은 adapter와 공통 계약에서 수행한다.

## 이번 리뷰와 변경

- **확인한 마찰:** `RoomAdmission`이 입장/만료 정책과 `Map<String, Object>` wire envelope를 함께
  조립했다. 단위 테스트도 중첩 Map을 캐스팅해야 해서 상태 결과와 직렬화 계약을 동시에 알아야 했다.
- **변경:** `AdmissionNotice`의 sealed 결과 타입과 `AdmissionProtocol`의 exhaustive 변환으로 분리했다.
  Welcome은 참여자/host 목록을 복사해 이후 상태 변경이 이미 만든 snapshot을 바꾸지 못하게 한다.
- **그대로 유지:** 방 monitor, welcome 수락 뒤 이전 연결 교체·알림 순서, 실패 rollback, 만료 작업 취소,
  비동기 정리 콜백, 송신 큐 정책. persistence나 새 host 기능을 이 구조 변경에 섞지 않았다.
- **검증 경계:** Java 단위 테스트는 결과 타입을 검증한다. adapter의 6개 결과는 기존
  `protocol/fixtures/wire-v7.json`의 기대 JSON과 비교한다. Gradle이 이 파일을 테스트 리소스로 복사하므로
  기존 Java CI에서도 실행되며 pnpm 실행은 필요 없다. 실제 HTTP/WS 연결 계약은 별도 E2E로 확인한다.

## Terminal 복구 후 재리뷰

[Terminal 복구 계약](../docs/2026-09-21-terminal-recovery-contract.md)에 P3g의 행동·실패·검증 경계를 기록했다.
TerminalWorkspace는 runtime 대조·소유권·종료 상태를 숨기고 TerminalOutput은 seq·보관 한도·gap을 소유한다.
RoomSessions에는 업무 규칙을 복제하지 않고 인증된 세션과 결과 전달 순서를 둔다. 방 상태의 잠금 소유자는 하나다.
RoomNotice는 불변 결과를 전달하고 RoomProtocol/OutputWire가 wire 표현을 만든다.
[대량 replay 보강](../docs/2026-09-21-bounded-replay.md)에서는 Peer에 스냅샷 예약 계약을 두고
SocketSender가 용량·FIFO·지연 인코딩·정리를 소유한다. application에 큐 여유 polling이나 전송 스케줄러를
추가하지 않는다. 동일 소켓의 후속 제어 메시지는 예약된 replay 뒤에 전송되므로 지연될 수 있다.

[생성·ID 발급 계약](../docs/2026-09-21-terminal-creation-contract.md)은 TerminalWorkspace가 ID와 runtime을
소유하고 ParticipantCommand/HostCommand가 요청과 보고를 분리한다. 확인 전 예약과 host 송신 실패 후
불확실한 생성도 inventory로 조정하며, ID를 즉시 재사용하지 않는다. 한 방의 생성 요청은 같은 monitor를 통과한다.

[메타데이터 계약](../docs/2026-09-21-terminal-metadata-contract.md)은 같은 TerminalWorkspace가
값 비교와 소유권을 판단하며 runtime·종료 상태를 보존한다. 생성 확인·종료·메타데이터가 같은 내부
소유권 검사를 사용하고, Session의 host 명령 진입 경계가 업무 거절을 오류 응답으로 바꾼다.
오류 응답 중의 PeerUnavailable은 해당 연결만 정리하며 예상하지 못한 예외를 숨기지 않는다.
별도 저장소나 잠금을 추가하지 않는다.
실제 Connector의 첫 메타데이터 보고 후 두 번째 PTY 생성까지 검증했다.

[Exclusive 입력 계약](../docs/2026-09-21-exclusive-input-contract.md)은 LeaseControl이 lease와 ID 수명을,
RoomControl이 terminal 상태·host 연결/허용·lease의 교차 규칙을 소유한다. RoomSessions는 현재 세션과
연결 사실, 효과 순서를 맡는다. 새 잠금/저장 큐 없이 같은 방 monitor에서 판단하고, binary input은
JSON 명령 경로를 거치지 않는다. 입력 seq는 중복 제거용이 아니다.
전송 실패 시 host만 정리하며 불확실한 명령을 재전송하지 않는다.

[RoomControl 추출](../docs/2026-09-22-room-control-refactoring.md)에서는 workspace와 leases를 같은 모델
내부에 감췄다. 획득 선행조건, 입력 거절 우선순위, host 제거 시 terminal/lease 동시 정리를 호출자가
조합하지 않는다. 연결 정보는 현재 Member에서 만든 일시적인 InputHost 값으로 전달하며 저장하지 않는다.
멤버 인증·세션 교체·잠금·타이머·출력 history·전송 실패는 계속 RoomSessions/TerminalOutput의 책임이다.

[Terminal 생명주기 명시화](../docs/2026-09-22-terminal-lifecycle-refactoring.md)에서는
TerminalWorkspace 내부 Pending/Running/Exited가 runtime과 종료 결과를 소유한다. 외부 Terminal은
불변 view이며 Pending도 기존 OPEN으로 투영한다. 생성 확인 이력은 runtime 연결/복구와 별개다.

[Shared 모드 계약](../docs/2026-09-22-shared-mode-contract.md)은 RoomControl이 모드 전환의 대상/연결
선행조건과 입력 정책을 함께 소유한다. 모드 전환은 lease를 바꾸지 않으며 shared도 host 연결·Kill Switch를
검사한다. exclusive 복귀는 그 시점에 남은 lease를 사용한다. 변경/무변경/거절 결과와 wire 변환은 분리한다.

[종료·resize 계약](../docs/2026-09-22-terminal-control-contract.md)은 mode/close/resize의 대상 검사를
RoomControl.terminalRequestRejection으로 모은다. close·resize는 제어권·입력 허용과 독립이며
소유 host로 전달한다. 종료 확정은 host 보고가 담당하고 resize는 창 geometry를 바꾸지 않는다.
전송 실패는 해당 host만 격리하고 상태/lease를 유지하며 재시도하지 않는다.

[제목·창 배치 계약](../docs/2026-09-22-terminal-view-contract.md)은 TerminalWorkspace가 값 변경을
소유하고 RoomControl이 workspace를 노출하지 않는 동작 경계를 유지한다. 두 명령은 terminal 존재만
요구하며 PTY 제어의 OPEN/host 연결 조건과 다르다. 동일 제목은 무응답, 동일 geometry는 재알림한다.
Unicode 제목 정규화·수치 범위·geometry 직렬화는 adapter 책임이며 runtime·lease는 바뀌지 않는다.

[참여자 focus·cursor 계약](../docs/2026-09-22-participant-presence-contract.md)에서는
RoomSessions.Member가 참여자 수명과 같은 focus 상태의 단일 원본을 소유한다. 교체 Welcome 전에
이전 값을 복사하며 실패 rollback과 만료는 기존 member 경계를 따른다. cursor는 저장하지 않고
현재 연결된 다른 참여자에게만 전달한다. 입력 정책이나 terminal 생명주기에 두 상태를 섞지 않는다.

[Java 계층 자동 검증](../docs/2026-09-22-java-architecture-tests.md)은 `ArchitectureTests`에서 실행한다.
`./gradlew test`와 기존 Java CI에 포함되며 domain은 domain/java, application은 application/domain/java만
의존하도록 검사한다. adapter 간 직접 의존과 진입점 역참조를 막고, 미분류 패키지도 실패 처리한다.
검사는 production 바이트코드에만 적용한다. 새 허용 의존성은 blanket 예외로 우회하지 않고 책임 경계와
함께 검토한다. 직렬화·rollback·전송 실패 같은 실행 의미는 기존 행동 테스트로 계속 검증한다.

영속성 도입 전에는 방·terminal 상태를 서버 재시작 후 복원한다고 주장하지 않는다. 저장 구현 시
save → commit → effects 순서를 보존하되 고빈도 출력은 저장 작업 큐에서 제외한다. 현재 구조가
입력 exactly-once, durable replay, 분산 lease 또는 무제한 replay 처리를 보장하는 것은 아니다.

## 영속 저장 이식의 다음 경계

[영속 저장 계약](../docs/2026-09-22-persistence-contract.md)에 Node 기준의 저장/복원 항목과
실패 순서, Spring의 책임 이동 및 단계별 인수 조건을 정리했다. 이번에는 Node 테스트와 재시작 계약을
고정했고, 후속 P4d에서 Spring의 실제 프로세스 재시작 계약도 지원한다.

[내구 상태 모델과 복원](../docs/2026-09-24-durable-room-model.md)에서는 RoomDirectory가 방의 초대 정보와
RoomControl을 함께 소유하고, Presence가 이 모델을 참조하도록 연결했다. host ID·이름과 terminal
lifecycle/runtime/다음 ID를 불변 값으로 복원하며 연결·lease·focus·출력 상태는 초기화한다.
소켓 없는 복원을 Java에서 검증한 단계로, 디스크 저장이나 부팅 DB 로딩을 구현한 것은 아니다.
이어지는 저장 조정 단계에서는 디스크 I/O를 Presence monitor 안에 넣지 않으며, 재시작용 restore를
live lease까지 보존해야 하는 draft 복제에 사용하지 않는다.

[저장 조정 경계](../docs/2026-09-24-save-boundary.md)는 RoomControl의 독립 draft, RoomDirectory의
방별 순서/저장소 수명, RoomSessions의 짧은 상태 잠금과 확정 후 효과를 연결한다.
ControlInbox는 수신 콜백 밖에서 제어 FIFO를 실행하고 ExpiryTimers는 저장 대기와 만료 시각 전달을
분리한다. 저장/삭제 실패·세션 교체·단절·만료·종료 drain은 대역 저장소로 검증했다.
[만료 예약 계약](../docs/2026-09-28-expiry-scheduling.md)은 실행기 상속을 내부 합성으로 바꾸고
예약·취소·종료만 제공한다. 취소 핸들은 완료 Future가 아니며, 이미 전달된 콜백은 Member 검사로
방어한다. 종료는 전달 실행기를 먼저 닫은 뒤 worker를 기다린다.
[방 변경 경계 정리](../docs/2026-09-27-room-change-boundary.md)에서는 입장·명령·만료가 반복하던
draft/save/commit을 `RoomDirectory.RoomOperation.changeIf`로 모았다. 상태 monitor는 Directory의
Room이 소유하며 실시간 세션 경로도 같은 monitor를 사용한다. 호출자는 적용 조건·업무 변경·확정 후
동작을 전달한다. 만료 후 마지막 방 삭제는 같은 작업 범위 안에서 별도로 확정한다.
[명령 결과 분리](../docs/2026-09-27-command-results.md)에서는 저장 대상 명령이 `Runnable` 대신
다섯 종류의 `ChangeResult`를 반환하고 commit 이후 exhaustive switch로 전달한다. lease·focus·입력
허용 등 live 명령은 같은 방 명령 범위의 `runIf`에서 즉시 처리한다. live 명령도 앞선 저장을 기다리지만
draft 복제를 하지 않는다. 데이터 경로는 계속 짧은 상태 monitor만 사용한다.

[Host 식별 불변식](../docs/2026-09-27-host-identity-invariant.md)은 `RoomControl`이 terminal 생성과
inventory 전에 host 등록을 보장하도록 한다. `DurableState`는 모든 생명주기의 terminal이 등록된
host를 참조하는지 검증한다. 등록 여부와 online 연결 여부는 서로 다른 책임이다.

[SQLite 저장 첫 단계](../docs/2026-09-28-sqlite-store.md)는 `SqliteRoomStore`가 JDBC 수명을,
`StoredRoomJson`이 Node v1 저장 표현을 소유하도록 한다. 실제 파일의 저장·재열기·교체 실패·삭제를
검증했다. 후속 [SQLite 부팅 연결](../docs/2026-09-28-sqlite-startup.md)은 composition root에서
저장소를 선택한다. RoomDirectory가 복원과 저장소 수명을 계속 소유하며 새 서비스 계층은 추가하지 않는다.

[설정 적용](../docs/2026-09-28-server-settings.md)은 ServerSettings가 외부 파일·환경변수·검증을
소유하고 composition root가 RoomSessions.Policy와 RoomSocketHandler.Limits로 조립한다.
application은 Spring Environment나 파일 JSON을 모르며 설정 adapter도 다른 adapter를 참조하지 않는다.
새 설정 서비스나 런타임 전역 locator는 두지 않는다. WS handler의 생성·종료도 composition root로 모았다.

[정적 웹과 브라우저 인수](../docs/2026-09-28-spring-browser-e2e.md)는 HTTP adapter가 패키지 리소스·캐시·보안
헤더를 소유한다. 도메인·업무 계층은 React를 모르며 브라우저 fixture도 서버 내부 구현을 import하지 않는다.
