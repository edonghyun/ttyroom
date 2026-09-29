# Exclusive 입력 권한·전달 계약 — P3k

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-21. Node의 lease 및 입력 동작을 프로세스 계약으로 고정하고 Spring에 이식했다.
이번 범위는 exclusive terminal의 획득·반납, 현재 연결/소유권 검증, Kill Switch 보고 반영과
실제 Connector의 셸 명령 실행이다. shared 모드 전환, 참여자의 close/resize, 영속 저장은 후속 단계다.

## 기존 Node와 맞춘 동작

| 상황                                 | 결과                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| 열린 exclusive terminal의 최초 획득  | 요청자 lease-result → lease-granted 이벤트, welcome에도 현재 lease 포함               |
| 같은 소유자의 재획득                 | 같은 leaseId 응답, 이벤트나 새 ID 없음                                                |
| 다른 소유자가 있는 terminal 획득     | holderClientId를 담은 denied, 요청자의 기존 lease도 유지                              |
| 다른 비점유 terminal 획득            | 참여자당 하나만 보유: 새 결과 → 이전 lease-released → 새 lease-granted                |
| 정확한 소유자·leaseId로 반납         | lease-released, 오래된 ID/다른 소유자는 not-holder                                    |
| 입력 대상 없음·종료됨·host 연결 없음 | lease-invalid / terminal-closed                                                       |
| host가 입력을 차단함                 | remote-input-disabled, lease 자체는 유지                                              |
| 잘못된 소유자·leaseId의 입력         | not-holder, Connector에 전달하지 않음                                                 |
| 유효한 입력                          | terminalId·seq·leaseId·opaque payload 그대로 소유 host에 전달                         |
| 같은 seq의 재입력                    | 그대로 재전달; 입력 중복 제거·실행 확인을 의미하지 않음                               |
| 참여자 단절/재접속                   | 15초 유예 동안 lease 유지, 같은 ID의 새 세션이 이어받음                               |
| 참여자 유예 만료                     | lease-released 후 participant-left                                                    |
| host 단절·교체·만료                  | 단절/교체는 lease 유지, 교체 연결은 입력 차단에서 시작; 만료 시 terminal과 lease 제거 |
| 종료 보고                            | lease는 유지하되 입력 차단. lease 수명은 소유자 만료·명시 반납·terminal 제거로 관리   |

Node 근거: `domain/lease-control.ts`, `domain/room.ts`, `usecases/acquire-lease.ts`,
`release-lease.ts`, `route-terminal-input.ts`, `handle-disconnect.ts`, `update-host-input-state.ts`.
이 경로는 모두 `legacy/node-server/src/` 아래다.

획득은 host 입력 허용 여부와 독립이다. 입력 전달은 host의 **현재 연결**과 입력 허용 보고를 확인한다.
Node처럼 inventory 이전에도 host가 허용을 보고하면 전달할 수 있다. 화면의 online 플래그와 실제 연결은
별개이므로 online 플래그를 새 선행조건으로 넣지 않았다. 실제 Connector는 inventory 완료 후 입력을 허용한다.

## 설계·실패 처리 리뷰

- `LeaseControl`은 보유자·단조 증가 ID·한 참여자 한 lease·해제·불변 snapshot을 소유한다.
  `TerminalWorkspace`의 불변 terminal 조회로 현재 open/exclusive를 확인하며, 둘 다 같은 방 monitor에서 변경한다.
- `RoomSessions`는 인증된 세션, terminal·host·lease 조정 및 결과 순서를 소유한다. 별도의 lease 잠금·저장 큐를 만들지 않았다.
- JSON은 sealed 참가자 명령과 업무 결과를 통해 처리한다. binary input은 별도 진입 경로이며 동일한 짧은 방 잠금으로
  세션 교체와 권한을 검증한다. 향후 persistence queue에 고빈도 입력을 넣지 않는다.
- `InputFrame`은 bytes를 소유하고 외부 변경을 막는다. v7의 tag=2, 13-byte header와 unsigned u32는 `InputWire`가 담당한다.
  `Peer.sendInput`은 송신 수락/실패만 노출하고, 실제 I/O는 기존 bounded `SocketSender` writer가 수행한다.
- lease 확정 후 요청자 응답이 실패해도 다른 참여자에게 확정된 상태를 알린다. 실패한 요청자는 기존 유예 정책을 따른다.
  송신 수락은 수신/명령 실행 완료 보장이 아니다.
- 입력 송신의 예상된 전송 실패/큐 초과는 해당 host만 정리하고 발신자에게 terminal-closed를 알린다.
  이미 실행했을 수 있는 명령은 재전송하지 않는다. 기존 큐의 1MiB·256개 및 쓰기 deadline 정책을 사용한다.
  이는 Node의 단순 send 호출과 동일한 내부 실패 경로라고 주장하지 않는다. Java의 격리 정책은 별도 단위 테스트로 검증했다.
- lease ID 소진 시 Java는 uint32를 넘기기 전에 bad-message로 거절하고 기존 lease를 유지한다.
  Node의 이론적인 2^32회 발급 경계까지 동등성을 검증한 단계는 아니다.

shared 입력은 이번 범위가 아니다. 후속 모드 전환에서 shared 동안 lease 보존과 입력 허용 규칙을 함께 이식해야 한다.
저장 성공 → 메모리 확정 → 알림이라는 기존 원칙은 영속성 단계에서도 유지해야 하며, 현재 Java 방/lease는 메모리 상태다.

## 테스트와 증거

`terminal-input.e2e.ts`는 독립 서버/방 fixture → 행동 → assert 순서다. 늦은 참가자의 빈 출력 history sync까지
준비 단계에서 소비해 lease 응답과 혼동하지 않는다. raw 수신은 정렬·중복 제거 없이 확인한다.
입력 테스트에는 입력 허용을 바꾸는 `captureThroughInputCycle()`을 사용하지 않는다.

새 공통 계약은 14개다. 소유권/반납/중복/방 격리/재접속/차단·복구/역할/잘못된 binary와 실제 셸 실행을 포함한다.
셸 명령은 입력 문자열에 완성된 marker가 없는 printf를 사용하므로 echo만으로 통과하지 않는다.
Java는 동시 획득의 단일 승자, 이전 세션 차단, 수동 유예 만료/취소, host 만료 정리, 응답/전달 실패 격리,
불변 payload/snapshot, 공유 v7 fixture와 malformed 명령을 별도로 검사한다.

로그는 `artifacts/migration-baseline/p3k-input/`에 보관한다.

- `node-baseline.log`: 초기 테스트의 Buffer/Uint8Array 비교와 늦은 참가자 sync 준비 누락을 드러낸 실패.
- `node-baseline-final.log`: 준비·비교 수정 후 최초 13개 Node 계약 통과. 이후 방 격리 1개를 추가했다.
- `java-red.log`: 변경 전 Spring의 lease 미지원 실패.
- `java-input-initial.log`: 기능 12개 통과 및 기동 실패 1개. E2E 도중 같은 JAR을 재생성한 실행 실수로
  클래스 로딩 오류가 발생했다. 최종 실행은 빌드 완료 뒤 동일 JAR을 변경하지 않고 수행한다.
- `gradle.log`, `java-contract.log`, `node-full.log`: 최종 Java 빌드/단위 테스트와 실제 서버 프로세스 계약 결과.
- `typecheck.log`, `dependencies.log`, `format.log`, `java-format.log`: 정적 검사 결과.

이 결과는 로컬 macOS 검증이다. 전체 브라우저 협업, Spring 영속성/서버 재시작 복원, 장시간 부하,
입력 exactly-once 또는 분산 lease 보장을 의미하지 않는다.

최종 검증: **Java 118개, 실제 Spring JAR 공통 계약 111개, Node 전체 프로세스 E2E 136개 통과**.
공통 입력 계약 14개와 기존 HTTP·입장·host·복구·생성·메타데이터·fixture 계약을 함께 실행했다.
JAR 빌드, E2E 타입, 의존성 경계, Java/변경 파일 포맷 검사도 통과했다.
