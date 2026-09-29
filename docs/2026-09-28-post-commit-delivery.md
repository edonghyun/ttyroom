# 저장 성공 후 알림 실패 검토

## 판단

검토한 RoomSessions와 SocketSender의 실패 처리 경계에서는 운영 코드 수정이 필요한
오류를 발견하지 않았다. 저장 성공과 네트워크 전달 성공은 별개의 계약이다.

- RoomOperation.changeIf는 save → commit → publish 순서를 유지한다.
- RoomSessions.broadcast는 수신자별 PeerUnavailable을 처리하고 다음 참가자로 진행한다.
  실패한 수신자를 정리해도 이미 commit한 변경을 되돌리지 않는다.
- 예상 밖 구현 예외는 정상적인 연결 장애로 숨기지 않고 전파한다. 이 경우 모든
  수신자에게 알림이 계속된다는 보장은 없다. 이미 저장한 상태는 유지된다.
- disconnected는 현재 등록된 Member와 동일한 연결인지 확인한다. 교체된 연결의
  늦은 disconnect/expiry가 새 연결을 정리하지 못한다.
- SocketSender의 실제 쓰기는 별도 worker에서 실행된다. 쓰기 실패·시간 초과는
  해당 sender를 종료하며, enqueue 성공은 실제 네트워크 전달 성공을 의미하지 않는다.

## 추가한 계약 테스트

RoomPersistenceTests의 기존 editableRoom fixture와 관찰 API를 사용했다.
새 helper나 운영 코드 계층은 추가하지 않았다.

1. rename 알림의 첫 참가자에게 PeerUnavailable이 발생해도 뒤 참가자는 정확히 한 번
   알림을 받고, 저장 상태와 메모리 상태는 새 제목이며 저장은 한 번만 추가된다.
   실패한 참가자만 닫힌다.
2. rename 알림에서 예상 밖 예외가 발생하면 동일한 예외가 전파되지만 저장·commit 결과는
   유지되며 저장을 재시도하지 않는다.

두 테스트 모두 현재 구현에서 통과했다. 오류를 재현한 RED → GREEN이 아니라
이미 의도한 동작의 특성 테스트 보강이다.

## 재사용한 기존 검증

- RoomSessionsTests.commandsAndDisconnectFromAReplacedHostCannotChangeTheNewSession
- RoomPersistenceTests.replacementWaitsForCommitAndAnOldExpiryCannotRemoveTheNewConnection
- SocketSenderTests.aFailedWriteDisconnectsOnceAndRejectsFutureMessages
- SocketSenderTests.anAlreadyRunningOldDeadlineCannotCloseTheNextWrite

Java 전체 테스트 355개 통과, 실패·오류·skip 0개.
운영 코드는 변경하지 않았으며 브라우저/프로토콜 E2E는 이번 단계에서 재실행하지 않았다.
이 검증은 durable delivery, 자동 재전송, exactly-once 전달을 보장하지 않는다.
