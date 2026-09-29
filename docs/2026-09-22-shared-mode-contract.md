# Shared 모드 전환·입력 계약 — P3n

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-22. [RoomControl 추출](2026-09-22-room-control-refactoring.md)과
[terminal 생명주기 정리](2026-09-22-terminal-lifecycle-refactoring.md) 위에 Node의 모드 전환을 이식했다.
공개 v7의 기존 set-terminal-mode와 terminal-mode-changed를 사용하며 새 프로토콜을 만들지 않았다.

## 기존 Node와 맞춘 동작

| 조건                                                      | 결과                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| 현재 참여자가 열린 terminal의 mode 변경                   | 해당 방 참여자 모두에게 mode-changed, welcome에도 반영                  |
| 참여자가 해당 lease를 소유하지 않음                       | 모드 변경 가능. 소유자/관리자 전용 권한을 추가하지 않음                 |
| 동일 mode 재요청                                          | 상태 변경·응답·추가 이벤트 없음                                         |
| 없는 terminal / exited terminal / host 연결 없음          | 각각 terminal-not-found / terminal-not-open / host-offline              |
| 동일 mode지만 대상이 유효하지 않음                        | no-op보다 위 거절 검사가 먼저 적용됨                                    |
| host가 연결됐으나 inventory 전이거나 입력 차단 중         | mode 변경 가능. 입력 허용 여부와 별개                                   |
| shared의 입력                                             | 현재 참여자라면 leaseId와 관계없이 허용. binary 내용은 그대로 전달      |
| shared의 입력 대상 없음·종료·host 단절                    | terminal-closed로 거절                                                  |
| shared의 Kill Switch 차단                                 | remote-input-disabled로 거절                                            |
| shared 동안 새 lease 획득                                 | 기존 Node처럼 lease-invalid / terminal-closed. 다른 보유권도 유지       |
| shared 진입/이탈                                          | lease 자체를 변경하지 않음. exclusive에서는 현재 보유 lease를 다시 검사 |
| shared 중 명시 반납·소유자 만료·다른 terminal로 획득 이동 | 기존 lease 수명 규칙 유지. exclusive 복귀가 과거 lease를 복원하지 않음  |
| host 역할 또는 hello 이전 요청·잘못된 mode/ID             | bad-message. 오래된 교체 세션은 무시                                    |

Node 근거는 `legacy/node-server/src/usecases/set-terminal-mode.ts`, `route-terminal-input.ts`,
`acquire-lease.ts`, `domain/room.ts`, `domain/terminal-workspace.ts`다.
terminal-request-rejected의 request는 set-mode이며 입력의 lease-invalid와는 다른 응답이다.

## 설계·실패 처리 리뷰

- TerminalWorkspace는 mode 값 변경과 immutable snapshot을 소유한다. Pending/Running/Exited의 runtime,
  exitCode, metadata, 생성 확인 이력은 mode 변경과 독립이다. 실제 PTY에 별도 mode 명령을 보내지 않는다.
- RoomControl은 대상/연결 선행조건과 shared/exclusive 입력 정책을 소유한다.
  ModeChange의 Changed/Unchanged/Rejected 결과로 변경·무변경·거절을 구분하며 거절 이유는 enum이다.
- RoomSessions는 현재 참여자 검증, 최신 host 연결 정보와 효과 순서를 맡는다.
  mode 변경과 binary input의 판단/enqueue가 같은 방 monitor를 사용한다. shared 때문에 별도 경로나 잠금을 만들지 않았다.
- host lookup은 입력/모드 변경이 같은 terminalHost 연산을 사용한다. 연결 상태를 도메인에 복제해 저장하지 않는다.
- RoomProtocol은 command 검증과 도메인 결과의 wire 변환을 맡는다. 타입 분기는 exhaustive switch를 사용한다.
- 알림 수락 실패는 해당 peer를 격리하고 다른 참여자에게 계속 알린다. 이미 바뀐 mode/lease를 롤백하지 않는다.
  요청자의 연결이 끊겨도 기존 유예 정책을 따른다. 영속 저장 성공/실패 정책을 구현한 것은 아니다.
- 두 입력 모드에 조건이 작고 명확하므로 Strategy 클래스 계층을 추가하지 않았다.
  입력 seq는 여전히 중복 제거·실행 확인이 아닌 전달 메타데이터다.

## 테스트 구성과 재현

`terminal-mode.e2e.ts`는 실제 Node/Spring 서버에 같은 14개 시나리오를 실행한다.
제어권 없는 참여자의 전환, lease 보존/반납, exclusive 복귀, typed 거절, Kill Switch, 역할/잘못된 입력,
host 교체의 inventory 이전 전환, 방 격리, hello 이전 거절, 실제 shared 셸 실행을 포함한다.

exclusive 테스트의 fixture와 raw 입력 행동을 `protocol-input-fixture.ts`로 이동해 두 suite가 공유한다.
준비·완료 대기·검증 역할을 유지하며 기존 exclusive 시나리오의 기대 결과는 바꾸지 않았다.
동일 mode의 무응답은 같은 participant 소켓에서 뒤이어 보낸 lease 요청 응답으로 완료를 확인한다.
입력 허용을 바꾸는 captureThroughInputCycle은 이 테스트의 완료 대기로 사용하지 않는다.

초기 Node 실행에서 실제 shared 셸 테스트가 `터미널의 임대가 없다`로 실패했다.
원인은 WsParticipant.sendInput의 exclusive-only 전제였다. shared snapshot이고 소유 lease가 없으면
wire의 leaseId=0을 사용하도록 고쳤다. exclusive에서는 기존 lease 요구를 유지한다.
raw 계약은 shared의 0 및 uint32 최대 leaseId를 그대로 전달하는지도 검사한다.

기존 Spring JAR에서는 shared fixture의 set-terminal-mode가 bad-message로 거절되는 실패를 재현했다.
이후 새 명령과 모델 규칙을 구현했다. Java는 모드 왕복/불변 snapshot, runtime·metadata·lease 보존,
거절 우선순위, shared 획득의 다른 lease/ID 보존, stale 세션, 전송 실패 격리와 소유자 유예 만료를 검사한다.
adapter는 기존 wire-v7 fixture의 mode event, 두 mode와 uint32 ID, malformed 명령을 검사한다.

## 검증 결과와 경계

- Java **158개 통과**, 실패·오류·skip 0개. bootJar 빌드와 Java 포맷 검사 통과.
- Node 입력/모드 최초 보정 후 26개 통과. 이후 방 격리·hello 이전 계약 2개를 추가해 전체 E2E를 실행했다.
- 실제 Spring JAR 공통 E2E **125개 / 9개 파일 통과**, Node 전체 E2E **150개 / 12개 파일 통과**.
  양쪽에서 제어권 없는 참여자의 실제 Connector shared 셸 실행을 확인했다.
- E2E TypeScript 검사·의존성 검사·변경 파일 포맷 검사 통과. jdeps에서 domain → JDK,
  application → domain/JDK 경계를 유지함을 확인했다.

근거: `artifacts/migration-baseline/p3n-shared-mode/`의 before snapshot, node-baseline.log,
node-baseline-final.log, java-red.log, gradle.log, java-results.json, java-contract.log, node-full.log,
typecheck.log, dependencies.log, jdeps.log, java-format.log.
최종 JAR을 먼저 빌드한 뒤 E2E를 실행했고 테스트 중 JAR을 다시 만들지 않았다.

다음 범위는 참여자의 close/resize다. Java 계층 자동 검사, 영속 저장·서버 재시작 복원,
전체 브라우저 협업과 부하 비교는 아직 후속 작업이다. Node를 기본 서버로 유지한다.
