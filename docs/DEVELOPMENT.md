# 개발·검증 안내

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

[프로젝트 소개와 빠른 시작](../README.md)으로 돌아가기.

아래 명령은 별도 안내가 없으면 저장소 루트에서 실행합니다. Node·pnpm 설치와
`pnpm install --frozen-lockfile`은 루트 빠른 시작을 따릅니다.

기여 전 [코드·테스트 작성 가이드](../docs/CODE_STYLE.md)를 참고합니다. 준비·행동·검증의 책임,
fixture 패턴, production 설계 기준과 Java/TypeScript 예시를 함께 정리했습니다.

```text
backend/               Java 21 · Spring Boot — Gradle 프로젝트
web/                   React 화면
connector/             사용자 PC의 PTY 실행 프로그램
protocol/              TS 코덱·통신 명세·언어 공통 fixture
e2e/                   HTTP/WS 기반 프로세스 인수 테스트
legacy/node-server/    프로토콜 회귀 비교용 Node 서버
scripts/               제품 빌드·Spring 실행·E2E 보조 도구
docs/                  설계·검증 문서
artifacts/             로컬 검증 증거
```

`backend/`는 독립 Gradle 프로젝트이고 `web`, `connector`, `protocol`, `e2e`, `legacy/node-server`는 pnpm workspace에 속합니다. 루트 `package.json`은 TypeScript 패키지와 E2E 도구를 관리합니다. Spring 빌드·실행을 pnpm으로 감싸지 않습니다.

Spring은 HTTP 방 생성·입장 인증, 터미널 inventory·생성·종료·resize·메타데이터·제목·창 배치, exclusive/shared 입력, 참여자 focus/cursor를 지원합니다. `TTYROOM_STATE_PATH`를 지정하면 SQLite에 방을 저장하고 새 서버 프로세스에서도 복원합니다. 실제 Connector의 PTY 유지·재접속 replay도 검증합니다. `TTYROOM_CONFIG_PATH`의 설정과 환경변수 우선순위·정책 적용도 지원합니다. React 빌드 결과를 JAR에 포함해 서버에서 화면을 제공합니다. 기본 실행 안내는 Spring을 기준으로 합니다. 프로토콜 회귀 비교용 Node 서버도 보관합니다. `pnpm test:e2e`는 Node 비교 서버, `pnpm test:browser`는 Spring v8을 대상으로 합니다. Spring 프로세스 검증에는 아래 스크립트를 사용합니다.

**Connector**는 사용자 PC의 로컬 셸을 연결하는 프로그램입니다. 자신의 컴퓨터에서 셸을 공유하는 사람이 실행하며, 다른 참여자는 브라우저만으로 관찰하거나 입력 권한을 받아 조작할 수 있습니다. **Host**는 Connector가 연결한 컴퓨터를 뜻합니다.

## Spring 백엔드 개발

Java 21 JDK를 설치하고 `JAVA_HOME`을 지정합니다.

```sh
cd backend
./gradlew bootRun       # API 개발 서버: 기본 3000, 웹 정적 파일 제외
./gradlew test          # Java 테스트
./gradlew test bootJar  # 테스트 + 실행 JAR 생성
java -jar build/libs/ttyroom-backend.jar  # backend/ 안에서 실행
cd ..                  # 이후 명령은 저장소 루트 기준
```

서버를 종료한 뒤 `cd ..`로 저장소 루트로 돌아옵니다. 루트에서는 `./scripts/run-spring.sh`로
같은 JAR를 실행할 수 있습니다. 위 기본 빌드는 API-only이며 화면까지 실행하려면
루트 빠른 시작의 `./scripts/build-spring.sh`를 사용합니다.
Spring 단독 개발·빌드는 Node나 pnpm 설치 없이 가능합니다. 자세한 계약과 공통 프로세스 검사는 [backend 안내](../backend/README.md)를 참고합니다.

## Node 비교 구현 실행

저장소 루트에서 의존성 설치 후 비교할 때만 다음 명령을 사용합니다.

```sh
pnpm --filter @ttyroom/connector... build
pnpm --filter @ttyroom/server build
TTYROOM_PORT=3001 pnpm --filter @ttyroom/server exec node dist/index.js
```

Node 서버는 v7 프로토콜 회귀 비교 전용입니다. 현재 React·Connector는 Spring v8을 사용합니다.
공통 E2E는 `e2e/fixtures/legacy-connector.mjs`의 명시적 v7 bootstrap으로 같은 Connector 실행 코어를 검증합니다.
제품 CLI는 v7 fallback을 제공하지 않습니다.

CLI 실행 파일 이름은 `ttyroom`, 명령은 `join`으로 유지합니다. 소스 체크아웃의 빠른 시작에서는 `node connector/dist/index.js join`을 사용합니다. npm 공개 배포 완료를 의미하지 않으며 외부 사용자용 설치 안내는 공개 배포 시 별도로 확정합니다.

Connector 실행 터미널에서 `k`는 원격 입력 차단을 전환하고 `Ctrl+C`는 Connector와 로컬 셸을 종료합니다. Connector는 서버가 발급한 Host credential을 stdin에서 한 번 읽어 네트워크 재접속 동안 재사용합니다.
프로세스를 다시 실행할 때는 새 Host credential을 발급합니다. 파일·환경변수·명령 인자에는 저장하지 않습니다.

## 검증 순서와 테스트 역할

| 검증          | 목적                                           | 명령                                |
| ------------- | ---------------------------------------------- | ----------------------------------- |
| Java          | 도메인·저장·동시성·WebSocket 어댑터·계층 계약  | `./backend/gradlew -p backend test` |
| TS 정적 검사  | 타입과 모듈 의존성                             | `pnpm typecheck` / `pnpm depcruise` |
| TS 단위       | React·Connector·프로토콜·Node 비교 구현의 동작 | `pnpm test`                         |
| 네이티브 통합 | 실제 PTY·메타 수집·패키지 및 Node 어댑터       | `pnpm test:integration`             |
| 프로토콜 E2E  | 실제 서버 프로세스의 HTTP/WS 계약·재시작       | `./scripts/test-spring.sh protocol` |
| 브라우저 E2E  | Chromium·실제 Connector의 협업·입력·복구       | `./scripts/test-spring.sh browser`  |

변경에 가까운 단위 테스트부터 실행하고, 영향을 받는 통합/E2E로 넓힙니다.
E2E 실행 전 `./scripts/build-spring.sh`로 최신 제품을 빌드합니다.
브라우저 테스트는 Chromium 설치와 `/bin/zsh`가 필요합니다(실제 셸 키보드 계약).
fixture가 테스트 전용 ZDOTDIR을 사용해 개인 설정·시스템 completion·첫 실행 안내가 입력을 가로채지 않도록 합니다.
사용자별 셸 초기화 설정의 호환성까지 검증하는 것은 아닙니다.

```sh
pnpm --filter @ttyroom/web exec playwright install chromium
./scripts/test-spring.sh browser
# 특정 파일만 실행
./scripts/test-spring.sh protocol src/persistence.e2e.ts
./scripts/test-spring.sh browser e2e/room-recovery.e2e.ts
```

E2E 실행기는 서버·Connector 프로세스를 직접 시작하고 정리합니다. 서버를 수동으로
켜 둘 필요는 없습니다. 스크립트는 Java/JAR 경로를 JSON argv로 전달하며 자동 빌드하지 않습니다.
Node 비교 구현을 빌드한 후에는 `pnpm test:e2e`로 공통 프로세스 테스트를 실행합니다.
제품 React·Connector는 v8 전용이므로 Node v7 브라우저 조합은 지원하지 않습니다. 이 pnpm 명령들은 Java 단위 테스트를 포함하지 않습니다.
Spring HTTP 명세·등록 API는 `./scripts/test-spring.sh registration`,
v8 입장·재접속·취소는 `./scripts/test-spring.sh authentication`으로 별도 검증합니다.
OpenAPI 구조·예시 검증은 `pnpm --filter @ttyroom/e2e test`이며 `pnpm test`에도 포함됩니다.
포맷 검사는 `pnpm format`입니다. 자세한 작성 기준은 [E2E 안내](../e2e/README.md)를 참고합니다.

## 서버 설정

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
| protocolVersion                        | TTYROOM_PROTOCOL_VERSION                     | 8. 정수 7 또는 8, Spring 전용                              |
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

Spring의 `maxQueuedDataBytesPerConnection`은 한 수신 binary frame 전체(header 포함)의 한도다.
출력 속도 설정은 Connector 협상이 없어 기본값만 허용한다. 송신 드롭 기준을 높여도
SocketSender의 별도 큐·replay 안전 상한이 없어지는 것은 아니다.

## CI 역할

실제 설정은 [.github/workflows/ci.yml](../.github/workflows/ci.yml)을 기준으로 합니다.

- `backend`: Java 21 Gradle 테스트와 API-only JAR 빌드
- `spring-contract`: Spring 대상 HTTP/WS 계약과 재접속·재시작 검사
- `check`: TypeScript 타입·포맷·의존성·단위 테스트
- `browser`: Node/Spring matrix의 정적 웹 계약과 Chromium 검증
- `full`: TypeScript 빌드·통합·Node 대상 프로토콜 E2E

## 설계와 개발 이력

현재 설계는 [백엔드 책임 경계](../backend/ARCHITECTURE.md)와
[통신 규약](../protocol/PROTOCOL.md)을 따른다. 날짜별 변경·검증과 이전 구현의 비교는
[개발 이력 안내](README.md#개발-이력)에서 확인한다.

## v8 기본 실행과 기존 저장 파일

Spring·React·Connector의 기본 버전은 8이다. 이전 서버를 종료하고 기존 SQLite 파일을 보존한 뒤,
아직 사용하지 않은 새 경로와 새 방으로 시작한다. 기존 host/client ID에 credential을 자동 발급하지 않는다.
서버 여러 개가 같은 SQLite 파일을 동시에 열지 않는다. 기존 v7 방은 제품 클라이언트로 재접속할 수 없다.

```sh
TTYROOM_PROTOCOL_VERSION=8 TTYROOM_PORT=3001 TTYROOM_STATE_PATH=.ttyroom/v8-rooms.sqlite \
  ./scripts/run-spring.sh
```

이 프로세스는 v7 hello를 거절한다. 방을 새로 만들고 생성 탭의 Add Host에서 Host credential을 발급한다.
Connector 명령에는 fragment 없는 방 주소만 넣고, 표시되지 않는 stdin 프롬프트에 credential을 붙여 넣는다.
관리 권한은 방 생성 탭의 sessionStorage에 보관되며, 이를 잃으면 기존 방의 관리 권한을 복구하는 API는 없다. [HTTP 등록](../protocol/HTTP.md#spring-등록-api) 후
[v8 hello](../protocol/AUTHENTICATION_V8.md)로 연결한다. 자동 검증은 서버를 직접 띄울 필요 없이
`./scripts/test-spring.sh authentication`으로 실행한다. 의존성·JAR 빌드를 먼저 마치고 테스트 중 재빌드하지 않는다.
