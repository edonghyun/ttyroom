# TTYRoom MVP 설계

> 상태: 설계 승인 완료 (구현 계획 대기)
> 작성일: 2026-08-12
> 근거 문서: `docs/brainstorming.md`

## 목표

한 사용자가 Quick Room을 만들고, 두 명 이상의 개발자가 각자의 머신을 Host로 연결한 뒤,
브라우저에서 서로 다른 터미널을 클릭해 동시에 작업할 수 있는 경험을 검증한다.
주 사용 장면은 페어·몹 디버깅이며, 원격 도움·온보딩과 장애 대응을 부차 장면으로 지원한다.

## 확정된 결정

| 주제 | 결정 |
|---|---|
| 주 사용 장면 | 페어·몹 디버깅 (온보딩·장애 대응 부차) |
| 암호화 | TLS만. 터미널 페이로드는 서버가 해석하지 않는 불투명 blob으로 다뤄 E2E를 나중에 얹을 수 있게 함 |
| 기술 스택 | 전부 TypeScript. Agent는 Node + node-pty, 배포는 npx/npm. 프로토콜은 언어 중립 명세로 유지해 Agent의 Rust/Go 재작성 경로를 열어둠 |
| Host 연결 UX | CLI 즉석 연결. Room 화면의 복사 버튼으로 `npx ttyroom join <url>` 실행, Ctrl+C로 종료. 상주 데몬 없음 |
| 입력권 UX | 창 선택과 입력권 획득을 분리. Available Terminal의 `Take control`로 획득하고 타인 소유 Terminal은 포커스·관찰만 허용. 강한 시각 피드백으로 혼동 완화 |
| 인증 | Room 링크가 초대권, 입장 시 닉네임 입력. 외부 노출은 Tailscale 네트워크 경계로 차단. 신원 체계는 포트로 추상화해 나중에 교체 가능 |
| 기존 세션 attach | MVP 제외. 브라우저에서 만드는 새 PTY만 지원 |
| 아키텍처 | 단일 서버 프로세스(Control Plane + Relay 겸임), 인메모리 상태, 클라이언트당 WebSocket 하나에 멀티플렉싱. 인프라는 포트/어댑터로 교체 가능하게 |
| 오픈소스 | 향후 공개를 전제로 특정 인프라(Tailscale 포함)에 하드 종속하지 않음 |
| 개발 규율 | strict TDD (`donghyuns-agent-tools`의 tdd 스킬) + `semantic-context-os/CODING-GUIDELINES.md` 준수 |
| Web UI | 별도 트랙으로 분리. 화면 설계를 먼저 하고 착수. 이번 구현 범위는 protocol·server·agent |

### 열린 질문에 대한 기본값 (설계에 포함된 결정)

- 한 사용자의 동시 입력권은 **하나**. 다른 Available Terminal의 `Take control`을 실행하면 기존 입력권을 해제하고 새로 획득한다.
- 터미널 협업 모드의 기본값은 **Exclusive**. Shared는 터미널별 옵트인 모드로 제공한다.
- Quick Room 종료 시 메타데이터는 남기지 않는다 (기록·타임라인은 후속 검토).
- 복구는 clientId + Room 스냅샷 + 스크롤백 replay로 처리한다 (아래 참조).

## 시스템 아키텍처

세 실행 컴포넌트와 공유 프로토콜 하나로 구성된다.

```text
┌──────────┐   Transport    ┌─────────────────────────┐   Transport    ┌──────────┐
│  Web     │◀══════════════▶│         Server          │◀══════════════▶│  Agent   │
│ (브라우저)│                │  domain / usecases      │                │ (Node)   │
└──────────┘                │  ports / adapters       │                └──────────┘
                            └─────────────────────────┘
```

- 브라우저와 Agent는 모두 서버로 아웃바운드 연결한다. 직접 연결은 없다.
- 서버가 웹 정적 파일도 직접 서빙한다. 배포물은 프로세스 하나다.
- Room·Host·Terminal(공유 geometry 포함)·Lease의 라이브 상태는 **서버 메모리가 authoritative**이며,
  도메인 이벤트는 단일 스레드에서 순차 처리한다 (입력권 경합에 레이스 없음).

### 모노레포 구성

```text
ttyroom/
├── packages/protocol   # 제어 메시지 zod 스키마, 데이터 프레임 인코더/디코더, PROTOCOL.md
├── packages/server     # domain / usecases / ports / adapters, config, main(조립)
├── packages/agent      # CLI, PTY 관리, Transport 클라이언트 어댑터
└── packages/web        # Room UI, xterm.js — 별도 트랙 (화면 설계 후 착수)
```

`protocol`이 유일한 공유 지점이다. TS 타입과 함께 언어 중립 명세(`PROTOCOL.md`)를 유지한다.

## 서버 레이어 구조

의존 방향은 항상 안쪽으로: `adapters → usecases → domain`.
순환·방향 위반은 CI의 의존성 검사(dependency-cruiser)로 강제한다.

```text
packages/server/src/
├── domain/      # Room·Host·Terminal·Lease 엔티티와 불변식. 순수 함수. 포트를 모름
├── usecases/    # 실질적 플로우의 주인. 포트를 호출하는 유일한 레이어
├── ports/       # Transport · SnapshotStore · Identity · Clock 인터페이스 + Policy 타입
├── adapters/
│   ├── ws/           # WebSocket Transport 어댑터 (송신 버퍼 감시 → 백프레셔 신호)
│   ├── memory/       # SnapshotStore no-op 어댑터
│   ├── link-auth/    # Room 토큰 + clientId Identity 어댑터
│   └── system-clock/
├── config.ts    # zod 스키마 단일 진실 (아래 설정 계층 참조)
└── main.ts      # 조립 지점. 어댑터 생성 → 유즈케이스 주입. 웹 정적 파일 서빙
```

컴포넌트는 가이드라인대로 클래스 기본, 협력 객체(Deps)와 설정값(Options)을 구분한
생성자 옵션 객체 주입으로 작성한다.

참고: 코딩 가이드라인 §3.1은 계층 이름 폴더 대신 역할 우선 폴더를 권장[SHOULD]하지만,
이 프로젝트는 계층 폴더 구조를 명시적으로 선택했다 — 포트/어댑터 교체 가능성이 제품의
핵심 요구라서 계층 경계가 폴더에 그대로 드러나는 쪽이 낫다고 판단.

### 도메인 (불변식)

- Exclusive 모드 터미널의 유효한 입력권 임대(Lease)는 최대 하나다.
- Exclusive 모드에서 입력 프레임은 유효한 임대 없이 Agent로 전달되지 않는다.
  Shared 모드 터미널은 임대 검증 대신 Room 참여자 자격 검증으로 입력을 통과시킨다.
- 임대 획득은 선착순이다.
- 임대는 연결에 묶인다. 연결이 끊기면 유예 후 해제된다.
- 임대 해제는 해당 터미널의 프로세스에 영향을 주지 않는다.

### 유즈케이스 목록

`joinRoom`, `connectHost`, `openTerminal`, `acquireLease`, `releaseLease`,
`routeTerminalInput`, `broadcastTerminalOutput`, `updateTerminalGeometry`, `handleDisconnect`,
`syncLateJoiner`.
테스트도 이 단위로 작성한다.

### 포트

- **Transport** — 연결 하나의 프레임 송수신. 의미론 계약을 인터페이스에 명시한다:
  프레임 순서 보장, 연결별 백프레셔 신호(송신 버퍼 수위), 재연결은 전송이 숨기지 않고
  "새 연결 + 세션 재개 프로토콜"로 처리. MVP 어댑터는 WebSocket.
- **SnapshotStore** — 라이브 상태 저장소가 아니라 스냅샷 영속화 전용.
  MVP 어댑터는 no-op. SQLite 어댑터를 붙이면 서버 재시작 복구와 Team Room이 열린다.
- **Identity** — 연결 → (안정적 clientId, 표시 이름) 매핑. 브라우저는 localStorage,
  Agent는 로컬 파일에 clientId를 보관한다. MVP 어댑터는 Room 토큰 + 닉네임.
  Tailscale identity·SSO 어댑터로 교체·병행 가능.
- **Clock** — 타이머 스케줄링. 코어는 "N초 뒤 이 이벤트"만 요청한다.
  테스트는 FakeClock으로 시간을 감는다.

### 설정 계층

1. **도메인 불변식** — 코드에 박히는 규칙. 설정 불가.
2. **정책 파라미터(Policy)** — 유예 시간, 링버퍼 크기, rate limit 등 도메인이 주입받는 숫자.
3. **인프라 설정** — 포트, TLS 등 어댑터만 아는 값.

전부 `config.ts`의 zod 스키마 하나로 정의한다(기본값·설명 포함).
`ttyroom.config.json` 또는 환경변수로 오버라이드하고, 잘못된 설정은 부팅 시 검증 에러로 잡는다.
`ttyroom-server --print-config`가 적용 중인 최종값과 출처를 출력하며, 설정 문서는 스키마에서 생성한다.
백프레셔에서 신호 감지는 Transport 어댑터, 드롭 정책 결정은 유즈케이스가 담당한다 (감지와 결정의 분리).

## 프로토콜

연결 위를 흐르는 것은 두 종류다.

- **제어 프레임(JSON)** — join, 터미널 생성, 임대 요청/획득/해제, 참여자 변동,
  터미널 메타데이터(cwd·git 브랜치·포그라운드 프로세스명), 공유 창 geometry, resize,
  sync, 에러.
  zod 스키마가 단일 진실.
- **데이터 프레임(바이너리)** — 출력(Agent→서버→브라우저):
  `[frameType(1B)][terminalId(4B)][seq(4B)][payload...]`,
  입력(브라우저→서버→Agent): `[frameType(1B)][terminalId(4B)][seq(4B)][leaseId(4B)][payload...]`.
  터미널 입출력 바이트. 서버는 헤더만 읽고 payload는 불투명하게 라우팅·저장한다
  ("해석 금지, 불투명 저장 허용" — E2E를 켜면 암호문이 그대로 흐르고 서버는 무변경).

추가 규칙:

- 최초 hello에 프로토콜 버전을 싣는다. 서버가 수용 못 하면 업그레이드 안내와 함께 거부한다
  (npx 배포 특성상 버전 스큐가 실제로 발생한다).
- **sync 제어 메시지** — "터미널 t의 seq n까지 방송 완료"를 알린다. 백프레셔 회복 시
  재동기화와 테스트의 명시적 동기화 지점으로 쓰이는 정식 프로토콜 요소다.
- 입력 데이터 프레임은 반드시 현재 leaseId를 지참한다.

## 핵심 데이터 플로우

### 입력 경로

```text
민수 브라우저 타이핑
  → 데이터 프레임 {terminal: t3, payload, leaseId: L7}
  → 서버: t3의 유효 임대가 L7(민수)인지 검증
      ├─ 유효 → Host Agent로 전달 → PTY write
      └─ 무효 → 폐기 + 민수에게 lease-invalid 통지
  → PTY 출력 → Agent → 서버 → Room 전체 브로드캐스트
```

검증 지점은 서버 한 곳이다. 오래된 브라우저의 입력이 입력권을 우회할 수 없다.

### 입력권 임대

- Available Terminal의 `Take control` → `acquire-lease` → 단일 스레드 처리라 선착순이 명확
  → 성공 시 Room 전체에 브로드캐스트, 실패 시 요청자에게 현재 소유자 정보 응답(UI는 포커스만 이동).
- 연결 단절 시 Clock으로 유예 타이머(기본 15초). 같은 clientId 재접속이면 임대 복원, 아니면 해제 브로드캐스트.

### 늦은 합류와 복구

서버는 터미널별 스크롤백 링버퍼(기본 1MB)를 불투명 blob으로 유지한다.
합류·재접속 시 Room 스냅샷(Host·터미널·임대·참여자) + 링버퍼를 받아 xterm.js에 replay한다.
브라우저 새로고침 복구도 같은 메커니즘이다.

### 백프레셔

- 느린 참여자: 송신 버퍼 임계치 초과 시 그 참여자에게 가는 출력만 드롭하고 유실 마커를 보내며,
  회복되면 sync + 링버퍼로 재동기화한다.
- Agent→서버: 터미널별 출력 rate limit으로 한 터미널의 폭주가 연결 전체를 점유하지 못하게 한다.

## Agent

```text
packages/agent/src/
├── cli.ts        # `ttyroom join <url>` 파싱, 상태 표시, Ctrl+C 처리
├── session.ts    # 접속·등록·재접속 (지수 백오프)
├── terminals.ts  # 서버 명령에 따른 PTY 생성/파기 (node-pty), 터미널별 출력 rate limit
├── meta.ts       # cwd·git 브랜치·포그라운드 프로세스명 수집(폴링) → 제어 프레임 보고
│                 #   셸 통합 기반의 의미 있는 명령 이벤트 수집은 후속 검토
└── transport/    # Transport 클라이언트 어댑터 (WS)
```

Agent는 의도적으로 얇다. 판단은 서버에 있고 Agent는 수행만 한다 — 얇을수록 재작성이 쉽다.
유일한 로컬 판단은 **Kill Switch**: Agent 상태창에서 키 한 번으로 모든 원격 입력을 즉시 차단한다.
서버를 거치지 않는 로컬 권한이어야 Host Owner가 신뢰할 수 있다.

## Web — 별도 트랙

Web UI는 이번 구현 범위에서 분리한다. 예시 화면 설계를 먼저 진행한 뒤 별도 계획으로 착수한다.
서버·Agent는 플로우 e2e(실제 ws 클라이언트)로 검증하므로 web 없이 완결적으로 개발할 수 있다.

화면 설계 기준은 `2026-08-12-ttyroom-web-ui-design.md`를 따른다. 이 문서는 여러 Terminal을
자유롭게 이동·겹치기·정렬할 수 있는 브라우저 데스크톱, Room 공유 창 배치, Dock과 Overview,
입력권 상태 표현을 정의한다.

Web 트랙에 승계되는 설계 결정:

- 프레임워크: React + Vite, 터미널 렌더링은 xterm.js.
- 서버가 보내는 스냅샷·이벤트가 유일한 진실이고 웹은 렌더링만 한다.
  낙관적 업데이트는 임대 획득 같은 지연 민감 지점에만 제한적으로 쓴다.
- Terminal의 논리 위치·크기는 Room 공유 상태다. drag·resize·Arrange commit을 서버에 보내고
  서버 수신 순서의 last-write-wins로 전체 참가자와 late join snapshot에 반영한다.
  z-order·최소화·최대화·Overview·Canvas pan/zoom은 참가자별 로컬 표현 상태로 둔다.
- 입력권 시각 상태(내 소유 / 타인 소유 / 빈 Terminal / Read-only)의 강한 피드백,
  Floating Terminal Window · Dock · Arrange · Overview 구조.
- `packages/protocol`과 Transport 브라우저 어댑터를 통해서만 서버와 통신한다.

## 개발 규율

- **strict TDD** — `donghyuns-agent-tools`의 tdd 스킬을 구현 전 과정에 적용한다.
  행동 증분 장부(ledger) 작성 → 행동 하나당 RED(실행으로 실패 확인) → 최소 GREEN →
  GREEN 상태에서만 REFACTOR. RED/GREEN의 실행 명령과 결과를 증거로 보고한다.
  버그 수정은 실패하는 회귀 테스트부터. 테스트는 co-located 스펙(`A.ts` 옆 `A.spec.ts`)으로
  작성하며, 이는 본 문서의 테스트 배치 규칙과 일치한다.
- **코딩 가이드라인** — `semantic-context-os/CODING-GUIDELINES.md`를 준수한다.
  이 설계에 특히 영향을 주는 항목: 컴포넌트는 클래스 기본(한 파일 한 역할),
  Deps/Options를 구분한 생성자 옵션 객체 주입,
  strict TS(`noUncheckedIndexedAccess` 등), 프로그래머 오류(throw)와 예상된 실패
  (discriminated union)의 구분, `cause` 보존, 시계·난수·ID 주입, 계약 스위트 공유,
  제약 코멘트만 허용, 매직 넘버는 근거 코멘트와 함께 상수화.
- 오류 표현의 프로젝트 표준: 예상된 실패는 discriminated union(`kind` 필드 +
  exhaustive switch)으로 통일한다.

## 에러 처리

원칙: 로컬 프로세스는 불필요하게 죽이지 않는다. 모든 실패는 사용자에게 보이는 명시적 상태가 된다.

| 시나리오 | 동작 |
|---|---|
| 브라우저 새로고침·단절 | clientId로 재접속 → 스냅샷 + replay. 유예(15초) 내 복귀면 임대 복원 |
| Agent 네트워크 단절 | PTY·프로세스는 로컬 유지. Host "연결 끊김" 표시, 유예(30초) 내 재접속이면 세션 지속, 초과 시 Host 제거 |
| Agent 프로세스 종료 (Ctrl+C 포함) | PTY도 함께 종료. 의도된 동작 |
| 서버 재시작 | MVP에서 Room 소멸. `room-not-found`와 명확한 안내. SnapshotStore 어댑터 장착 시 복구로 업그레이드 |
| 셸 종료 | 터미널 카드 "종료됨 (exit N)" 상태, 닫기/새로 열기 제공 |
| 입력 거부 | 폐기 + 보낸 사람에게만 이유가 담긴 토스트 |
| 프로토콜 버전 불일치 | hello에서 거부 + 업그레이드 안내 |

## 테스트 전략

사내 저장소 libera·hzpro-dev·hexai의 검증된 패턴을 채택했다. hexaijs 프레임워크 자체는
채택하지 않는다 (TTYRoom은 CQRS/이벤트소싱이 아니라 실시간 상태 릴레이).
작성 순서는 개발 규율 섹션의 strict TDD가 지배한다 — 아래는 테스트의 구조와 배치 규칙이다.

1. **배치 규칙** — Vitest 단일 스택. 테스트는 소스 옆 co-located, 레이어는 파일명 접미사로 구분:
   `*.spec.ts`(유닛) / `*.integration.spec.ts`(실제 인프라) / `*.e2e.ts`(플로우).
   레이어별 vitest config 분리. 접미사 규칙은 처음부터 하나로 통일한다.
2. **테스트 컴포지션 루트 `RoomTestContext`** — 가짜 포트 일습(FakeClock, 메모리 Transport 쌍,
   no-op SnapshotStore)을 꽂고 아웃바운드를 배열로 캡처(`getBroadcastFrames()`, `getAgentWrites()`).
   **예상 못 한 협력자 호출(허용 안 된 Agent 쓰기·브로드캐스트)은 즉시 throw** — 원격 머신에
   바이트를 쓰는 제품에서 "조용히 뭔가 실행됨"이 통과하는 것이 최대 리스크이므로.
3. **배포급 fake + 공개 테스트 킷** — `InMemoryTransportPair`, `FakeClock`, `FakePtySpawner`를
   각 패키지 `src/test/`에 두고 `exports["./test"]`로 공개. 세 패키지가 같은 더블을 공유하고,
   `FakePtySpawner`는 로컬 데모·CI에서도 재사용한다.
4. **포트 계약 스위트 공유** — `describeTransportContract(makeTransport)` 하나를 메모리·WS
   어댑터 양쪽에 실행. Transport의 의미론 계약(순서 보장, 백프레셔 신호)을 실행되는 테스트로 만든다.
5. **시간 결정론** — 유예·백오프·rate limit은 FakeClock으로 시간을 감아 검증.
   스트림 테스트는 gate promise 패턴(수동 resolve로 막았다 열기). sleep 금지,
   대기는 조건 폴링(`waitUntil(...)`)만.
6. **프로토콜 계약 드리프트 테스트** — 제어 메시지 직렬화 형태와 데이터 프레임 바이트 레이아웃을
   골든 테스트로 고정. 변경 시 `PROTOCOL.md` 갱신과 버전 범프를 강제.
7. **플로우 e2e (주력)** — 실제 서버(포트 0) + 실제 Agent(자식 프로세스, 진짜 PTY) + 실제 ws
   클라이언트 2~3개로 협업 시나리오 검증: A 입력 → B 수신 → C 늦은 조인 replay → A 단절 →
   유예 후 임대 해제 브로드캐스트. `given.room()` / `given.host()` / `assert.allClientsSee()`
   시나리오 DSL. 동기화는 프로토콜의 sync 메시지를 사용한다 (sleep 없음).
8. **어서션 품질 + 표준 케이스** — `expectFrameToMatch()` 등 실패 메시지에 투자한 도메인 매처
   (실패 시 수신 프레임 타입 목록과 최근접 diff 출력). 재전송·중복 멱등성 테스트를 모든
   유즈케이스의 기본 케이스로 승격 ("같은 acquire-lease가 두 번 와도 상태 동일").
9. **UI 스모크** — Playwright 한두 개: Room 생성 → Agent 연결 → 터미널 클릭 → 타이핑 → 출력 확인.
   Web 트랙에 속하며 web 착수 시 추가한다.
10. **실행과 게이트** — `pnpm test` = 유닛+프로토콜(인프라 불요). `test:integration` = 실제 PTY/WS.
    `test:e2e` = 플로우. 환경 미비 시 사유를 이름에 담은 `describe.skip`. CI는 GitHub Actions를
    처음부터 두고, PR 게이트는 유닛+프로토콜, 전체는 main 머지 시.

## MVP 범위

이번 구현 계획의 산출물은 **protocol + server + agent + 플로우 e2e**다.
Web UI는 별도 트랙이므로, 아래 "포함" 중 UI 관련 항목(터미널 탭·분할, 카드 표시 등)의
화면 구현은 web 트랙에서 완성된다. 서버·Agent는 해당 기능의 프로토콜·상태 관리를 이번에 완성한다.

### 포함

- Quick Room 생성·참여 (링크 + 닉네임)
- CLI Agent 연결 (`npx ttyroom join <url>`), Host별 다중 터미널
- 터미널 목록·탭·분할, 터미널 카드의 자동 맥락 표시
- Exclusive 입력권 (클릭 획득), 터미널별 Shared 모드 옵트인
- 참여자·입력권 소유자 표시
- 재접속 복구 (스냅샷 + replay), 유예 기반 임대 회수
- Host Owner Kill Switch
- 백프레셔 처리, 프로토콜 버전 협상

### 후속 검토 (설계가 경로를 열어둔 것)

- SnapshotStore 어댑터 → 서버 재시작 복구, Team Room
- Identity 어댑터 → Tailscale identity, SSO
- E2E 암호화 (페이로드 불투명성이 전제 조건을 마련)
- Agent 데몬 모드 (`ttyroom up`), 기존 세션/tmux attach
- Agent Rust/Go 재작성 (PROTOCOL.md가 전제 조건)
- 명령 제안·승인, 타임라인, 감사 로그

### 제외

- 자체 음성·영상, 범용 채팅, 파일 탐색기·IDE 기능, AI 요약,
  운영 자격증명 보관, 완전한 녹화·재생, 자체 터미널 렌더러

## 품질 기준

`docs/brainstorming.md`의 품질 기준 7항을 그대로 승계하며, 이 설계에서의 담보 지점은 다음과 같다.

| 기준 | 담보 지점 |
|---|---|
| 누가 조작하는지 즉시 이해 | lease 브로드캐스트 + 터미널 카드 시각 상태 |
| 의도 없는 입력권 탈취 금지 | 타인 소유 클릭은 포커스만, 선착순 불변식 |
| 오래된 입력의 우회 금지 | 입력 프레임의 leaseId 검증 (서버 단일 지점) |
| 포트 개방 불필요 | Agent·브라우저 모두 아웃바운드만 |
| 느린 스트림 격리 | 참여자별 드롭 + sync 재동기화, 터미널별 rate limit |
| 새로고침 시 프로세스 보존 | 임대와 PTY 수명의 분리, 유예 복구 |
| Host Owner 차단권 | Agent 로컬 Kill Switch (서버 비경유) |
