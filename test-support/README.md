# Test support

`@ttyroom/test-support`는 E2E·브라우저·벤치마크가 실제로 공유하는 검증 도구다.
서버나 Connector의 구현을 import하지 않으며, 각 공개 subpath가 하나의 자원이나 행동을 소유한다.

- `server-process`: 임시 설정·SQLite·서버 child process의 시작·복원·종료.
- `test-process`: 유한 로그와 직접 child process 정리.
- `socket-probe`: raw HTTP/WS 경계에서 순서와 중복을 유지하는 관찰.
- `registered-room`: v8 등록과 peer 수명을 포함한 방 준비.
- `wait-until`: timeout이 있는 관찰 조건 대기.

벤치마크의 목표 부하·통과 기준과 E2E assertion은 소비자가 소유한다. 이 패키지에 시나리오별
기대값이나 Docker 환경을 넣지 않는다. `ServerProcess`는 개발자의 `TTYROOM_*` 설정을 제거하고
자신의 임시 경로를 전달한다. 재시작은 같은 DB를 사용하고 종료는 자신이 만든 경로만 정리한다.

`pnpm --filter @ttyroom/test-support test`는 작은 실제 Node child server로 환경 격리·재시작·정리를
확인한다. OS matrix 통과는 이 계약의 이식성만 뜻하며 Spring이나 Windows PTY 지원을 뜻하지 않는다.
