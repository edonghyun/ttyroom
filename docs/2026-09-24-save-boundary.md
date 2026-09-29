# 저장 성공 뒤 상태 확정과 알림 — P3u

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-24. [내구 상태 모델](2026-09-24-durable-room-model.md)에 방별 저장 조정 경계를 연결했다.
**저장 대역으로 실행 순서와 실패를 검증한 단계다. 기본 실행은 여전히 메모리 전용이며 SQLite 파일 저장과
실제 서버 재시작 복구는 다음 단계다.**

## 변경을 확정하는 경계

```text
제어 명령 / 입장 / 만료
  → RoomDirectory: 작업 접수 + 방별 명령 순서
  → Presence monitor: 현재 세션 확인, 독립 draft와 결과 준비
  → monitor 해제: 변경된 내구 값만 RoomStore.save
  → Presence monitor: commit, 현재 연결 확인, 결과 전달

바이너리 입출력 / cursor
  → Presence monitor: 지금 확정된 상태로 처리
```

- `RoomControl.stageChange`는 workspace, host 식별 정보, lease와 다음 lease ID,
  명시적 생성 확인 이력을 복사한다. 재시작용 restore와 달리 live 제어 상태를 유지한다.
  저장 투영이 달라졌을 때만 `recordToSave`가 생긴다. 실패하면 draft를 버리므로 rollback으로
  이미 들어온 연결·출력 상태를 덮지 않는다. commit은 한 번만 허용한다.
- 호출자는 draft 생성부터 commit/폐기까지 해당 방의 제어 변경을 직렬화해야 한다.
  `RoomDirectory.execute`가 fair lock으로 이 계약을 담당한다. 서로 다른 방은 독립적으로 실행한다.
  Presence monitor는 짧은 상태 접근에 사용하고 저장을 기다리는 동안 놓는다.
- 생성은 save 후 방을 등록하고 초대를 반환한다. 삭제는 delete 후 directory에서 제거한다.
  loadAll/복원 실패는 저장소를 닫고 원래 오류를 전파한다. 실패를 빈 방으로 대체하지 않는다.
- `RoomStore`는 application의 실제 I/O 경계다. 다른 방의 호출이 동시에 들어올 수 있으므로
  adapter는 동시 호출을 다뤄야 한다. domain/application에 JDBC·Jackson·Spring 의존성은 없다.
  기본 `transientOnly()`는 프로세스 메모리 모드이며 디스크 내구성을 제공하지 않는다.

## 실패와 세션 경합

내구 변경은 제목·geometry·mode·생성 예약·생성 확인·종료·metadata·inventory·host 등록/제거에 적용한다.
lease·focus·host 입력 허용 등의 live 명령도 같은 방의 순서를 지나지만 저장하지 않는다.
같은 geometry 재요청은 저장 없이 기존 이벤트를 발행한다.

저장이 실패하면 terminal ID 발급 위치·lease·기존 상태와 알림을 보존한다. application 작업은 원래
예외를 전파하며 다음 명령은 진행할 수 있다. WebSocket adapter에서 처리 실패는 로그에 남기고 해당
연결을 종료한다. 다른 연결의 방 명령까지 중단하지 않는다.

저장 중 disconnect는 즉시 connected=false를 반영한다. 이후 save가 성공하면 해당 상태 변경을
확정하지만 끊긴 host에 생성 지시를 보내거나 inventory 때문에 online=true로 되살리지 않는다.
교체 입장은 같은 방 순서를 기다린 뒤 확정 상태를 읽으며, 이전 만료 callback은 Member identity
검사로 새 연결을 제거하지 못한다. output history와 source/browser seq는 draft에 포함하지 않는다.

**이전 단계에서 바뀐 실패 의미:** host 이름 저장이 성공한 뒤 Welcome 송신이 실패하면 저장한 식별
정보를 유지한다. 후보 Member는 제거하고 기존 연결이 있었다면 유지한다. 저장까지 되돌리면 DB와
메모리가 달라지므로 이전의 “Welcome 실패 시 내구 이름도 이전 값” 테스트를 이 계약으로 수정했다.
반대로 save 자체가 실패하면 Welcome도 보내지 않고 기존 식별 정보/연결을 유지한다.
Node `usecases/connect-host.ts`도 host 내구 변경을 Welcome보다 먼저 확정한다.

## 만료와 종료

- host 만료는 terminal/lease 제거 draft를 저장한 후 Member와 output을 정리하고 알린다.
  save 실패 시 host의 내구 상태와 lease를 유지한다. 실패는 로그와 예외로 관찰 가능하며 자동 재시도는 하지 않는다.
- participant 만료는 live presence/lease를 먼저 제거하고 알린다. 마지막 방 delete가 실패해도
  이미 만료한 participant/lease/focus를 복구하지 않는다. 초대와 저장된 방은 남는다.
- host 제거 save와 마지막 room delete도 별도 확정 단계다. delete 실패가 완료된 host 제거를 되돌리지 않는다.
- `ExpiryTimers`는 만료 시각만 전달하고 실제 만료는 virtual thread로 실행한다. 한 방의 저장 대기가
  타이머 스레드나 다른 방의 만료까지 막지 않는다. 미래의 타이머는 취소하고 이미 접수된 작업은 drain한다.
- 종료 시 신규 directory 작업 접수를 막고, 접수되어 방 순서를 기다리는 명령과 진행 중 저장/만료를
  마친 후 저장소를 닫는다. 종료 시점까지 room ordering에 들어오지 않은 만료 작업은 취소된다.

## WebSocket 수신 경계

Presence monitor만 해제하고 수신 콜백에서 저장을 기다리면 같은 소켓의 후속 바이너리가 막힌다.
이 실패를 테스트로 재현한 뒤 `ControlInbox`가 연결별 제어 메시지를 FIFO로 실행하도록 분리했다.
실제 송신은 기존 SocketSender가 계속 담당한다.

- 바이너리와 cursor는 제어 수신 대기열을 통과하지 않는다. 입력 권한은 실행 시점의 **확정된 상태**로 판단한다.
  제어 JSON과 바이너리 전체에 하나의 FIFO를 보장한다는 뜻은 아니다. 권한 취득/복구 완료는 응답을 확인해야 한다.
  Node의 현재 ws-transport는 연결 수신을 하나의 promise chain으로 묶으므로, 이 점은 Spring 수신 구현의 차이다.
- 대기량은 실행 중인 명령을 포함하여 연결당 256개, 원문 UTF-8 합계 100 MiB로 제한한다.
  상한을 넘기면 연결을 종료한다. 이 값은 JVM heap 사용량 상한을 뜻하지 않는다.
- hello 전 명령은 **수신 시점**에 거절한다. worker를 기다리다 나중 hello의 인증을 얻지 못한다.
  이 경합도 의도적으로 worker를 막은 테스트에서 실패를 확인한 후 수정했다.
- 정상 종료는 제어 수신을 닫고 FIFO를 drain한 뒤 연결을 닫는다. 연결 단절/처리 실패는 대기 명령을
  폐기하지만 이미 저장을 시작한 application 작업은 확정/실패 처리를 끝낸다.

[후속 입력 순서 검증](2026-09-28-input-ordering.md)은 저장 대기 뒤 lease 반납과 binary를 같은
연결로 보낸 사례를 양쪽 실제 세션 로직으로 비교했다. Java는 반납 전 확정 lease로 전달하고,
Node는 앞선 반납 처리 후 거절한다. 실제 사용한 transport·저장 대역의 범위도 함께 기록했다.

## 검증과 리뷰

- `RoomChangeTests` 3개: draft 비노출/ID, live lease ID·생성 확인 이력 보존, live-only/동일 값 저장 생략.
- `RoomPersistenceTests` 22개: 8종 내구 명령 저장 실패, 생성 비노출, 같은 방 순서/다른 방 진행,
  저장 중 입출력/cursor, 세션 교체/단절, host/participant 만료, delete 실패, load 실패와 종료 drain.
- `ControlInboxTests` 5개와 `ExpiryTimersTests` 2개: 대기 상한·FIFO·종료·실패·만료 독립 실행.
- `RoomSocketHandlerTests` 2개 추가: 같은 연결의 수신 콜백/binary 진행과 pre-hello 경합.
- gate/latch로 저장 시점을 고정하고, 행동 완료 후 상태·알림을 검증한다. sleep으로 저장 순서를 추측하지 않는다.
  방 lock을 기다리는 테스트 thread는 WAITING 상태를 제한 시간 내 확인한다.
- 모델 API 부재의 컴파일 RED와 수신 콜백/pre-hello의 동작 RED를 구분해 남겼다.
- 새 일반 이벤트 버스·트랜잭션 annotation·JPA·메시지 브로커를 도입하지 않았다.
  I/O 성공, 모델 확정, 소켓 송신 수락은 여전히 다른 보장이다.

Java 전체 **270개**와 bootJar가 통과했으며, 계층 의존성 검사 5개도 포함한다.
최종 Spring JAR의 기존 HTTP/WebSocket/Connector 계약 **168개 / 12개 파일**도 통과했다.
SQLite 재시작 계약은 이번 실행에 포함하지 않았다.

실행 근거: `artifacts/migration-baseline/p3u-save-boundary/`의 `java-final-tests.log`, `java-counts.txt`,
`jar-final.log`, `receiver-red.log`, `prehello-red.log`, `spring-e2e-final.log`와 `verified-hashes.txt`.
이번 변경은 실제 DB I/O·강제 프로세스 종료·저장 응답 손실 후 재시도·분산 트랜잭션을 검증하지 않는다.

## 다음 작업

SQLite adapter와 부팅 연결: Node schemaVersion=1 저장 파일 호환, TTYROOM_STATE_PATH,
원자적 save/delete, 잘못된 파일의 부팅 실패와 close를 실제 파일로 검증한다.
그 후 `persistence.e2e.ts`의 서버 재시작 및 살아 있는 Connector PTY 복구 인수를 Spring에서 실행한다.
