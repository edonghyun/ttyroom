# 명령 결과와 live 상태 변경 분리 — P3w

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-27. [방 변경 경계](2026-09-27-room-change-boundary.md)에 이어 명령이 반환하던
`Runnable`을 제거했다. 동작을 실행하는 callback과 명령의 결과 값을 구분하는 리팩터링이다.

## 이전의 읽기 부담

`Function<RoomControl, Runnable>`의 반환 값에는 방송, host 요청, lease 변경, focus 변경,
입력 허용 상태 변경이 섞여 있었다. `change.result().run()`을 보고 상태가 이미 확정됐는지,
이제 변경되는지 알기 어려웠다. `live(...)`도 연결 확인과 지연 실행을 함께 숨겼다.

## 현재 구조

```text
내구 상태 명령
  RoomDirectory.execute → changeIf
    draft 변경 → ChangeResult → 필요하면 저장 → commit → publish(result)

live 명령
  RoomDirectory.execute → runIf
    현재 세션 확인 → 상태 변경 / 전송

input / output / cursor / disconnect
  기존처럼 짧은 상태 monitor만 사용
```

두 명령 경로는 같은 방별 명령 순서와 같은 상태 monitor를 사용한다. live 경로는 저장용 draft를
복제하지 않지만 앞선 저장을 추월하지 않는다. 고빈도 데이터 경로의 우회 정책은 그대로다.

`ChangeResult`는 `RoomSessions` 내부의 다섯 종류 값이다.

| 결과          | 확정 후 처리                                                    |
| ------------- | --------------------------------------------------------------- |
| `Unchanged`   | 전송 없음                                                       |
| `Reply`       | 여전히 유효한 요청 세션에 응답                                  |
| `Broadcast`   | 현재 참여자들에게 확정 결과 알림                                |
| `HostRequest` | 캡처한 host의 현재 연결/identity를 확인한 뒤 요청               |
| `Inventory`   | 복구 결과와 현재 연결 상태에 따라 Ready/Connected/terminal 알림 |

이 값에는 실행할 함수가 없다. `publish`는 exhaustive switch로 결과를 처리한다. 메시지마다
handler나 결과 클래스를 만들지 않고 실제 전달 의미를 공유하는 다섯 종류로 제한했다.
`HostRequest`의 Member 참조는 동일 host 연결 여부를 판단하기 위한 내부 문맥이며 저장 DTO가 아니다.

lease 획득·반납, focus, replay, host 입력 허용, close/resize 전달은 `executeLive` 경로에서 바로
처리한다. lease 변경은 기존 `RoomControl` 정책을 사용하고, 그 다음 응답과 알림을 보낸다.
`Runnable`은 이 동기 작업을 경계 안에서 실행하는 인자로만 남으며 명령의 결과로 반환되지 않는다.

## 유지한 실패 의미

- 저장 실패 시 결과를 전달하지 않고 기존 상태를 유지한다.
- 저장 중 요청자가 끊겨도 이미 저장한 변경의 방송을 생략하지 않는다. 개인 응답은 현재 세션만 받는다.
- host 생성 지시 직전에는 캡처한 host의 연결과 identity를 다시 확인한다. 실패 시 재전송하지 않는다.
- inventory 저장 중 disconnect된 host를 다시 online으로 만들지 않는다. 확정된 terminal 복구는 알린다.
- lease 수락 응답이 실패해도 이미 획득한 lease는 유지하며 다른 관찰자에게 알린다.
- live 경로도 기존 명령 순서와 종료 drain에 포함되며 예상하지 못한 예외는 전파한다.

전송 실패 때문에 연결 상태를 정리하거나 inventory 확정 뒤 presence를 갱신하는 일은 여전히
application의 책임이다. 모든 후속 처리가 순수 함수라는 뜻은 아니다. 도메인 변경을 임의의
실행 함수에 넣어 나중에 호출하던 모호함을 제거한 것이다.

## 검증과 재리뷰

- 새 행동 테스트: mode 저장을 막고 lease 획득을 접수한다. 저장 완료 뒤 SHARED 모드를 기준으로
  거절하며 lease가 남지 않음을 확인한다. 이 테스트는 변경 전 구현에서도 통과한 특성화 테스트다.
- 기존 저장 실패·세션 교체·단절·송신 실패·만료·종료 테스트의 기대값은 수정하지 않았다.
- Java 전체 271개 통과, 실패/오류/건너뜀 0. `bootJar` 통과.
- 실제 Spring JAR 공통 E2E 168개 / 12개 파일 통과. 실제 Connector PTY 시나리오 포함.
- Java 소스·테스트와 변경 문서 포맷 검사 통과. 최종 소스·테스트·JAR SHA-256 확인.

근거는 `artifacts/migration-baseline/p3w-command-results/`의 `baseline-tests.log`,
`targeted-tests.log`, `java-tests-and-jar.log`, `java-final-tests.log`, `java-counts.txt`,
`spring-e2e.log`, `application.diff`, `verified-hashes.txt`에 남긴다.

host 관계 불변식, 타이머 상속 계약, 테스트 대기 장치 개선, SQLite adapter는 이번 변경에 포함하지
않았다. 다음은 미등록 host의 terminal 생성과 복원 경로에서 관계를 보장하는 도메인 경계다.
