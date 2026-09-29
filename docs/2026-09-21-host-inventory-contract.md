# Host 초기 연결과 inventory 이식 계약

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

## 기준 문서와 소스

- [백엔드 리팩터링 로드맵](2026-08-14-backend-refactoring-roadmap.md): 한 Room 변경 경계, domain outcome과 wire 변환 분리, 깊은 capability, 작은 리팩터링과 계약 검증.
- [Engineering Deep Dive](2026-09-18-ttyroom-interview-portfolio-engineering-review.md): 구현·해석·미검증 경계 구분, late callback identity, 수락과 전달 보장의 차이.
- [초기 브레인스토밍의 품질 기준](brainstorming.md#품질-기준): 재접속으로 입력 권한을 우회하지 않기, 느린 연결 격리, 실행 중인 PTY의 불필요한 종료 방지. 초기 가설의 모든 기능을 현재 요구로 간주하지 않는다.
- [E2E 작성 기준](../e2e/README.md): fixture → action → assert, 의미 있는 완료 조건, 실제 프로세스, 테스트 간 독립성, 수신 결과를 정렬·중복 제거하지 않기.

Node 비교 소스는 `legacy/node-server/src/` 아래의 `usecases/connect-host.ts`, `reconcile-host.ts`,
`update-host-input-state.ts`, `connection-registry.ts`, `domain/terminal-workspace.ts`다. 관련 테스트는
`usecases/connect-host.spec.ts`, `update-host-input-state.spec.ts`, `domain/room.spec.ts`에 있다.
`reconcile-host.spec.ts`라는 별도 파일이 있다고 가정하지 않는다.

이 문서는 P3f 완료 시점의 기록이다. nonempty inventory와 출력 경로는 후속
[Terminal 복구 계약](2026-09-21-terminal-recovery-contract.md)에서 구현·검증했다.

## 당시 구현한 범위

빈 inventory를 가진 새 Connector의 `hello → host-inventory → host-ready → host-input-state` 흐름이다.
기존 PTY 목록은 아직 복구하지 않는다. 유효한 nonempty inventory도 명시적으로 `bad-message`로
거절하며 `host-ready`를 보내거나 기존 host 상태를 변경하지 않는다. Node는 nonempty inventory를
처리하므로 이 부분은 남은 구현 차이다.

| 입력/조건                              | 유지하는 관찰 가능 결과                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| host hello / 같은 hostId의 새 연결     | welcome에서 offline·입력 차단. 이전 세션 교체 후 그 세션의 명령/close가 새 상태를 바꾸지 못함             |
| 빈 host-inventory                      | host에게 `host-ready {terminals: []}`, 참여자에게 `host-connected`; online=true, remoteInputAllowed=false |
| host-input-state                       | 실제 변경일 때만 `host-input-state-changed`; 이후 welcome에도 보고 상태 반영                              |
| 같은 입력 상태 재보고                  | 중복 이벤트 없음. 임의 sleep 대신 같은 소켓의 다음 inventory 이벤트를 경계로 검증                         |
| inventory 전에 입력 상태를 보고        | Node처럼 보고 자체는 반영하며 이후 inventory가 false로 초기화. 별도의 새 권한 정책을 추가하지 않음        |
| host 단절                              | 즉시 offline, 유예 후 제거. Node처럼 마지막 입력 보고 값은 offline 전환만으로 덮어쓰지 않음               |
| participant의 host 명령, hello 전 명령 | `bad-message`, host 상태 변경 없음                                                                        |
| malformed inventory/input report       | `bad-message`, 연결을 유지하고 이후 정상 명령 처리                                                        |
| welcome 실패 중 교체                   | 이전 세션과 그 host 상태 유지                                                                             |
| host-ready 송신 수락 실패              | 해당 host를 offline·종료 유예 처리; 관찰자 송신 실패는 다른 세션의 입장을 막지 않음                       |

`online`과 `remoteInputAllowed`는 각각 가용성과 로컬 보고 상태다. 둘 중 하나만으로 실제 입력
권한을 판정하면 안 된다. 터미널 입력 전달 경로와 lease 검증은 이번 범위가 아니다.

## 설계와 재리뷰

- `RoomAdmission`을 `RoomSessions`로 바꿨다. 입장 반환값은 연결에 결합된 `Session`이며, 외부 호출자는
  roomId/hostId를 다시 전달하지 않는다. `Role` enum과 `HostCommand` sealed 타입으로 역할과 명령을
  분기하고, 명령·단절 모두 같은 방 monitor와 현재 Member identity를 확인한다.
- `HostPresence`가 복구 시작 상태, inventory 완료, 입력 보고 중복 여부, 단절 상태를 소유한다.
  이 domain은 Spring/Jackson/application을 참조하지 않는다. `RoomSessions`는 전송·유예·알림 순서를
  조정한다. 아직 없는 Terminal/Lease 상태 저장소나 generic event bus를 추가하지 않았다.
- `AdmissionNotice/AdmissionProtocol`은 범위에 맞게 `RoomNotice/RoomProtocol`로 바꿨다. 입력 검증과
  JSON 변환은 WS adapter, 세션 인증·역할·현재 연결 확인은 application, host 상태 규칙은 domain에 둔다.
- uint32 식별자/sequence는 Java `long`으로 받는다. 불변 결과 snapshot과 송신 큐의 수락 의미는 유지한다.
- `hostFixture`는 실제 서버·소켓을 소유하고 `readyHostFixture`는 준비 완료까지 기다린다. 본문은
  해당 케이스의 결과만 검증한다. 실제 Connector 프로세스도 초기 연결·입력 보고까지 확인한다.

## 다음에 고정할 복구 계약

Node에는 이미 다음 동작이 있다. 현재 Java의 구현 완료 항목은 아니다.

1. 기존 terminal과 runtimeId가 일치하면 유지하며 누락된 terminal은 exited 처리한다.
2. runtimeId 충돌 또는 이미 종료된 ID의 PTY는 `close-terminal`로 정리한다. 다른 host의 ID를 가져오지 못한다.
3. Connector에만 있던 PTY는 Room의 terminal로 복구하고 후속 ID 발급과 충돌하지 않게 한다.
4. `host-ready.replayAfterSeq`는 서버가 수신한 source sequence를 기준으로 한다. 보고된 lastOutputSeq를
   수신 완료로 간주하지 않는다. replay 완료·중복 제거·참여자 동기화를 함께 구현한다.
5. 영속성 도입 시 저장 성공 → 메모리 확정 → 알림 순서를 유지하며 inventory와 Kill Switch 보고를
   같은 Room 변경 순서로 처리한다.

이 동작을 구현할 때 `RoomSessions`에 Terminal/Lease 규칙을 계속 쌓지 않는다. 먼저 Room aggregate의
소유 범위와 terminal workspace를 정하고 공통 계약을 추가한 뒤 다음 세로 기능을 이식한다.

검증 로그는 `artifacts/migration-baseline/p3f-host/`에 보관한다. 최초 공통 테스트 12개는 Node에서
전부 통과하고 변경 전 Java에서 10개 실패했다. 최종 결과와 현재 실행 명령은 [backend README](../backend/README.md)에 기록한다.
