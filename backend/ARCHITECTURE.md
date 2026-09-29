# 백엔드 설계

백엔드는 방 상태와 입력 정책을 관리하고 브라우저와 Connector 사이의 메시지를 중계한다.
설계 기준은 **불변식, 책임 소유자, 실패 의미와 검증 방식**이다.
파일 수나 패턴 이름보다 호출자가 알아야 할 조건과 순서를 줄이는 데 집중한다.

## 책임과 의존성

| 경계             | 소유한 책임                                                    | 알지 않는 것                    |
| ---------------- | -------------------------------------------------------------- | ------------------------------- |
| `domain`         | terminal 생명주기·소유권, 입력 모드, lease, 영속 상태의 불변식 | Spring, JSON, 소켓, JDBC        |
| `application`    | 방별 명령 순서, 저장·commit 조정, 세션 동일성, 만료, 출력 보관 | HTTP/WS 직렬화와 저장 파일 표현 |
| `adapter`        | HTTP/WS 규약, 송신 큐·deadline, SQLite, 설정 읽기              | 독자적인 업무 정책              |
| composition root | 설정값과 구현체 조립, 생성·종료 수명                           | 업무 규칙의 중복 구현           |

[ArchitectureTests](src/test/java/dev/ttyroom/architecture/ArchitectureTests.java)가 production
바이트코드의 계층 의존성을 검사한다. domain/application은 Spring이나 Jackson에 의존하지 않는다.
[RoomProtocol](src/main/java/dev/ttyroom/adapter/ws/RoomProtocol.java)은 업무 결과를 wire 메시지로
변환하며 새 결과 종류의 처리는 exhaustive switch로 확인한다.

## 방의 변경과 저장

[RoomDirectory](src/main/java/dev/ttyroom/application/RoomDirectory.java)는 방의 영속 상태와
명령 순서, 저장소 수명을 소유한다. `RoomOperation.changeIf`가 다음 순서를 묶는다.

1. 같은 방의 명령 순서 안에서 적용 조건을 확인하고 독립 draft를 만든다.
2. 영속 레코드가 달라졌으면 저장한다. 저장 중에는 상태 monitor를 놓는다.
3. 저장이 성공하면 상태 monitor 안에서 commit하고 후속 효과를 처리한다.

저장 실패는 상태·ID·알림을 노출하지 않는다. 저장 뒤 eligibility는 다시 검사하지 않으므로
그동안 연결이 끊겨도 이미 시작한 저장 결정을 확정할 수 있다. 전달 단계가 현재 연결을 확인한다.
lease·focus 같은 live 제어는 같은 명령 순서를 사용하되 draft·저장을 생략한다.
입력·출력·cursor와 단절 처리는 짧은 상태 monitor에서 확정된 상태를 사용한다.

명령 lock은 방별이지만 저장 장치의 처리량까지 방마다 독립적인 것은 아니다.
전체 흐름과 실패 경로는 [시퀀스 도식](../docs/ARCHITECTURE.md),
검증은 [RoomPersistenceTests](src/test/java/dev/ttyroom/application/RoomPersistenceTests.java)를 따른다.

## 업무 판단과 전달 효과

[RoomControl](src/main/java/dev/ttyroom/domain/RoomControl.java)은 terminal·lease를 함께 보며
입력 허용과 명령의 선행조건을 판단한다. 호출자가 workspace와 lease 상태를 따로 조합하지 않는다.
[TerminalWorkspace](src/main/java/dev/ttyroom/domain/TerminalWorkspace.java)는 Pending/Running/Exited,
runtime 동일성, 소유 host, ID와 메타데이터를 소유한다.

[RoomSessions](src/main/java/dev/ttyroom/application/RoomSessions.java)는 현재 연결, 역할,
연결 교체·만료와 결과 전달을 맡는다. `ChangeResult`는 변경 결과를 Reply/Broadcast/HostRequest
등으로 표현하고 commit 뒤 발행한다. 업무 변경이 임의의 전송 callback을 만들지 않는다.

`Peer`는 네트워크 I/O 완료가 아닌 큐 수락 계약이다.
[SocketSender](src/main/java/dev/ttyroom/adapter/ws/SocketSender.java)가 실제 쓰기, 한도,
FIFO와 deadline을 소유한다. 수신자별 `PeerUnavailable`은 해당 연결만 정리하고 다음 수신자로
진행한다. 예상 밖 구현 예외는 전파한다. 어느 실패도 저장된 결정을 되돌리지 않는다.
commit과 전송은 원자적이지 않으며 outbox나 지속적 메시지 전달은 구현하지 않았다.

## 재접속·출력·수명주기

Connector가 실제 PTY와 runtimeId를 소유한다. 서버는 inventory를 저장된 workspace와 대조한다.
[TerminalOutput](src/main/java/dev/ttyroom/application/TerminalOutput.java)은 source 순번 중복 제거,
browser 순번, 제한된 history와 수신자별 output gap을 소유한다.
저장된 terminal 복원과 실제 셸 생존은 별개이며 입력을 자동 재실행하지 않는다.

교체된 연결의 늦은 disconnect·expiry는 현재 Member 동일성 검사로 무시한다.
만료 타이머의 취소가 이미 전달된 callback까지 없앤다고 가정하지 않는다.
방 저장소 종료는 수락한 작업이 끝난 뒤 처리하며, 각 모듈이 만든 자원의 종료를 소유한다.

## 변경·리뷰 기준

- 새 기능은 입력·결과·실패 의미를 먼저 정하고 작은 행동 계약으로 검증한다.
- 기존 동작이 불명확하면 특성 테스트를 추가한다. 이미 통과한 테스트를 RED라고 기록하지 않는다.
- 호출자가 반복해서 알아야 하는 저장·실패·수명 지식을 해당 소유자 안으로 모은다.
- 독립적인 변경 이유나 호출 부담 감소가 없는 wrapper·service·범용 이벤트 버스는 추가하지 않는다.
- wire 표현은 adapter와 프로토콜 E2E에서, 업무 상태는 domain/application 테스트에서 검증한다.

[Java 테스트 기준](TESTING.md)과 [공통 코드 가이드](../docs/CODE_STYLE.md)를 함께 적용한다.
저장소는 단일 서버 프로세스를 전제로 하며 분산 lease·입력 exactly-once·무한 replay를 보장하지 않는다.
현재 v7의 초대 토큰·역할 신뢰와 후속 인증 과제는 [보안 모델](../docs/SECURITY_MODEL.md)에 있다.

개발 당시의 구조 비교와 단계별 변경은 [설계 이력](history/design-notes.md)에 보관한다.
