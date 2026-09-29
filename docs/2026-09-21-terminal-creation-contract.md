# 터미널 생성·ID 발급 계약 — P3i

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

[기존 리팩터링 로드맵](2026-08-14-backend-refactoring-roadmap.md)의 방별 변경 경계, 깊은 도메인,
wire 분리와 [E2E 작성 기준](../e2e/README.md)을 따른다. Node 기준은 `usecases/open-terminal.ts`,
`domain/terminal-workspace.ts`, `usecases/control-plane.ts`다. 실제 Connector 생성 실패 응답은
`connector/src/connector-app.ts`에서 확인했다.

## 생성과 확인은 다른 단계다

1. participant의 유효한 요청에 같은 방의 연결된 host가 있으면 ID와 terminal을 예약한다.
2. host에 `open-terminal {terminalId, cols:80, rows:24}`를 보낸다.
3. host의 `terminal-opened` 확인에 runtime을 연결하고 참여자에게 열린 이벤트를 보낸다.
4. 생성 실패·Kill Switch 차단·종료를 알리는 `terminal-closed`는 exited 상태와 exitCode를 반영한다.

기존 v7 snapshot은 확인 전 예약도 `status: open`으로 표현한다. 별도의 pending wire 상태를 만들지
않았다. 따라서 snapshot에 보이는 open을 실제 셸 생성 완료 증거로 해석하면 안 된다. Node처럼 hello만
완료하고 inventory를 아직 보내지 않은 host에도 생성 명령을 전달할 수 있다. 로컬 Kill Switch 판단은
Connector가 수행하고, 이 단계에서는 입력 권한 검증을 추가하지 않았다.

| 조건                                       | 결과                                                       |
| ------------------------------------------ | ---------------------------------------------------------- |
| 복구된 terminal ID가 있음                  | 그 뒤의 ID부터 생성, 모든 host가 방 단위 allocator 공유    |
| host 제거 / 종료된 terminal                | 발급 counter를 되돌리지 않음                               |
| 확인 전 재접속 inventory                   | null runtime의 예약에 보고된 runtime을 연결                |
| 동일 terminal-opened 재전송                | runtime은 Node처럼 갱신, 확인 이벤트는 중복 발행하지 않음  |
| terminal-closed 재전송 / 종료 후 늦은 확인 | 첫 exitCode 유지, 중복 종료나 다시 열린 이벤트 없음        |
| 없는/다른 방/단절된 host, 잘못된 역할·입력 | 요청자 거절, ID 소비 없음                                  |
| 교체된 연결의 늦은 요청·보고               | 현재 Member identity 확인으로 무시                         |
| uint32 ID 소진                             | 다음 ID를 만들기 전에 거절, wrap/reuse/추가 상태 변경 없음 |

inventory의 복구 이벤트와 terminal-opened 확인 이벤트는 별개다. 중복 확인 억제를 전체 메시지 전달의
exactly-once 보장으로 해석하지 않는다. wire exitCode는 Node의 정수 number/null 범위를 유지하므로
Java int로 자르지 않는다. parser가 유한한 정수인지 확인하고 Double로 보관한다.

## 실패와 책임

`TerminalWorkspace`가 ID·예약·runtime·확인 중복·종료 규칙을 소유한다. `RoomSessions`는 같은 방의
monitor에서 현재 연결·역할을 확인하고 명령/알림을 전달한다. `ParticipantCommand`는 생성과 기존
resync 요청을, `HostCommand`는 inventory·생성 확인·종료 보고를 표현한다. WS adapter가 parsing과
wire 표현을 소유한다. 명령마다 pass-through service나 별도 변경 잠금을 만들지 않았다.

Spring에서 host 송신 수락이 실패하면 해당 host만 offline/종료 유예 처리하고 요청자에게 오류를
보낸다. 이미 예약한 ID를 되돌리지 않는다. 다음 inventory가 실제 runtime이 있는지 확인하여 유지하거나
종료한다. 전송 수락이 실제 생성 완료를 뜻하지 않기 때문이다. 이 실패 경로는 Java 단위 테스트로
검증하며 Node와 모든 transport 실패 정책이 같다고 주장하지 않는다.

Node는 저장 성공 → 메모리 commit → host 명령 순서를 유지한다. 이번에는 domain의 ID 소진만
typed failure로 번역했으며 저장 실패 등 다른 예외는 다시 전파한다. 기존 저장 실패 회귀도 유지한다.
Spring에는 아직 영속성이 없으므로 동일한 재시작 보장을 주장하지 않는다.

## 리뷰에서 수정한 문제

- 복구된 최대 ID 이후 생성하던 Node는 uint32를 벗어난 terminal을 만들려다가 연결을 종료했다.
  공통 계약에서 실패를 재현하고 두 구현 모두 예약 전에 소진을 검사하도록 했다.
- Spring의 기존 reconciliation은 모든 open terminal에 runtime이 있다고 가정했다. 생성 예약의
  null runtime을 구별해 재접속 inventory를 충돌로 처리하지 않도록 수정했다.
- 생성 요청만 구현하면 Connector의 실패 응답이 미지원 명령으로 거절되고 예약이 open으로 남는다.
  host 종료 보고까지 포함했으며 null/일반/32-bit 범위를 넘는 정수 exitCode를 검증했다.
- 세 E2E 파일에 반복되던 실제 서버·소켓 ownership을 `protocol-fixture.ts`로 모았다. 준비·행동·assert는
  계속 분리하고, 테스트 간 상태 의존이나 helper의 수신 정렬·중복 제거는 추가하지 않았다.

## 검증 범위

공통 생성 계약은 protocol peer ↔ 실제 서버 검증이다. Node 기준 최초 10개 중 9개 통과, ID 소진 1개
실패를 기록했다. 변경 전 Spring의 기본 생성 계약 1개와 종료 보고 3개도 실패를 재현했다.

Java 단위 테스트는 동시 생성 ID, host 송신 실패 후 예약 유지, 이전 participant/host 차단, runtime
연결, 중복 확인/종료, ID 소진 시 무변경, 잘못된 exitCode를 검증한다. JAR 공통 계약은 HTTP·입장·Host·
복구·생성 파일을 함께 실행한다. 로그는 `artifacts/migration-baseline/p3i-creation/`에 보관한다.

실제 Connector 셸 생성·셸 명령 실행·브라우저 협업 전체의 Spring 검증은 아니다. `terminal-meta`가
아직 미지원이고 Connector는 error 응답을 받으면 연결을 닫으므로, **실제 Connector 생성 후 지속 연결은
다음 단계에서 메타데이터 처리와 함께 검증해야 한다.** 참여자의 close/resize, 입력 권한/전달, 저장·
재시작 복구도 남아 있다. 이번 결과만으로 Spring을 기본 협업 서버로 전환하지 않는다.

최종 검증(2026-09-21, macOS/Java 21): **Java 87개, 실제 Spring JAR 공통 계약 81개,
Node 서버 단위 211개, Node 전체 프로세스 E2E 106개 통과**. 생성 계약 16개를 포함한다.
Java/Node 빌드, E2E/Node 타입·의존성·Java/변경 파일 포맷 검사도 통과했다.

후속 상태: 위 P3i 당시 미지원이던 메타데이터와 실제 Connector의 첫 보고 이후 다음 PTY 생성은
[P3j 메타데이터 계약](2026-09-21-terminal-metadata-contract.md)에서 구현·검증했다.
