# P2: 서버 프로세스 기반 E2E와 검증 신뢰성

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-18. P2 완료. Node 백엔드로 검증했으며 Spring 서버 구현은 아직 시작하지 않았다.

## 변경한 경계

`packages/e2e`가 @ttyroom/server의 startServer/loadConfig/타입을 직접 import하던 구조를 제거했다. 실제 빌드된 서버 실행 파일을 자식 프로세스로 시작하고 HTTP 및 WebSocket으로만 제품 상태를 관찰한다. Connector도 source loader 대신 빌드된 CLI를 실행한다.

- ServerProcess: 임시 설정·SQLite 디렉터리, port=0 시작, 준비 확인, 같은 저장소/포트로 재시작, 종료 후 정리.
- TestProcess: 직접 실행한 자식 프로세스, 최근 출력의 제한된 보관, 종료 신호와 강제 종료 관리.
- 기존 given.server/connector/participant 시나리오 API 유지. 서버 구현 타입 의존은 없으며 공개 정책 override 계약만 E2E에 선언한다.
- 환경변수의 JSON argv 배열로 다른 실행 파일을 지정한다. Java 서버는 동일한 설정·준비 알림 규약을 구현하면 같은 제품 시나리오로 검증할 수 있다.
- dependency-cruiser가 E2E의 server/connector src·dist import를 금지한다. 실행 파일 경로로 기동하는 것은 허용한다.

## 잘못 통과할 가능성을 줄인 부분

1. 이전 outputText는 seq를 Map key로 사용하고 정렬해 출력했다. 중복·역순이 테스트 도우미에 의해 제거될 수 있었다. 이제 도착한 프레임을 그대로 보관하고 replay의 실제 sequence를 검사한다.
2. 이전 echo 결과 검사는 셸이 입력 명령을 그대로 표시한 것만으로 통과할 수 있었다. 입력 원문에 기대 결과가 연속으로 나타나지 않는 printf 명령으로 바꿨다. PTY 환경변수 보존 테스트도 같은 방식으로 보강했다.
3. welcome에서 이전 sync 상태가 남아 새 replay 완료 전 통과할 수 있었다. 새 welcome과 resync에서 해당 상태를 초기화한다.
4. 테스트용 snapshot projection에 이름·위치·focus event 반영이 빠져 있었다. 수신 이벤트를 반영하고, 다른 참여자와 늦은 참여자가 같은 이름·위치를 보는지 검증한다.
5. output-gap을 실제 유도하지 않던 테스트는 “명시적 resync” 검증으로 이름을 정정했다.
6. 개인 셸 초기화와 busy polling 영향을 줄이기 위해 Connector 셸은 /bin/sh, ENV/BASH_ENV는 빈 값으로 지정하고 조건 polling에 짧은 대기 간격을 사용한다.

## 새 시나리오

- 잘못된 초대 토큰 거절 후 정상 참여 가능.
- 동시에 입력권을 요청해 정확히 한 명이 승인되고 두 참여자가 같은 소유자를 관찰.
- 이름·위치 변경이 다른 참여자와 늦은 입장자에게 전파.
- 두 방의 terminalId가 같아도 출력이 섞이지 않음. 각 방의 replay/sync를 완료 경계로 사용.
- 서버 시작 실패 시 종료 코드와 로그 제공.
- 준비되지 않는 서버의 timeout 후 실제 프로세스 제거.

기존 재시작 시나리오에는 PID 변경 검증을 추가했다. 실제 프로세스를 교체하며 같은 SQLite 상태와 살아 있는 PTY를 복구한다. SIGTERM 후 필요 시 SIGKILL로 정리하므로 graceful drain 검증과는 구분한다.

## 검증 결과

| 검증                               | 결과                              |
| ---------------------------------- | --------------------------------- |
| 기본 서버 실행 경로                | 25개 통과: 제품 20, 실행기 수명 5 |
| 외부 명령 지정 + seed=42 순서 섞기 | 같은 25개 통과                    |
| 타입 검사                          | 통과                              |
| 의존성 경계 검사                   | 통과                              |

기본 실행과 외부 명령 실행 모두 Node 서버를 사용했다. 후자는 실행 파일 교체 경로가 동작함을 검증한 것이며 Java 호환 검증으로 해석하면 안 된다. 최종 POSIX 셸 실행은 각각 약 10.9초와 10.8초였다. 환경은 macOS arm64, Node 26.3.1, pnpm 10.10.0이다.

증거는 `artifacts/migration-baseline/p2/`에 있다. 최종 테스트 로그는 posix-e2e.log와 posix-external-shuffled.log이며 변경 전 소스 스냅샷도 보관했다. 처음 format 실패는 자동 기록한 results.json의 배열 포맷 때문에 발생했고 최종 문서 정리에서 해당 파일도 포맷한다.

CI의 full job은 이제 main뿐 아니라 PR에서도 빌드·통합·E2E를 실행한다. 로컬에서 CI 정의를 수정한 것이며 원격 CI 실행을 확인한 것은 아니다.

## 남은 경계

- 브라우저 E2E는 아직 Node 함수를 직접 import하고 일부 테스트가 policy를 직접 변경한다. Spring의 브라우저 인수 검증 전 별도 전환이 필요하다.
- 이번 단계는 실제 slow-consumer backpressure 장애 주입, 부하/soak, Windows 검증을 추가하지 않았다.
- 전체 제품 단위·브라우저 테스트를 이번에 다시 실행한 것은 아니다. 제품 코드는 바꾸지 않았고 변경한 E2E와 타입·구조 검증을 수행했다.
- 다음 P3는 Spring 부트스트랩과 방 생성→입장→Connector→실제 PTY 입출력의 첫 흐름 구현이다.

실행 규약과 시나리오 작성 기준은 [E2E README](../e2e/README.md)를 따른다.
