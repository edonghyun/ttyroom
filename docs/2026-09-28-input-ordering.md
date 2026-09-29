# 저장 지연 중 lease 반납과 입력 수신 순서 — P4b

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-28. [품질 리뷰](2026-09-25-node-java-quality-review.md)에 남긴 Node/Java 수신 순서 차이를
실제 세션 로직과 transport 경계를 연결한 테스트로 확인했다. production 동작은 변경하지 않았다.

## 같은 순서로 보냈을 때의 결과

준비: online host, 열린 terminal 7, 입력 허용, 참가자 Alice가 가진 유효 lease.
Alice의 같은 연결에서 제목 변경 → lease 반납 → binary 입력을 순서대로 보낸다.
제목 변경의 저장은 gate로 멈춘 상태이며 lease 반납은 아직 처리되지 않았다.

| 관찰 시점                                   | Java                                             | 기존 Node                                       |
| ------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| 저장 대기 중 후속 binary 수신               | 현재 확정 lease가 유효하므로 host에 전달         | 같은 연결의 처리 큐에서 앞선 제어 처리를 기다림 |
| 저장 해제 후 대기 중 반납 처리              | lease를 반납하고 `lease-released` 알림           | lease를 반납하고 `lease-released` 알림          |
| 대기 중 보낸 입력의 최종 결과               | 이미 host로 전달한 상태                          | 반납 후 처리하므로 `lease-invalid: not-holder`  |
| Java에서 반납 완료 알림 이후 다시 보낸 입력 | `lease-invalid: not-holder`, 추가 host 전달 없음 | 이번 비교의 추가 입력 사례는 Java에서만 실행    |

Java의 `ControlInbox`는 control FIFO를 유지하지만 binary는 우회한다. 따라서 **반납 메시지를 먼저
보낸 사실만으로 후속 입력의 거절이 보장되지는 않는다.** 권한 변경 완료 알림과 수신 순서를 구별해야
한다. 이미 전달된 입력을 취소하거나 PTY 실행 완료를 보장하는 계약도 아니다.

Node의 결과는 **같은 연결**에서 앞선 비동기 작업을 기다리는 `WsTransport`의 Promise chain에서
나온다. 서로 다른 연결 전체에 대한 FIFO를 의미하지 않는다. 저장 지연 중 실시간 진행을 선택한
Java의 기존 계약을 확인한 것이며, 여기서 Node와 동일한 큐 구조로 바꾸지는 않았다.

## 테스트 경계와 읽기 방식

- Java `RoomInputOrderingTests`는 실제 `RoomSocketHandler`, `ControlInbox`, `RoomSessions`, 도메인을
  사용한다. WebSocket 콜백에 순서대로 메시지를 넣고, 저장소 대역의 latch로 저장을 멈춘다.
  socket 쓰기와 host Peer는 대역이다. 실제 Tomcat/TCP/Connector PTY E2E는 아니다.
- Node `input-ordering.integration.spec.ts`는 실제 로컬 HTTP/WebSocket, `WsTransport`, `ServerCore`,
  도메인을 사용한다. 저장은 `RecordingRoomRepository` gate로 멈추고 host는 기존 recording peer를
  사용한다. 뒤따른 ping의 pong까지 받아 앞선 프레임이 서버에 도착했음을 확인한다. 이는 application
  처리 완료가 아니라 수신 경계의 확인이다.
- 두 본문 모두 이름 있는 fixture·rename·lease 반납·입력 행동을 사용한다. 준비 기능을 중간 assertion으로
  반복하지 않고, 저장 중 관찰값을 보관한 뒤 마지막에 결과를 검증한다.
- 입력은 frame 수와 내용으로 검증한다. Java는 반납 이후 거절 사유와 전체 거절 개수도 검증한다.
  알림 대기는 필요한 메시지를 찾되 수신 이력은 별도로 보존한다.
- 모든 gate/메시지 대기에 제한 시간을 두고 실패 경로에서도 저장 gate를 해제한 뒤 자원을 정리한다.
  임의 sleep이나 `Thread.State`로 명령 접수를 추정하지 않는다.

## 변경 과정과 근거

이 작업은 기존 동작의 **특성화**다. 새로운 기능을 구현한 RED → GREEN 이력이 아니다.
Java 테스트는 기존 구현에서 통과했다. Node 첫 실행은 추가 inventory 뒤 입력 허용을 다시 보고하지
않아 `remote-input-disabled`로 거절됐다. fixture 전제 오류를 고친 후 `not-holder`를 확인했다.
첫 실패는 `node-fixture-failure.log`로 보관하고 production 결함의 RED로 취급하지 않는다.

로그와 최종 파일 hash는 `artifacts/migration-baseline/p4b-input-ordering/`에 남긴다.
저장 실패·권한 취득·mode 변경·여러 연결 경합의 모든 조합을 이번 두 사례로 검증했다는 뜻은 아니다.
기존 품질 리뷰의 lease 반납+binary 순서 비교를 마쳤으며 SQLite adapter 구현은 별도 후속 작업이다.

## 최종 검증

- Java 전체 **291개**, 실패·오류·건너뜀 0.
- Node WebSocket 통합 **9개**, 저장·입력 계약 unit **13개** 통과.
- Node 서버 TypeScript typecheck, 변경 Java·TypeScript·문서 포맷 검사 통과.
- 테스트와 문서만 변경했다. Spring JAR 공통 E2E는 재실행하지 않았다. 직전 P3z의 168개 통과는
  별도 실행 기록이며, 기존 JAR 및 앞서 변경했던 production 소스의 hash가 유지됨을 확인했다.
