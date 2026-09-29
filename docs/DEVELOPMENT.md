# 개발·검증·전환 안내

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
legacy/node-server/    전환 중 유지하는 Node 서버
scripts/               제품 빌드·Spring 실행·E2E 보조 도구
docs/                  설계·전환 기록
artifacts/             로컬 검증 증거
```

`backend/`는 독립 Gradle 프로젝트이고 `web`, `connector`, `protocol`, `e2e`, `legacy/node-server`는 pnpm workspace에 속합니다. 루트 `package.json`은 TypeScript 패키지와 E2E 도구를 관리합니다. Spring 빌드·실행을 pnpm으로 감싸지 않습니다.

Spring은 HTTP 방 생성·입장 인증, 터미널 inventory·생성·종료·resize·메타데이터·제목·창 배치, exclusive/shared 입력, 참여자 focus/cursor를 지원합니다. `TTYROOM_STATE_PATH`를 지정하면 SQLite에 방을 저장하고 새 서버 프로세스에서도 복원합니다. 실제 Connector의 PTY 유지·재접속 replay도 검증합니다. `TTYROOM_CONFIG_PATH`의 설정과 환경변수 우선순위·정책 적용도 지원합니다. React 빌드 결과를 JAR에 포함해 Spring에서도 화면을 제공합니다. 기본 실행 안내는 Spring을 기준으로 합니다. 기존 Node 서버는 비교 구현으로 유지하며, 기존 pnpm E2E 명령의 기본 대상은 Node입니다.

**Connector**는 이전에 Agent로 부르던 로컬 프로그램입니다. 자신의 컴퓨터에서 셸을 공유하는 사람이 실행하며, 다른 참여자는 브라우저만으로 관찰하거나 입력 권한을 받아 조작할 수 있습니다. **Host**는 Connector가 연결한 컴퓨터를 뜻합니다.

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

브라우저와 Connector의 초대 주소는 Node 서버의 포트에 맞춥니다.

CLI 실행 파일 이름은 `ttyroom`, 명령은 `join`으로 유지합니다. 첫 설치 시 dist가 없으면 workspace 실행 파일 링크가 생성되지 않을 수 있으므로, 소스 체크아웃에서는 `node connector/dist/index.js join`을 사용합니다. npm 공개 배포 완료를 의미하지 않으며 외부 사용자용 설치 안내는 공개 배포 시 별도로 확정합니다.

Connector 실행 터미널에서 `k`는 원격 입력 차단을 전환하고 `Ctrl+C`는 Connector와 로컬 셸을 종료합니다. Connector의 clientId는 프로세스마다 생성되며 네트워크 재접속 동안 유지됩니다. 파일에 영구 저장되는 식별자가 아닙니다.

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
Node 비교 구현을 빌드한 후에는 `pnpm test:e2e`, `pnpm test:browser`로
같은 테스트를 실행합니다. 이 pnpm 명령들은 Java 단위 테스트를 포함하지 않습니다.
포맷 검사는 `pnpm format`입니다. 자세한 작성 기준은 [E2E 안내](../e2e/README.md)를 참고합니다.

## CI 역할

실제 설정은 [.github/workflows/ci.yml](../.github/workflows/ci.yml)을 기준으로 합니다.

- `backend`: Java 21 Gradle 테스트와 API-only JAR 빌드
- `spring-contract`: Spring 대상 HTTP/WS 계약과 재접속·재시작 검사
- `check`: TypeScript 타입·포맷·의존성·단위 테스트
- `browser`: Node/Spring matrix의 정적 웹 계약과 Chromium 검증
- `full`: TypeScript 빌드·통합·Node 대상 프로토콜 E2E

## 전환 기록

- [Terminal 복구 계약·검증](../docs/2026-09-21-terminal-recovery-contract.md)
- [독립 디렉터리 정리와 검증](../docs/2026-09-19-project-layout.md)

- [Spring Boot 전환 계획](../docs/2026-09-18-connector-spring-boot-plan.md)
- [명칭 변경 전 기준 검증](../docs/2026-09-18-migration-baseline.md)
- [Connector 명칭 변경 결과](../docs/2026-09-18-connector-rename.md)
- [서버 프로세스 E2E 결과](../docs/2026-09-18-e2e-process-boundary.md)
- [E2E 실행·작성 기준](../e2e/README.md)
- [현재 통신 규약](../protocol/PROTOCOL.md)

2026-09-19 디렉터리 정리 전 기록의 `packages/web`, `packages/connector`, `packages/protocol`, `packages/e2e`는 현재 루트의 동명 디렉터리에 해당하고, `packages/server`는 `legacy/node-server`로 이동했습니다. Git 저장소는 하나이며 서브모듈은 사용하지 않습니다.

과거 설계·실행 기록의 Agent와 `packages/agent`는 당시 이름입니다. 현재 경로는 `connector`, 패키지는 `@ttyroom/connector`입니다. Wire protocol의 `host`, `hostId`, 버전과 기존 저장 형식은 명칭 변경으로 바꾸지 않습니다.
