# 설정 파일·환경변수와 정책 적용 — P4e

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-28. Spring이 `TTYROOM_CONFIG_PATH`의 JSON 파일을 읽고 `TTYROOM_*` 값으로 덮어쓴 뒤
검증한다. 환경변수와 같은 이름의 Spring 명령행 property도 사용할 수 있다. 파일 선택을 생략하면
실행 디렉터리의 `ttyroom.config.json`을 찾고, 그 기본 파일이 없을 때만 기본값을 사용한다.
명시한 파일이 없거나 읽을 수 없으면 시작을 실패시킨다.

## 실행 계약

우선순위는 **TTYROOM 환경변수/property → JSON 파일 → 기본값**이다. port의 마지막 기본값에는
Spring의 `server.port`가 적용되고, 그마저 없으면 3000이다. Spring 명령행 property는 일반 환경변수보다
우선하는 Spring 자체의 규칙을 따른다. `server.port`로 TTYROOM 설정을 다시 덮는 두 번째 경로는 없다.

```json
{
  "port": 3000,
  "statePath": ".ttyroom/rooms.sqlite",
  "policy": {
    "participantGraceMs": 15000,
    "hostGraceMs": 30000,
    "scrollbackBytesPerTerminal": 1048576,
    "sendBufferDropThresholdBytes": 1048576,
    "maxQueuedDataBytesPerConnection": 1048576
  }
}
```

```sh
TTYROOM_CONFIG_PATH=/absolute/path/ttyroom.config.json \
  java -jar backend/build/libs/ttyroom-backend.jar
```

설정 파일과 SQLite의 상대 경로는 실행 디렉터리 기준이다. 설정 파일이 있는 디렉터리 기준이 아니다.
설정은 시작 시 한 번 읽는다. 실행 중 파일 변경을 자동 반영하지 않는다.

| JSON 항목                              | 환경변수                                     | 기본값·허용 범위                                           |
| -------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| port                                   | TTYROOM_PORT                                 | 3000, 정수 0..65535. 0은 임의 포트                         |
| statePath                              | TTYROOM_STATE_PATH                           | 미설정은 메모리. 환경변수의 빈 문자열도 명시적 메모리 선택 |
| policy.participantGraceMs              | TTYROOM_PARTICIPANT_GRACE_MS                 | 15000, 0 이상 정수                                         |
| policy.hostGraceMs                     | TTYROOM_HOST_GRACE_MS                        | 30000, 0 이상 정수                                         |
| policy.scrollbackBytesPerTerminal      | TTYROOM_SCROLLBACK_BYTES_PER_TERMINAL        | 1048576, 0 이상 정수                                       |
| policy.sendBufferDropThresholdBytes    | TTYROOM_SEND_BUFFER_DROP_THRESHOLD_BYTES     | 1048576, 0 이상 정수                                       |
| policy.maxQueuedDataBytesPerConnection | TTYROOM_MAX_QUEUED_DATA_BYTES_PER_CONNECTION | 1048576, 양의 정수                                         |
| policy.outputRateLimitBytesPerSec      | TTYROOM_OUTPUT_RATE_LIMIT_BYTES_PER_SEC      | 기존 기본값 4194304만 허용. 다른 값은 미지원 오류          |

JSON 숫자는 숫자 타입이어야 하며 문자열/boolean/null은 허용하지 않는다. 환경변수는 십진수·지수
표현을 정수로 해석하며 빈 값·소수·범위 초과를 거절한다. 정책 수치는 JS safe integer 상한 이하로
제한한다. JSON 최상위와 policy는 객체여야 하며 알 수 없는 키도 오류다. 잘못된 최종 필드는 이름으로
진단하지만 파일 원문·임의 키·입력값을 예외에 복사하지 않는다. 환경변수는 이미 파싱한 파일의 잘못된
값을 대체할 수 있다. JSON 문법 오류나 알 수 없는 키 자체를 숨기지는 않는다.

## 정책의 소유자와 Node와의 차이

- `ServerSettings.load`가 파일 읽기·우선순위·표현 검증을 숨기고 불변 설정을 반환한다. composition
  root만 이를 소비한다. 설정 adapter가 WS/SQLite adapter를 호출하거나 application이 Environment를
  읽지 않는다. 기존 계층 검사를 통과한다.
- `RoomSessions.Policy`는 유예와 history 보관량만 전달한다. 만료의 save-before-commit 순서와
  TerminalOutput의 seq·중복 제거·frame 수 상한은 그대로다. 보관량 0은 history를 끄며 live는 유지한다.
- `RoomSocketHandler.Limits`는 송신 드롭 기준과 수신 바이너리 한도를 전달한다. Handler는 Spring
  bean으로 조립해 close의 소유자를 하나로 두고, WebSocketConfiguration은 경로 등록만 맡는다.
- `SocketSender`는 in-flight/대기 메시지와 replay 예약량이 기준 이상이면 live output을 거절한다.
  제어와 replay 전송 자체는 이 기준으로 드롭하지 않는다. live 거절 후 gap 처리도 기존 TerminalOutput이
  맡는다. 송신 큐의 별도 안전 상한(1MiB/256개)·replay 예약 상한은 그대로다. 설정을 높여 이 안전
  상한까지 무제한으로 늘리는 동작이 아니다. Node의 ws bufferedAmount와 바이트 집계 방식은 다르다.
- Node의 maxQueuedDataBytesPerConnection은 저장 대기 중 누적되는 수신 binary 큐를 제한한다.
  Spring은 binary를 그 큐에 넣지 않으므로 동일한 누적 대기 의미를 주장하지 않는다. 외부 설정 키는
  유지하되 현재 직접 실행되는 **한 수신 frame 전체(header 포함)**의 허용량으로 적용한다. 기본값도
  적용하여 이전 Spring이 허용하던 1MiB 초과 frame은 이제 거절한다. transport의 100MiB 메시지
  조립 상한도 유지되므로 설정으로 이를 넘길 수는 없다.
- 출력 속도는 현재 Connector에 고정되어 있다. 확인한 Node 서버도 이 설정을 Connector로 전달하거나
  서버에서 사용하지 않는다. Spring은 기본값만 받아들이고 변경 요청은 명시적으로 거절한다. 속도 설정을
  지원하려면 별도 프로토콜·Connector 계약이 필요하다.
- Spring의 기본 포트 3000·기본 메모리 모드를 유지한다. Node는 기본 포트 0·SQLite 파일을 사용한다.
  Node CLI는 현재 cwd의 기본 파일만 읽지만 Spring은 명시적 TTYROOM_CONFIG_PATH도 지원한다.
  Node의 null 객체/default 처리나 hex 환경변수까지 동일하게 복제한 parser는 아니다.
  Node의 `--print-config`와 설정 출처 출력도 이번 범위에 포함하지 않는다.

## 실제 테스트 순서

1. 컴파일 가능한 기본값-only 설정 skeleton에 새 테스트를 실행했다. 29개 중 기본값·명시적 메모리
   사례만 통과하고 **27개 assertion이 실패**했다. 병합·검증 구현 후 29개 모두 통과했다.
2. 변경 전 JAR에 기존 Connector 종료 사례를 실행했다. hostGraceMs=100이 무시되어 10초 관찰
   시점에도 host가 남는 **assertion 실패**를 확인했다.
3. 정책 공통 E2E 6개를 변경 전 JAR에 실행했다. history 2개·드롭 기준은 assertion 실패,
   초과 frame 종료·참여자 즉시 만료는 의미 있는 이벤트를 기다리다 timeout으로 실패했다.
   기본 한도 아래 frame 사례 1개는 이미 통과했다.
4. 설정과 실행을 연결한 후 정책 6개와 기존 resilience 전체 5개가 Spring에서 통과했다.
   같은 새 정책 6개는 Node에서도 통과했다.
5. 처음 전체 Java 실행에서는 기존 느린 수신자 테스트 1개가 실패했다. 1MiB payload에 wire header
   9바이트가 추가되어 새 기본 수신 한도를 넘었다. outbound replay를 검증하는 fixture에 입력 허용량을
   명시했고, 원래 replay 크기·순서·다른 참여자 비차단 기대값은 유지했다. 최종 Java는 343개 통과했다.

추가한 실제 Spring 부팅 2개와 SocketSender의 양수 임계값 2개는 구현 이후 회귀 검증이며 새 RED
순환으로 포장하지 않는다. 이번 순환은 설정 사례를 한 묶음으로 진행했다. 앞으로도 행동별로 더 작은
순환을 선호한다. fixture는 독립 서버/파일/소켓과 실패 시 정리를 소유하고, 본문은 행동·관찰·검증을
분리한다. 정책 E2E는 실제 수신 frame 순서를 보존하고 앞선 테스트의 상태에 의존하지 않는다.

## 실행 근거

`artifacts/migration-baseline/p4e-server-settings/`에 변경 전 코드, RED/GREEN 로그, 실제 Java XML
건수 합계와 최종 파일 hash를 남긴다. Java 343개는 실패·오류·건너뜀 0이며 JAR 빌드 성공이다.
공통 E2E **183개 / 15개 파일**(기존 168 + persistence 4 + resilience 5 + policy 6)가 최종 JAR에서
실패·건너뜀 없이 통과했다.
Node 정책 E2E 6개와 E2E 타입 검사를 통과했다. CI도 정책 6개와 resilience 전체를 실행하도록 갱신했다.
원격 CI·브라우저·운영 배포 성공을 의미하지 않는다.
