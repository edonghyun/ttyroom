# TypeScript / Java 백엔드 품질 비교

> 개발 당시의 기록이다. 언어 변경과 비교 내용은 작업 이력이며, 현재 프로젝트 소개는
> [포트폴리오](PORTFOLIO.md), 구현 상태와 실행 방법은 [백엔드 안내](../backend/README.md)를 따른다.

검토일: 2026-09-25. 대상은 현재 작업 트리의 `legacy/node-server`와 `backend`다.
기준은 기존 리팩터링 로드맵과 `backend/ARCHITECTURE.md`의 정보 은닉, 불변식 소유권,
실패 의미, 읽기 쉬운 행동 테스트다. 프로덕션 코드 변경 없이 검토했다.

후속: 2026-09-27에 첫 항목의 저장·commit 중복을 [방 변경 경계](2026-09-27-room-change-boundary.md)로
모았다. 두 번째 항목은 [명령 결과 분리](2026-09-27-command-results.md)로 정리했다.
세 번째 항목은 [host 식별 불변식](2026-09-27-host-identity-invariant.md)으로 보강했다.
네 번째 항목은 2026-09-28 [만료 예약 계약](2026-09-28-expiry-scheduling.md)으로 정리했다.
다섯 번째 항목은 [대기 관찰·동시성 시나리오](2026-09-27-concurrency-test-conventions.md)와
[저장 생략 시나리오](2026-09-28-persistence-test-scenarios.md)를 우선 정리했다.
아래 진단은 2026-09-25 당시의 근거다. [lease 반납과 binary 순서 비교](2026-09-28-input-ordering.md)는
2026-09-28 P4b에서 특성화했고, SQLite 구현은 후속 작업으로 남아 있다.

## 판단

Java는 typed application boundary와 terminal lifecycle 표현이 좋아졌다. 반면 저장 경계가
추가되면서 application 호출자가 알아야 할 잠금·저장·commit·세션 유효성 규칙이 늘었다.
전체를 더 좋은 설계라고 판정하기는 어렵다. SQLite 구현 전에 이 경계를 먼저 정리하는 편이 좋다.

이는 Spring 자체의 문제가 아니다. TypeScript에도 discriminated union과 포트가 있었으며,
프레임워크나 클래스 개수만으로 설계 품질을 비교하지 않는다. 원래 TS 구현도 작은 use case
클래스가 과도하게 흩어진 부분이 있어 그대로 복제하는 것이 목표는 아니다.

## 우선 개선할 부분

### 1. 저장 경계가 호출 순서를 충분히 숨기지 않는다 — 높음

- TS `src/usecases/room-registry.ts:77`의 `change()`는 방별 직렬화, draft, 저장, commit을 숨긴다.
- Java `RoomSessions.java:264`의 일반 명령, `:168`의 입장, `:768`의 만료는
  `stageChange → save → commit`과 monitor 해제/재획득을 각각 관리한다.
- 저장 중 monitor를 놓아 실시간 데이터를 진행시키는 설계는 타당하다. 문제는 이 규칙을
  여러 업무 흐름이 직접 알고 있어 다음 명령에서도 순서를 올바르게 재현해야 한다는 점이다.

권고: 방 단위 변경 경계가 직렬화·상태 보호·저장·commit을 함께 소유하도록 한다.
단순히 기존 코드를 여러 callback 인자로 옮기는 helper는 피한다. 호출자는 업무 변경과
그 결과를 다루고, 저장 실패 시 미반영 및 저장 성공 후 알림이라는 계약에 의존해야 한다.
입장/만료의 서로 다른 실패 정책은 유지한다. 현재 데이터 손실이 재현됐다는 뜻은 아니다.

### 2. `Runnable`이 결과 전달과 모델 변경을 함께 뜻한다 — 높음

`RoomSessions.java:264`의 `Function<RoomControl, Runnable>`은 draft 변경 뒤 실행할 동작을
반환한다. 이름 변경은 draft에서 일어나지만 lease 획득/반납은 `:409`부터 반환하는
`live(...)` 내부에서 확정 모델을 변경한다. 따라서 `change.result().run()`이 단순 알림인지,
상태 변경인지, 세션 유효성 때문에 생략할 작업인지 호출 형태만 보고 알기 어렵다.

권고: 도메인 변경과 전달 효과의 의미를 명확히 한다. lease 변경을 어디서 확정하는지 한곳에서
보이게 하고, 필요한 명령부터 이름 있는 결과 값으로 표현한다. 모든 메시지에 Command/Handler/
Event 클래스를 하나씩 만들 필요는 없다. 저장 중 연결 단절 후에도 이미 저장된 결정은 유지한다는
기존 계약을 먼저 고정하고 리팩터링해야 한다.

### 3. host–terminal 불변식이 aggregate 밖에 남아 있다 — 중간

TS `src/domain/terminal-workspace.ts:134`는 미등록 host에 터미널 생성을 거부한다.
Java `RoomControl.java:225`는 host 목록을 소유하면서도 `workspace.open(hostId)`에 바로 위임한다.
`reconcileTerminals()`와 `DurableState`의 관계 검증도 함께 점검할 대상이다.

현재 Java 소스를 임시 디렉터리에 컴파일해 실행한 결과:

```text
new RoomControl().openTerminal("unregistered")
→ hosts=0, terminals=1
```

현재 WebSocket/application 생성 경로는 host를 검사하므로 이를 외부에서 재현 가능한 장애로
보고하지 않는다. 다만 도메인 API와 향후 복원 경로가 자체적으로 관계를 보장하지 못한다.
권고: host 식별 정보를 소유하는 `RoomControl`에서 정책을 정의하고 생성·inventory·복원에
일관되게 적용한다. 테스트 fixture도 유효한 host 등록을 통해 상태를 만들도록 맞춘다.

### 4. 타이머 상속이 반환 값의 의미를 바꾼다 — 중간

2026-09-28 P3z에서 [만료 예약 계약](2026-09-28-expiry-scheduling.md)으로 정리했다.
아래는 변경 전 진단이다. 현재는 내부 합성과 취소 전용 핸들을 사용한다.

`ExpiryTimers.java:22`는 `ScheduledThreadPoolExecutor.schedule()`을 재정의하면서
실제 작업을 다른 executor에 전달한다. 반환 Future는 만료 작업이 아니라 전달 작업의 완료다.
현재 소스를 실행해 작업 본문을 latch로 멈추고 `future.get()`을 호출한 결과:

```text
futureDone=true, commandCompleted=false
```

현재 호출부는 주로 취소에 사용하고 Member identity 검사로 오래된 만료를 방어하며,
`close()`는 worker도 기다린다. 지금 종료가 깨진다고 단정할 근거는 없다.
그러나 상속받은 일반 scheduler API를 그대로 믿고 쓰기 어려운 구조다.
권고: scheduler와 worker를 합성하고, 만료 예약/취소/종료라는 실제 계약만 노출한다.
일반 Future의 완료·취소 의미를 유지하려면 실제 작업과 연결하는 별도 구현이 필요하다.

### 5. 테스트의 업무 표현과 동시성 장치가 섞인다 — 중간

후속 P3y에서 `awaitBlocked()`를 대상 큐 관찰로 교체했고, P4a에서 저장 생략 테스트를 행동별로
나눴다. 아래는 변경 전 진단이며, 모든 복합 테스트를 일괄 수정한 것은 아니다.

`RoomPersistenceTests`의 `emptyRoom()`, `restoredRoom()`, 저장 gate는 좋은 방향이다.
저장 실패 후 상태/알림을 검증하는 시나리오도 가치가 있다. 반면 `PendingCall.awaitBlocked()`
(`:784`)는 `Thread.State.WAITING`을 polling한다. 어떤 이유로 기다리는지까지 증명하지 못하며
실행 방식 변경에 민감하다. 중첩된 저장 record 접근도 기대하는 업무 상태를 가린다.

권고: 가능한 곳은 제어 가능한 실행 경계와 관찰 가능한 완료 순서를 검증한다. 시나리오에는
업무 행동과 기대 결과를 남기고, 동시성 장치와 자원 정리는 fixture 안에서 숨긴다.
모든 assertion을 이름만 바꾼 helper로 감싸거나 테스트용 production hook을 남발하지 않는다.
TS 테스트도 조건 분기가 있어 그대로 모범 답안으로 삼지는 않는다.

## 유지할 장점과 패턴 판단

| 영역               | 판단                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ports and Adapters | Java의 wire 파싱/매핑과 typed application command/notice 분리가 좋다. TS도 도메인이 이미 protocol 타입에서 분리되어 있으므로 옛 로드맵의 부채를 현재 코드에 그대로 적용하면 안 된다. |
| Aggregate          | `RoomControl`의 terminal/lease 교차 정책 소유는 적절하다. host 관계까지 닫히면 더 일관된다.                                                                                          |
| 상태 모델링        | `TerminalWorkspace`의 sealed `Pending / Running / Exited`는 불가능한 조합을 줄인다. 별도 State 패턴 클래스 계층을 더할 이유는 없다.                                                  |
| 저장 모델          | Java durable record가 JSON/SQL 스키마를 직접 알지 않는 점은 좋다. 저장 형식 결정은 adapter에 남긴다.                                                                                 |
| 애플리케이션 분해  | TS의 작은 use case 과분해와 Java `RoomSessions`의 책임 집중 사이에서, 독립적으로 이해할 수 있는 책임 단위로 나눈다. 파일 길이만으로 판단하지 않는다.                                 |
| 실패 처리          | 저장 전 live 상태 비노출, 저장 실패 시 상태 보존, 저장 이후 송신 실패를 분리하는 정책은 계속 유지한다.                                                                               |

## 동작 비교에서 별도로 남길 항목

후속 P4b의 [입력 수신 순서 검증](2026-09-28-input-ordering.md)에서 저장 지연 중 lease 반납과
후속 binary를 같은 연결에 보냈을 때의 차이를 테스트로 고정했다. production 정책은 유지했다.
아래는 검토 당시의 문제 제기다.

TS `ws-transport.ts:83`은 같은 연결의 JSON과 binary를 한 Promise chain에 넣는다.
Java `RoomSocketHandler.java:269`는 control만 queue에 넣고 cursor/binary는 우회한다.
이 차이는 `2026-09-24-save-boundary.md`에 이미 명시된 선택이다.

예를 들어 제어 처리가 지연되면 lease 반납 뒤 수신한 입력도 이전 확정 lease로 판단될 수 있다.
수신 순서 전체의 동등성과 저장 중 실시간 진행은 별개 계약이다. 저장 지연을 통제하는
반납/권한 변경+binary 비교 시나리오로 차이를 명시해야 한다. 문서에 없는 새 버그로 분류하지 않는다.

## 다음 작업 순서와 검증 경계

1. 방 변경 경계를 한곳으로 모으고 기존 실패·동시성 계약을 유지한다.
2. `Runnable`이 나타내는 업무 결과와 후속 효과를 명확히 한다.
3. host 관계 불변식과 타이머의 공개 계약을 각각 작은 변경으로 정리한다.
4. 테스트 시나리오의 행동·기대 결과 표현을 다듬고 SQLite adapter로 진행한다.

이번 검토는 소스 비교와 위 두 가지 실행 실험이다. 전체 Java/E2E suite는 재실행하지 않았다.
이전 검증 기록은 현재 리뷰에서 새로 통과시킨 결과로 취급하지 않는다. SQLite 실제 저장/재시작
검증도 아직 이 리뷰의 범위 밖이다. 언어 전환만으로 운영 성숙도가 같아졌다고 판단하지 않는다.
