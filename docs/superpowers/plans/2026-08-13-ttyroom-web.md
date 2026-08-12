# TTYRoom Web Frontend + Integration Implementation Plan

> **Execution rule:** 이 문서는 F7 구현자가 한 Task씩 순서대로 실행하는 계획이다. 각 행동은
> `RED 실행 -> 실패 원인 확인 -> 최소 GREEN -> 관련 게이트 -> GREEN 상태에서만 REFACTOR -> 커밋`
> 순서를 지킨다. 테스트를 나중에 추가하거나 실행하지 않은 RED/GREEN을 보고하지 않는다.

**Goal:** 승인된 floating terminal workspace를 `packages/web`의 React + Vite + xterm.js
애플리케이션으로 구현하고, 같은 프로세스의 실제 TTYRoom Server/Agent와 통합해 두 명 이상의
브라우저 참여자가 터미널을 관찰·제어·복구할 수 있음을 검증한다.

**Scope:** Web 패키지, 서버 정적 파일 서빙, 실제 Server/Agent 브라우저 인수 테스트, 접근성,
동일 viewport visual QA까지다. F5 protocol/server/agent 계약 자체를 다시 설계하거나 구현하지 않는다.

**Specs:**

- `docs/superpowers/specs/2026-08-12-ttyroom-mvp-design.md`
- `docs/superpowers/specs/2026-08-12-ttyroom-web-ui-design.md`
- 시각 단일 진실: `docs/superpowers/specs/assets/ttyroom-floating-terminal-workspace.png`
  (`1487 x 1058 px`, 기준 캡처도 CSS `1487 x 1058`, `deviceScaleFactor: 1`)

**Implementation discipline:**

- `/Users/idonghyeon/projects/donghyuns-agent-tools/plugins/dev-discipline/skills/tdd/SKILL.md`
- `/Users/idonghyeon/projects/semantic-context-os/CODING-GUIDELINES.md`
- `/Users/idonghyeon/projects/ttyroom/sprints/ttyroom-mvp/INSTRUCTION.md`

### Sprint context

- Plan assignment: `F6 / T6.1` (Web 구현·통합·인수·visual QA 실행 계획).
- Implementation target after review: `F7` (Web frontend + integration).
- Sprint root: `/Users/idonghyeon/projects/ttyroom/sprints/ttyroom-mvp`.
- Main repository: `/Users/idonghyeon/projects/ttyroom/main`; implementation은 F7 전용 worktree에서만 한다.
- Dependency: F7은 F5 contracts와 본 F6 plan이 모두 main에 통합되기 전까지 blocked다.
- Sprint decision: Available Terminal 클릭은 창 선택만 하며 Lease는 명시적 `Take control`에서 요청한다.
- Sprint decision: server authoritative state와 사용자별 browser layout을 분리한다.
- Sprint lessons: `_sprint.md`에 현재 추가 lesson 없음.
- 이 F6 산출물은 계획 문서만 커밋한다. Sprint owner의 명시적 지시가 없으므로 `BACKLOG.md`,
  `HANDOFF.md`, `active/`, `refs/`는 수정하지 않는다.

**Grounding files (implementation 전에 현재 내용 재확인):**

- `/Users/idonghyeon/projects/ttyroom/main/docs/superpowers/specs/2026-08-12-ttyroom-mvp-design.md`
- `/Users/idonghyeon/projects/ttyroom/main/docs/superpowers/specs/2026-08-12-ttyroom-web-ui-design.md`
- `/Users/idonghyeon/projects/ttyroom/main/docs/superpowers/specs/assets/ttyroom-floating-terminal-workspace.png`
- `/Users/idonghyeon/projects/ttyroom/main/packages/{protocol,server,agent,e2e}`
- `/Users/idonghyeon/projects/libera/main/packages/frontend/vitest.config.ts`, `vitest.setup.ts`
- `/Users/idonghyeon/projects/libera/main/packages/frontend/src/app/admin/lectures/_monitoring/LectureOpsProvider.tsx`, `.test.tsx`
- `/Users/idonghyeon/projects/libera/main/packages/frontend/src/app/lectures/[id]/discussion-board/_components/ThreadContext.tsx`, `.test.tsx`
- `/Users/idonghyeon/projects/libera/main/e2e/src/{fixtures,page-objects,setup}`
- `/Users/idonghyeon/projects/hzpro-dev/main/packages/apps/institution/src/features/work-review/core/review-round-state.ts`, `.test.ts`
- `/Users/idonghyeon/projects/hzpro-dev/main/packages/apps/institution/src/features/work-review/ui/hooks/use-stream-core.ts`, `.test.ts`
- `/Users/idonghyeon/projects/hzpro-dev/main/packages/apps/institution/e2e/shared/scenarios/base-scenario.ts`
- `/Users/idonghyeon/projects/ttyroom/main/refs/sshx/src/lib/ui/XTerm.svelte`
- `/Users/idonghyeon/projects/ttyroom/main/refs/sshx/src/lib/Session.svelte`
- `/Users/idonghyeon/projects/ttyroom/main/refs/sshx/src/lib/arrange.ts`

## 1. 구현 브리핑

### 1.1 제품 흐름

```text
Room URL(/r/:roomId#token)
  -> Room Entry(닉네임)
  -> BrowserTransport(WS /ws, protocol public API만 사용)
  -> RoomSession(연결 수명·명령·재접속)
  -> RoomProjection(서버 snapshot/event/output을 유일한 사실로 투영)
  -> React Room Workspace
       |- WindowManager + LayoutRepository: 사용자별 표현 상태
       |- TerminalController -> XtermAdapter: terminalId당 정확히 1개
       |- Dock: 메타데이터만, xterm 없음
       `- Overview: 같은 Window DOM을 재배치·축소, xterm 복제 없음
```

서버 상태와 브라우저 표현 상태를 섞지 않는다. `RoomProjection`은 Host/Terminal/Participant/Lease,
output seq를 소유한다. `WindowManager`는 위치·크기·z-order·최소화·최대화·overview만 소유한다.
창 이동은 WS 메시지를 만들지 않고, Room event는 다른 사용자의 창을 움직이지 않는다.

### 1.2 기존 프로덕션 모노레포에 대한 Product Design preflight 조정

Product Design의 `local-prototype-preflight`는 **새 독립 프로토타입** 생성 규칙이다. 이 작업은 기존
pnpm 프로덕션 모노레포에 `packages/web`을 추가하므로 bootstrap template, Sites starter,
`init-site.sh`, 별도 prototype 폴더를 사용하지 않는다. 대신 기존 Node >= 22, ESM, pnpm workspace,
strict TS, Vitest, Prettier, dependency-cruiser, CI를 그대로 확장한다. 선택된 이미지가 이미 있으므로
ideation을 재실행하지 않는다. 구현 완료 시에는 image-to-code의 브라우저 검증과 design-qa blocking
gate를 그대로 적용한다.

Product Design user-context preflight 결과는 `user-context.md` 없음이었다. 따라서 저장된 외부 디자인
문맥은 없고 위 두 스펙과 기준 PNG만 시각 진실로 사용한다.

### 1.3 레퍼런스에서 채택할 검증된 패턴

- Libera `packages/frontend/vitest.config.ts`, `vitest.setup.ts`: jsdom + React Testing Library +
  jest-dom의 작은 component test stack.
- Libera `LectureOpsProvider.tsx/.test.tsx`, `ThreadContext.tsx/.test.tsx`: 서버 snapshot을 seed로
  받고 쓰기 가능 여부를 한 owner에서 파생하며, Provider의 공개 동작으로 테스트한다.
- Libera `e2e/src/fixtures/actor.ts`, `actors.ts`, `page-objects/base.ts`, `setup/health-check.setup.ts`:
  사용자마다 독립 BrowserContext/localStorage를 가진 Actor, role 기반 Page Object, 테스트 전 health gate,
  fixture teardown에서 context 정리.
- HZPRO `review-round-state.ts/.test.ts`: UI capability를 흩어진 조건문 대신 순수한 파생 상태로 고정.
- HZPRO `use-stream-core.ts/.test.ts`: rAF batching, 이전 generation 무시, unmount cleanup. Terminal output
  flush와 resize throttle에 같은 수명 규칙을 적용한다.
- `refs/sshx/src/lib/ui/XTerm.svelte`, `Session.svelte`, `arrange.ts`: xterm mount 전 preload buffer,
  dispose, resize 하한, move/resize 빈도 제한, 겹침을 피하는 새 창 배치. sshx의 공유 layout,
  random 배치, 포커스 해킹은 가져오지 않고 TTYRoom의 사용자별 결정론 layout으로 바꾼다.

### 1.4 의존성 선택

구현 시작 시 아래 버전을 lockfile에 고정한다. 버전이 바뀌었다면 새 버전을 자동 채택하지 말고 API/
license를 확인한 후 계획 변경으로 기록한다.

| 용도 | 패키지 | 선택 이유 |
|---|---|---|
| UI | `react@19.2.8`, `react-dom@19.2.8`, `vite@8.2.1`, `@vitejs/plugin-react@6.0.5` | 요구 스택, ESM/Vite 구성 |
| Terminal | `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0` | 자체 renderer를 만들지 않고 terminalId당 한 instance + fit |
| UI icons | `react-feather@2.0.10` | 기준 이미지의 16px, 1.5px stroke 선형 아이콘과 가깝고 `refs/sshx`의 `svelte-feather-icons`와 같은 Feather 어휘를 React에서 유지. Lucide를 관성적으로 선택하지 않음 |
| Fonts | `@fontsource-variable/inter@5.3.0`, `@fontsource-variable/fira-code@5.3.0` | 기준 화면과 `refs/sshx`가 사용하는 Inter Variable + Fira Code를 네트워크 요청 없이 번들 |
| Unit/UI test | `vitest`, `jsdom`, `@testing-library/react@16.3.2`, `@testing-library/user-event@14.6.4`, `@testing-library/jest-dom` | 현재 모노레포 Vitest와 Libera 패턴 유지 |
| Browser | `@playwright/test@1.62.1`, `@axe-core/playwright@4.13.0` | 독립 participant actor, 실제 통합, keyboard/a11y gate |

기준 PNG에는 사진·일러스트·텍스처 같은 별도 raster asset이 없다. PNG 자체를 제품 배경으로 쓰지
않고 비교 증거로만 둔다. 로고와 모든 control icon은 Feather를 사용한다. custom SVG, CSS 그림,
emoji, 텍스트 glyph 대체를 만들지 않는다.

### 1.5 기준 이미지 측정값

아래 값은 첫 구현의 CSS token/visual fixture seed다. 코드에 흩어 쓰지 말고 theme/geometry 상수로
이름을 붙인다. 시각 비교에서 실제 source crop을 다시 열어 확인하며, 오차를 합리화하는 목표치로
사용하지 않는다.

| Surface | 측정값 |
|---|---|
| 전체 | `1487 x 1058`, DPR 1 |
| Top Bar | `y=0..50`, height `50` |
| Workspace | `y=50..914`, height `864`, grid 간격 `15` |
| Dock | `y=914..1058`, height `144` |
| Window | radius `8`, border `#55585A` |
| Base colors | page `#0F1215`, terminal `#111417`, dock `#171A1F`, purple `#9964D4` |
| Semantic colors | own `#57C87A`, other `#F8B322`, read-only `#8EA6C0`, error `#ED4543` |
| backend | `x=62, y=62, width=698, height=613` |
| frontend | `x=788, y=62, width=652, height=453` |
| staging logs | `x=786, y=445, width=671, height=271` |
| tests | `x=40, y=633, width=454, height=223` |
| Claude Code | `x=503, y=569, width=386, height=282` |
| success toast | `x=595, y=857, width=271, height=46` |

기준 이미지의 Dock thumbnail 자리는 같은 footprint의 이름·상태·최근 activity item으로 바꾼다.
이는 이미지와 다른 임의 redesign이 아니라 Web UI 스펙의 명시적 MVP override(중복 renderer 금지)다.

### 1.6 현재 main API inventory (`7089486` 기준)

- HTTP: `GET /healthz`, `POST /api/rooms -> {roomId, token, joinUrl}`, `GET /r/:roomId` placeholder.
  Task 17 전까지 static app은 아직 없다.
- WS: same-origin `/ws`, 한 connection에서 JSON control과 binary data를 multiplex한다.
- Existing participant messages: `hello`, `open-terminal-request`, `acquire-lease`, `release-lease`,
  `resize-request`.
- Existing server messages: `welcome(snapshot)`, `room-event`, `lease-result`, `lease-invalid`, `sync`,
  `output-gap`, `error` 및 host용 `open-terminal`, `close-terminal`, `resize`.
- Binary output: `[type][terminalId:u32][seq:u32][payload]`; binary input은 이어서
  `[leaseId:u32][payload]`. encode/decode는 `@ttyroom/protocol` public API만 쓴다.
- Server is authoritative: `welcome` snapshot 후 `participant/host/terminal/lease/meta` room event가
  상태를 갱신한다. late join/reconnect는 retained output 뒤 `sync`를 보낸다.
- Agent: 실제 `node-pty`, reconnect session, meta collector, local kill switch를 이미 가진다. Web은
  Agent에 직접 연결하거나 PTY 수명을 소유하지 않는다.
- F4 `packages/e2e/src/harness.ts`: 실제 port-0 server, 실제 Agent child, 실제 WS participant를 조립하고
  `openTerminal/acquire/type/outputText/reconnect`와 조건 기반 `waitUntil`을 제공한다. 브라우저 harness는
  이 수명/teardown/동기화 패턴을 재사용하되 Playwright BrowserContext Actor를 추가한다.

## 2. F5 선행 계약 — 구현 전 blocking gate

F7 브랜치는 F5와 F6가 main에 들어간 뒤 만든다. 아래 public `@ttyroom/protocol` 계약을 먼저 확인한다.
이름이 다르면 F5의 최종 public export가 단일 진실이며, 이 계획을 갱신한 뒤 구현한다. web은 protocol
source deep import나 server domain type을 import하지 않는다.

```ts
RoomSnapshot & { name: string };
HostView & { remoteInputAllowed: boolean };

// participant -> server
{ type: "close-terminal-request"; terminalId: number }
{ type: "set-terminal-mode-request"; terminalId: number; mode: "exclusive" | "shared" }
{ type: "resync-output-request"; terminalId: number; afterSeq?: number }

// host -> server
{ type: "host-input-state"; remoteInputAllowed: boolean }

// server -> room
{ type: "room-event"; event: { kind: "host-input-state"; hostId: string; remoteInputAllowed: boolean } }
{ type: "room-event"; event: { kind: "terminal-mode-changed"; terminalId: number; mode: "exclusive" | "shared" } }

// expected failure is typed, including remote-input-disabled
{ type: "lease-invalid"; terminalId: number; reason: LeaseInvalidReason }
```

추가 F5 의미론:

- `POST /api/rooms`가 Room 이름을 받아 snapshot의 `name`으로 돌아온다. 이전 payload는 `Quick Room`으로
  정규화되지만 web은 임의 fallback을 만들지 않는다.
- Host Agent는 connect와 kill-switch toggle 때 `host-input-state`를 보고한다. Web은
  `HostView.remoteInputAllowed`만 읽는다.
- participant의 close, mode 변경, replay 요청은 위 message를 통해서만 수행한다.
- input binary layout은 shared에서도 `leaseId` slot을 유지한다. F5가 현재 server contract test처럼
  shared 입력의 sentinel을 `0`으로 고정한 것을 `PROTOCOL.md`에서 확인하고 그 public 규칙을 사용한다.
- replay는 retained output 뒤 `sync`로 끝난다. Web은 `output-gap`을 받으면 terminal별 마지막 연속 seq를
  `afterSeq`로 보내며, `sync` 전까지 `restoring`으로 표시한다.

**Preflight commands (모두 PASS 전에는 Task 1 금지):**

```bash
git status --short --branch
git log --oneline --decorate -12
rg -n 'name: z.string|remoteInputAllowed|close-terminal-request|set-terminal-mode-request|resync-output-request|host-input-state|terminal-mode-changed|remote-input-disabled' packages/protocol packages/server packages/agent
pnpm --filter @ttyroom/protocol test
pnpm --filter @ttyroom/server test
pnpm --filter @ttyroom/agent test
pnpm test:e2e
```

## 3. 목표 파일 구조와 public contracts

```text
packages/web/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── vitest.setup.ts
├── playwright.config.ts
├── playwright.visual.config.ts
├── src/
│   ├── main.tsx
│   ├── app/{create-web-app,room-route,room-api,room-identity}.*
│   ├── projection/room-projection.*
│   ├── transport/{browser-transport,browser-socket}.*
│   ├── session/room-session.*
│   ├── layout/layout-repository.*
│   ├── windows/{window-manager,window-geometry}.*
│   ├── terminal/{terminal-controller,xterm-adapter,terminal-adapter}.*
│   ├── ui/
│   │   ├── App.tsx, theme.css, app.css
│   │   ├── room/{RoomEntry,RoomWorkspace,RoomGone}.*
│   │   ├── chrome/{TopBar,Dock,Overview}.*
│   │   ├── terminal/{TerminalWindow,TerminalScene,TerminalStatus}.*
│   │   └── overlays/{AddHostDrawer,CloseTerminalDialog,ToastRegion,ConnectionBanner}.*
│   └── test/{fake-browser-socket,fake-terminal-adapter,room-builders}.ts
└── e2e/
    ├── fixtures/{test-system,participant-actor,actors}.ts
    ├── pages/{room-entry.page,room-workspace.page}.ts
    ├── setup/health-check.setup.ts
    ├── room-collaboration.e2e.ts
    ├── room-recovery.e2e.ts
    ├── keyboard-accessibility.e2e.ts
    └── visual/{reference-app,reference-room,reference.e2e}.tsx

packages/server/
├── scripts/copy-web-assets.mjs
└── src/http/{http-api,static-web-app}.*   # 기존 src/http.ts는 이 경계로 이동

design-qa.md
artifacts/design-qa/                       # 비교 증거; repo 정책에 따라 screenshot은 gitignore 가능
```

핵심 interface는 다음처럼 얕게 유지한다.

```ts
interface RoomProjectionView {
  connection: "joining" | "live" | "reconnecting" | "restoring" | "gone" | "incompatible";
  selfClientId: string | null;
  room: RoomSnapshot | null;
  terminal(terminalId: number): ProjectedTerminal | null;
}

interface RoomSessionCommands {
  openTerminal(hostId: string): void;
  closeTerminal(terminalId: number): void;
  takeControl(terminalId: number): void;
  releaseControl(terminalId: number): void;
  setMode(terminalId: number, mode: TerminalView["mode"]): void;
  resize(terminalId: number, cols: number, rows: number): void;
  sendInput(terminalId: number, bytes: Uint8Array): SendInputResult;
}

interface TerminalAdapter {
  mount(element: HTMLElement): void;
  write(bytes: Uint8Array): void;
  fit(): { cols: number; rows: number };
  focus(): void;
  setInputEnabled(enabled: boolean): void;
  dispose(): void;
  onInput(handler: (bytes: Uint8Array) => void): () => void;
}
```

`BrowserTransport`, `RoomSession`, `RoomProjection`, `WindowManager`, `LayoutRepository`,
`TerminalController`, `XtermAdapter`는 상태·의존성·수명을 가진 역할이므로 class로 만든다. React는 이
객체를 조립하고 view를 구독할 뿐 protocol 판단을 복제하지 않는다.

## 4. 공통 TDD 및 커밋 절차

각 Task에서 다음 순서를 그대로 반복한다.

1. 행동 장부의 첫 항목 하나만 co-located spec에 작성한다.
2. 표시된 `RED` command를 실행한다. 새 테스트가 실제 실행됐고 요구 행동 부재로 실패했는지 확인한다.
3. 현재 항목만 통과시키는 최소 production 변경을 한다.
4. `GREEN narrow` 후 `GREEN package`를 실행한다.
5. 구조 개선이 필요하면 GREEN에서만 하고 narrow/package를 다시 실행한다.
6. `git diff --check && git status --short`로 범위를 확인한다.
7. Task별 commit command를 실행한다. 메시지 본문 끝에 빈 줄 + 지정 trailer를 둔다.

아래의 `Expected RED`는 예상 이유이지 실행 증거가 아니다. 실제 오류가 다르면 진행을 멈추고 test/
environment를 고친 뒤 올바른 RED를 다시 만든다.

---

## Phase A — Package + Core

### Task 1: `@ttyroom/web` 실행·테스트 shell

**Files:** root `package.json`, `pnpm-lock.yaml`; create `packages/web/{package.json,tsconfig.json,index.html,vite.config.ts,vitest.config.ts,vitest.setup.ts}`; create/test `src/app/create-web-app.ts`, `create-web-app.spec.ts`; create `src/main.tsx`.

**Behavior ledger:** app factory가 주입된 root에 React app을 한 번 mount하고 dispose가 unmount한다.

**RED:** `pnpm --filter @ttyroom/web exec vitest run src/app/create-web-app.spec.ts`

**Expected RED:** `create-web-app.js` 또는 `createWebApp` 부재.

**GREEN:** `pnpm --filter @ttyroom/web test && pnpm --filter @ttyroom/web typecheck && pnpm --filter @ttyroom/web build`

**Implementation notes:**

- `packages/web/package.json` scripts는 정확히 다음 역할을 제공한다:
  `dev: vite`, `test: vitest run`, `typecheck: tsc -p tsconfig.json --noEmit`,
  `build: tsc -p tsconfig.json --noEmit && vite build`,
  `test:browser: playwright test --config playwright.config.ts`,
  `test:visual: playwright test --config playwright.visual.config.ts`.
- root scripts는 `test:browser`와 `test:visual`을 각각 위 package script로 위임한다.
- `vite.config.ts`는 `/api`, `/ws`를 `VITE_TTYROOM_SERVER_ORIGIN`으로 proxy하고 코드에는 host를 hardcode하지 않는다.
- `vitest`는 `jsdom`, `restoreMocks`, setup의 jest-dom과 결정론 `matchMedia`만 둔다.
- root에 `test:browser`, `test:visual` scripts를 추가하되 아직 CI에 blocking으로 연결하지 않는다.
- dependency command:
  ```bash
  pnpm --filter @ttyroom/web add react@19.2.8 react-dom@19.2.8 '@ttyroom/protocol@workspace:*' @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 react-feather@2.0.10 @fontsource-variable/inter@5.3.0 @fontsource-variable/fira-code@5.3.0
  pnpm --filter @ttyroom/web add -D vite@8.2.1 @vitejs/plugin-react@6.0.5 jsdom @types/react @types/react-dom @testing-library/react@16.3.2 @testing-library/user-event@14.6.4 @testing-library/jest-dom @playwright/test@1.62.1 @axe-core/playwright@4.13.0
  ```

**Commit:** `feat(web): bootstrap React package`

### Task 2: Room route, HTTP creation, browser identity

**Files:** create/test `src/app/room-route.ts`, `room-api.ts`, `room-identity.ts` and matching `*.spec.ts`.

**Interfaces:**

```ts
type RoomRoute = { kind: "entry" } | { kind: "room"; roomId: string; token: string };
class RoomApi { createRoom(name: string, signal?: AbortSignal): Promise<CreateRoomResult>; }
class RoomIdentity { clientId(roomId: string): string; nickname(roomId: string): string | null; saveNickname(...): void; }
```

**Ledger:** fragment token parsing without decode ambiguity -> create-room response runtime validation -> stable per-room clientId without token persistence.

For each item run:

```bash
pnpm --filter @ttyroom/web exec vitest run src/app/room-route.spec.ts
pnpm --filter @ttyroom/web exec vitest run src/app/room-api.spec.ts
pnpm --filter @ttyroom/web exec vitest run src/app/room-identity.spec.ts
```

**Expected RED:** missing parser/class, then invalid response is not rejected, then identity changes or stores secret.

**GREEN package:** `pnpm --filter @ttyroom/web test && pnpm --filter @ttyroom/web typecheck`

**Constraints:** HTTP `unknown -> zod -> domain result`; token stays URL fragment/in-memory and never localStorage/log/error text; expected HTTP failure is discriminated union.

**Commit:** `feat(web): add room route and identity boundaries`

### Task 3: Authoritative `RoomProjection`

**Files:** create/test `src/projection/room-projection.ts`, `room-projection.spec.ts`; create `src/test/room-builders.ts` only after first GREEN if repeated setup justifies it.

**Ledger:** welcome replaces state atomically -> every current/F5 room-event mutates only its entity -> derived terminal joins host/lease/holder/remote-input state -> unknown terminal event is safe and diagnosed -> subscriber sees immutable snapshots.

**RED/GREEN narrow:**

```bash
pnpm --filter @ttyroom/web exec vitest run src/projection/room-projection.spec.ts
```

**Expected RED:** first `RoomProjection` missing; later event or derived state differs.

**Required derived capability:**

```ts
type InputCapability =
  | { kind: "mine"; leaseId: number }
  | { kind: "available" }
  | { kind: "held-by-other"; holderName: string }
  | { kind: "shared" }
  | { kind: "read-only"; reason: "host-disabled" | "host-offline" | "exited" };
```

React component가 clientId/lease/mode/host 상태를 다시 조합하지 않게 한다.

**GREEN package:** `pnpm --filter @ttyroom/web test && pnpm --filter @ttyroom/web typecheck`

**Commit:** `feat(web): project authoritative room state`

### Task 4: Output seq, gap, replay convergence

**Files:** modify/test `src/projection/room-projection.ts`, `.spec.ts`.

**Ledger:** 연속 output을 한 번만 publish -> 중복/과거 seq 무시 -> gap은 terminal 하나만 restoring + replay intent -> retained replay가 빈틈을 메움 -> `sync`가 연속 seq와 일치할 때 live; 다른 terminal은 영향 없음.

**RED:** `pnpm --filter @ttyroom/web exec vitest run src/projection/room-projection.spec.ts -t 'output|gap|replay|sync'`

**Expected RED:** 중복 bytes publish, gap 미감지, 또는 sync가 조기 live 전환.

**GREEN:** same command, then `pnpm --filter @ttyroom/web test`.

`RoomProjection`은 output payload를 xterm에 직접 쓰지 않고 `TerminalOutput` 이벤트를 낸다. replay 요청 자체는 `RoomSession`이 보낸다.

**Commit:** `feat(web): converge terminal output replay`

### Task 5: Browser WebSocket adapter

**Files:** create/test `src/transport/browser-socket.ts`, `browser-transport.ts`, `.spec.ts`, `src/test/fake-browser-socket.ts`.

**Interface:** real `WebSocket`을 `BrowserSocket` port 뒤에 숨기고, `BrowserTransport`는 same-origin `/ws`, JSON parse/serialize, binary `ArrayBuffer`, open/close/error, idempotent dispose만 소유한다.

**Ledger:** open 후 hello 1회 -> JSON server message parse -> binary data decode -> malformed frame is expected failure -> close/dispose 뒤 late event 무시 -> token 없는 logs.

**RED:** `pnpm --filter @ttyroom/web exec vitest run src/transport/browser-transport.spec.ts`

**Expected RED:** adapter missing, later late event가 subscriber로 샘.

**GREEN:** same command, then `pnpm --filter @ttyroom/web test && pnpm --filter @ttyroom/web typecheck`.

**Commit:** `feat(web): add browser protocol transport`

### Task 6: `RoomSession` command and reconnect lifecycle

**Files:** create/test `src/session/room-session.ts`, `room-session.spec.ts`.

**Ledger (one RED/GREEN each):** start/hello/welcome -> reconnect with same clientId and bounded injected clock -> explicit Take control (window focus alone sends nothing) -> switch control release then acquire -> Esc release -> close/mode/resize F5 messages -> typed lease denial/invalid feedback -> output-gap replay request with `afterSeq` -> stop cancels timers and transport.

**RED:** `pnpm --filter @ttyroom/web exec vitest run src/session/room-session.spec.ts`

**Expected RED:** current ledger command/state missing. Interaction assertions are allowed because WS send is this boundary's observable contract.

**GREEN:** same command, then web package suite.

**Constraints:** no optimistic lease owner mutation; only `pending-control` may be local. `welcome`/room-event remains authoritative. Backoff clock and ID are injected. All public failures are discriminated unions.

**Commit:** `feat(web): orchestrate room session lifecycle`

### Task 7: `LayoutRepository` persistence and cleanup

**Files:** create/test `src/layout/layout-repository.ts`, `.spec.ts`.

**Ledger:** key is versioned `roomId + clientId + viewportBucket` -> malformed/old JSON returns empty safely -> terminal removal prunes entry -> room gone clears room keys only -> viewport restore clamps later through WindowManager -> token/nickname/output never persisted.

**RED:** `pnpm --filter @ttyroom/web exec vitest run src/layout/layout-repository.spec.ts`

**Expected RED:** repository missing or malformed JSON throws.

**GREEN:** same + web suite.

**Commit:** `feat(web): persist participant window layouts`

### Task 8: `WindowManager` deterministic geometry

**Files:** create/test `src/windows/window-geometry.ts`, `window-manager.ts`, matching specs.

**Interfaces:** `reconcile`, `activate`, `move`, `resize`, `minimize`, `maximize`, `restore`, `arrange`, `enterOverview`, `exitOverview`, `subscribe`.

**Ledger:** deterministic cascade -> activation only changes z -> title bar remains at least 48 px visible -> min size 360x240 -> arrange tiles all non-minimized windows -> focused/maximized keeps others in Dock -> viewport resize clamps -> overview preserves pre-overview geometry.

**Desktop bounds:** baseline `1487x1058`; required checks `1024x768`, `1280x800`, `1920x1080`; workspace excludes measured top bar/dock. `<1024` width uses desktop-required state and never enables terminal input.

**RED:** `pnpm --filter @ttyroom/web exec vitest run src/windows/window-geometry.spec.ts src/windows/window-manager.spec.ts`

**Expected RED:** manager absent, then boundary/arrange invariant failure.

**GREEN:** same + web suite.

No random placement, DOM measurement in algorithm, or server write. Geometry gets an explicit viewport input.

**Commit:** `feat(web): manage bounded terminal windows`

### Task 9: `TerminalController` lifecycle and batching

**Files:** create/test `src/terminal/terminal-adapter.ts`, `terminal-controller.ts`, `.spec.ts`, `src/test/fake-terminal-adapter.ts`.

**Ledger:** mount once per terminalId -> pre-mount bytes buffered in seq order -> one rAF flush -> input forwards only when capability allows -> Tab produces no terminal bytes -> fit resize is throttled/deduped -> hidden terminal still tracks seq -> remount does not create a second adapter -> dispose cancels rAF/listeners.

**RED:** `pnpm --filter @ttyroom/web exec vitest run src/terminal/terminal-controller.spec.ts`

**Expected RED:** class missing, later duplicate adapter/write or stale rAF.

**GREEN:** same + web suite.

Adopt HZPRO generation/rAF cleanup idea: scheduled flush captures generation and cannot mutate a disposed/replaced controller.

**Commit:** `feat(web): control terminal renderer lifecycle`

### Task 10: `XtermAdapter` one-instance contract

**Files:** create/test `src/terminal/xterm-adapter.ts`, `xterm-adapter.spec.ts`; modify `src/main.tsx` to import `@xterm/xterm/css/xterm.css` and font files.

**Ledger:** exact one `Terminal` + one `FitAddon` -> UTF-8 onData mapping -> write/fit/focus -> input disabled blocks bytes but preserves scroll -> Tab handed to browser -> dispose once.

**RED:** `pnpm --filter @ttyroom/web exec vitest run src/terminal/xterm-adapter.spec.ts`

**Expected RED:** adapter missing or terminal factory call count != 1.

**GREEN:** same + web package suite/build.

Inject `XtermFactory` in tests; do not mock `TerminalController` internals. WebGL addon is not added in MVP: first establish default renderer correctness, measure 4–6 terminals, then consider it separately.

**Commit:** `feat(web): adapt xterm renderer`

---

## Phase B — UI screens and interactions

### Task 11: Theme, entry, gone, and app state routing

**Files:** create/test `src/ui/{App.tsx,theme.css,app.css}`, `src/ui/room/{RoomEntry,RoomGone}.*`; modify `create-web-app.ts`.

**Ledger:** bare route creates named Quick Room -> room link shows nickname sheet -> join disabled only for invalid name -> joining/restoring states announced -> room-not-found replaces workspace with Room Gone -> create-new action works.

**RED:** `pnpm --filter @ttyroom/web exec vitest run src/ui/App.spec.tsx src/ui/room/RoomEntry.spec.tsx src/ui/room/RoomGone.spec.tsx`

**Expected RED:** screens absent or visible state incorrect.

**GREEN:** same + `pnpm --filter @ttyroom/web test && pnpm --filter @ttyroom/web build`.

Use semantic form/heading/status. Font tokens: Inter Variable UI 14–16px; Fira Code terminal 14px; near-black/charcoal, restrained purple, no gradients/glow/glass.

**Commit:** `feat(web): render room entry and terminal states`

### Task 12: Workspace, Top Bar, status semantics

**Files:** create/test `src/ui/room/RoomWorkspace.tsx`, `src/ui/chrome/TopBar.tsx`, `src/ui/terminal/TerminalStatus.tsx` and CSS/specs.

**Ledger:** Room name/Connected/commands -> Host/title/cwd/branch -> mine/available/other/read-only/shared/exited status with icon+text -> inactive window differs from terminal focus -> 5 terminals distinguishable without color.

**RED:** component spec command for the three specs.

```bash
pnpm --filter @ttyroom/web exec vitest run src/ui/room/RoomWorkspace.spec.tsx src/ui/chrome/TopBar.spec.tsx src/ui/terminal/TerminalStatus.spec.tsx
```

**Expected RED:** accessible labels/status copy missing.

**GREEN:** same + package suite/build.

Use Feather `Terminal`, `Link`, `Grid`, `Monitor`, `MoreVertical`, `User`, `Eye`, `Lock`, `CheckCircle` (or closest actual exports), 기본 `size=16`, `strokeWidth=1.5`. Verify actual exports by typecheck; do not replace missing icons with glyphs.

**Commit:** `feat(web): render workspace status chrome`

### Task 13: Terminal scene, windows, Dock, Overview

**Files:** create/test `src/ui/terminal/{TerminalScene,TerminalWindow}.*`, `src/ui/chrome/{Dock,Overview}.*`.

**Ledger:** one TerminalWindow per terminalId -> click brings front but never acquires -> explicit Take/Switch -> drag/resize commits bounded geometry -> minimize/maximize/restore -> Dock restores and contains metadata/activity only -> Overview reuses same window DOM and disables input -> close opens confirmation.

**RED:** component spec command for all four specs.

```bash
pnpm --filter @ttyroom/web exec vitest run src/ui/terminal/TerminalScene.spec.tsx src/ui/terminal/TerminalWindow.spec.tsx src/ui/chrome/Dock.spec.tsx src/ui/chrome/Overview.spec.tsx
```

**Expected RED:** missing UI or `XtermFactory` count rises when Dock/Overview opens.

**GREEN:** same + package suite/build.

**No duplicate renderer gate:** one keyed `TerminalWindow` tree remains mounted. Overview applies alternate transforms/scale to those nodes; it does not map terminals into another xterm component. Dock never imports `TerminalController`, `XtermAdapter`, or xterm package. Add a dependency test/depcruise rule if this invariant is not obvious from the component test.

**Commit:** `feat(web): implement floating terminal workspace`

### Task 14: Overlay stack and modal-first keyboard

**Files:** create/test `src/ui/overlays/{AddHostDrawer,CloseTerminalDialog,ToastRegion}.*`; create/test `src/ui/use-workspace-keyboard.ts`; modify TopBar/Workspace.

**Ledger:** Add Host command copy/wait/success/failure -> close confirm sends F5 close only after confirmation -> toast is polite assertive by severity -> Tab follows focus order and sends no input/acquire -> Esc closes top modal/drawer first -> next Esc releases current lease -> Overview keyboard enter/exit -> focus returns to opener.

**RED:**

```bash
pnpm --filter @ttyroom/web exec vitest run src/ui/overlays src/ui/use-workspace-keyboard.spec.tsx
```

**Expected RED:** overlay absent; Esc releases behind open modal; Tab causes input or action.

**GREEN:** same + package suite.

Dialogs use native `<dialog>` only if focus behavior is deterministic in supported browsers; otherwise one small accessible dialog component owns trap/restore. No generic wrapper layer unless it reduces all overlay caller burden.

**Commit:** `feat(web): add accessible workspace overlays`

### Task 15: Connection/error/responsive states

**Files:** create/test `src/ui/overlays/ConnectionBanner.*`; modify/test Workspace/TerminalWindow/app CSS.

**Ledger:** reconnect keeps geometry and says processes continue -> restoring blocks input until sync -> host offline/read-only -> remote input disabled -> exited code/actions -> lease denied owner toast -> protocol mismatch upgrade screen -> reduced motion -> unsupported narrow viewport.

**RED:**

```bash
pnpm --filter @ttyroom/web exec vitest run src/ui/overlays/ConnectionBanner.spec.tsx src/ui/room/RoomWorkspace.spec.tsx src/ui/terminal/TerminalWindow.spec.tsx
```

**Expected RED:** each newly introduced state lacks copy/interaction guard.

**GREEN:** same + package suite/build.

CSS must show reference proportions at 1487x1058 and remain usable at the three desktop bounds. Persistent top/dock controls must not overflow. `prefers-reduced-motion` removes nonessential snap/overview transitions.

**Commit:** `feat(web): surface recovery and responsive states`

### Task 16: Production composition root

**Files:** create/test `src/app/room-app.ts`, `.spec.tsx`; modify `create-web-app.ts`, `main.tsx`.

**Ledger:** route -> identity -> BrowserTransport -> RoomSession -> Projection -> Repository/WindowManager -> terminalId-scoped Controller map -> teardown in reverse order. Terminal removal disposes exactly its controller; app unmount disposes all once.

**RED:** `pnpm --filter @ttyroom/web exec vitest run src/app/room-app.spec.tsx`

**Expected RED:** roles are not wired or lifecycle count differs.

**GREEN:** same + full web unit/type/build.

`main.tsx` is boundary-only. It may parse root/config and call factory; it contains no state decision. React Context exposes stable semantic APIs, not raw socket or mutable maps.

**Commit:** `feat(web): compose room application`

---

## Phase C — Single-process static integration

### Task 17: Secure static web serving from Server

**Files:** move/refactor `packages/server/src/http.ts` to `src/http/http-api.ts`; create/test `src/http/static-web-app.ts`, `.spec.ts`; modify/test `src/main.ts`, `main.integration.spec.ts`; create `scripts/copy-web-assets.mjs`; modify server/root package scripts and lockfile.

**Ledger:** `/assets/*` serves built bytes/content type/cache -> `/` and `/r/:id` return SPA index -> `/api/*`, `/healthz`, `/ws` keep precedence -> missing hashed asset is 404, not index -> traversal/encoded traversal rejected -> HEAD works -> package build copies web dist -> production start serves one process.

**RED:**

```bash
pnpm --filter @ttyroom/server exec vitest run src/http/static-web-app.spec.ts
pnpm --filter @ttyroom/server exec vitest run --config vitest.integration.config.ts src/main.integration.spec.ts
```

**Expected RED:** class/routes absent; `/r/:id` returns placeholder text.

**GREEN:** same commands, then:

```bash
pnpm --filter @ttyroom/web build
pnpm --filter @ttyroom/server build
test -f packages/server/dist/web/index.html
pnpm --filter @ttyroom/server test
pnpm --filter @ttyroom/server test:integration
```

Build ordering is explicit: server has build-only workspace dependency on web, then `copy-web-assets.mjs` copies
`packages/web/dist` to `packages/server/dist/web`. Runtime server does not import web source. Static adapter resolves
and containment-checks absolute paths; HTML is no-cache, hashed assets immutable.

**Commit:** `feat(server): serve bundled web application`

### Task 18: Root gates and dependency boundaries

**Files:** modify `.dependency-cruiser.cjs`, `.github/workflows/ci.yml`, root/package manifests.

**Ledger:** web may import protocol only; web core does not import React/xterm; Dock/Overview do not import xterm; server src does not import web src; unit PR gate stays infrastructure-free; browser gate has explicit CI job/artifacts.

**RED:** first add rules then run `pnpm depcruise`; expected failure pinpoints existing forbidden import if architecture drifted. A rule that passes immediately is a characterization gate, not RED—report it honestly and do not fabricate RED.

**GREEN:**

```bash
pnpm typecheck
pnpm format
pnpm depcruise
pnpm test
pnpm -r --if-present run build
```

CI browser job installs Chromium, builds web/server, and runs `pnpm test:browser`; upload trace/screenshots/report on failure. Visual QA remains deliberate release gate rather than brittle pixel gate on every unit PR.

**Commit:** `ci(web): enforce package and browser gates`

---

## Phase D — Browser acceptance with isolated actors

### Task 19: Real test system and participant Actor fixtures

**Files:** create `playwright.config.ts`, `e2e/setup/health-check.setup.ts`; create/test `e2e/fixtures/{test-system,participant-actor,actors}.ts`, `e2e/fixtures/actors.e2e.ts`; create page objects.

**Boundary exception:** these are true black-box browser tests, so `e2e/` is intentional; unit/component specs stay co-located.

**Actor contract:** each `ParticipantActor` owns a unique BrowserContext/Page, stable clientId localStorage, nickname,
and `dispose`. It cannot reuse another actor's `storageState`. Page Objects expose domain actions (`joinRoom`,
`takeControl`, `typeInTerminal`, `openOverview`) through accessible role/name selectors. `.xterm-rows` is isolated in
one page-object method because xterm has no ARIA transcript contract.

**RED:** create a fixture smoke spec that asserts Alice/Bob have different context/clientId, then:

```bash
pnpm --filter @ttyroom/web exec playwright test e2e/fixtures/actors.e2e.ts --project=chromium --workers=1
```

**Expected RED:** fixture/Actor absent.

**GREEN:** same command.

`TestSystem` starts real `startServer({port:0})`, creates Room over HTTP, spawns the real agent CLI child using the existing F4 pattern, captures bounded diagnostics, and always closes browser contexts -> server transport -> child. Health setup uses `expect.poll`; no `waitForTimeout` or fixed port.

**Commit:** `test(web): add isolated participant actors`

### Task 20: Real Server/Agent collaboration acceptance

**Files:** create `e2e/room-collaboration.e2e.ts`.

**Ledger, one test/RED/GREEN at a time:**

1. create named Room -> real Agent host visible -> open terminal -> explicit Take control -> type command -> Alice and Bob see output;
2. Bob selecting Alice-controlled terminal does not acquire/input; owner remains Alice;
3. Alice switches to Available terminal; old lease releases only after explicit Switch control;
4. close confirmation terminates via F5 request;
5. exclusive/shared mode change is reflected for both actors;
6. agent kill-switch state becomes read-only and typed rejected input is visible;
7. Dock/Overview find all five terminals and actor layout changes remain local.

**RED/GREEN per test:**

```bash
pnpm --filter @ttyroom/web exec playwright test e2e/room-collaboration.e2e.ts --project=chromium --workers=1
```

**Expected RED:** only the just-added user-visible behavior fails. Network/env/setup failure is invalid RED.

Use unique command sentinels and `expect.poll`/protocol-visible sync, never sleep. Keep two contexts live simultaneously to prove isolation.

**Commit:** `test(web): accept real browser collaboration`

### Task 21: Reconnect, replay, room-gone acceptance

**Files:** create `e2e/room-recovery.e2e.ts`.

**Ledger:** context keeps clientId across page reload -> lease restored within grace -> geometry restored locally -> output during disconnect appears once after replay -> gap requests replay and restoring clears on sync -> server loss shows Room Gone after reconnect reaches room-not-found.

**RED/GREEN:**

```bash
pnpm --filter @ttyroom/web exec playwright test e2e/room-recovery.e2e.ts --project=chromium --workers=1
```

**Expected RED:** current increment's recovery assertion fails, not a timeout from missing readiness instrumentation.

Record browser console/page errors as immediate test failures except explicitly expected protocol rejection.

**Commit:** `test(web): accept browser recovery flows`

### Task 22: Keyboard and accessibility acceptance

**Files:** create `e2e/keyboard-accessibility.e2e.ts`.

**Ledger:** Tab visits top controls/window actions/Dock without sending input or acquiring -> Shift+Tab reverse -> focus window and terminal are distinguishable -> modal traps -> first Esc closes modal only -> next Esc releases -> Overview keyboard enter/select/exit -> status has icon/text/name -> axe has no serious/critical violations.

**RED/GREEN:**

```bash
pnpm --filter @ttyroom/web exec playwright test e2e/keyboard-accessibility.e2e.ts --project=chromium --workers=1
```

**Expected RED:** focus or axe assertion for the new behavior fails.

Do not add `tabIndex` indiscriminately. Native interactive elements first; window keyboard alternative is a labeled menu/action set.

**Commit:** `test(web): enforce keyboard accessibility`

---

## Phase E — Visual reference and Product Design QA

### Task 23: Deterministic visual reference harness

**Files:** create `playwright.visual.config.ts`, `e2e/visual/reference-app.tsx`, `reference-room.ts`, `reference.e2e.ts` and e2e-only Vite config/HTML if required.

The harness mounts the **same production Workspace/components and real XtermAdapter** with injected in-memory
session/projection inputs. It seeds the five named reference terminals and stable terminal text. It is excluded from
the production build. This is visual determinism only; Tasks 20–22 prove real integration.

**RED:**

```bash
pnpm --filter @ttyroom/web exec playwright test --config playwright.visual.config.ts e2e/visual/reference.e2e.ts --update-snapshots --workers=1
```

**Expected RED:** harness/expected workspace absent. Snapshot creation itself is not behavioral RED; first assert visible room name, five windows, five dock items, and exactly five `.xterm` roots, then observe that assertion fail before implementation.

**GREEN assertions:**

- viewport exactly `1487 x 1058`, DPR 1;
- fonts loaded (`document.fonts.ready`) before capture;
- state matches reference: backend mine, frontend other, staging read-only, tests available, Claude Code other;
- exactly five xterm roots before/during/after Overview;
- no horizontal/vertical page overflow;
- screenshot saved `artifacts/design-qa/implementation-iteration-01.png`.

같은 Playwright spec에서 source PNG와 새 implementation screenshot을 base64 data URL로 한 비교 page에
나란히 렌더링하고 `artifacts/design-qa/iteration-01-comparison.png`을 캡처한다. source와 implementation
각각에 `1487x1058` 고정 box를 사용하고 browser scaling을 금지한다. focused crop도 두 이미지를 같은
clip 좌표로 잘라 한 page에 붙인다. 별도 이미지 창을 번갈아 본 것을 side-by-side 증거로 보고하지 않는다.

**Commit:** `test(web): add deterministic visual workspace`

### Task 24: Blocking design-QA iteration

**Files:** create/update root `design-qa.md`; capture artifacts under `artifacts/design-qa/`; production fixes and co-located regression specs as findings require.

1. Open the source PNG and implementation capture at original size.
2. Put both into one side-by-side comparison image; do not judge from separate views.
3. Compare same `1487x1058`, DPR 1, five-terminal workspace state.
4. Create focused paired crops for Top Bar, backend header/status, tests Take control, and Dock/participant presence.
5. Evaluate required surfaces: fonts/typography, spacing/layout rhythm, colors/tokens, icon/asset fidelity, copy/content; also responsive/accessibility/polish.
6. Write findings with severity/location/evidence/impact/fix. `design-qa.md` records source/implementation dimensions, CSS viewport, density, state, full comparison, focused comparisons, console/interactions, iteration history.
7. For every P0/P1/P2: write a co-located regression/component/visual assertion first, run meaningful RED, apply minimum fix, recapture, recombine, compare again.
8. Stop only when `design-qa.md` ends in exact `final result: passed`. P3 may remain as follow-up.

**Commands:**

```bash
pnpm --filter @ttyroom/web test
pnpm --filter @ttyroom/web test:visual
pnpm --filter @ttyroom/web test:browser
```

Also capture `1024x768`, `1280x800`, `1920x1080` usability evidence. These are responsive evidence, not source-fidelity comparisons. If either source or rendered capture cannot be opened/combined, mark exact `final result: blocked` and do not hand off.

Each meaningful fix is its own commit (`fix(web): ...`) with required trailer. Final QA report commit: `docs(web): record visual QA evidence`.

### Task 25: Final release gates and evidence audit

**Files:** only scoped fixes/tests/docs found by the audit; no sprint file edits from this plan execution unless the active sprint owner explicitly assigns them.

Run in order:

```bash
pnpm --filter @ttyroom/web test
pnpm --filter @ttyroom/web typecheck
pnpm --filter @ttyroom/web build
pnpm --filter @ttyroom/server test
pnpm --filter @ttyroom/server test:integration
pnpm test:e2e
pnpm test:browser
pnpm test:visual
pnpm typecheck
pnpm format
pnpm depcruise
pnpm test
pnpm -r --if-present run build
git diff --check
git status --short
```

Audit every requested behavior -> test mapping and every implementation task's actual RED/GREEN record. Verify:

- `packages/web` imports server/agent internals nowhere;
- only public `@ttyroom/protocol` is consumed;
- server/agent F5 semantics are not duplicated in UI conditions;
- Dock/Overview never create a second terminal renderer;
- no token in storage/log/artifact;
- no skipped/focused browser tests;
- no fixed sleep/port;
- all child processes, sockets, listeners, rAF, ResizeObserver, xterm instances dispose;
- `design-qa.md` says exact `final result: passed`;
- built server alone serves `/`, `/r/:id`, `/assets/*`, `/api/rooms`, `/healthz`, `/ws`.

If audit changes behavior, start a new RED/GREEN loop and commit separately. Pure verification gets no empty commit.

## 5. Gate summary

| Gate | What it proves | Blocking command |
|---|---|---|
| Package | every package compiles/tests/builds, server contains web dist | `pnpm typecheck && pnpm test && pnpm -r --if-present run build` |
| Core | projection/session/layout/window/terminal invariants independent of React/browser | `pnpm --filter @ttyroom/web exec vitest run src/projection src/session src/layout src/windows src/terminal` |
| UI | visible states, explicit controls, keyboard semantics in jsdom | `pnpm --filter @ttyroom/web test` |
| Browser | isolated participants + actual server/agent/PTY/WS | `pnpm test:browser` |
| Visual | source-matched viewport plus design QA iteration | `pnpm test:visual` and `design-qa.md: final result: passed` |
| Architecture | public protocol-only dependency and no duplicate renderer boundary | `pnpm depcruise` |

## 6. Product acceptance map

| Acceptance | Owning tests |
|---|---|
| 5초 안에 Host/Lease owner 구분 | TerminalStatus component + visual QA |
| 다른 사람 Terminal 선택 시 탈취 없음 | RoomSession spec + collaboration browser test |
| 의도 없는 기존 Lease 해제 없음 | explicit switch spec + two-actor acceptance |
| 5개 Terminal Dock/Overview 발견 | WindowManager/Dock/Overview specs + visual/browser |
| minimize/back window도 PTY/output 유지 | TerminalController + real collaboration |
| 다른 사용자의 배치가 내 배치에 영향 없음 | LayoutRepository + isolated Actor test |
| reconnect snapshot + local layout | Projection/Repository + recovery browser test |
| 색상 외 icon/text 상태 | TerminalStatus + axe + visual QA |
| Tab focus navigation | adapter/controller/component + Playwright keyboard test |
| modal-first Esc, 이후 lease release | overlay unit + Playwright keyboard test |
| remote input block/kill switch | F5 contract + Projection + real Agent acceptance |
| output gap/replay convergence | Projection/Session + recovery browser test |
| single server process | StaticWebApp integration + production browser test |

## 7. Out of scope guardrails

- mobile terminal input, shared/presenter layout, terminal thumbnails, duplicate xterm renderers
- chat, file explorer, IDE editing, command history/timeline, AI summary
- custom encryption, auth redesign, F5 protocol renaming, server state ownership changes
- WebGL performance work before 4–6-terminal measurement
- handwritten SVG/CSS/emoji substitute assets, reference PNG as a product background
- Sites/Vercel deployment; user asks separately before any publish/share action

이 경계 밖 문제가 발견되면 현재 RED/GREEN을 오염시키지 말고 후속 항목으로 기록한다.
