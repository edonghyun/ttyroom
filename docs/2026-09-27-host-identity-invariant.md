# Host 식별 정보와 terminal 관계 — P3x

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-27. [품질 리뷰](2026-09-25-node-java-quality-review.md)의 host–terminal 불변식을 보강했다.
이번 변경은 단순 리팩터링과 달리 잘못된 도메인 호출과 저장 상태를 더 엄격하게 거절한다.
정상 HTTP/WebSocket 요청의 동작과 실패 응답은 기존 계약을 유지한다.

## 규칙과 소유자

방의 모든 terminal은 같은 방에 등록된 host 식별 정보를 참조해야 한다. Pending, Running,
Exited 모두 해당한다. host가 offline이어도 식별 정보는 남을 수 있으므로 연결 상태와는 다른 규칙이다.

- `RoomControl.openTerminal()`은 host 등록을 확인한 뒤 ID를 발급한다.
- `RoomControl.reconcileTerminals()`는 빈 inventory도 등록 여부를 먼저 확인한다. 미등록 host가
  terminal을 복구하거나 ID 발급 위치를 바꾸지 못한다.
- `RoomControl.DurableState`는 중복 host ID와 terminal의 host 참조를 검증한다. 잘못된 값은 생성
  단계에서 실패하므로 `restore()`에 전달되지 않는다. 누락된 host를 임의로 만들거나 terminal을
  조용히 삭제하지 않는다.

등록 여부는 host 목록을 소유한 `RoomControl`이 보장한다. `TerminalWorkspace`는 ID·runtime·생명주기를
계속 소유하며 host 목록이나 연결 상태를 중복 보관하지 않는다. 별도 validator/service/예외 계층을
추가하지 않고 기존 `IllegalArgumentException` 방식으로 잘못된 도메인 인자와 저장 값을 거절한다.

application의 online host 검사는 그대로 필요하다. 등록은 내구 식별 정보의 존재를 뜻하고,
현재 연결에 PTY 생성 지시를 전달할 수 있는지는 세션 경계의 정책이기 때문이다.

## 기존 코드와 fixture 조정

기존 TS `TerminalWorkspace.openTerminal()`도 미등록 host 생성을 거절한다. Java에서는 host 목록이
`RoomControl`에 있으므로 그 경계에 같은 선행조건을 두었다.

일부 도메인 테스트가 host 등록 없이 terminal을 만들고 있었다. 해당 fixture에 명시적 host 등록을
추가했다. host 제거 후 ID 발급 위치를 검증하는 테스트는 복원 당시 host 목록을 먼저 관찰하고,
다시 host를 등록한 뒤 다음 생성 또는 ID 소진을 검증하도록 바꿨다. ID·lease·생명주기 기대값을 낮추지 않았다.

## 검증

새 `RoomHostInvariantTests` 6개가 변경 전 실제 assertion 실패를 보였다.

- 미등록 host 생성 거절, 상태와 다음 ID 보존: 1개.
- 미등록 host의 빈 inventory와 runtime 포함 inventory 거절, 상태·lease·다음 ID 보존: 2개.
- Pending/Running/Exited terminal의 host가 빠진 저장 값 거절: 3개.

수정 후 새 테스트와 기존 도메인 테스트가 통과했다. Java 전체 277개도 실패/오류/건너뜀 없이
통과했고 `bootJar`를 생성했다. 실제 Spring JAR 공통 E2E 168개 / 12개 파일도 통과했다.
Java·문서 포맷 검사와 실행 소스·테스트·JAR의 SHA-256 일치를 확인했다.

근거는 `artifacts/migration-baseline/p3x-host-invariant/`의 `red-tests.log`, `domain-tests.log`,
`java-tests-and-jar.log`, `java-counts.txt`, `spring-e2e.log`, `domain-and-tests.diff`,
`verified-hashes.txt`와 변경 전 소스에 남긴다.
이번 복원 검증은 값 모델의 계약이며 실제 SQLite 파일이나 서버 재시작 복구를 구현한 것은 아니다.

다음 품질 항목은 `ExpiryTimers`의 상속과 반환 Future 계약이다.
