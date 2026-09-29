# 방 변경의 저장·commit 경계 — P3v

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-27. [품질 비교 리뷰](2026-09-25-node-java-quality-review.md)의 첫 번째 항목을 정리했다.
입장·명령·만료의 동작과 실패 의미를 유지하는 리팩터링이다.

## 변경

기존 `RoomSessions`의 세 경로는 각각 draft 생성, monitor 해제, 저장, monitor 재획득,
commit을 관리했다. 이제 `RoomDirectory.RoomOperation.changeIf()` 한곳에서 실행한다.

```text
RoomDirectory.execute(room, operation)
  방 명령 순서 / 종료 drain 범위
    operation.changeIf(적용 조건, draft 변경, 확정 후 처리)
      room monitor: 조건 확인 + draft 변경
      monitor 밖: 필요한 경우 저장
      room monitor: commit + 확정 후 처리
    필요하면 operation.remove(): 저장소 삭제 후 directory 제거
```

- `RoomOperation`은 `execute` 안에서만 사용하는 방 작업 범위다. 별도 서비스나 저장소 포트를
  추가하지 않고 기존 `RoomDirectory` 안에 두었다.
- 호출자는 저장 필요 여부, draft 수명, commit 호출, 저장 중 monitor 해제를 관리하지 않는다.
  적용 조건은 draft 변경과 같은 monitor에서 확인하여 그 사이 연결 단절이 끼어들지 않는다.
- 적용 조건이 거짓이면 변경과 확정 후 처리를 생략하고 null을 반환한다. 입장은 세션 또는 null,
  만료는 방이 비었는지 여부를 결과로 사용한다.
- 상태 monitor를 `Presence`에서 `RoomDirectory.Room`으로 옮겼다. input/output/cursor/disconnect도
  같은 monitor를 사용하며 명령 순서 대기를 거치지 않는다. `durableState()` 조회 역시 이 monitor로
  보호한다. 방별 명령 lock과 짧은 상태 monitor의 서로 다른 역할은 유지했다.
- 세션 교체와 Welcome 실패 처리는 `attach`, 만료 후 presence/알림 정리는 `removeExpiredMember`에
  남겼다. Directory가 Peer나 Member 정책을 알 필요는 없다.

## 이 인터페이스를 선택한 이유

기존 TypeScript `RoomRegistry.change()`의 장점인 저장 순서 은닉을 가져왔다. Java는 저장 대기 중에도
다른 스레드의 disconnect와 입출력이 진행하므로, 세션 조건과 확정 후 처리가 상태 monitor 아래
실행된다는 계약이 추가로 필요하다. 세 callback은 적용 조건·업무 변경·확정 후 동작을 나타내며,
별도 monitor나 저장소를 인자로 전달하지 않는다.

작업 범위와 변경을 구분한 이유는 만료다. host 제거 저장과 마지막 방 삭제는 같은 명령 순서 안에서
실행하지만 서로 다른 확정 단계다. `changeIf()`가 반환한 뒤 명령 순서를 먼저 풀면 새 입장이 방 삭제
앞에 끼어들 수 있다. `execute`는 삭제와 presence 정리까지 포함하고, `remove()`는 상태 monitor 밖에서
저장을 기다린다. 순서 보호를 위해 새 callback 계층이나 범용 이벤트 버스를 추가하지 않았다.

## 유지한 실패 계약

- 저장 실패: draft 폐기, 기존 상태/ID/lease 유지, 확정 후 동작 없음.
- 저장 중 disconnect: 즉시 live 상태에 반영. 이미 저장한 결정은 commit하고, 연결 가용성은
  기존 후속 처리에서 다시 판단한다. 저장 뒤 적용 조건을 재검사해 commit을 버리지 않는다.
- Welcome 실패: 이전 Member 복구, 이미 저장한 host 식별 정보는 유지.
- host 만료 저장 실패: host/terminal/lease 유지.
- 마지막 방 delete 실패: 이미 확정한 host 제거 또는 participant 만료를 되돌리지 않음.
- 종료: 이미 접수되어 기다리는 명령과 진행 중 저장/만료를 마친 뒤 저장소 종료.

## 범위와 후속 검토

`RoomSessions`에서 `RoomControl.Change`, `stageChange`, `commit`, 직접 `save` 호출을 제거했다.
실시간 경로에는 짧은 상태 잠금이 여전히 필요하다. 모든 동시성 지식을 감췄다는 의미는 아니다.
기존 `Runnable`이 도메인 변경과 후속 효과를 함께 표현하는 문제는 다음 독립 리팩터링으로 남긴다.
host 관계 불변식, 타이머 API, SQLite adapter와 테스트 표현 개선도 이번 변경에 섞지 않았다.

## 검증

- 변경 전 `RoomPersistenceTests`와 `RoomSessionsTests` 통과.
- 변경 후 같은 테스트 통과. 테스트의 assertion이나 기대 동작은 수정하지 않았다.
- Java 전체 270개 통과, 실패/오류/건너뜀 0. `bootJar` 통과.
- 실제 Spring JAR의 공통 E2E 168개 / 12개 파일 통과. 실제 Connector의 PTY 시나리오 포함.
- Java 소스 및 변경 문서 포맷 검사 통과. E2E 완료 후 실행 JAR와 두 소스의 SHA-256 일치 확인.

근거: `artifacts/migration-baseline/p3v-room-change-boundary/`의 변경 전 두 소스,
`targeted-tests.log`, `java-tests-and-jar.log`, `java-counts.txt`, `spring-e2e.log`,
`application.diff`, `verified-hashes.txt`.
이 검증은 실제 SQLite 저장/재시작 복구를 포함하지 않는다.
