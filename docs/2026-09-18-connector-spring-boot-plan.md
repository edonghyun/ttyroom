# TTYRoom Connector 명칭 변경 및 Spring Boot 전환 계획

> 개발 당시의 기록이다. 언어 변경과 비교 내용은 작업 이력이며, 현재 프로젝트 소개는
> [포트폴리오](PORTFOLIO.md), 구현 상태와 실행 방법은 [백엔드 안내](../backend/README.md)를 따른다.

작성일: 2026-09-18. 상태: P0·P1·P2 완료, P3 진행 중. P3a는 Spring HTTP 부팅 기반이며 협업 기능·배포는 아직 미완료.

진행 업데이트: [P0 기준 확보](2026-09-18-migration-baseline.md), [P1 명칭 변경](2026-09-18-connector-rename.md) 완료. 아래 현재 코드 설명은 계획 작성 시점의 명칭이며, 현재 Agent는 Connector로 변경되었다.

[P2 서버 프로세스 E2E](2026-09-18-e2e-process-boundary.md) 완료. 백엔드 HTTP/WS 시나리오의 실행 경계를 분리했다. 브라우저 E2E의 Node 내부 의존 제거는 Spring 브라우저 인수 검증 전에 별도로 수행한다.

## 1. 목표와 범위

사용자 PC에서 셸을 연결하는 프로그램의 이름을 TTYRoom Connector로 변경하고, 중앙 백엔드를 Java/Spring Boot로 이식한다. 기존 React 웹과 Node.js 기반 PTY 실행은 유지한다. 목표는 기존 협업 동작을 보존하면서 Java 동시성, Spring의 구성과 생명주기, 영속성 경계를 학습하고 검증 가능한 포트폴리오를 만드는 것이다.

| 구성      | 목표                                                        |
| --------- | ----------------------------------------------------------- |
| 웹        | 기존 React + TypeScript + Vite, packages/web 유지           |
| 백엔드    | Java 21 + Spring Boot 4.x + Gradle Wrapper 제안             |
| Connector | Node.js + TypeScript + node-pty, packages/connector         |
| 통신      | 기존 HTTP API, /ws, JSON 제어 메시지와 바이너리 프레임 유지 |
| 저장      | 첫 전환은 SQLite + JDBC, 기존 저장 형식 호환 검증           |

Boot 세부 릴리스와 Gradle/SQLite JDBC 버전은 착수 시 공식 호환 범위 확인 후 고정한다. Java 21은 학습 기준으로 제안한 선택이며 기존 사용자 환경 요구사항이 아니다. 서버는 Spring MVC와 기본 WebSocket API를 사용한다. 초기에는 STOMP, WebFlux, JPA, Redis, Kafka, MSA, Connector 언어 변경을 추가하지 않는다. 제품명 TTYRoom과 CLI의 ttyroom join 문법도 유지한다.

## 2. 현재 코드에서 확인한 전환 조건

- packages/server/src/main.ts가 HTTP API, 웹 정적 파일, WebSocket, SQLite 저장소를 조립한다.
- ServerCore는 JSON 제어 경로와 바이너리 입출력 경로를 구분한다.
- RoomRegistry는 방별 변경 직렬화와 저장 성공 후 메모리 commit을 책임진다.
- 출력 경로에는 순서 번호, 중복 제거, bounded buffer, 느린 수신자의 gap 및 재동기화 처리가 있다.
- packages/e2e/src/harness.ts는 @ttyroom/server의 startServer/loadConfig를 직접 import하고 Agent 소스를 자식 프로세스로 실행한다. 그대로는 Java 서버 검증에 사용할 수 없다.
- CI, 빌드 스크립트, 패키징 테스트가 기존 server/agent 이름과 경로에 의존한다.
- 현재 working tree에 서버 리팩터링과 웹 수정이 다수 있다. 구현 시작 시 변경 소유권과 기준 스냅샷을 확인하고 보존한다. 현 시점 테스트 통과를 확인한 것은 아니다.

## 3. 목표 구조

2026-09-19: 아래 독립 디렉터리 배치를 적용했다. 문서의 이전 단계 설명에 나오는 `packages/*` 경로는 당시 위치이며, 실행 안내는 루트 README를 따른다.

```text
web/                  React UI
connector/            사용자 PC의 PTY와 서버 연결
protocol/             TS 코덱·스키마·언어 중립 명세와 공통 fixture
e2e/                  실제 프로세스 대상으로 HTTP/WS 검증
backend/              Gradle 기반 Spring Boot 애플리케이션
legacy/node-server/   전환 검증 동안 유지하는 Node 비교 구현
```

Java는 하나의 Gradle 애플리케이션으로 시작한다. 내부에는 domain, application, adapter(http/ws/persistence), configuration 경계를 두되 기존 파일을 기계적으로 클래스 하나씩 번역하지 않는다. 도메인은 Spring API에 의존하지 않고 실제 변동 경계인 저장소·전송·시간에만 작은 인터페이스를 둔다. 프론트엔드 빌드 결과는 최종 JAR 정적 리소스로 포함해 현재의 단일 서버 제공 방식을 유지한다. 개발 중에는 Vite proxy로 같은 API/WS 계약을 사용한다.

2026-09-21: 이후 구현은 [Spring 설계 연속성 기준](../backend/ARCHITECTURE.md)에 따라 기존 Node 구현·계약 비교, 준비 리팩터링, 기능 구현, 재리뷰 순으로 진행한다. 현재 구현 범위와 실행 결과는 [backend README](../backend/README.md)에 기록한다.

## 4. 단계별 작업과 완료 기준

### P0. 기준 동작 고정

- 현재 변경을 포함한 기준 소스를 보존하고 기존 단위·통합·E2E·브라우저 테스트를 실행한다. 실패는 기존 결함과 환경 문제를 구분해 기록한다.
- HTTP 경로, WS hello/역할, 전체 메시지 유형, 오류 코드, 바이너리 형식, 정책 기본값, 저장 스키마의 호환 목록을 만든다.
- 프로토콜 버전 7의 JSON 및 바이너리 golden fixture를 만든다. endian, unsigned 32-bit 경계, malformed frame, 알 수 없는 메시지, UTF-8 바이트를 포함한다.
- 완료: 재현 가능한 실행 명령, 기준 결과, 기능/계약 목록 확보.

### P1. Agent → Connector 명칭 변경

- 사용자 표기 TTYRoom Connector, 설명은 “내 컴퓨터의 터미널을 협업 방에 연결합니다”.
- packages/agent → packages/connector, @ttyroom/agent → @ttyroom/connector.
- AgentApp/AgentSession/AgentTransport 등 프로그램을 뜻하는 심벌, import, 테스트 harness, pnpm lockfile, CI, 문서와 화면 문구를 일관되게 변경한다.
- host/hostId/role:host는 연결된 실행 컴퓨터라는 프로토콜 도메인 개념이므로 유지한다. AI Agent 등 다른 의미의 단어는 치환하지 않는다.
- ttyroom join, 환경변수·설정 키·실행 파일 이름은 호환성을 먼저 확인한다. 실제 Connector clientId는 프로세스마다 생성되고 네트워크 재접속 동안 유지된다. 파일에 영구 보관되는 식별자가 아니며 이 수명은 변경하지 않는다. 공개 배포된 패키지가 있는지 확인하고 있다면 이전 설치 경로의 전환 안내 또는 호환 릴리스를 따로 계획한다. 무조건적인 전체 문자열 치환은 하지 않는다.
- 완료: 기존 검증 통과, build/pack 설치 smoke 확인, 사용자 화면과 CLI 도움말의 용어 일치.

### P2. 구현 언어에 독립적인 테스트 실행

- E2E 서버 구동 경계를 start/stop/restart/baseUrl/statePath로 한정하고 Node/Java 프로세스 실행기를 제공한다.
- 기존 테스트의 정상 종료·강제 종료·포트 할당·환경설정·자식 프로세스 정리를 보존한다. 재시작은 같은 저장소와 실제 새 프로세스로 검증한다.
- 시나리오는 HTTP와 WS로 실행한다. 서버 내부 객체를 요구하는 검증은 단위 테스트로 남긴다.
- 완료: Node 프로세스를 대상으로 기존 협업·복구 시나리오가 통과. Java 연결만 아직 미구현인 상태를 명확히 표시.

### P3. Spring 뼈대와 첫 수직 기능

P3a: `backend/`에 Java 21·Spring Boot 4.0.8·Gradle 9.7.1 기반과 `/healthz`, 프로세스 readiness 계약을 추가한다. [실행과 현재 범위](../backend/README.md). P3b(2026-09-19): 방 생성 HTTP 계약과 메모리 방 디렉터리·토큰 digest 검증을 구현했다. P3c(2026-09-21): WS 입장 인증·welcome·참여자 입장 알림·동일 identity 연결 대체를 추가했다. 다음은 Connector inventory·터미널 생성·입출력의 수직 기능이다. P3 완료 기준은 그대로 유지한다.

- Gradle Wrapper/toolchain/의존성 고정, 설정 검증, HTTP/WS 연결, 정적 리소스 제공을 구성한다.
- 방 생성 → 브라우저 입장 → Connector 연결 → 터미널 생성 → 입력·출력 한 흐름을 먼저 완성한다.
- 기존 링크 토큰 인증과 역할 검증을 보존한다. 토큰 digest, 길이 제한, 잘못된 프레임, 허용 origin/네트워크 경계의 현재 동작을 확인해 명시한다.
- Java의 long 등으로 프로토콜 uint32 범위를 손실 없이 처리하고 TS/Java가 같은 fixture를 읽고 쓰는지 검증한다.
- 완료: 기존 웹·Connector에서 Java 서버를 통해 실제 PTY 입출력 성공.

### P4. 상태·동시성·복구 완성

- 모든 제어 기능을 호환 목록 순서대로 이식한다: 권한 획득/반납, 모드, 이름·위치·크기, 참여자 포커스·커서, Host 차단 상태, disconnect 유예, inventory reconciliation, replay/resync.
- 최초 설계는 방별 직렬 실행을 상태 소유 경계로 제안한다. 타이머, 연결 해제, 입력 권한 확인, 출력 sequence도 같은 상태 소유 규칙을 따른다. 제어 명령만 잠그고 데이터 경로가 가변 상태를 동시에 읽는 구조를 피한다.
- 큐는 용량과 포화 정책을 정하고 공용 실행기를 사용한다. 방마다 영구 전용 스레드를 만들지 않는다. 연결별 순서와 방별 순서, 이전 연결의 늦은 callback 식별을 별도로 검증한다.
- 실제 소켓 송신은 방 상태 처리에서 분리하고 연결별 bounded queue로 순서를 지킨다. 느린 수신자 하나가 전체 방을 정지시키지 않도록 한다. Spring 송신 decorator만으로 기존 gap/replay 정책이 대체되지는 않는다.
- DB 저장 후 메모리 반영과 이벤트 발행 순서를 보존한다. @Transactional이 메모리·소켓까지 롤백한다고 가정하지 않는다.
- 저장 실패, 동시에 권한 요청, 재접속과 유예 만료 경합, 오래된 연결 close, 중복 출력, 큐 포화를 검증한다.
- 완료: Node/Java 양쪽에 같은 기능·복구 시나리오 통과. 직렬화가 출력 지연에 미치는 영향은 P6에서 측정하고 필요할 때 상태 소유 경계를 유지하며 최적화한다.

### P5. 저장·패키징·운영 호환

- SQLite JDBC로 기존 저장 스키마와 JSON snapshot 의미를 구현한다. 저장용 직렬화와 WS 직렬화의 계약을 각각 검증한다.
- Node가 만든 DB 사본을 Java가 읽고, Java가 갱신한 사본을 Node가 읽는 양방향 호환 검증을 수행한다. 같은 파일을 두 서버가 동시에 사용하지 않는다.
- 복원 완료 전 readiness를 열지 않고 종료 시 신규 접속 차단, 큐 drain, 저장소 종료 순서를 정의한다.
- Actuator 상태 확인과 연결 수·큐 바이트·저장 지연·출력 gap 메트릭을 붙인다. 토큰·셸 입력·출력 내용을 운영 로그에 기록하지 않는다. 관리 endpoint 노출 범위를 제한한다.
- Java 빌드와 pnpm 빌드를 CI에서 각각 수행하고 프론트엔드가 포함된 JAR 및 Connector 패키지 smoke를 실행한다.
- 완료: 새 설치, 종료, 재시작, 기존 DB 복원, 패키지 실행 검증 통과.

### P6. 비교 검증과 기본 백엔드 전환

- 같은 장비·방 수·연결 수·PTY 출력량으로 입력→출력 p50/p95/p99, 처리량, CPU, RSS, 큐 성장, 복구 시간을 비교한다. JVM warm-up, 반복 횟수, 환경과 한계를 기록한다.
- 느린 수신자 포함 부하·장시간 실행에서 메모리/큐가 제한되고 정상 참여자의 진행이 유지되는지 확인한다. 임의 성능 향상을 주장하지 않는다.
- 기능 호환 전체 통과와 기준 대비 성능 결과 검토 후 로컬 실행·CI·문서의 기본 서버를 Java로 바꾼다.
- Node 구현은 비교 기간에만 유지하고, 기준 commit/tag 및 재현 절차를 남긴 뒤 제거 여부를 결정한다. 원복은 서버 중지→DB 백업/호환 확인→Node 시작 순서로 한다.
- 실제 배포는 별도 요청 시 수행한다. 배포 전 DB 백업과 복원 경로를 검증한다.
- 완료: React + Spring Boot + Connector 데모, 재현 가능한 검증 보고서와 설계 결정 기록.

## 5. 학습·포트폴리오 결과물

1. Spring 도입 범위와 Connector 스택 유지 이유를 설명하는 ADR.
2. Node 이벤트 루프와 Java 방별 상태 소유/직렬화 비교, 실패 재현 및 수정 근거.
3. DB commit·메모리 commit·WS 송신 사이의 장애 경계 설명.
4. 언어 간 wire contract fixture와 실제 PTY를 포함한 공통 E2E.
5. 재접속·서버 재시작·느린 수신자 데모와 측정 결과.

JPA/PostgreSQL, 계정·멤버십, 분산 방 소유권은 후속 학습 프로젝트로 분리한다. 이번 전환 완료 조건에 포함하지 않는다.

## 6. 공식 참고 자료

- Spring Boot 시스템 요구사항: https://docs.spring.io/spring-boot/system-requirements.html
- Spring WebSocket API: https://docs.spring.io/spring-framework/reference/web/websocket/server.html
- 동시 송신 제한과 decorator: https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/socket/handler/ConcurrentWebSocketSessionDecorator.html
- Actuator: https://docs.spring.io/spring-boot/reference/actuator/
