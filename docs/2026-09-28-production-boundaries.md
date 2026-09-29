# 운영 코드 책임 경계 검토

## 범위와 판단 기준

기존 Node 서버의 `RoomRegistry.change`, `ControlPlane`과 Spring의
`RoomDirectory.RoomOperation`, `RoomSessions`를 비교했다. 프론트엔드는
`RoomAppRuntime`의 종료·화면 투영·공유 geometry 동기화, Connector는
`ConnectorSession`, `ConnectorApp`, `PtyManager`, `OutputReplayBuffer`를 검토했다.
전체 코드의 결함 부재를 보증하는 감사가 아니라, 책임과 상태 소유권에 초점을 둔 검토다.

파일 길이나 패턴 수보다 호출자가 알아야 하는 상태, 실행 순서, 실패 의미를 기준으로 판단했다.

## 유지할 설계

| 영역        | 관찰                                                                                                                                                   | 판단                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 서버 저장   | Node는 room별 queue 안에서 stage → save → commit한다. Spring은 room별 명령 직렬화 안에서 같은 순서를 지키며 저장 중에는 짧은 room monitor를 놓는다.    | Java의 동시성 차이를 반영한 구조다. 일반적인 Spring 서비스/저장소 형태로 단순 치환하지 않는다.                                                             |
| 명령과 알림 | Node ControlPlane은 여러 use case를 조립한다. Java RoomSessions는 세션 동일성 검증과 명령 처리를 함께 두고 ChangeResult로 commit 이후 효과를 표현한다. | 클래스 수를 맞추기 위한 분리는 하지 않는다. 저장 실패 시 외부 알림이 나오지 않는 경계가 핵심이다.                                                          |
| 실시간 출력 | Java 출력·cursor는 durable 명령 대기를 우회한다.                                                                                                       | 모든 메시지를 하나의 generic dispatcher로 합치면 서로 다른 순서 계약을 숨긴다. 현재 차이를 유지한다.                                                       |
| 재접속      | ConnectorSession이 현재 연결의 동일성, 늦은 callback 무시, 재시도 타이머와 stop을 소유한다.                                                            | callback별 독립 서비스나 State 클래스로 분리할 근거가 없다.                                                                                                |
| PTY 종료    | PtyManager가 closing과 실제 exit을 구별하고, 남은 출력을 flush한 다음 exit을 보고한다.                                                                 | close 요청 시 종료 보고를 옮기면 출력/종료 순서와 단일 보고 계약을 깨뜨린다.                                                                               |
| 화면        | RoomAppRuntime은 projection과 창 상태를 연결한다. 공유 geometry의 마지막 반영값은 로컬 이동을 덮어쓰지 않기 위한 정보다.                               | 이 Map은 제거 가능한 중복이 아니다. 화면 조정 책임을 별도 모듈로 옮기려면 restore·dismiss·dispose를 포함한 독립 계약부터 정의해야 한다. 이번에는 유지한다. |

## 적용한 리팩터링

ConnectorApp의 `outputSeqs`와 OutputReplayBuffer의 `lastOutputSeq`가 같은
터미널 출력 순번을 중복 보관하고 있었다. 출력 생성 시 둘을 갱신하고 종료 시 둘을
제거해야 했으므로 동기화 책임이 불필요했다.

별도 `outputSeqs` Map을 제거하고, 기존 버퍼의 마지막 순번에서 다음 순번을 계산한다.
버퍼는 용량 초과로 프레임을 모두 제거해도 마지막 순번을 보존한다.
출력 보관, 재접속 inventory, 다음 출력의 순번이 동일한 상태를 사용한다.
새 클래스나 공개 API는 추가하지 않았다. 종료 시 버퍼 제거 계약은 유지한다.

ConnectorSession의 오래된 “출력 재생성 불가” 주석도 현재의 bounded replay 소유권에
맞게 수정했다. Session은 전송만, ConnectorApp은 보관과 replay를 책임진다.

## 검증

- 변경 전 Connector 단위 테스트 56개 통과.
- 용량 초과로 모든 프레임이 제거된 뒤 replay 완료 순번과 다음 출력 순번을 확인하는
  특성 테스트 추가. 구현 변경 전 57개 통과, 변경 후에도 57개 통과.
- 실제 PTY·메타 수집·배포 패키지 통합 테스트 16개 통과.
- Connector typecheck, 전체 dependency-cruiser, 변경 TypeScript 포맷 검사 통과.
- 기존 Spring JAR와 실제 Connector를 사용한 Chromium recovery E2E 5개 통과:
  reload, 참가자 재접속 replay, 출력 gap 복구, 방 소멸, 영속 서버 재시작 후 PTY 복원.
  전체 브라우저·Java 테스트는 이번 변경에서 재실행하지 않았다.

이번 작업은 기존 동작을 고정한 GREEN → REFACTOR → GREEN이다.
새 기능을 실패 테스트에서 구현한 RED → GREEN 작업으로 표현하지 않는다.
Java와 프론트엔드 운영 코드는 이번 검토에서 변경하지 않았다.
