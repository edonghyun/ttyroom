# 참여자 focus·cursor 계약 — P3q

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-22. [제목·창 배치 계약](2026-09-22-terminal-view-contract.md) 다음 단계로
focus-terminal과 move-cursor를 Spring에 추가했다. focus는 참여자의 현재 선택 상태이고,
cursor는 같은 방의 다른 참여자에게 전달하는 일시적인 포인터 위치다.

## Node 기준 계약

근거는 `legacy/node-server/src/usecases/focus-participant.ts`, `share-participant-cursor.ts`,
`join-room.ts`, `domain/room.ts`, `domain/presence.ts`, `protocol/src/messages.ts`다.

| 조건                             | focus                                      | cursor                                         |
| -------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| 정상 요청                        | 본인 포함 같은 방의 참여자에게 변경 알림   | 본인을 제외한 같은 방의 연결된 참여자에게 전달 |
| 같은 값 반복                     | 무응답                                     | 매번 전달                                      |
| null                             | focus 해제                                 | canvas 이탈 전달                               |
| snapshot / 유예 중 재접속        | focus 보존                                 | 저장·재생 없음                                 |
| 대상 terminal                    | 존재해야 함. pending·exited·offline도 허용 | terminal 또는 focus가 필요하지 않음            |
| lease / Kill Switch              | 입력 정책과 독립                           | 입력 정책과 독립                               |
| host 역할 / hello 전 / 잘못된 값 | bad-message                                | bad-message                                    |

focus의 terminalId는 unsigned 32-bit 또는 명시적 null이며 누락은 거절한다. 없는 terminal 요청은
기존 focus를 유지한 채 bad-message로 거절한다. cursor.position은 명시적 null 또는 x/y 객체이며
각 좌표는 유한한 수, -65535..65535 범위의 소수까지 허용한다. 발신 clientId는 인증된 세션에서 정한다.

focus는 participant-focus-changed room-event이고 cursor는 participant-cursor 독립 메시지다.
둘 다 Connector에는 전송하지 않는다. cursor에는 이력·재시도·재접속 replay를 만들지 않는다.

기존 Node는 host 만료로 terminal이 제거돼도 참가자의 focus ID를 자동으로 지우지 않는다.
따라서 “focus가 항상 존재하는 terminal을 가리킨다”는 불변식을 새로 도입하지 않았다.
제거된 ID로 같은 focus를 다시 요청하면 거절하고, null로 해제하는 것은 허용한다.
존재 검사를 값 비교보다 먼저 수행해야 이 순서를 유지한다.

## 모델링·리팩터링 리뷰

- focus의 수명은 참여자 입장·유예·교체·만료와 같다. 기존 RoomSessions.Member가 단일 원본을
  소유하고 Welcome/참여자 알림에는 불변 값으로 복사한다. 별도 focus 맵이나 참여자 레지스트리를
  추가해 입장 rollback과 만료 정리 대상을 두 곳으로 늘리지 않았다.
- 연결 교체 시 이전 focus를 Welcome 생성 전에 복사한다. Welcome 실패는 기존 member를 복원하므로
  이전 세션·focus·lease가 유지된다. 성공한 교체와 유예 중 복귀는 joined/focus를 재방송하지 않는다.
- 같은 방 monitor 안에서 현재 세션·역할·terminal 존재를 검사하고 변경 및 enqueue를 수행한다.
  focus는 참여자 상태이므로 RoomControl의 PTY OPEN/online-host 검증을 재사용하지 않는다.
  terminal/lease 모델에는 소켓·포인터 상태를 넣지 않았다.
- cursor는 검증된 CursorPosition 값과 전달 명령/결과만 가진다. 현재 연결 목록에서 발신자를 제외해
  전달하며 참여자나 terminal 모델에 좌표를 저장하지 않는다. 전송 수락이 수신 완료 보장은 아니다.
- 예상된 PeerUnavailable은 실패한 수신자만 단절·유예 처리하고 나머지에게 계속 전달한다.
  focus는 확정한 상태를 되돌리지 않고 cursor를 재시도하지 않는다. 예상 밖 예외는 숨기지 않는다.
- RoomProtocol의 workspaceCoordinate 검증을 창 geometry와 cursor가 공유한다. geometry 치수 검증은
  별도로 유지한다. JSON 숫자 비교는 공통 wire fixture assertion으로 모아 정수/실수 노드 차이를 숨겼다.

변경 전 소스는 before/src, 이번 단계의 제품 코드 차이는 main.diff에 남겼다.
새 Spring 컴포넌트·이벤트 버스·저장소·잠금이나 정책 계층을 추가하지 않았다.

## 테스트와 검증

`participant-presence.e2e.ts`는 독립 방·연결을 준비하고 행동 뒤 결과를 검증한다. 소켓과 서버는
fixture가 소유하며 준비 도중 실패해도 정리한다. 무응답·비전달 검증은 같은 연결의 후속
invalid-lease 응답으로 FIFO 순서를 확인한다. 임의 sleep이나 retry로 결과를 숨기지 않는다.

- 최초 Node 공통 계약 **13개 통과**. 기존 Spring JAR에서 정상 focus가 bad-message로 거절되는 실패를 확인했다.
- 최종 공통 계약은 **14개**다. focus/blur·중복·없는 대상, pending/exited/offline, 연결 교체·재접속,
  cursor 반복/null·좌표 범위·발신 ID·방 격리·역할·malformed 입력을 다룬다.
- cursor가 활성 상태일 때 늦은 입장자에게 과거 위치가 재생되지 않는지 확인한다. 단절 중 이동도
  보관하지 않으며 수신자 재접속 후 새 이동만 전달한다.
- Java **212개 통과**, bootJar 빌드 성공. 실패한 Welcome rollback, 불변 snapshot, participant 만료의
  focus/lease 초기화, 오래된 세션·만료 콜백, host 제거 후 focus 유지/재요청 거절, 수신자 실패 격리와
  예외 전파를 포함한다. 만료 세부 계약은 수동 타이머를 쓰는 Java 테스트로 검증했다.
- E2E 타입 검사, 의존성 검사, Java 포맷 검사 통과. jdeps에서 domain → JDK, application → domain/JDK 경계를 확인했다.
- 최종 Spring 공통 E2E **168개 / 12개 파일 통과**, Node 전체 E2E **193개 / 15개 파일 통과**.

근거는 `artifacts/migration-baseline/p3q-participant-presence/`의 node-baseline.log, java-red.log,
java-red-validation.log, gradle.log, java-results.json, java-contract.log, node-full.log, typecheck.log,
dependencies.log, jdeps.log, java-format.log다. 최종 JAR의 빌드가 끝난 후 전체 프로세스 회귀를 실행했다.

이는 HTTP/WebSocket 계약 검증이다. 브라우저의 실제 focus 표시·cursor 애니메이션, 고빈도 cursor 부하,
영속 저장·서버 재시작 복원까지 검증한 것은 아니다. Node가 계속 기본 서버다.
다음 단계는 영속성 도입에 앞서 Java 계층 의존성 규칙을 CI 테스트로 고정하는 것이다.
