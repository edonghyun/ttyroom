# 영속 저장 경계와 이식 인수 계약 — P3s

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-22. 이번 단계는 **Node의 저장 계약을 테스트로 고정하고 Spring의 변경 경계를 결정**한다.
Spring의 저장 구현을 완료한 단계가 아니다. Node 기준 재시작 계약은 통과하고 현재 Spring JAR에서는
재시작 후 방이 사라져 같은 계약이 실패한다. 이 실패는 남은 기능을 드러내는 인수 조건이다.

## 저장되는 것과 복원되는 것

근거는 Node의 `domain/room.ts`, `domain/terminal-workspace.ts`,
`usecases/room-registry.ts`, `adapters/sqlite/stored-room-record.ts`다.

| 상태                                                 | 저장 | 복원 의미                                                           |
| ---------------------------------------------------- | ---- | ------------------------------------------------------------------- |
| 방 ID·이름·token SHA-256 digest                      | O    | 같은 초대 링크로 입장 가능. token 원문은 저장하지 않음              |
| nextTerminalId                                       | O    | 삭제·재시작 후 과거 ID를 재사용하지 않음. u32 소진 상태도 보존      |
| host ID·이름                                         | O    | 소켓 없이 목록 복원, online=false·remoteInputAllowed=false          |
| terminal 제목·geometry·mode·status·exitCode·metadata | O    | snapshot 값 보존. OPEN은 실행 중이라는 확인이 아니라 기존 view 상태 |
| terminal runtimeId                                   | O    | 이후 Connector inventory와 대조. 불일치하면 종료/close 지시         |
| 생성 확인 전 예약                                    | O    | runtimeId=null, OPEN view와 발급한 ID 보존                          |
| 참여자 이름·focus·lease·lease ID 발급 상태           | X    | 재시작 시 초기화. 참여자 재접속 유예와 서버 재시작은 서로 다른 계약 |
| host 연결·입력 허용·만료 타이머·소켓                 | X    | 현재 연결이 보고한 사실로 다시 구성                                 |
| cursor·출력 history·source/browser seq               | X    | 재생하지 않음. 출력 복구는 살아 있는 Connector의 replay buffer 책임 |

현재 Node의 SQLite는 `rooms(room_id PRIMARY KEY, record_json)`에 schemaVersion=1 레코드를 저장한다.
저장 JSON 검증은 wire protocol schema와 분리되어 있다. 이전 레코드의 geometry 누락은 기존 기본값으로
읽지만, 다른 필수 필드/버전/JSON 오류를 빈 방으로 대체하지 않는다. Node는 loadAll/restore 실패 시
부팅을 실패시키고 저장소를 닫는다. 이 파일 호환성을 Spring adapter의 인수 조건으로 삼는다.

## 변경을 확정하는 순서

```text
같은 방의 제어 명령
  → 확정된 상태로 draft 생성·규칙 판단
  → 내구 레코드가 달라졌을 때만 save
  → 저장 성공 후 메모리 상태 확정
  → 결과/room-event/Connector 명령 전달
```

- create는 저장 성공 전 registry 조회·초대 응답으로 노출하지 않는다.
- save 대기 중 snapshot은 이전 확정 상태를 보여준다. 실패하면 draft와 그 결과 알림을 버리고
  기존 상태·ID 발급 위치·lease를 유지한다. 원래 오류를 성공 응답으로 바꾸지 않는다.
- 같은 방의 live-only 제어 명령도 같은 순서를 통과한다. 실패한 명령 뒤에도 큐가 계속 진행되어야 한다.
  다른 방의 명령을 한 방의 저장 대기 때문에 막지 않는다.
- focus·lease·입력 허용 등 live-only 변경이나 동일한 durable 값은 save를 만들지 않는다.
  동일 geometry는 저장 없이 이벤트를 보낼 수 있다. 이벤트 발생과 저장 발생은 같은 조건이 아니다.
- cursor와 바이너리 입출력은 저장 큐로 보내지 않는다. 입력은 그 시점의 확정된 상태로 권한을 검사한다.
- 삭제는 저장소 delete 성공 후 방을 제거한다. 실패하면 방/초대를 보존한다. host 제거의 terminal/lease
  정리도 해당 변경의 저장 성공 후 함께 반영하며, 만료 작업 오류를 관찰 가능하게 처리한다.
  participant 만료는 먼저 live presence/lease를 제거하고 알린 뒤 빈 방을 delete한다. 이 마지막 delete가
  실패해도 이미 처리한 participant 만료를 되돌리지 않는다. host 제거 save와 빈 방 delete도 별도 단계이며,
  전체 만료를 하나의 DB 트랜잭션으로 처리한다고 주장하지 않는다.
- 종료는 이미 접수한 저장/만료 작업을 정리한 뒤 저장소를 닫는다. 저장 응답 손실 후 자동 재시도나
  input exactly-once·분산 트랜잭션까지 보장하는 계약은 아니다.

## 현재 Spring에서 먼저 해결할 구조

| 현재 책임                                   | 영속성을 붙일 때의 문제                                             | 결정한 변경 경계                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| RoomDirectory의 초대 맵                     | RoomControl과 별도로 저장하면 방과 terminal 저장 순서가 갈라짐      | 방별 내구 상태를 하나의 저장 단위로 소유하고 초대 인증도 같은 확정 상태를 참조                                  |
| RoomSessions.Presence가 새 RoomControl 생성 | 복원된 terminal 상태가 입장 시 새 모델로 덮일 수 있음               | 복원한 방 모델을 세션 상태가 참조하도록 연결                                                                    |
| host 이름·ID가 소켓을 가진 Member에만 존재  | offline host 복원에 가짜 소켓/Peer가 필요해짐                       | host 식별 정보는 내구 모델에, 연결·입력 허용·타이머는 세션에 유지                                               |
| RoomControl/TerminalWorkspace의 즉시 변경   | 저장 실패 후 전역 rollback을 하면 동시에 바뀐 live 상태를 덮을 위험 | 독립 draft와 확정 연산을 모델 안에 숨기고 호출자가 상태 복사를 조합하지 않게 함                                 |
| Presence monitor 안의 변경·enqueue          | 그 안에서 디스크 I/O를 기다리면 출력/다른 소켓 처리까지 멈춤        | 방별 제어 순서는 직렬화하되 저장 대기는 monitor 밖에서 수행, 짧은 잠금으로 확정 상태 조회/반영                  |
| 만료에서 member를 먼저 제거                 | delete 실패 후 복구할 방/host 문맥을 잃음                           | host 내구 변경/방 삭제 각각의 저장 성공 전에 해당 상태를 제거하지 않도록 재정렬; 완료된 participant 만료는 별개 |

연결 단절 사실은 즉시 반영해 오래된 소켓의 입력을 차단해야 한다. 비동기 저장이 끝난 뒤에는
후속 소켓 효과의 대상 세션이 아직 유효한지도 다시 확인한다. 이미 저장한 결과를 이전 연결의 단절만으로
메모리에서 버려 DB와 어긋나게 하지 않는다. 내구 draft를 확정하면서 Member·타이머·출력
이력을 통째로 이전 값으로 덮지 않는다. 이 경합은 Java의 latch/수동 스케줄러 테스트로 고정할 대상이다.

위 표는 **구현 결정이며 아직 구현된 타입/API가 아니다**. 저장소 인터페이스는 application에,
SQLite·JSON·schemaVersion 처리는 adapter에 둔다. domain/application에 JDBC/Jackson/Spring을
들이지 않으며 기존 ArchitectureTests를 유지한다. DB 트랜잭션 annotation만으로 메모리·소켓 효과까지
원자적으로 바뀐다고 가정하지 않는다. 현재 사용하지 않는 Repository/UnitOfWork 계층을 미리 추가하지 않는다.

## 단계별 완료 조건

1. **내구 상태 모델:** 불변 저장 투영과 restore를 추가한다. token digest, host 식별 정보, terminal
   lifecycle/runtime/next ID를 복원하고 live 상태를 초기화하는 Java 테스트를 먼저 만든다.
2. **저장 조정 경계:** 방 생성/변경/삭제의 draft → save → commit → effects를 도입한다. 저장 대기·실패,
   같은 방 순서, 다른 방 진행, 세션 교체/단절/만료 경합과 종료 drain을 대역 저장소로 검증한다.
3. **SQLite adapter와 부팅:** 기존 schemaVersion=1 호환, TTYROOM_STATE_PATH, load 실패, atomic replace,
   delete, close를 실제 파일로 검증한다. 같은 저장 파일에 Node/Java를 동시에 실행하지 않는다.
4. **프로세스 인수:** 신규 persistence.e2e.ts와 기존 resilience의 살아 있는 PTY 복구 계약을 Spring에서
   통과시킨다. 저장 레코드 복원과 Connector가 가진 PTY/출력 복구를 별개로 검증한다.

2026-09-24 후속: 1번은 [내구 상태 모델과 복원](2026-09-24-durable-room-model.md)으로 구현했다.
2번은 [저장 조정 경계](2026-09-24-save-boundary.md)로 구현했다. 다음 작업 단위는 3번이다. 초대만 먼저 저장해 전체 workspace 복원처럼 보이게 하거나, 파일 저장을
현재 모든 mutation 뒤에 덧붙이는 방식으로 중간 계약을 만들지 않는다.

## 이번에 고정한 실행 가능한 계약

- `legacy/node-server/src/usecases/persistence-contract.spec.ts`: 저장 성공/실패 시 상태·알림 비노출,
  live-only·동일 값·cursor·출력의 저장 없음, 생성 실패 시 비노출, 실패 후 같은 방의 다음 명령 진행과 다른 방 독립성 — **5개**.
  대기 중의 관찰값을 복사하고 gate를 해제한 뒤 assert한다. 시간 기반 sleep이나 테스트 간 상태 공유가 없다.
- 기존 `room-registry.spec.ts`, `open-terminal.spec.ts`, `handle-disconnect.spec.ts`의 create/save/delete
  실패, 생성 지시 전 저장, 만료 실패/종료 drain 계약은 함께 실행했다. 만료 후 delete 실패 테스트는
  방 보존뿐 아니라 이미 확정한 참여자/lease 제거를 되돌리지 않는다는 검증도 추가했다.
- `e2e/src/persistence.e2e.ts`: 새 PID에서 초대/workspace 복원 및 live 상태 초기화, 저장 runtime 일치/충돌,
  생성 확인 전 예약/다음 ID 보존 — **4개**. raw host는 자동 재접속하지 않아 서버 저장과 Connector 복구를 분리한다.
- Node 단위 **216개**, 통합 **20개** 통과. 신규 실제 재시작 계약 **4개** 통과.
- Spring JAR에서 재시작 전 준비는 완료했지만 재시작 후 Welcome 대신 오류가 와 실패했다. 저장 기능은
  여전히 미구현이다. 신규 계약을 skip/예상 실패로 숨기지 않았으며 지원 완료 Spring 목록에는 추가하지 않는다.
- Node 전체 E2E **197개 / 16개 파일 통과**, server/E2E 타입 검사와 의존성 검사 통과.

근거: `artifacts/migration-baseline/p3s-persistence-contract/`의 ordering.log, node-restart.log,
node-unit.log, node-integration.log, node-full.log, java-red.log, server-types.log, e2e-types.log.
Java 제품 코드와 JAR는 이번 단계에서 수정하지 않았다. Java 217개 등 이전 단계 결과를 이번 실행 결과로
다시 계산하지 않는다. 실제 디스크 장애/강제 전원 차단/다중 서버 운영 검증까지 수행한 것은 아니다.

2026-09-28 후속: 3번의 [SQLite adapter와 파일 재열기](2026-09-28-sqlite-store.md)를 구현했다.
부팅 시 `TTYROOM_STATE_PATH` 선택과 load 실패 처리의 실행 연결, 4번 새 프로세스 인수는 아직 남았다.

2026-09-28 P4d: [부팅 연결과 새 프로세스 인수](2026-09-28-sqlite-startup.md)를 완료했다.
환경변수 선택, 시작 실패, 실제 Connector PTY 유지 검증을 포함한다. 앞선 단계의 결과와 구분한다.
