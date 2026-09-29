# 저장·동시성 테스트의 관찰과 가독성 — P3y

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-27. 타이머 구현을 바꾸기 전에 `RoomPersistenceTests`의 대기 관찰과 시나리오 표현을 정리했다.
production 코드와 타이머 구현은 변경하지 않았다.

## 실제로 재현한 테스트 장치의 결함

기존 `PendingCall.awaitBlocked()`는 `Thread.State.WAITING`이면 명령이 방 순서 또는 종료 drain을
기다린다고 판단했다. 그러나 방 명령과 무관한 latch를 기다려도 같은 상태가 된다.

`waitingOnAnUnrelatedLatchDoesNotCountAsAnAcceptedRoomCommand`를 먼저 추가했다. 별도 worker를
무관한 latch에서 멈추고 방 명령으로 인정하지 않아야 한다는 기대를 검증했다.

1. 첫 실행은 fixture가 제한 시간 있는 latch 대기를 사용해 다른 이유로 실패했다. 이 실행은
   `probe-fixture-failure.log`로 보존했으며 의도한 RED로 취급하지 않는다.
2. fixture를 수정한 뒤 기존 장치가 무관한 대기를 받아들이는 assertion 실패를 확인했다:
   `probe-red.log`.
3. 대상 방의 실제 명령 대기 큐 관찰로 바꾸고 같은 테스트가 통과했다: `probe-green.log`.
4. 시나리오를 분리한 뒤 기존 저장·종료 테스트도 통과했다: `refactored-tests.log`.

이 부분은 테스트 장치의 거짓 양성에 대한 RED → GREEN이다. 뒤따른 본문 정리는 행동 보존
리팩터링이며 새로운 production 기능의 TDD라고 부르지 않는다.

## 대기 관찰의 보장과 비용

- `fixture.awaitRoomQueued(call)`은 해당 Room의 `ReentrantLock.hasQueuedThread`를 확인한다.
  이 큐에는 directory 수명 read lock을 얻은 뒤 진입하므로, 종료 전에 접수된 명령이라는 기존
  shutdown 테스트의 전제를 유지한다.
- `fixture.awaitStorageDrain(shutdown)`은 directory 수명 lock에서 종료 thread가 실제로 대기함을
  확인한다. 그 후 신규 요청 거절과 저장소가 아직 열려 있음을 관찰한다.
- 단순히 thread가 시작했다는 latch 또는 아직 완료되지 않은 Future로 대체하지 않았다. 그것만으로는
  명령이 종료 전에 접수됐다는 사실을 보장하지 못하기 때문이다.
- 조건을 최대 5초 동안 확인한다. 짧은 polling 간격은 CPU 점유를 줄이기 위한 것이며, 시간이 지났다는
  이유로 접수됐다고 판정하지 않는다. 저장 gate는 관찰이 끝날 때까지 대상 큐를 유지한다.

**이는 완전히 black-box인 검증이 아니다.** 접수 확인을 위한 공개 API가 없어 fixture의 `lockField`
한곳에서 reflection으로 `commands`와 `lifetime`을 읽는다. 운영 코드에 테스트 전용 API를 추가하지
않는 대신 현재 lock 구조에 명시적으로 의존한다. JDK 내부 field는 읽지 않는다. 직렬화 구현을 바꾸면
이 좁은 관찰 지점도 다시 검토해야 한다. 일반 업무 assertion에 reflection을 확산하는 기준은 아니다.

최종 판정은 여전히 상태·이벤트·저장소 종료 순서를 검증한다. 큐 관찰은 실행 전제의 확정에만 사용한다.

## 기존 컨벤션에 맞춘 표현

한 본문에서 여러 계약을 검증하던 테스트를 다음 세 개로 분리했다.

- 저장 중에는 이전 확정 상태가 보이고 input/output/cursor는 진행한다.
- 다른 방은 이 방의 저장 완료를 기다리지 않고 저장할 수 있다.
- 같은 방의 후속 rename은 앞선 저장 뒤에 확정되고 같은 순서로 알린다.

각 테스트는 독립적인 `Fixture.editableRoom()`을 사용한다. 이전 테스트의 성공이나 상태에 의존하지
않는다. 준비 단계의 공통 기능 검증을 반복하지 않고 행동과 관찰값 수집 뒤에 assertion을 둔다.

`Probe.renameTerminal()`은 업무 행동을, `assertStoredTerminalTitle()`은 저장 결과의 의미를 드러낸다.
`noticesOf()`는 타입별 이벤트를 추출하되 순서나 중복을 바꾸지 않는다. `savedRecord()`는 live 상태와
저장 상태를 이름으로 구별한다. 간단한 도메인 호출과 AssertJ 검증은 그대로 유지했다.

## 검증 범위

최종 Java 전체 280개가 실패/오류/건너뜀 없이 통과했다. 기존 277개에서 장치 회귀 테스트 1개와
시나리오 분리로 2개가 늘었다. 테스트와 문서만 바꿨으므로 실제 JAR E2E는 재실행하지 않았다.
직전 P3x의 공통 Spring 프로세스 E2E 168개 통과와 이번 실행을 구분한다.

근거: `artifacts/migration-baseline/p3y-concurrency-tests/`의 위 로그, `java-tests.log`, 변경 전 소스와
`test-refactoring.diff`, `java-counts.txt`, `verified-hashes.txt`.
타이머 상속/Future 계약 변경과 SQLite 구현은 후속 작업이다.
