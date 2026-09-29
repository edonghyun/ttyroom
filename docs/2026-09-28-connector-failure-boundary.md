# Connector 생성 실패와 보고 실패의 경계

## 발견

`ConnectorApp`의 open-terminal 처리에서 PTY 생성, 출력 버퍼 준비,
terminal-opened 전송을 하나의 try/catch가 감싸고 있었다.
전송이 동기 예외를 던지면 실제로 생성된 PTY를 생성 실패로 분류해
실패 상태 문구와 terminal-closed를 보낼 수 있었다.

실제 네트워크 장애에서 관측한 사고가 아니라, SessionPort에 일회성 동기 전송 예외를
주입하여 확인한 오류 분류 문제다. 비동기 WebSocket 오류와는 구별한다.

## 변경

catch는 `ptys.open`만 감싼다. 생성 성공 후 버퍼 준비와 terminal-opened 전송은
catch 밖에서 실행한다. 생성 실패 시 기존 상태 안내와 terminal-closed 회신은 유지한다.
생성 완료 보고의 동기 예외는 다른 전송 경로처럼 호출자에게 전파한다.
전송 재시도, 예외 격리, 관찰자 호출 순서, 연결 복구 정책은 변경하지 않았다.

## 검증

새 테스트는 전송 실패를 준비한 뒤 open-terminal 명령을 실행하고 다음을 검증한다.

- 원래 전송 예외가 전파된다.
- 실제 생성된 PTY는 inventory에 남는다.
- 거짓 terminal-closed와 생성 실패 상태 문구가 나오지 않는다.

구현 변경 전 57개 통과·새 테스트 1개 실패를 확인했다. 변경 후 58개 모두 통과했다.
실제 PTY·메타 수집·패키지 통합 테스트 16개, Connector typecheck와 변경 파일 포맷
검사도 통과했다. 이번 변경은 단순 리팩터링이 아닌 RED → GREEN 오류 수정이다.
브라우저 E2E와 Java 전체 테스트는 이번 단계에서 재실행하지 않았다.
