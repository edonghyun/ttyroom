# 저장 생략 테스트를 행동별로 분리 — P4a

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-28. [품질 리뷰](2026-09-25-node-java-quality-review.md)의 테스트 표현 항목을 이어서 정리했다.
`RoomPersistenceTests.liveOnlyAndSameValueChangesDoNotWriteButStillPublishTheirContractedEvents`
하나에 묶였던 여덟 행동을 각각 독립된 fixture에서 검증한다. production 코드는 변경하지 않았다.

## 발견한 읽기·검증 문제

이전 테스트는 lease 획득, focus, cursor, 입력 허용, 동일 제목, 동일 geometry, 출력, host 단절을
연속 실행했다. 마지막 저장 횟수만으로 어느 행동이 저장을 추가했는지 알기 어려웠다.
알림은 geometry 발행과 rename 미발행만 검증해, 다른 행동이 아무것도 하지 않아도 통과할 여지가 있었다.

기존 TypeScript의 `persistence-contract.spec.ts`에도 여러 live 행동을 묶은 테스트가 있다.
저장 생략과 알림·출력을 함께 검증하는 기준은 유지하되, 그 복합 본문 자체를 복제하지 않았다.

## 변경한 구조

- lease 획득·focus·cursor 제거·입력 허용은 같은 계약인 **저장 추가 없음 + 정확한 알림 발행**을
  파라미터화했다. provider는 사례 이름, 행동, 불변 기대 알림만 제공한다. 본문에 사례별 분기는 없다.
- host 단절은 입력 허용과 lease가 있는 기존 전제를 준비한 별도 테스트로 둔다. 준비 과정은 결과
  assertion과 분리하며, 단절이 저장을 추가하지 않고 `HostOffline`을 알리는지 검증한다.
- 같은 제목은 저장·알림 모두 생략하고, 요청을 잘못 거절하지 않는지 검증한다.
- 같은 geometry는 저장을 생략하지만 `TerminalGeometryChanged`를 발행한다. 제목과 기대 결과가
  달라 별도 테스트로 읽을 수 있게 했다.
- 출력은 저장 생략과 실제 수신 frame의 terminal ID·sequence·payload를 함께 검증한다.

`Fixture.terminal(id)`는 저장 record의 중첩 경로를 숨긴 준비용 조회다.
`Probe.noticesSince(count)`는 준비 후 추가된 알림의 복사본을 반환한다. 정렬·타입 필터·중복 제거를
하지 않으며, `containsExactly`로 예상 밖 알림과 중복도 검출한다. 모든 사례는 독립된 방을 만든다.

## 검증과 범위

변경 전 `RoomPersistenceTests` GREEN을 확인했고, 분리한 테스트도 기존 production 구현에서 통과했다.
이번 변경은 **테스트 리팩터링과 기존 동작의 특성화**이며 새 기능 TDD의 RED → GREEN은 아니다.
기록은 `artifacts/migration-baseline/p4a-persistence-test-scenarios/`의 변경 전 소스와 실행 로그,
최종 diff·hash에 남긴다.

리뷰의 다른 긴 실패·재시도 시나리오를 모두 분리한 것은 아니다. 수신 순서 전체의 Node/Java 비교와
SQLite 파일 저장·실제 재시작 복구도 이 변경의 검증 범위에 포함하지 않는다.

최종 Java 전체 **290개**가 실패·오류·건너뜀 없이 통과했다. 기존 복합 테스트 1개를 8개 사례로
나눠 7개가 늘었다. Java·문서 포맷 검사도 통과했다. production 변경이 없어 JAR E2E는 재실행하지
않았다. 직전 P3z의 공통 E2E 168개 통과는 이전 실행 기록이다.
