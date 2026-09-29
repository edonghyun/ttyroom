# Terminal inventory·출력 복구 계약 — P3g

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

[Host 초기 연결](2026-09-21-host-inventory-contract.md) 다음 단계다. 기존 설계의 기준은
[리팩터링 로드맵](2026-08-14-backend-refactoring-roadmap.md),
[Spring 아키텍처 기준](../backend/ARCHITECTURE.md), [E2E 작성 기준](../e2e/README.md)에서 이어간다.

## 구현과 관찰 가능한 결과

| 조건                                  | 결과                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------- |
| 같은 host·terminalId·runtimeId        | 기존 terminal 유지, `host-ready`에 replay 시작 위치 응답               |
| inventory에서 누락 / runtime 충돌     | 기존 terminal을 exited 처리. 충돌한 Connector PTY에는 `close-terminal` |
| 다른 host의 ID / 이미 종료된 ID       | 해당 PTY를 닫도록 지시하며 기존 소유권을 바꾸지 않음                   |
| Connector에만 있는 PTY                | open terminal로 복구, `host-connected` 뒤 `terminal-opened`            |
| inventory의 lastOutputSeq가 앞서 있음 | 이를 수신 완료로 간주하지 않음                                         |
| source seq 중복·역순                  | 출력 중계와 history에 중복을 넣지 않음                                 |
| 늦은 참여 / 명시적 resync             | 보관된 출력의 browser seq를 유지해 전송하고 마지막에 `sync`            |
| 교체된 세션의 늦은 출력·완료 보고     | 현재 세션 identity 검사로 무시                                         |
| host 유예 만료                        | 그 host의 terminal·출력 history·수신자 gap 제거                        |
| 큰 u32 terminalId                     | 초기 좌표를 65535 이하로 제한해 유효한 이벤트·snapshot 생성            |

`host-ready`의 replay 위치는 서버가 처리한 source watermark다. 바이너리 출력 수신과
`terminal-replay-complete`가 이를 전진시킨다. 완료 보고가 앞서면 watermark는 전진하지만 빠진 payload를
만들어내지는 않는다. 브라우저용 seq는 서버가 실제로 수락한 출력마다 별도로 증가한다.
이것을 손실 없는 전달이나 입력 exactly-once 보장으로 해석하지 않는다.

Node 비교 소스는 `legacy/node-server/src/usecases/reconcile-host.ts`, `broadcast-terminal-output.ts`,
`sync-late-joiner.ts`, `resync-terminal-output.ts`, `scrollback-buffer.ts`, `domain/terminal-workspace.ts`다.

## 책임과 실패 경계

- `domain/TerminalWorkspace`가 runtime 대조·소유권·종료/복구 결과를 소유한다. Spring/Jackson을 알지 않는다.
- `application/TerminalOutput`이 source/browser seq, 보관 출력과 수신자별 gap을 소유한다.
- `RoomSessions`는 인증된 연결 identity, 한 방의 잠금, 조정 결과의 전달 순서와 만료를 관리한다.
  binary는 JSON control routing·저장 큐를 거치지 않지만 현재 방 monitor는 사용한다. lock-free라고 주장하지 않는다.
- `RoomProtocol`과 `OutputWire`가 v7 표현을 만들고 `SocketSender`가 실제 쓰기를 격리한다.
  gap 재개 알림은 `sync → output-gap → binary` 묶음 전체를 수락하거나 전부 거절한다.
- 소켓 큐 수락은 실제 전달 확인이 아니다. 예상된 실패만 `PeerUnavailable`로 처리한다.

### 리뷰에서 재현하고 수정한 문제

1. **host-ready 실패 후 관찰자 상태 누락:** inventory가 메모리에 확정됐는데 host reply 예외가 이후
   participant 알림을 건너뛰었다. 확정된 결과는 알린 뒤 host를 offline·종료 유예 처리한다.
   아직 persistence는 없으며 향후 저장 실패에도 같은 알림을 보낸다는 뜻은 아니다.
2. **resync 후 오래된 gap 재발행:** replay와 sync 수락 후 해당 수신자의 pending gap을 지운다.
3. **큰 ID의 잘못된 geometry:** 이전 Node 공식 `24 + (id - 1) * 32`가 workspace 좌표 상한을 넘었다.
   Node/Java의 실제 서버에서 실패를 재현했고 두 구현 모두 좌표를 제한했다. 기존 범위 안의 배치는 유지한다.

### 명시적으로 다른 용량·실패 정책

Spring history는 terminal당 **payload 1MiB + 16,384 frame**까지 보관한다. Node의 payload 한도에
empty frame까지 제한하는 개수 상한을 추가했다. 오래된 frame은 통째로 버리며 보관하지 못한 출력을
복구했다고 주장하지 않는다. 큰 단일 frame도 history에서 빠질 수 있다.

P3g에서는 replay를 일반 송신 큐에 펼쳐 넣어 큐가 차면 연결을 종료했다. 이 제약은
[P3h replay 예약·송신 변경](2026-09-21-bounded-replay.md)에서 보강했다. live/control 큐는
1MiB·256개를 유지하고, replay는 별도의 유한한 스냅샷 예약으로 같은 FIFO writer가 순차 전송한다.
Node와 동일한 slow-consumer 정책이나 무제한 replay를 보장하는 것은 아니다.

## 테스트와 증거

공통 테스트 `e2e/src/terminal-recovery.e2e.ts`는 각 테스트가 실제 서버와 독립 소켓을 소유한다.
fixture는 준비와 정리, `reportInventory`/출력 송신/`captureUntilSync`는 행동과 완료 대기,
본문의 expect는 해당 결과를 검증한다. 소켓 probe는 제어·바이너리의 도착 순서를 보존하며
정렬·중복 제거를 하지 않는다. 임의 sleep이나 다른 테스트의 선행 실행에 의존하지 않는다.

새 복구 계약은 **프로토콜 peer ↔ 실제 Node/Java 서버** 검증이다. 실제 Connector의 PTY 생성이나
셸 실행·서버 재시작 복구는 이 9개 테스트가 검증하지 않는다. 실제 Connector 초기 연결은 기존
`host-session.e2e.ts`, Node의 실제 PTY 협업/재시작은 기존 전체 E2E가 담당한다.

| 검증                  | 결과/증거                                                                              |
| --------------------- | -------------------------------------------------------------------------------------- |
| 최초 복구 계약 8개    | Node 8 통과, 변경 전 Java 8 실패 (`node-baseline.log`, `java-red.log`)                 |
| 리뷰 회귀 2개         | 수정 전 2 실패 (`review-red.log`), 최종 Java suite에서 통과                            |
| 큰 ID 공통 회귀       | Node/Java 각각 실패 (`geometry-node-red.log`, `geometry-java-red.log`) 후 두 구현 수정 |
| Java 테스트·JAR 빌드  | 63 통과 (`gradle.log`, Gradle XML report)                                              |
| 최종 Spring 공통 계약 | 64 통과 (`java-contract.log`)                                                          |
| Node 서버 단위        | 210 통과 (`node-unit.log`)                                                             |
| 최종 Node 전체 E2E    | 89 통과 (`node-full.log`)                                                              |

E2E/Node 타입 검사, 의존성 검사, Java/변경 파일 포맷 검사도 통과했다.

로그 디렉터리는 `artifacts/migration-baseline/p3g-recovery/`다. slow consumer·history 상한·교체/만료
경합은 Java 단위 테스트에서 통제한 조건으로 검증했다. 실제 네트워크 부하/soak 검증과 구분한다.

## 다음 범위

터미널 생성 → 입력 권한/lease → 입력 전달을 공통 계약으로 이식한다. 복구된 ID와 새 ID의 충돌,
u32 ID 소진, offline/종료 상태, Kill Switch와 lease 조합, 오래된 연결의 입력을 먼저 검증한다.
영속 저장·프로세스 재시작·전체 브라우저 협업은 남아 있다. 현재 방·terminal·출력은 메모리 상태다.
