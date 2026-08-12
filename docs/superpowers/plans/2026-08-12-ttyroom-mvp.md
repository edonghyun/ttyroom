# TTYRoom MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 브라우저 참여자와 CLI Host Agent가 중앙 서버를 통해 Room에서 터미널을 공유·조작하는 TTYRoom MVP의 protocol + server + agent + 플로우 e2e를 구현한다 (Web UI는 별도 트랙).

**Architecture:** 단일 Node 서버 프로세스(도메인은 `adapters → usecases → domain` 의존 방향의 헥사고날 계층, 라이브 상태는 메모리 authoritative, 단일 스레드 순차 처리). 클라이언트당 WebSocket 하나에 JSON 제어 프레임과 바이너리 데이터 프레임을 멀티플렉싱. Agent는 판단 없이 PTY를 수행하는 얇은 클라이언트.

**Tech Stack:** TypeScript(strict, ESM), pnpm workspace, vitest, zod, ws, node-pty.

**Spec:** `docs/superpowers/specs/2026-08-12-ttyroom-mvp-design.md` — 모든 태스크는 이 스펙과 `semantic-context-os/CODING-GUIDELINES.md`, strict TDD 규율(RED 실행 증거 → 최소 GREEN → GREEN에서만 REFACTOR)을 따른다.

## Global Constraints

- Node >= 22, pnpm >= 9. 모든 패키지 `"type": "module"`.
- tsconfig: `strict`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`, `noImplicitOverride` 전부 true.
- 테스트는 co-located: `A.ts` 옆 `A.spec.ts`(유닛) / `A.integration.spec.ts`(실제 인프라) / e2e 패키지는 `*.e2e.ts`. `__tests__`/`test/` 미러 트리 금지 (테스트 킷 `src/test/`는 예외 — 테스트 인프라 전용).
- 테스트 이름은 행동 명세 문장 (describe에 역할, it에 행동과 결과).
- 컴포넌트는 클래스 기본. 의존성은 `deps`(협력 객체)/`options`(설정값)를 구분한 생성자 옵션 객체로 주입.
- 예상된 실패는 discriminated union(`kind` 필드 + exhaustive switch), 프로그래머 오류는 throw. 재던질 때 `cause` 보존.
- 코멘트는 제약 코멘트만. 매직 넘버는 근거 코멘트와 함께 상수화.
- 프로토콜 버전: `PROTOCOL_VERSION = 1`. 데이터 프레임 레이아웃(스펙 고정): 출력 `[frameType(1B)=0x01][terminalId(u32BE)][seq(u32BE)][payload]`, 입력 `[frameType(1B)=0x02][terminalId(u32BE)][seq(u32BE)][leaseId(u32BE)][payload]`.
- Policy 기본값(스펙·근거): participantGraceMs=15000, hostGraceMs=30000, scrollbackBytesPerTerminal=1048576(1MiB), sendBufferDropThresholdBytes=1048576, outputRateLimitBytesPerSec=4194304(4MiB/s).
- 모든 ID: `terminalId`/`leaseId`/`seq`는 u32 숫자(Room 단위 증가 카운터), `roomId`/`hostId`/`clientId`는 문자열.
- TDD 증거(RED/GREEN 명령·결과)를 태스크 완료 보고에 포함한다.

## File Structure (전체 조감)

```text
ttyroom/
├── pnpm-workspace.yaml, package.json, tsconfig.base.json, .gitignore, .dependency-cruiser.cjs
├── .github/workflows/ci.yml
├── packages/protocol/src/
│   ├── data-frame.ts (+.spec.ts)      # 바이너리 코덱
│   ├── messages.ts (+.spec.ts)        # zod 제어 메시지 스키마·타입
│   └── index.ts / PROTOCOL.md
├── packages/server/src/
│   ├── domain/room.ts (+.spec.ts)     # Room·Host·Terminal·Lease 상태와 불변식
│   ├── domain/room-registry.ts (+.spec.ts)
│   ├── ports/{transport,clock,identity,snapshot-store,policy}.ts
│   ├── usecases/*.ts (+.spec.ts)      # 유즈케이스 9개 + connection-registry, scrollback
│   ├── adapters/ws/ws-transport.ts (+.integration.spec.ts)
│   ├── adapters/{memory,link-auth,system-clock}/*.ts
│   ├── test/{fake-clock,recording-connection,room-test-context,matchers,transport-contract}.ts
│   ├── config.ts (+.spec.ts) / http.ts / main.ts (+.integration.spec.ts)
├── packages/agent/src/
│   ├── session.ts (+.spec.ts)         # 접속·hello·재접속 백오프
│   ├── pty-manager.ts (+.integration.spec.ts)
│   ├── rate-limiter.ts (+.spec.ts)
│   ├── meta-collector.ts (+.integration.spec.ts)
│   ├── cli.ts (+.spec.ts) / index.ts(bin)
│   └── test/fake-agent-transport.ts
└── packages/e2e/src/
    ├── harness.ts                     # given/assert DSL (서버 in-process, agent 자식 프로세스, ws 참여자)
    ├── collab.e2e.ts / resilience.e2e.ts
```

---

## Phase A — 기반: 모노레포와 프로토콜

### Task 1: 모노레포 셋업 + 데이터 프레임 코덱

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.gitignore`, `.prettierrc.json`
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/vitest.config.ts`
- Create: `packages/protocol/src/data-frame.ts`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/data-frame.spec.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  ```ts
  export const PROTOCOL_VERSION = 1;
  export const FRAME_OUTPUT = 0x01;
  export const FRAME_INPUT = 0x02;
  export interface OutputFrame { kind: "output"; terminalId: number; seq: number; payload: Uint8Array }
  export interface InputFrame { kind: "input"; terminalId: number; seq: number; leaseId: number; payload: Uint8Array }
  export type DataFrame = OutputFrame | InputFrame;
  export function encodeDataFrame(frame: DataFrame): Uint8Array;
  export type DecodeResult = { kind: "ok"; frame: DataFrame } | { kind: "malformed"; reason: string };
  export function decodeDataFrame(bytes: Uint8Array): DecodeResult;
  ```

- [ ] **Step 1: 워크스페이스 스캐폴딩 작성**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

루트 `package.json`:
```json
{
  "name": "ttyroom",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "pnpm -r --if-present run test",
    "test:integration": "pnpm -r --if-present run test:integration",
    "test:e2e": "pnpm --filter @ttyroom/e2e run test:e2e",
    "typecheck": "pnpm -r --if-present run typecheck",
    "format": "prettier --check ."
  },
  "devDependencies": { "prettier": "^3.3.0", "typescript": "^5.6.0", "vitest": "^3.0.0" }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true, "useUnknownInCatchVariables": true,
    "noImplicitOverride": true, "declaration": true, "sourceMap": true,
    "skipLibCheck": true, "isolatedModules": true, "forceConsistentCasingInFileNames": true
  }
}
```

`.gitignore`:
```text
node_modules/
dist/
*.tsbuildinfo
.env
refs/sshx/
```

`.prettierrc.json`: `{ "printWidth": 100 }`

`packages/protocol/package.json`:
```json
{
  "name": "@ttyroom/protocol",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^3.0.0" },
  "dependencies": { "zod": "^3.23.0" }
}
```

`packages/protocol/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

`packages/protocol/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.spec.ts"], environment: "node" } });
```

실행: `pnpm install`

- [ ] **Step 2: 코덱의 실패하는 테스트 작성**

`packages/protocol/src/data-frame.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decodeDataFrame, encodeDataFrame, FRAME_INPUT, FRAME_OUTPUT } from "./data-frame.js";

describe("데이터 프레임 코덱 — 역할: 터미널 입출력 바이트의 유선 표현", () => {
  it("출력 프레임을 인코딩-디코딩 라운드트립하면 동일한 값이 나온다", () => {
    const frame = { kind: "output", terminalId: 7, seq: 42, payload: new Uint8Array([104, 105]) } as const;
    const decoded = decodeDataFrame(encodeDataFrame(frame));
    expect(decoded).toEqual({ kind: "ok", frame });
  });

  it("입력 프레임 라운드트립은 leaseId를 보존한다", () => {
    const frame = { kind: "input", terminalId: 1, seq: 3, leaseId: 9, payload: new Uint8Array([108, 115]) } as const;
    const decoded = decodeDataFrame(encodeDataFrame(frame));
    expect(decoded).toEqual({ kind: "ok", frame });
  });

  it("출력 프레임 바이트 레이아웃은 PROTOCOL.md 명세와 일치한다", () => {
    // 골든 테스트 — 레이아웃 변경은 프로토콜 버전 범프를 요구한다
    const bytes = encodeDataFrame({ kind: "output", terminalId: 0x0102, seq: 1, payload: new Uint8Array([0xaa]) });
    expect([...bytes]).toEqual([FRAME_OUTPUT, 0, 0, 1, 2, 0, 0, 0, 1, 0xaa]);
  });

  it("입력 프레임 바이트 레이아웃은 seq 다음에 leaseId를 둔다", () => {
    const bytes = encodeDataFrame({ kind: "input", terminalId: 1, seq: 2, leaseId: 3, payload: new Uint8Array() });
    expect([...bytes]).toEqual([FRAME_INPUT, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3]);
  });

  it("알 수 없는 frameType은 malformed 결과를 돌려준다 (throw하지 않는다)", () => {
    expect(decodeDataFrame(new Uint8Array([0xff, 0, 0, 0, 1, 0, 0, 0, 1]))).toMatchObject({ kind: "malformed" });
  });

  it("헤더보다 짧은 바이트열은 malformed 결과를 돌려준다", () => {
    expect(decodeDataFrame(new Uint8Array([FRAME_OUTPUT, 0, 0]))).toMatchObject({ kind: "malformed" });
  });
});
```

- [ ] **Step 3: RED 확인**

Run: `pnpm --filter @ttyroom/protocol test`
Expected: FAIL — `data-frame.js` 모듈 없음 (모듈 부재가 곧 다음 요구 행동이므로 유효한 RED).

- [ ] **Step 4: 최소 구현**

`packages/protocol/src/data-frame.ts`:
```ts
export const PROTOCOL_VERSION = 1;
export const FRAME_OUTPUT = 0x01;
export const FRAME_INPUT = 0x02;

// 출력 헤더 9B(type+terminalId+seq), 입력은 leaseId 4B 추가 — PROTOCOL.md와 동기
const OUTPUT_HEADER_BYTES = 9;
const INPUT_HEADER_BYTES = 13;

export interface OutputFrame { kind: "output"; terminalId: number; seq: number; payload: Uint8Array }
export interface InputFrame { kind: "input"; terminalId: number; seq: number; leaseId: number; payload: Uint8Array }
export type DataFrame = OutputFrame | InputFrame;
export type DecodeResult = { kind: "ok"; frame: DataFrame } | { kind: "malformed"; reason: string };

export function encodeDataFrame(frame: DataFrame): Uint8Array {
  const headerBytes = frame.kind === "output" ? OUTPUT_HEADER_BYTES : INPUT_HEADER_BYTES;
  const out = new Uint8Array(headerBytes + frame.payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, frame.kind === "output" ? FRAME_OUTPUT : FRAME_INPUT);
  view.setUint32(1, frame.terminalId);
  view.setUint32(5, frame.seq);
  if (frame.kind === "input") view.setUint32(9, frame.leaseId);
  out.set(frame.payload, headerBytes);
  return out;
}

export function decodeDataFrame(bytes: Uint8Array): DecodeResult {
  if (bytes.length < OUTPUT_HEADER_BYTES) return { kind: "malformed", reason: "frame shorter than header" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameType = view.getUint8(0);
  const terminalId = view.getUint32(1);
  const seq = view.getUint32(5);
  if (frameType === FRAME_OUTPUT) {
    return { kind: "ok", frame: { kind: "output", terminalId, seq, payload: bytes.slice(OUTPUT_HEADER_BYTES) } };
  }
  if (frameType === FRAME_INPUT) {
    if (bytes.length < INPUT_HEADER_BYTES) return { kind: "malformed", reason: "input frame shorter than header" };
    return {
      kind: "ok",
      frame: { kind: "input", terminalId, seq, leaseId: view.getUint32(9), payload: bytes.slice(INPUT_HEADER_BYTES) },
    };
  }
  return { kind: "malformed", reason: `unknown frame type ${frameType}` };
}
```

`packages/protocol/src/index.ts`:
```ts
export * from "./data-frame.js";
```

- [ ] **Step 5: GREEN 확인**

Run: `pnpm --filter @ttyroom/protocol test`
Expected: PASS (6 tests)

- [ ] **Step 6: 커밋**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json .gitignore .prettierrc.json pnpm-lock.yaml packages/protocol
git commit -m "feat(protocol): 모노레포 셋업 + 데이터 프레임 바이너리 코덱"
```

---

### Task 2: 제어 메시지 스키마 + PROTOCOL.md

**Files:**
- Create: `packages/protocol/src/messages.ts`, `packages/protocol/PROTOCOL.md`
- Modify: `packages/protocol/src/index.ts` (messages re-export 추가)
- Test: `packages/protocol/src/messages.spec.ts`

**Interfaces:**
- Consumes: Task 1의 `PROTOCOL_VERSION`
- Produces (전 태스크가 사용하는 유선 타입 — 이후 태스크는 이 이름·형태를 그대로 쓴다):
  ```ts
  // 뷰 타입
  export interface ParticipantView { clientId: string; name: string }
  export interface HostView { hostId: string; name: string; online: boolean }
  export interface TerminalMeta { cwd: string | null; gitBranch: string | null; fgProcess: string | null }
  export interface TerminalView {
    terminalId: number; hostId: string; title: string;
    mode: "exclusive" | "shared"; status: "open" | "exited"; exitCode: number | null;
    meta: TerminalMeta;
  }
  export interface LeaseView { terminalId: number; leaseId: number; holderClientId: string }
  export interface RoomSnapshot {
    roomId: string; participants: ParticipantView[]; hosts: HostView[];
    terminals: TerminalView[]; leases: LeaseView[];
  }
  // 클라이언트(참여자·호스트 공통)→서버: hello
  //   { type:"hello", protocolVersion, roomId, token, clientId, name, role:"participant"|"host" }
  // 참여자→서버: open-terminal-request{hostId} · acquire-lease{terminalId}
  //   · release-lease{terminalId,leaseId} · resize-request{terminalId,cols,rows}
  // 호스트→서버: terminal-opened{terminalId} · terminal-closed{terminalId,exitCode}
  //   · terminal-meta{terminalId,meta:TerminalMeta}
  // 서버→클라이언트: welcome{selfClientId,snapshot:RoomSnapshot}
  //   · room-event{event:RoomEvent} · lease-result{terminalId,result}
  //   · lease-invalid{terminalId,reason} · sync{terminalId,seq}
  //   · output-gap{terminalId,fromSeq,toSeq} · error{code,message}
  // 서버→호스트: open-terminal{terminalId,cols,rows} · close-terminal{terminalId} · resize{terminalId,cols,rows}
  export type RoomEvent =
    | { kind: "participant-joined"; participant: ParticipantView }
    | { kind: "participant-left"; clientId: string }
    | { kind: "host-connected"; host: HostView }
    | { kind: "host-offline"; hostId: string }
    | { kind: "host-removed"; hostId: string }
    | { kind: "terminal-opened"; terminal: TerminalView }
    | { kind: "terminal-closed"; terminalId: number; exitCode: number | null }
    | { kind: "lease-granted"; lease: LeaseView }
    | { kind: "lease-released"; terminalId: number }
    | { kind: "terminal-meta"; terminalId: number; meta: TerminalMeta };
  export type LeaseResult = { kind: "granted"; leaseId: number } | { kind: "denied"; holderClientId: string };
  export type ErrorCode = "room-not-found" | "invalid-token" | "unsupported-protocol-version" | "bad-message";
  export type ClientMessage = /* 위 클라이언트→서버 전체의 discriminated union (type 필드) */;
  export type ServerMessage = /* 위 서버→클라이언트·호스트 전체의 union */;
  export type ParseResult = { kind: "ok"; message: ClientMessage } | { kind: "bad-message"; reason: string };
  export function parseClientMessage(raw: string): ParseResult;   // zod safeParse 기반
  export function serializeServerMessage(msg: ServerMessage): string; // JSON.stringify
  export function parseServerMessage(raw: string): { kind: "ok"; message: ServerMessage } | { kind: "bad-message"; reason: string }; // agent·e2e 클라이언트용
  ```

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/protocol/src/messages.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage, serializeServerMessage } from "./messages.js";

describe("제어 메시지 스키마 — 역할: JSON 제어 프레임의 검증과 유선 형태 고정", () => {
  it("정상 hello 메시지를 파싱해 타입을 부여한다", () => {
    const raw = JSON.stringify({
      type: "hello", protocolVersion: 1, roomId: "r1", token: "t", clientId: "c1", name: "동현", role: "participant",
    });
    expect(parseClientMessage(raw)).toMatchObject({ kind: "ok", message: { type: "hello", role: "participant" } });
  });

  it("알 수 없는 type은 bad-message 결과를 돌려준다", () => {
    expect(parseClientMessage(JSON.stringify({ type: "nope" }))).toMatchObject({ kind: "bad-message" });
  });

  it("JSON이 아닌 입력은 bad-message 결과를 돌려준다 (throw하지 않는다)", () => {
    expect(parseClientMessage("not-json")).toMatchObject({ kind: "bad-message" });
  });

  it("acquire-lease는 terminalId가 음수가 아닌 정수여야 한다", () => {
    expect(parseClientMessage(JSON.stringify({ type: "acquire-lease", terminalId: -1 }))).toMatchObject({ kind: "bad-message" });
  });

  it("서버 메시지 직렬화 형태는 골든과 일치한다 — 변경은 PROTOCOL.md 갱신을 요구한다", () => {
    const json = serializeServerMessage({ type: "sync", terminalId: 3, seq: 10 });
    expect(JSON.parse(json)).toEqual({ type: "sync", terminalId: 3, seq: 10 });
  });

  it("서버 메시지를 클라이언트 측에서 파싱할 수 있다 (라운드트립)", () => {
    const msg = { type: "lease-result", terminalId: 1, result: { kind: "granted", leaseId: 5 } } as const;
    expect(parseServerMessage(serializeServerMessage(msg))).toEqual({ kind: "ok", message: msg });
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `pnpm --filter @ttyroom/protocol test -- messages`
Expected: FAIL — `messages.js` 모듈 없음.

- [ ] **Step 3: 최소 구현**

`packages/protocol/src/messages.ts` — Interfaces 블록의 모든 메시지를 zod로 정의한다. 형태(발췌 — 나머지 메시지도 동일 패턴으로 전부 정의):
```ts
import { z } from "zod";

const u32 = z.number().int().min(0).max(0xffffffff);

export const terminalMetaSchema = z.object({
  cwd: z.string().nullable(), gitBranch: z.string().nullable(), fgProcess: z.string().nullable(),
});
export const participantViewSchema = z.object({ clientId: z.string(), name: z.string() });
export const hostViewSchema = z.object({ hostId: z.string(), name: z.string(), online: z.boolean() });
export const terminalViewSchema = z.object({
  terminalId: u32, hostId: z.string(), title: z.string(),
  mode: z.enum(["exclusive", "shared"]), status: z.enum(["open", "exited"]),
  exitCode: z.number().int().nullable(), meta: terminalMetaSchema,
});
export const leaseViewSchema = z.object({ terminalId: u32, leaseId: u32, holderClientId: z.string() });
export const roomSnapshotSchema = z.object({
  roomId: z.string(), participants: z.array(participantViewSchema), hosts: z.array(hostViewSchema),
  terminals: z.array(terminalViewSchema), leases: z.array(leaseViewSchema),
});

const helloSchema = z.object({
  type: z.literal("hello"), protocolVersion: z.number().int(), roomId: z.string(),
  token: z.string(), clientId: z.string(), name: z.string(), role: z.enum(["participant", "host"]),
});
const acquireLeaseSchema = z.object({ type: z.literal("acquire-lease"), terminalId: u32 });
// ... open-terminal-request / release-lease / resize-request / terminal-opened
//     / terminal-closed / terminal-meta 도 같은 방식으로 정의

export const clientMessageSchema = z.discriminatedUnion("type", [
  helloSchema, acquireLeaseSchema, /* ...나머지 클라이언트 메시지 전부 */
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// RoomEvent·LeaseResult·서버 메시지들도 zod로 정의하고 serverMessageSchema union 구성
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type ParseResult = { kind: "ok"; message: ClientMessage } | { kind: "bad-message"; reason: string };

export function parseClientMessage(raw: string): ParseResult {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { kind: "bad-message", reason: "invalid json" }; }
  const parsed = clientMessageSchema.safeParse(json);
  return parsed.success
    ? { kind: "ok", message: parsed.data }
    : { kind: "bad-message", reason: parsed.error.message };
}

export function serializeServerMessage(msg: ServerMessage): string { return JSON.stringify(msg); }

export function parseServerMessage(raw: string) { /* parseClientMessage와 동일 패턴, serverMessageSchema 사용 */ }
```

`index.ts`에 `export * from "./messages.js";` 추가.

- [ ] **Step 4: GREEN 확인**

Run: `pnpm --filter @ttyroom/protocol test`
Expected: PASS (전체)

- [ ] **Step 5: PROTOCOL.md 작성 (언어 중립 명세)**

`packages/protocol/PROTOCOL.md` — 다음 내용을 담는다: 프로토콜 버전과 협상 규칙(hello에서 불일치 시 error `unsupported-protocol-version` 후 종료), 데이터 프레임 두 레이아웃의 바이트 표(Task 1 골든과 동일), 제어 메시지 전체 목록과 JSON 예시(각 메시지 1개씩), 연결 수명(연결 → hello → welcome → 이벤트 스트림, 재접속은 새 연결 + 동일 clientId), seq·sync 의미론(터미널별 출력 seq 단조 증가, sync는 "seq n까지 방송 완료", output-gap은 드롭 구간 통지).

- [ ] **Step 6: 커밋**

```bash
git add packages/protocol
git commit -m "feat(protocol): 제어 메시지 zod 스키마와 PROTOCOL.md 명세"
```

---

## Phase B — 서버 도메인

### Task 3: server 패키지 골격 + Room 엔티티 (참여자·Host·Terminal)

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/vitest.config.ts`, `packages/server/vitest.integration.config.ts`
- Create: `packages/server/src/domain/room.ts`
- Test: `packages/server/src/domain/room.spec.ts`

**Interfaces:**
- Consumes: `@ttyroom/protocol`의 `RoomSnapshot`, `TerminalView`, `TerminalMeta`
- Produces (Task 4~12가 사용):
  ```ts
  export class Room {
    constructor(options: { roomId: string; token: string });
    readonly roomId: string;
    readonly token: string;
    addParticipant(clientId: string, name: string): void;      // 같은 clientId 재호출은 이름 갱신 (멱등)
    removeParticipant(clientId: string): void;
    hasParticipant(clientId: string): boolean;
    connectHost(hostId: string, name: string): void;           // 재접속 시 online 복귀 (멱등)
    markHostOffline(hostId: string): void;
    removeHost(hostId: string): number[];                      // 제거된 host의 terminalId들 반환
    openTerminal(hostId: string): TerminalView;                // terminalId 자동 증가, title="term-<id>", mode="exclusive"
    setTerminalMode(terminalId: number, mode: "exclusive" | "shared"): void;
    markTerminalExited(terminalId: number, exitCode: number | null): void;
    terminal(terminalId: number): TerminalView | undefined;
    updateTerminalMeta(terminalId: number, meta: TerminalMeta): void;
    isEmpty(): boolean;                                        // 참여자 0 && 온라인 host 0
    snapshot(): RoomSnapshot;
  }
  ```

- [ ] **Step 1: server 패키지 스캐폴딩**

`packages/server/package.json`:
```json
{
  "name": "@ttyroom/server",
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./test": { "types": "./dist/test/index.d.ts", "import": "./dist/test/index.js" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run --config vitest.config.ts",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "@ttyroom/protocol": "workspace:*", "ws": "^8.18.0", "zod": "^3.23.0" },
  "devDependencies": { "@types/ws": "^8.5.0", "typescript": "^5.6.0", "vitest": "^3.0.0" }
}
```

`vitest.config.ts`: `include: ["src/**/*.spec.ts"]`, `exclude: ["src/**/*.integration.spec.ts"]`.
`vitest.integration.config.ts`: `include: ["src/**/*.integration.spec.ts"]`, `fileParallelism: false`.
`tsconfig.json`: protocol과 동일 + `"references"` 없이 workspace 의존.

- [ ] **Step 2: Room 행동별 실패 테스트 작성**

`packages/server/src/domain/room.spec.ts` (전체가 한 번에가 아니라, TDD 규율대로 **it 하나 → RED → 구현 → GREEN을 행동 단위로 반복**한다. 아래는 최종 도달할 스펙 목록):
```ts
import { describe, expect, it } from "vitest";
import { Room } from "./room.js";

const makeRoom = () => new Room({ roomId: "r1", token: "tok" });

describe("Room — 역할: Room 라이브 상태와 불변식의 소유자", () => {
  it("참여자를 추가하면 스냅샷에 나타난다", () => {
    const room = makeRoom();
    room.addParticipant("c1", "동현");
    expect(room.snapshot().participants).toEqual([{ clientId: "c1", name: "동현" }]);
  });

  it("같은 clientId로 다시 추가하면 중복 없이 이름만 갱신된다 (재접속 멱등)", () => {
    const room = makeRoom();
    room.addParticipant("c1", "동현");
    room.addParticipant("c1", "동현2");
    expect(room.snapshot().participants).toEqual([{ clientId: "c1", name: "동현2" }]);
  });

  it("Host 연결 후 openTerminal은 증가하는 terminalId로 exclusive 터미널을 만든다", () => {
    const room = makeRoom();
    room.connectHost("h1", "동현-Mac");
    const t1 = room.openTerminal("h1");
    const t2 = room.openTerminal("h1");
    expect([t1.terminalId, t2.terminalId]).toEqual([1, 2]);
    expect(t1).toMatchObject({ hostId: "h1", mode: "exclusive", status: "open", exitCode: null });
  });

  it("없는 Host에 openTerminal하면 throw한다 (프로그래머 오류)", () => {
    expect(() => makeRoom().openTerminal("nope")).toThrow();
  });

  it("Host를 offline으로 표시해도 터미널은 스냅샷에 남는다", () => {
    const room = makeRoom();
    room.connectHost("h1", "동현-Mac");
    room.openTerminal("h1");
    room.markHostOffline("h1");
    expect(room.snapshot().hosts).toEqual([{ hostId: "h1", name: "동현-Mac", online: false }]);
    expect(room.snapshot().terminals).toHaveLength(1);
  });

  it("removeHost는 host와 그 터미널을 제거하고 terminalId 목록을 돌려준다", () => {
    const room = makeRoom();
    room.connectHost("h1", "동현-Mac");
    const t = room.openTerminal("h1");
    expect(room.removeHost("h1")).toEqual([t.terminalId]);
    expect(room.snapshot().hosts).toEqual([]);
    expect(room.snapshot().terminals).toEqual([]);
  });

  it("markTerminalExited는 상태만 바꾸고 터미널을 제거하지 않는다", () => {
    const room = makeRoom();
    room.connectHost("h1", "h");
    const t = room.openTerminal("h1");
    room.markTerminalExited(t.terminalId, 0);
    expect(room.terminal(t.terminalId)).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("참여자와 온라인 host가 모두 없으면 isEmpty가 참이다 (Quick Room 소멸 조건)", () => {
    const room = makeRoom();
    room.addParticipant("c1", "동현");
    room.connectHost("h1", "h");
    expect(room.isEmpty()).toBe(false);
    room.removeParticipant("c1");
    room.markHostOffline("h1");
    expect(room.isEmpty()).toBe(true);
  });
});
```

- [ ] **Step 3: 행동 단위 RED→GREEN 반복**

각 it마다: Run `pnpm --filter @ttyroom/server test -- room.spec` → RED 확인 → `room.ts`에 최소 구현 → GREEN 확인. 구현 형태:
```ts
import type { RoomSnapshot, TerminalMeta, TerminalView } from "@ttyroom/protocol";

export class Room {
  readonly roomId: string;
  readonly token: string;
  private readonly participants = new Map<string, { name: string }>();
  private readonly hosts = new Map<string, { name: string; online: boolean }>();
  private readonly terminals = new Map<number, TerminalView>();
  private nextTerminalId = 1;

  constructor(options: { roomId: string; token: string }) {
    this.roomId = options.roomId;
    this.token = options.token;
  }
  // ... Interfaces 블록의 메서드들. 불변식 위반(없는 host/terminal 참조)은 throw.
  snapshot(): RoomSnapshot { /* Map들을 배열로 투영. terminals는 구조 복사로 외부 변경 차단 */ }
}
```

- [ ] **Step 4: 전체 GREEN + 커밋**

Run: `pnpm --filter @ttyroom/server test`
Expected: PASS

```bash
git add packages/server
git commit -m "feat(server): Room 엔티티 — 참여자·Host·Terminal 상태와 불변식"
```

---

### Task 4: Lease 규칙 (선착순·1인 1임대·멱등)

**Files:**
- Modify: `packages/server/src/domain/room.ts`
- Create: `packages/server/src/domain/room-registry.ts`
- Test: `packages/server/src/domain/room.spec.ts` (describe 추가), `packages/server/src/domain/room-registry.spec.ts`

**Interfaces:**
- Consumes: Task 3의 `Room`
- Produces:
  ```ts
  // Room에 추가되는 메서드 — 스펙 불변식: Exclusive 터미널 유효 임대 최대 1, 선착순,
  // 한 사용자의 동시 임대는 1개(새 획득 시 기존 자동 해제), 같은 요청 재도착은 멱등
  export type AcquireDecision =
    | { kind: "granted"; lease: LeaseView; autoReleased: LeaseView | null }
    | { kind: "already-held"; lease: LeaseView }
    | { kind: "denied"; holderClientId: string }
    | { kind: "rejected"; reason: "terminal-not-open" | "shared-terminal" };
  export type ReleaseDecision = { kind: "released"; lease: LeaseView } | { kind: "not-holder" };
  // class Room 추가 멤버:
  //   acquireLease(clientId: string, terminalId: number): AcquireDecision
  //   releaseLease(clientId: string, terminalId: number): ReleaseDecision
  //   releaseAllOf(clientId: string): LeaseView[]        // 연결 단절 시 사용
  //   leaseOf(terminalId: number): LeaseView | undefined
  //   isInputAllowed(clientId: string, terminalId: number, leaseId: number): boolean
  //     // exclusive: 유효 lease 일치 / shared: 참여자면 true / exited·없음: false

  export class RoomRegistry {
    create(options: { roomId: string; token: string }): Room;  // 중복 roomId는 throw
    get(roomId: string): Room | undefined;
    remove(roomId: string): void;
  }
  ```

- [ ] **Step 1: 임대 행동별 실패 테스트 작성 (행동 단위 반복)**

`room.spec.ts`에 describe 추가:
```ts
describe("Room 입력권 임대 — 역할: 터미널 입력 권한의 단일 진실", () => {
  const withTerminal = () => {
    const room = makeRoom();
    room.addParticipant("alice", "A");
    room.addParticipant("bob", "B");
    room.connectHost("h1", "h");
    return { room, t: room.openTerminal("h1") };
  };

  it("빈 exclusive 터미널의 임대 요청은 granted된다", () => {
    const { room, t } = withTerminal();
    expect(room.acquireLease("alice", t.terminalId)).toMatchObject({
      kind: "granted", lease: { terminalId: t.terminalId, holderClientId: "alice" },
    });
  });

  it("이미 잡힌 터미널의 타인 요청은 denied되고 현재 소유자를 알려준다 (선착순)", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);
    expect(room.acquireLease("bob", t.terminalId)).toEqual({ kind: "denied", holderClientId: "alice" });
  });

  it("소유자의 같은 요청 재도착은 already-held로 멱등하다 (재전송 안전)", () => {
    const { room, t } = withTerminal();
    const first = room.acquireLease("alice", t.terminalId);
    const second = room.acquireLease("alice", t.terminalId);
    expect(second.kind).toBe("already-held");
    expect(room.snapshot().leases).toHaveLength(1);
    if (first.kind === "granted" && second.kind === "already-held")
      expect(second.lease.leaseId).toBe(first.lease.leaseId);
  });

  it("다른 터미널 획득 시 기존 임대는 자동 해제된다 (1인 1임대)", () => {
    const { room, t } = withTerminal();
    const t2 = room.openTerminal("h1");
    room.acquireLease("alice", t.terminalId);
    const d = room.acquireLease("alice", t2.terminalId);
    expect(d).toMatchObject({ kind: "granted", autoReleased: { terminalId: t.terminalId } });
    expect(room.leaseOf(t.terminalId)).toBeUndefined();
  });

  it("exited 터미널의 임대 요청은 rejected된다", () => {
    const { room, t } = withTerminal();
    room.markTerminalExited(t.terminalId, 0);
    expect(room.acquireLease("alice", t.terminalId)).toEqual({ kind: "rejected", reason: "terminal-not-open" });
  });

  it("소유자가 아닌 release는 not-holder이고 상태를 바꾸지 않는다", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);
    expect(room.releaseLease("bob", t.terminalId)).toEqual({ kind: "not-holder" });
    expect(room.leaseOf(t.terminalId)).toMatchObject({ holderClientId: "alice" });
  });

  it("releaseAllOf는 해당 사용자의 임대만 걷어 반환한다", () => {
    const { room, t } = withTerminal();
    room.acquireLease("alice", t.terminalId);
    expect(room.releaseAllOf("alice")).toMatchObject([{ terminalId: t.terminalId }]);
    expect(room.snapshot().leases).toEqual([]);
  });

  it("isInputAllowed: exclusive는 유효 leaseId 일치일 때만 참이다", () => {
    const { room, t } = withTerminal();
    const d = room.acquireLease("alice", t.terminalId);
    const leaseId = d.kind === "granted" ? d.lease.leaseId : -1;
    expect(room.isInputAllowed("alice", t.terminalId, leaseId)).toBe(true);
    expect(room.isInputAllowed("alice", t.terminalId, leaseId + 99)).toBe(false); // 오래된 leaseId 우회 차단
    expect(room.isInputAllowed("bob", t.terminalId, leaseId)).toBe(false);
  });

  it("isInputAllowed: shared 터미널은 참여자면 임대 없이 참이다", () => {
    const { room, t } = withTerminal();
    room.setTerminalMode(t.terminalId, "shared");
    expect(room.isInputAllowed("bob", t.terminalId, 0)).toBe(true);
    expect(room.isInputAllowed("stranger", t.terminalId, 0)).toBe(false);
  });
});
```

`room-registry.spec.ts`:
```ts
describe("RoomRegistry — 역할: 라이브 Room 인스턴스의 보관소", () => {
  it("create한 Room을 get으로 돌려준다", () => { /* create → get 동일 인스턴스 */ });
  it("중복 roomId create는 throw한다", () => { /* ... */ });
  it("remove 후 get은 undefined다", () => { /* ... */ });
});
```

- [ ] **Step 2: 행동 단위 RED→GREEN 반복**

Run: `pnpm --filter @ttyroom/server test -- room` (각 행동마다 RED 확인 후 구현).
구현 요점: `Room`에 `private readonly leases = new Map<number, LeaseView>()`, `private nextLeaseId = 1`. `acquireLease`는 순서대로 검사: 터미널 존재·open → shared면 rejected(`shared-terminal`) → 기존 소유 동일이면 already-held → 타인 소유면 denied → 본인의 다른 임대 releaseAllOf 후 granted.

- [ ] **Step 3: 전체 GREEN + 커밋**

Run: `pnpm --filter @ttyroom/server test`
Expected: PASS

```bash
git add packages/server/src/domain
git commit -m "feat(server): Lease 규칙 — 선착순·1인1임대·멱등·shared 예외"
```

---

### Task 5: 포트 정의 + 테스트 킷 (FakeClock·RecordingConnection·RoomTestContext·매처)

**Files:**
- Create: `packages/server/src/ports/clock.ts`, `ports/transport.ts`, `ports/identity.ts`, `ports/snapshot-store.ts`, `ports/policy.ts`
- Create: `packages/server/src/adapters/system-clock/system-clock.ts`, `adapters/memory/noop-snapshot-store.ts`
- Create: `packages/server/src/test/fake-clock.ts`, `test/recording-connection.ts`, `test/matchers.ts`, `test/index.ts`
- Test: `packages/server/src/test/fake-clock.spec.ts`, `test/matchers.spec.ts`

**Interfaces:**
- Consumes: `@ttyroom/protocol`의 `ServerMessage`, `DataFrame`, `RoomSnapshot`
- Produces (전 유즈케이스 태스크가 사용):
  ```ts
  // ports/clock.ts
  export type CancelTimer = () => void;
  export interface Clock { schedule(delayMs: number, fn: () => void): CancelTimer }

  // ports/transport.ts — 의미론 계약을 주석으로 명시:
  //   send/sendData는 프레임 순서를 보존한다. bufferedBytes는 아직 커널로 넘기지 못한
  //   송신 대기 바이트 수다(백프레셔 신호). 재연결은 어댑터가 숨기지 않는다 —
  //   끊기면 onClose가 반드시 한 번 불리고, 새 연결은 새 Connection이다.
  export interface Connection {
    readonly connectionId: string;
    send(message: ServerMessage): void;
    sendData(frame: DataFrame): void;
    bufferedBytes(): number;
    close(): void;
  }

  // ports/identity.ts
  export type AuthResult =
    | { kind: "ok"; clientId: string; displayName: string }
    | { kind: "rejected"; code: "invalid-token" | "room-not-found" };
  export interface Identity { authenticate(hello: HelloMessage, room: Room | undefined): AuthResult }

  // ports/snapshot-store.ts
  export interface SnapshotStore { save(roomId: string, snapshot: RoomSnapshot): void }

  // ports/policy.ts — Global Constraints의 기본값을 DEFAULT_POLICY 상수로 제공
  export interface Policy {
    participantGraceMs: number; hostGraceMs: number;
    scrollbackBytesPerTerminal: number; sendBufferDropThresholdBytes: number;
    outputRateLimitBytesPerSec: number;
  }
  export const DEFAULT_POLICY: Policy;

  // test/fake-clock.ts
  export class FakeClock implements Clock {
    schedule(delayMs: number, fn: () => void): CancelTimer;
    advance(ms: number): void;       // 경과 시각까지의 타이머를 등록 순서대로 실행
    pendingCount(): number;
  }

  // test/recording-connection.ts
  export class RecordingConnection implements Connection {
    readonly messages: ServerMessage[];
    readonly dataFrames: DataFrame[];
    bufferedBytesValue: number;       // 테스트가 백프레셔를 시뮬레이션할 때 직접 설정
    closed: boolean;
    constructor(options: { connectionId: string; guard?: (what: "message" | "data") => void });
    // guard가 있으면 send/sendData 전에 호출 — RoomTestContext의 "예상 못 한 쓰기 throw"용
  }

  // test/matchers.ts — 실패 메시지에 수신 목록과 최근접 diff를 담는다
  export function expectMessageToMatch(received: ServerMessage[], type: ServerMessage["type"], partial: object): void;
  export function expectNoMessage(received: ServerMessage[], type: ServerMessage["type"]): void;
  ```

- [ ] **Step 1: FakeClock 실패 테스트 → RED → 구현 → GREEN**

`test/fake-clock.spec.ts`:
```ts
describe("FakeClock — 역할: 시간을 감아서 타이머 로직을 결정론화", () => {
  it("advance가 경과 시각에 도달한 타이머만 실행한다", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.schedule(100, () => fired.push("a"));
    clock.schedule(200, () => fired.push("b"));
    clock.advance(150);
    expect(fired).toEqual(["a"]);
    clock.advance(50);
    expect(fired).toEqual(["a", "b"]);
  });

  it("취소한 타이머는 advance해도 실행되지 않는다", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    const cancel = clock.schedule(100, () => fired.push("a"));
    cancel();
    clock.advance(200);
    expect(fired).toEqual([]);
  });
});
```

Run: `pnpm --filter @ttyroom/server test -- fake-clock` → RED(모듈 없음) → 구현(내부에 `{at, fn, cancelled}` 배열과 현재 가상 시각 보관) → GREEN.

- [ ] **Step 2: 매처 실패 테스트 → RED → 구현 → GREEN**

`test/matchers.spec.ts`:
```ts
describe("expectMessageToMatch — 역할: 진단 가능한 메시지 스트림 어서션", () => {
  it("일치하는 메시지가 있으면 통과한다", () => {
    const received = [{ type: "sync", terminalId: 1, seq: 5 }] as ServerMessage[];
    expect(() => expectMessageToMatch(received, "sync", { seq: 5 })).not.toThrow();
  });

  it("없으면 수신된 type 목록을 담아 실패한다", () => {
    const received = [{ type: "sync", terminalId: 1, seq: 5 }] as ServerMessage[];
    expect(() => expectMessageToMatch(received, "welcome", {})).toThrow(/received types: sync/);
  });
});
```

구현: type 일치 메시지들을 골라 **모든 깊이 partial 매치**(객체는 부분집합, 배열은 길이 일치 + 원소별 partial, 리프는 Object.is — Task 6의 중첩 단언 사용 예가 이 의미론을 요구한다. vitest 무의존 순수 구현). 전부 불일치면 수신 type 목록 + 기대 partial + 같은 type 중 첫 메시지의 JSON을 에러 메시지에 포함해 throw.

- [ ] **Step 3: 포트·어댑터 파일 작성 (인터페이스는 테스트 불요, 구현 두 개는 스모크만)**

`system-clock.ts`(`setTimeout` 위임)와 `noop-snapshot-store.ts`(빈 구현), `DEFAULT_POLICY` 상수. `test/index.ts`에서 킷 전부 re-export.

- [ ] **Step 4: 전체 GREEN + 커밋**

Run: `pnpm --filter @ttyroom/server test`
Expected: PASS

```bash
git add packages/server/src
git commit -m "feat(server): 포트 계약과 테스트 킷 (FakeClock·RecordingConnection·매처)"
```

---

## Phase C — 서버 유즈케이스

유즈케이스 공통 구조: 어댑터가 아는 것은 `ServerCore` 파사드 하나다.
`ServerCore.handleMessage(conn, raw)` / `handleData(conn, bytes)` / `handleClose(conn)`이
단일 스레드에서 순차 호출되며, 내부에서 각 유즈케이스 클래스에 위임한다.

### Task 6: joinRoom + welcome + RoomTestContext

**Files:**
- Create: `packages/server/src/usecases/connection-registry.ts`, `usecases/server-core.ts`, `usecases/join-room.ts`
- Create: `packages/server/src/adapters/link-auth/link-auth.ts`
- Create: `packages/server/src/test/room-test-context.ts`
- Modify: `packages/server/src/test/index.ts`
- Test: `packages/server/src/usecases/join-room.spec.ts`

**Interfaces:**
- Consumes: Task 3~5 전부
- Produces (Task 7~14가 사용):
  ```ts
  // usecases/connection-registry.ts — clientId↔Connection 매핑과 Room 브로드캐스트
  export interface Session {
    connection: Connection; roomId: string; clientId: string;
    role: "participant" | "host"; hostId?: string;
  }
  export class ConnectionRegistry {
    register(session: Session): void;
    bySessionOf(connectionId: string): Session | undefined;
    byClientId(roomId: string, clientId: string): Session | undefined;
    hostSession(roomId: string, hostId: string): Session | undefined;
    participantsOf(roomId: string): Session[];
    unregister(connectionId: string): Session | undefined;
    broadcast(roomId: string, message: ServerMessage): void;   // 참여자 전원 send
  }

  // usecases/server-core.ts — 어댑터가 아는 유일한 진입점
  export class ServerCore {
    constructor(deps: {
      rooms: RoomRegistry; connections: ConnectionRegistry; identity: Identity;
      clock: Clock; snapshots: SnapshotStore;
    }, options: { policy: Policy });
    handleMessage(conn: Connection, raw: string): void;
    handleData(conn: Connection, bytes: Uint8Array): void;
    handleClose(conn: Connection): void;
  }

  // adapters/link-auth/link-auth.ts — Room 토큰 일치 검사, 닉네임 그대로 사용
  export class LinkAuth implements Identity { ... }

  // test/room-test-context.ts — 테스트 컴포지션 루트
  export class RoomTestContext {
    readonly clock: FakeClock;
    readonly core: ServerCore;
    constructor(options?: { policy?: Partial<Policy> });
    createRoom(roomId?: string): { roomId: string; token: string };
    connectParticipant(room: { roomId: string; token: string }, name: string, clientId?: string): ParticipantHandle;
    connectHost(room: { roomId: string; token: string }, name: string, hostId?: string): HostHandle;
    // 스펙 요구 — 예상 못 한 협력자 호출은 즉시 실패:
    // HostHandle의 sendData(서버→Agent 입력 전달)는 allowAgentData()를 부르지 않으면
    // "Unexpected agent write... call host.allowAgentData() in tests that expect input forwarding" throw
  }
  export interface ParticipantHandle {
    clientId: string; conn: RecordingConnection;
    send(msg: ClientMessage): void;                 // core.handleMessage로 직렬화 주입
    sendInput(terminalId: number, leaseId: number, text: string, seq?: number): void;
    disconnect(): void;                             // core.handleClose 호출
  }
  export interface HostHandle {
    hostId: string; clientId: string; conn: RecordingConnection;
    send(msg: ClientMessage): void;
    sendOutput(terminalId: number, seq: number, text: string): void;
    allowAgentData(): void;
    disconnect(): void;
  }
  ```

- [ ] **Step 1: 실패 테스트 작성 (행동 단위 반복)**

`usecases/join-room.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { RoomTestContext } from "../test/room-test-context.js";
import { expectMessageToMatch } from "../test/matchers.js";

describe("joinRoom — 역할: hello 검증과 Room 입장", () => {
  it("유효한 hello에 현재 Room 스냅샷이 담긴 welcome으로 응답한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant(room, "alice");
    expectMessageToMatch(alice.conn.messages, "welcome", {
      selfClientId: alice.clientId,
      snapshot: { roomId: room.roomId, participants: [{ name: "alice" }] },
    });
  });

  it("입장하면 기존 참여자 전원에게 participant-joined가 브로드캐스트된다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant(room, "alice");
    ctx.connectParticipant(room, "bob");
    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "participant-joined", participant: { name: "bob" } },
    });
  });

  it("틀린 토큰의 hello는 error(invalid-token) 후 연결이 닫힌다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant({ ...room, token: "wrong" }, "alice");
    expectMessageToMatch(alice.conn.messages, "error", { code: "invalid-token" });
    expect(alice.conn.closed).toBe(true);
  });

  it("없는 Room의 hello는 error(room-not-found)로 거부된다", () => {
    const ctx = new RoomTestContext();
    const alice = ctx.connectParticipant({ roomId: "ghost", token: "t" }, "alice");
    expectMessageToMatch(alice.conn.messages, "error", { code: "room-not-found" });
  });

  it("프로토콜 버전 불일치는 error(unsupported-protocol-version)로 거부된다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    // 미등록 연결로 주입 — 등록된 연결의 재hello는 별도 계약(bad-message)에 먼저 걸린다
    const conn = ctx.rawConnection();
    ctx.core.handleMessage(conn, JSON.stringify({
      type: "hello", protocolVersion: 999, roomId: room.roomId, token: room.token,
      clientId: "x", name: "x", role: "participant",
    }));
    expectMessageToMatch(conn.messages, "error", { code: "unsupported-protocol-version" });
  });

  it("hello 이전의 다른 메시지는 error(bad-message)다", () => {
    const ctx = new RoomTestContext();
    const conn = ctx.rawConnection();   // hello를 보내지 않은 생 연결 헬퍼
    ctx.core.handleMessage(conn, JSON.stringify({ type: "acquire-lease", terminalId: 1 }));
    expectMessageToMatch(conn.messages, "error", { code: "bad-message" });
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `pnpm --filter @ttyroom/server test -- join-room`
Expected: FAIL — `room-test-context.js` 없음.

- [ ] **Step 3: 최소 구현**

구현 순서: `ConnectionRegistry`(Map 두 개: connectionId→Session, roomId→Set) → `LinkAuth`(`room === undefined → room-not-found`, `hello.token !== room.token → invalid-token`, 아니면 ok) → `JoinRoom` 유즈케이스:
```ts
export class JoinRoom {
  constructor(private readonly deps: {
    rooms: RoomRegistry; connections: ConnectionRegistry; identity: Identity;
  }) {}

  execute(conn: Connection, hello: HelloMessage): void {
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      conn.send({ type: "error", code: "unsupported-protocol-version", message: `server=${PROTOCOL_VERSION}` });
      conn.close();
      return;
    }
    const room = this.deps.rooms.get(hello.roomId);
    const auth = this.deps.identity.authenticate(hello, room);
    if (auth.kind === "rejected") {
      conn.send({ type: "error", code: auth.code, message: auth.code });
      conn.close();
      return;
    }
    // room은 auth 성공 시 반드시 존재 — LinkAuth가 room-not-found를 걸렀다
    if (hello.role === "participant") {
      room!.addParticipant(auth.clientId, auth.displayName);
      this.deps.connections.register({ connection: conn, roomId: room!.roomId, clientId: auth.clientId, role: "participant" });
      this.deps.connections.broadcast(room!.roomId, {
        type: "room-event", event: { kind: "participant-joined", participant: { clientId: auth.clientId, name: auth.displayName } },
      });
      conn.send({ type: "welcome", selfClientId: auth.clientId, snapshot: room!.snapshot() });
      return;
    }
    // host 역할은 Task 7에서 확장
  }
}
```
`ServerCore.handleMessage`: 미등록 연결의 첫 메시지는 hello여야 하며(`parseClientMessage` → type 검사), 아니면 `error(bad-message)`. 등록된 연결의 후속 메시지는 type별 스위치(이번 태스크에서는 hello만, exhaustive switch의 default는 bad-message 응답).
`RoomTestContext`: Interfaces 블록대로 조립. `createRoom`은 `rooms.create({roomId: "room-" + n, token: "tok-" + n})`. broadcast는 participant-joined를 **입장자 본인 제외 없이 전원에게** 보내되 welcome 이전에 register했으므로 자기 자신에게도 감 — 자기 제외가 필요하면 welcome 이후 스냅샷과 중복이므로 **register 전에 broadcast** 순서로 해결(테스트가 이 순서를 고정).

- [ ] **Step 4: GREEN 확인 + 커밋**

Run: `pnpm --filter @ttyroom/server test`
Expected: PASS

```bash
git add packages/server/src
git commit -m "feat(server): joinRoom 유즈케이스와 RoomTestContext 테스트 컴포지션 루트"
```

---

### Task 7: connectHost + openTerminal

**Files:**
- Create: `packages/server/src/usecases/connect-host.ts`, `usecases/open-terminal.ts`
- Modify: `packages/server/src/usecases/server-core.ts`, `usecases/join-room.ts`(host 분기), `test/room-test-context.ts`(connectHost 헬퍼)
- Test: `packages/server/src/usecases/connect-host.spec.ts`, `usecases/open-terminal.spec.ts`

**Interfaces:**
- Consumes: Task 6의 `ServerCore`·`ConnectionRegistry`·`RoomTestContext`
- Produces: host hello 처리(`connectHost` — Room에 host 등록, host-connected 브로드캐스트, welcome 응답), `open-terminal-request` 처리(`openTerminal` — Room에 터미널 생성, host 세션으로 `open-terminal{terminalId,cols:80,rows:24}` 전송, terminal-opened는 **host의 `terminal-opened` 확인 후** 브로드캐스트), host의 `terminal-closed`·`terminal-meta` 반영.

- [ ] **Step 1: 실패 테스트 작성 (행동 단위 반복)**

`connect-host.spec.ts`:
```ts
describe("connectHost — 역할: Agent hello 처리와 Host 등록", () => {
  it("host hello로 Room에 host가 등록되고 참여자에게 host-connected가 브로드캐스트된다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const alice = ctx.connectParticipant(room, "alice");
    ctx.connectHost(room, "동현-Mac");
    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "host-connected", host: { name: "동현-Mac", online: true } },
    });
  });

  it("같은 hostId 재접속은 host를 online으로 복귀시킨다 (중복 등록 없음)", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "동현-Mac");
    host.disconnect();
    const again = ctx.connectHost(room, "동현-Mac", host.hostId);
    expectMessageToMatch(again.conn.messages, "welcome", {
      snapshot: { hosts: [{ hostId: host.hostId, online: true }] },
    });
  });
});
```

`open-terminal.spec.ts`:
```ts
describe("openTerminal — 역할: 터미널 생성 요청의 중개", () => {
  it("open-terminal-request는 host에게 open-terminal 명령을 전달한다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    expectMessageToMatch(host.conn.messages, "open-terminal", { cols: 80, rows: 24 });
  });

  it("host가 terminal-opened를 확인하면 참여자 전원에게 terminal-opened 이벤트가 브로드캐스트된다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = lastOpenTerminalId(host.conn.messages);   // 테스트 로컬 헬퍼
    host.send({ type: "terminal-opened", terminalId });
    expectMessageToMatch(alice.conn.messages, "room-event", {
      event: { kind: "terminal-opened", terminal: { terminalId, hostId: host.hostId, status: "open" } },
    });
  });

  it("오프라인 host에 대한 요청은 요청자에게만 error(bad-message)를 보낸다", () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    host.disconnect();
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    expectMessageToMatch(alice.conn.messages, "error", { code: "bad-message" });
  });

  it("host의 terminal-closed는 terminal-closed 이벤트로 브로드캐스트되고 상태가 exited가 된다", () => {
    /* open 후 host.send({type:"terminal-closed", terminalId, exitCode: 0}) →
       room-event {kind:"terminal-closed", exitCode: 0} 브로드캐스트 확인 */
  });

  it("host의 terminal-meta는 terminal-meta 이벤트로 브로드캐스트된다", () => {
    /* host.send({type:"terminal-meta", terminalId, meta:{cwd:"/tmp",gitBranch:"main",fgProcess:"zsh"}}) →
       room-event {kind:"terminal-meta"} 확인 */
  });
});
```

- [ ] **Step 2: 행동 단위 RED→GREEN 반복**

Run: `pnpm --filter @ttyroom/server test -- connect-host open-terminal` (각 행동마다 RED 확인).
구현 요점: 터미널 생성은 2단계 — `openTerminal` 유즈케이스가 `room.openTerminal(hostId)`로 ID를 먼저 발급하고 host에 명령을 보냄. 이 시점의 터미널은 스냅샷에 존재하지만, terminal-opened **브로드캐스트는 host 확인 후**(PTY 실제 생성 증거). host 확인 전 참여자가 새로 들어오면 스냅샷으로 보게 되므로 문제없음.

- [ ] **Step 3: 전체 GREEN + 커밋**

```bash
git add packages/server/src
git commit -m "feat(server): connectHost·openTerminal 유즈케이스"
```

---

### Task 8: acquireLease / releaseLease 유즈케이스

**Files:**
- Create: `packages/server/src/usecases/acquire-lease.ts`, `usecases/release-lease.ts`
- Modify: `packages/server/src/usecases/server-core.ts`
- Test: `packages/server/src/usecases/acquire-lease.spec.ts`

**Interfaces:**
- Consumes: Task 4의 `Room.acquireLease/releaseLease`, Task 6의 브로드캐스트
- Produces: `acquire-lease` 메시지 → 요청자에게 `lease-result`, 성공 시 전원에게 `room-event{lease-granted}` (+ autoReleased가 있으면 `lease-released` 먼저). `release-lease` → 소유자 검증 후 `room-event{lease-released}`.

- [ ] **Step 1: 실패 테스트 작성**

`acquire-lease.spec.ts`:
```ts
describe("acquireLease — 역할: 입력권 요청의 처리와 전파", () => {
  const setup = () => {
    const ctx = new RoomTestContext();
    const room = ctx.createRoom();
    const host = ctx.connectHost(room, "h");
    const alice = ctx.connectParticipant(room, "alice");
    const bob = ctx.connectParticipant(room, "bob");
    alice.send({ type: "open-terminal-request", hostId: host.hostId });
    const terminalId = lastOpenTerminalId(host.conn.messages);
    host.send({ type: "terminal-opened", terminalId });
    return { ctx, alice, bob, terminalId };
  };

  it("빈 터미널 요청자는 granted lease-result를 받고 전원이 lease-granted를 받는다", () => {
    const { alice, bob, terminalId } = setup();
    alice.send({ type: "acquire-lease", terminalId });
    expectMessageToMatch(alice.conn.messages, "lease-result", { terminalId, result: { kind: "granted" } });
    expectMessageToMatch(bob.conn.messages, "room-event", {
      event: { kind: "lease-granted", lease: { terminalId, holderClientId: alice.clientId } },
    });
  });

  it("점유된 터미널 요청자는 denied와 현재 소유자를 받고, 브로드캐스트는 없다", () => {
    const { alice, bob, terminalId } = setup();
    alice.send({ type: "acquire-lease", terminalId });
    bob.conn.messages.length = 0;
    bob.send({ type: "acquire-lease", terminalId });
    expectMessageToMatch(bob.conn.messages, "lease-result", {
      terminalId, result: { kind: "denied", holderClientId: alice.clientId },
    });
    expectNoMessage(bob.conn.messages, "room-event");
  });

  it("다른 터미널 획득 시 이전 임대의 lease-released가 먼저 브로드캐스트된다", () => {
    /* 터미널 2개 열고 alice가 순서대로 획득 → bob 수신 목록에서
       lease-released(t1)가 lease-granted(t2)보다 앞인지 인덱스 비교 */
  });

  it("같은 acquire가 두 번 도착해도 두 번째는 granted 재응답만 하고 상태는 동일하다 (멱등)", () => {
    /* alice 두 번 send → lease-result 2회 수신, room의 leases 스냅샷은 1개,
       두 응답의 leaseId 동일 */
  });

  it("release-lease는 소유자만 성공하고 lease-released가 브로드캐스트된다", () => { /* ... */ });
});
```

- [ ] **Step 2: RED→GREEN 반복 + 커밋**

Run: `pnpm --filter @ttyroom/server test -- acquire-lease`
구현: `AcquireLease.execute`가 `room.acquireLease` decision을 exhaustive switch로 매핑 (granted→result+broadcast(들), already-held→granted 재응답, denied→denied 응답, rejected→`lease-result` 대신 `error(bad-message)`가 아니라 `lease-invalid{reason:"terminal-closed"}` 응답).

```bash
git add packages/server/src
git commit -m "feat(server): acquireLease·releaseLease 유즈케이스"
```

---

### Task 9: routeTerminalInput

**Files:**
- Create: `packages/server/src/usecases/route-terminal-input.ts`
- Modify: `packages/server/src/usecases/server-core.ts` (handleData 배선)
- Test: `packages/server/src/usecases/route-terminal-input.spec.ts`

**Interfaces:**
- Consumes: Task 4의 `Room.isInputAllowed`, Task 6의 `ConnectionRegistry.hostSession`, protocol의 `decodeDataFrame`
- Produces: 참여자의 입력 데이터 프레임 → 검증 통과 시 해당 터미널 host 세션으로 `sendData(원본 프레임)`, 실패 시 보낸 사람에게만 `lease-invalid`.

- [ ] **Step 1: 실패 테스트 작성**

`route-terminal-input.spec.ts`:
```ts
describe("routeTerminalInput — 역할: 입력권 검증의 단일 지점", () => {
  it("유효한 임대의 입력 프레임은 host로 그대로 전달된다", () => {
    const { ctx, alice, host, terminalId } = setupWithLease();  // Task 8의 setup + alice acquire
    host.allowAgentData();
    alice.sendInput(terminalId, alice.leaseId, "ls\n");
    expect(host.conn.dataFrames).toMatchObject([
      { kind: "input", terminalId, leaseId: alice.leaseId },
    ]);
  });

  it("오래된 leaseId의 입력은 폐기되고 보낸 사람만 lease-invalid를 받는다", () => {
    const { alice, bob, host, terminalId } = setupWithLease();
    alice.sendInput(terminalId, alice.leaseId + 99, "rm -rf /\n");
    expect(host.conn.dataFrames).toEqual([]);   // allowAgentData 안 했지만 도달 자체가 없어야 함
    expectMessageToMatch(alice.conn.messages, "lease-invalid", { terminalId, reason: "not-holder" });
    expectNoMessage(bob.conn.messages, "lease-invalid");
  });

  it("host가 오프라인이면 입력은 폐기되고 lease-invalid(terminal-closed)를 받는다", () => { /* ... */ });

  it("shared 터미널은 임대 없이 참여자 입력이 통과한다", () => { /* setTerminalMode 후 bob 입력 → host 도달 */ });

  it("malformed 데이터 프레임은 error(bad-message)로 응답한다", () => {
    /* ctx.core.handleData(alice.conn, new Uint8Array([0xff])) */
  });
});
```

주의: RoomTestContext의 "예상 못 한 Agent 쓰기 throw" 가드가 여기서 처음 의미를 가진다 — 첫 테스트는 `allowAgentData()` 없이 쓰면 throw로 실패해야 하며, 이 가드 자체도 it 하나로 핀한다:
```ts
  it("테스트가 허용하지 않은 Agent 쓰기는 즉시 실패한다 (가드)", () => {
    const { alice, terminalId } = setupWithLease();   // allowAgentData 하지 않음
    expect(() => alice.sendInput(terminalId, alice.leaseId, "x")).toThrow(/Unexpected agent write/);
  });
```

- [ ] **Step 2: RED→GREEN 반복 + 커밋**

Run: `pnpm --filter @ttyroom/server test -- route-terminal-input`

```bash
git add packages/server/src
git commit -m "feat(server): routeTerminalInput — 입력권 검증 단일 지점"
```

---

### Task 10: broadcastTerminalOutput + 스크롤백 + 백프레셔

**Files:**
- Create: `packages/server/src/usecases/scrollback-buffer.ts`, `usecases/broadcast-terminal-output.ts`
- Modify: `packages/server/src/usecases/server-core.ts`
- Test: `packages/server/src/usecases/scrollback-buffer.spec.ts`, `usecases/broadcast-terminal-output.spec.ts`

**Interfaces:**
- Consumes: Task 5의 `Policy`, `Connection.bufferedBytes`
- Produces:
  ```ts
  export class ScrollbackBuffer {
    constructor(options: { maxBytes: number });
    append(frame: OutputFrame): void;    // maxBytes 초과 시 오래된 프레임부터 제거
    frames(): OutputFrame[];
    lastSeq(): number;                    // 비어 있으면 0
    totalBytes(): number;
  }
  // BroadcastTerminalOutput: host의 출력 프레임 →
  //   1) 터미널별 ScrollbackBuffer에 append (서버는 seq를 재부여: 터미널별 단조 증가 — 신뢰 지점은 서버)
  //   2) 참여자별: bufferedBytes() >= policy.sendBufferDropThresholdBytes 면 드롭하고
  //      그 참여자를 gapped 상태로 표시. 아니면 sendData
  //   3) gapped 참여자의 버퍼가 임계 미만으로 회복하면 output-gap{fromSeq,toSeq} + 최신 프레임부터 재개
  //      (재동기화 신호: 회복 시 sync{terminalId, seq: lastSeq} 먼저 전송)
  ```

- [ ] **Step 1: ScrollbackBuffer 실패 테스트 → RED → 구현 → GREEN**

```ts
describe("ScrollbackBuffer — 역할: 늦은 합류자를 위한 불투명 출력 보관", () => {
  it("append한 프레임을 순서대로 돌려준다", () => { /* 2개 append → frames() 순서 확인 */ });
  it("maxBytes를 넘으면 오래된 프레임부터 버린다", () => {
    const buf = new ScrollbackBuffer({ maxBytes: 10 });
    buf.append({ kind: "output", terminalId: 1, seq: 1, payload: new Uint8Array(6) });
    buf.append({ kind: "output", terminalId: 1, seq: 2, payload: new Uint8Array(6) });
    expect(buf.frames().map((f) => f.seq)).toEqual([2]);
  });
  it("lastSeq는 마지막 프레임의 seq다 (비면 0)", () => { /* ... */ });
});
```

- [ ] **Step 2: 출력 브로드캐스트 실패 테스트 → RED → 구현 → GREEN (행동 단위 반복)**

`broadcast-terminal-output.spec.ts`:
```ts
describe("broadcastTerminalOutput — 역할: 출력 팬아웃과 느린 참여자 격리", () => {
  it("host 출력이 참여자 전원에게 서버 seq로 전달된다", () => {
    const { host, alice, bob, terminalId } = setupOpenTerminal();
    host.sendOutput(terminalId, 1, "hi");
    expect(alice.conn.dataFrames).toMatchObject([{ kind: "output", terminalId, seq: 1 }]);
    expect(bob.conn.dataFrames).toMatchObject([{ kind: "output", terminalId, seq: 1 }]);
  });

  it("송신 버퍼가 임계 이상인 참여자에게는 드롭되고 다른 참여자는 계속 받는다", () => {
    const { host, alice, bob, terminalId } = setupOpenTerminal();
    bob.conn.bufferedBytesValue = DEFAULT_POLICY.sendBufferDropThresholdBytes;
    host.sendOutput(terminalId, 1, "hi");
    expect(alice.conn.dataFrames).toHaveLength(1);
    expect(bob.conn.dataFrames).toHaveLength(0);
  });

  it("드롭된 참여자의 버퍼가 회복되면 sync와 output-gap을 받은 뒤 스트림이 재개된다", () => {
    const { host, bob, terminalId } = setupOpenTerminal();
    bob.conn.bufferedBytesValue = DEFAULT_POLICY.sendBufferDropThresholdBytes;
    host.sendOutput(terminalId, 1, "a");
    host.sendOutput(terminalId, 2, "b");
    bob.conn.bufferedBytesValue = 0;
    host.sendOutput(terminalId, 3, "c");
    expectMessageToMatch(bob.conn.messages, "output-gap", { terminalId, fromSeq: 1, toSeq: 2 });
    expectMessageToMatch(bob.conn.messages, "sync", { terminalId, seq: 2 });
    expect(bob.conn.dataFrames).toMatchObject([{ seq: 3 }]);
  });
});
```

- [ ] **Step 3: 전체 GREEN + 커밋**

```bash
git add packages/server/src
git commit -m "feat(server): 출력 브로드캐스트·스크롤백 링버퍼·백프레셔 격리"
```

---

### Task 11: handleDisconnect + 유예 복원

**Files:**
- Create: `packages/server/src/usecases/handle-disconnect.ts`
- Modify: `packages/server/src/usecases/server-core.ts`, `usecases/join-room.ts`(재접속 시 유예 타이머 취소·임대 복원)
- Test: `packages/server/src/usecases/handle-disconnect.spec.ts`

**Interfaces:**
- Consumes: Task 5의 `Clock`, Task 4의 `releaseAllOf`, Task 3의 `markHostOffline/removeHost/isEmpty`
- Produces: 참여자 단절 → 임대는 유지한 채 participantGraceMs 타이머, 만료 시 `releaseAllOf` + `lease-released`·`participant-left` 브로드캐스트. 같은 clientId 재접속 시 타이머 취소, 임대 유지. host 단절 → `host-offline` 브로드캐스트 + hostGraceMs 타이머, 만료 시 `removeHost` + `host-removed`·터미널별 `terminal-closed` 브로드캐스트. Room이 isEmpty면 registry에서 제거.

- [ ] **Step 1: 실패 테스트 작성 (FakeClock으로 시간 감기, 행동 단위 반복)**

```ts
describe("handleDisconnect — 역할: 단절의 유예 처리와 복원", () => {
  it("참여자 단절 후 유예 내 재접속이면 임대가 유지된다", () => {
    const { ctx, alice, terminalId } = setupWithLease();
    alice.disconnect();
    ctx.clock.advance(DEFAULT_POLICY.participantGraceMs - 1);
    const aliceAgain = ctx.connectParticipant(room, "alice", alice.clientId);
    ctx.clock.advance(10_000);
    expectMessageToMatch(aliceAgain.conn.messages, "welcome", {
      snapshot: { leases: [{ terminalId, holderClientId: alice.clientId }] },
    });
  });

  it("유예를 넘기면 임대가 해제되고 lease-released·participant-left가 브로드캐스트된다", () => {
    const { ctx, alice, bob, terminalId } = setupWithLease();
    alice.disconnect();
    ctx.clock.advance(DEFAULT_POLICY.participantGraceMs);
    expectMessageToMatch(bob.conn.messages, "room-event", { event: { kind: "lease-released", terminalId } });
    expectMessageToMatch(bob.conn.messages, "room-event", { event: { kind: "participant-left", clientId: alice.clientId } });
  });

  it("host 단절 즉시 host-offline이 브로드캐스트되고 터미널은 스냅샷에 남는다", () => { /* ... */ });

  it("host 유예를 넘기면 host-removed와 각 터미널의 terminal-closed가 브로드캐스트된다", () => {
    /* host.disconnect() → clock.advance(hostGraceMs) → bob 수신 확인 */
  });

  it("host가 유예 내 재접속하면 타이머가 취소되고 host-connected(online:true)가 브로드캐스트된다", () => { /* ... */ });

  it("모두 떠나고 유예가 끝나면 Room이 소멸해 재접속은 room-not-found를 받는다", () => { /* ... */ });
});
```

- [ ] **Step 2: RED→GREEN 반복 + 커밋**

Run: `pnpm --filter @ttyroom/server test -- handle-disconnect`
구현 요점: `HandleDisconnect`가 clientId별 `CancelTimer`를 Map으로 보관. `JoinRoom`이 재접속(같은 roomId+clientId) 감지 시 `cancelPending(clientId)` 호출 — 이 협력은 `PendingDisconnects` 클래스(Deps로 양쪽에 주입)로 분리한다.

```bash
git add packages/server/src
git commit -m "feat(server): 단절 유예·복원 — 임대 보존과 host 제거"
```

---

### Task 12: syncLateJoiner — 늦은 합류·재접속 replay

**Files:**
- Create: `packages/server/src/usecases/sync-late-joiner.ts`
- Modify: `packages/server/src/usecases/join-room.ts` (welcome 직후 호출)
- Modify: `packages/server/src/test/recording-connection.ts` (messages·dataFrames 도착 순번 `arrivalOrder` 추가)
- Test: `packages/server/src/usecases/sync-late-joiner.spec.ts`

**Interfaces:**
- Consumes: Task 10의 `ScrollbackBuffer`
- Produces: welcome 직후, 각 open 터미널에 대해 스크롤백 프레임 전체를 `sendData`로 재전송하고 마지막에 `sync{terminalId, seq: lastSeq}`를 보낸다.

- [ ] **Step 1: 실패 테스트 작성**

```ts
describe("syncLateJoiner — 역할: 늦은 합류자의 화면 복원", () => {
  it("합류하면 기존 출력이 스크롤백에서 재생되고 sync로 끝난다", () => {
    const { ctx, host, room, terminalId } = setupOpenTerminal();
    host.sendOutput(terminalId, 1, "old-output");
    const carol = ctx.connectParticipant(room, "carol");
    expect(carol.conn.dataFrames).toMatchObject([{ kind: "output", terminalId, seq: 1 }]);
    expectMessageToMatch(carol.conn.messages, "sync", { terminalId, seq: 1 });
  });

  it("welcome이 replay 프레임보다 먼저 도착한다 (수신 순서 고정)", () => {
    /* RecordingConnection에 통합 타임라인(messages·dataFrames의 도착 순번)을 두고
       welcome 순번 < 첫 data 순번 검증 — RecordingConnection에 arrivalOrder 배열 추가 */
  });

  it("출력이 없던 터미널은 replay 없이 sync(seq:0)만 받는다", () => { /* ... */ });
});
```

- [ ] **Step 2: RED→GREEN + 커밋**

```bash
git add packages/server/src
git commit -m "feat(server): syncLateJoiner — 스크롤백 replay와 sync"
```

---

## Phase D — 서버 어댑터와 부팅

### Task 13: Transport 계약 스위트 + WebSocket 어댑터

**Files:**
- Create: `packages/server/src/test/transport-contract.ts`
- Create: `packages/server/src/test/in-memory-link.ts`
- Create: `packages/server/src/adapters/ws/ws-transport.ts`
- Test: `packages/server/src/test/in-memory-link.spec.ts`(계약 스위트 실행), `packages/server/src/adapters/ws/ws-transport.integration.spec.ts`(같은 스위트 + WS 고유)

**Interfaces:**
- Consumes: Task 5의 `Connection`
- Produces:
  ```ts
  // test/transport-contract.ts — 스펙 4항: 하나의 스위트를 모든 어댑터에 실행
  export interface TransportLink {
    connection: Connection;                       // 서버 쪽 끝
    remote: {                                     // 클라이언트 쪽 끝 관찰자
      messages: ServerMessage[]; dataFrames: DataFrame[];
      sendText(raw: string): void; sendBinary(bytes: Uint8Array): void;
      close(): void;
    };
    received: { texts: string[]; binaries: Uint8Array[] };  // 서버 쪽이 수신한 것
    onServerClose: Promise<void>;
    flush(): Promise<void>;                        // 전송 완료 대기 (인메모리는 no-op)
  }
  export function describeTransportContract(name: string, makeLink: () => Promise<TransportLink>): void;
  // 계약 항목: (1) send한 제어 메시지가 순서대로 remote에 도착
  //           (2) sendData한 프레임이 순서대로, 제어와 독립적으로 도착
  //           (3) remote가 보낸 텍스트/바이너리가 서버 수신 콜백에 도착
  //           (4) remote.close() 시 onServerClose가 정확히 한 번 resolve
  //           (5) close된 연결에 send해도 throw하지 않는다

  // adapters/ws/ws-transport.ts
  export class WsTransport {
    constructor(deps: { core: ServerCore }, options: { server: import("node:http").Server });
    // http server의 upgrade를 받아 ws 연결마다 Connection 구현체 생성,
    // 텍스트 프레임→core.handleMessage, 바이너리→core.handleData, close→core.handleClose.
    // bufferedBytes()는 ws.bufferedAmount 위임.
  }
  ```

- [ ] **Step 1: 계약 스위트와 인메모리 링크 작성 → 인메모리로 GREEN**

`in-memory-link.spec.ts`는 `describeTransportContract("InMemoryLink", makeInMemoryLink)` 한 줄. RED(스위트·링크 없음) 확인 후 구현.
Run: `pnpm --filter @ttyroom/server test -- in-memory-link`

- [ ] **Step 2: WS 어댑터 integration 테스트 작성**

`ws-transport.integration.spec.ts`:
```ts
// makeWsLink: http.createServer + WsTransport(단, core 대신 수신을 그대로 기록하는 스텁 core)
//   + 실제 ws 클라이언트로 연결. remote는 ws 클라이언트를 감싼 관찰자.
describeTransportContract("WsTransport", makeWsLink);

describe("WsTransport 고유 동작", () => {
  it("bufferedBytes는 ws.bufferedAmount를 반영한다", async () => { /* 큰 페이로드 직후 > 0 확인은 타이밍 민감 —
      대신 close 후 0, 정상시 number 반환 스모크로 한정 */ });
});
```

Run: `pnpm --filter @ttyroom/server test:integration`
Expected: RED(어댑터 없음) → 구현 → PASS.

- [ ] **Step 3: 커밋**

```bash
git add packages/server/src
git commit -m "feat(server): Transport 계약 스위트와 WebSocket 어댑터"
```

---

### Task 14: config + HTTP + main 조립

**Files:**
- Create: `packages/server/src/config.ts`, `src/http.ts`, `src/main.ts`, `src/index.ts`
- Test: `packages/server/src/config.spec.ts`, `packages/server/src/main.integration.spec.ts`

**Interfaces:**
- Consumes: 지금까지의 전부
- Produces (agent·e2e가 사용):
  ```ts
  // config.ts — zod 스키마 단일 진실. 출처 추적을 위해 값마다 {value, source} 보관
  export const configSchema = z.object({
    port: z.number().int().default(0),
    policy: z.object({ /* Policy 필드 전부, DEFAULT_POLICY 기본값 */ }).default({}),
  });
  export type ServerConfig = z.infer<typeof configSchema>;
  export function loadConfig(input: { file?: unknown; env?: NodeJS.ProcessEnv }): ServerConfig; // 검증 실패는 throw
  export function printConfig(config: ServerConfig): string;  // 최종값과 출처(default/file/env) 표

  // main.ts
  export interface RunningServer { port: number; httpBaseUrl: string; close(): Promise<void> }
  export function startServer(config: ServerConfig): Promise<RunningServer>;
  // HTTP: POST /api/rooms → 201 {roomId, token, joinUrl:"<base>/r/<roomId>#<token>"}
  //       GET /healthz → 200 "ok" · GET /r/:roomId → 200 텍스트 자리표시(웹 트랙에서 교체)
  //       GET /ws (upgrade) → WsTransport
  // CLI 엔트리(index.ts): --print-config면 출력 후 exit 0, 아니면 startServer
  ```

- [ ] **Step 1: config 실패 테스트 → RED → 구현 → GREEN**

```ts
describe("loadConfig — 역할: 설정의 검증과 출처 추적", () => {
  it("빈 입력이면 기본값으로 채운다", () => {
    expect(loadConfig({})).toMatchObject({ policy: { participantGraceMs: 15000 } });
  });
  it("파일 값이 기본값을 덮고 env가 파일을 덮는다", () => {
    const config = loadConfig({ file: { port: 1234 }, env: { TTYROOM_PORT: "5678" } });
    expect(config.port).toBe(5678);
  });
  it("범위를 벗어난 값은 부팅 시점에 throw한다", () => {
    expect(() => loadConfig({ file: { port: -1 } })).toThrow();
  });
  it("printConfig는 각 값의 출처를 표시한다", () => {
    expect(printConfig(loadConfig({ file: { port: 1234 } }))).toMatch(/port.*1234.*file/);
  });
});
```

- [ ] **Step 2: 부팅 integration 테스트 → RED → 구현 → GREEN**

`main.integration.spec.ts`:
```ts
describe("startServer — 역할: 조립과 HTTP 경계", () => {
  it("포트 0으로 부팅해 healthz가 200이다", async () => {
    const server = await startServer(loadConfig({}));
    const res = await fetch(`${server.httpBaseUrl}/healthz`);
    expect(res.status).toBe(200);
    await server.close();
  });

  it("POST /api/rooms가 roomId·token·joinUrl을 발급한다", async () => { /* ... */ });

  it("발급받은 Room에 실제 ws로 hello하면 welcome이 온다 (엔드투엔드 배선)", async () => {
    /* @ttyroom/protocol의 parseServerMessage로 검증. ws 클라이언트 직접 사용 */
  });
});
```

- [ ] **Step 3: 커밋**

```bash
git add packages/server
git commit -m "feat(server): config·HTTP 경계·main 조립"
```

---

## Phase E — Agent

### Task 15: agent 패키지 + AgentSession (재접속 백오프)

**Files:**
- Create: `packages/agent/package.json`(deps: `@ttyroom/protocol`, `ws`, `node-pty`; bin: `ttyroom`), `tsconfig.json`, `vitest.config.ts`, `vitest.integration.config.ts`
- Create: `packages/agent/src/ports/agent-transport.ts`, `src/session.ts`, `src/test/fake-agent-transport.ts`
- Test: `packages/agent/src/session.spec.ts`

**Interfaces:**
- Consumes: `@ttyroom/protocol`
- Produces:
  ```ts
  // ports/agent-transport.ts — agent 쪽 Transport 포트 (연결 시도 단위)
  export interface AgentConnection {
    send(msg: ClientMessage): void;
    sendData(frame: DataFrame): void;
    onMessage(handler: (msg: ServerMessage) => void): void;
    onData(handler: (frame: DataFrame) => void): void;
    onClose(handler: () => void): void;
    close(): void;
  }
  export interface AgentTransport { connect(wsUrl: string): Promise<AgentConnection> } // 실패는 reject

  export interface AgentClock { schedule(delayMs: number, fn: () => void): () => void } // 서버 Clock과 동형

  // session.ts
  export type SessionEvent =
    | { kind: "connected" } | { kind: "reconnecting"; attempt: number; delayMs: number }
    | { kind: "rejected"; code: string }           // error 메시지 수신 — 재시도하지 않는 종료
    | { kind: "server-message"; message: ServerMessage }
    | { kind: "server-data"; frame: DataFrame };
  export class AgentSession {
    constructor(deps: { transport: AgentTransport; clock: AgentClock },
                options: { wsUrl: string; hello: HelloMessage; onEvent: (e: SessionEvent) => void });
    start(): void;
    send(msg: ClientMessage): void;      // 미연결이면 무시 (출력은 서버 스크롤백이 아니라 재생성 불가 — MVP 수용)
    sendData(frame: DataFrame): void;
    stop(): void;                        // 재접속 중단 + 연결 종료
  }
  // 백오프: 500ms * 2^attempt, 상한 10초. welcome 수신 시 attempt 리셋.
  ```

- [ ] **Step 1: 실패 테스트 작성 (FakeAgentTransport + FakeClock, 행동 단위 반복)**

`session.spec.ts`:
```ts
describe("AgentSession — 역할: 서버 연결 수명주기", () => {
  it("start하면 연결 후 hello를 보낸다", async () => {
    const { transport, session } = makeSession();
    session.start();
    await transport.settle();     // FakeAgentTransport: 대기 중 connect resolve
    expect(transport.lastConnection().sent).toMatchObject([{ type: "hello" }]);
  });

  it("연결이 끊기면 지수 백오프(500ms→1s→2s, 상한 10s)로 재접속한다", async () => {
    const { transport, clock, session, events } = makeSession();
    session.start();
    await transport.settle();
    transport.lastConnection().emitClose();
    expect(events).toContainEqual({ kind: "reconnecting", attempt: 1, delayMs: 500 });
    clock.advance(500);
    await transport.settle();
    transport.lastConnection().emitClose();
    expect(events).toContainEqual({ kind: "reconnecting", attempt: 2, delayMs: 1000 });
  });

  it("서버 error 메시지를 받으면 재시도 없이 rejected로 끝난다 (버전 불일치 안내)", async () => {
    /* emitMessage({type:"error", code:"unsupported-protocol-version",...}) →
       events에 rejected, close 후 clock.advance해도 재연결 시도 없음 */
  });

  it("stop하면 진행 중 백오프 타이머가 취소된다", async () => { /* ... */ });
});
```

- [ ] **Step 2: RED→GREEN 반복 + 커밋**

Run: `pnpm --filter @ttyroom/agent test`

```bash
git add packages/agent
git commit -m "feat(agent): AgentSession — hello·지수 백오프 재접속"
```

---

### Task 16: PtyManager + 출력 RateLimiter

**Files:**
- Create: `packages/agent/src/rate-limiter.ts`, `src/pty-manager.ts`
- Test: `packages/agent/src/rate-limiter.spec.ts`, `packages/agent/src/pty-manager.integration.spec.ts`

**Interfaces:**
- Consumes: Task 15의 `AgentClock`
- Produces:
  ```ts
  // rate-limiter.ts — 토큰 버킷. 한 터미널의 폭주가 연결 전체를 점유하지 못하게 (스펙 백프레셔)
  export class RateLimiter {
    constructor(deps: { clock: AgentClock }, options: { bytesPerSec: number; burstBytes: number });
    submit(chunk: Uint8Array, deliver: (chunk: Uint8Array) => void): void;
    // 버킷 내에서는 즉시 deliver, 초과분은 시간 경과에 따라 순서대로 지연 deliver. 드롭 없음.
  }

  // pty-manager.ts
  export class PtyManager {
    constructor(deps: { clock: AgentClock },
                options: { shell?: string; rateLimitBytesPerSec: number;
                           onOutput: (terminalId: number, chunk: Uint8Array) => void;
                           onExit: (terminalId: number, exitCode: number | null) => void });
    open(terminalId: number, cols: number, rows: number): void;   // node-pty spawn (기본 $SHELL, 폴백 /bin/sh)
    write(terminalId: number, data: Uint8Array): void;            // 없는 터미널이면 무시 (경합 중 close 수용)
    resize(terminalId: number, cols: number, rows: number): void;
    close(terminalId: number): void;
    closeAll(): void;
    fgProcess(terminalId: number): string | null;                 // node-pty의 pty.process
    pid(terminalId: number): number | null;
  }
  ```

- [ ] **Step 1: RateLimiter 유닛 (FakeClock) → RED → 구현 → GREEN**

```ts
describe("RateLimiter — 역할: 터미널별 출력 속도 상한", () => {
  it("버스트 한도 내 청크는 즉시 전달된다", () => { /* submit 후 delivered 즉시 확인 */ });
  it("한도 초과분은 시간이 지나야 순서대로 전달된다", () => {
    /* burstBytes=10, bytesPerSec=10: 15B submit → 10B 즉시, clock.advance(500) → 나머지 5B */
  });
});
```

- [ ] **Step 2: PtyManager integration (실제 PTY) → RED → 구현 → GREEN**

`pty-manager.integration.spec.ts`:
```ts
describe("PtyManager — 역할: 실제 셸의 생성과 입출력", () => {
  it("open한 셸에 echo를 쓰면 출력 콜백으로 되돌아온다", async () => {
    const chunks: Uint8Array[] = [];
    const manager = new PtyManager({ clock: systemClock }, {
      shell: "/bin/sh", rateLimitBytesPerSec: 1 << 20,
      onOutput: (_id, c) => chunks.push(c), onExit: () => {},
    });
    manager.open(1, 80, 24);
    manager.write(1, new TextEncoder().encode("echo ttyroom-ok\n"));
    await waitUntil(() => decode(chunks).includes("ttyroom-ok"));   // sleep 금지 — 조건 폴링 헬퍼
    manager.closeAll();
  });

  it("셸이 exit하면 onExit이 종료 코드와 함께 불린다", async () => {
    /* write("exit 3\n") → waitUntil(exitCode === 3) */
  });
});
```

`waitUntil(condition, {timeoutMs=5000, intervalMs=20})` 헬퍼는 `packages/agent/src/test/wait-until.ts`에 두고 e2e에서도 재사용한다.

- [ ] **Step 3: 커밋**

```bash
git add packages/agent
git commit -m "feat(agent): PtyManager와 출력 RateLimiter"
```

---

### Task 17: Agent 배선 — CLI·Kill Switch·meta 수집

**Files:**
- Create: `packages/agent/src/agent-app.ts`, `src/meta-collector.ts`, `src/cli.ts`, `src/index.ts`(bin 엔트리)
- Test: `packages/agent/src/cli.spec.ts`, `src/agent-app.spec.ts`, `src/meta-collector.integration.spec.ts`

**Interfaces:**
- Consumes: Task 15·16 전부, protocol 메시지
- Produces:
  ```ts
  // cli.ts — 엔트리는 경계 책임만 (가이드라인 §1.6). 파싱은 순수 함수로 테스트
  export type CliCommand =
    | { kind: "join"; httpUrl: string; roomId: string; token: string; wsUrl: string; name: string }
    | { kind: "invalid"; reason: string };
  export function parseCli(argv: string[], env: { hostname: string }): CliCommand;
  // 입력 형식: ttyroom join <joinUrl> [--name <표시명>]
  //   joinUrl = http(s)://host[:port]/r/<roomId>#<token> → wsUrl = ws(s)://host[:port]/ws
  //   --name 생략 시 hostname 사용

  // agent-app.ts — 서버 메시지 → PtyManager 배선 + Kill Switch
  export class AgentApp {
    constructor(deps: { session: AgentSession; ptys: PtyManager },
                options: { onStatus: (line: string) => void });
    // session의 onEvent가 AgentApp.handleEvent(e: SessionEvent)를 부르도록 조립부(index.ts)가 배선
    // server-message 처리: open-terminal→ptys.open+terminal-opened 회신,
    //   close-terminal→ptys.close, resize→ptys.resize
    // server-data(input frame) 처리: killSwitch가 꺼져 있을 때만 ptys.write
    // ptys.onOutput → session.sendData(출력 프레임, seq는 agent 로컬 단조 증가 — 서버가 재부여)
    // ptys.onExit → session.send({type:"terminal-closed", terminalId, exitCode})
    setKillSwitch(on: boolean): void;   // 로컬 판단 — 서버를 거치지 않는다 (스펙)
    killSwitch(): boolean;
  }

  // meta-collector.ts — 5초 폴링(상수·근거 코멘트)
  export class MetaCollector {
    constructor(deps: { ptys: PtyManager; clock: AgentClock },
                options: { intervalMs: number; onMeta: (terminalId: number, meta: TerminalMeta) => void });
    track(terminalId: number): void; untrack(terminalId: number): void;
    // cwd: linux는 /proc/<pid>/cwd readlink, darwin은 `lsof -a -p <pid> -d cwd -Fn` 파싱, 실패 시 null
    // gitBranch: cwd에서 `git rev-parse --abbrev-ref HEAD`, 실패 시 null
    // fgProcess: ptys.fgProcess(terminalId)
  }
  ```

- [ ] **Step 1: parseCli 유닛 → RED → 구현 → GREEN**

```ts
describe("parseCli — 역할: join 명령의 해석", () => {
  it("joinUrl에서 roomId·token·wsUrl을 뽑아낸다", () => {
    const cmd = parseCli(["join", "http://localhost:8080/r/lively-fox#tok123"], { hostname: "mac" });
    expect(cmd).toEqual({
      kind: "join", httpUrl: "http://localhost:8080", roomId: "lively-fox",
      token: "tok123", wsUrl: "ws://localhost:8080/ws", name: "mac",
    });
  });
  it("--name이 hostname을 덮는다", () => { /* ... */ });
  it("토큰 없는 URL은 invalid다", () => { /* ... */ });
  it("모르는 서브커맨드는 invalid다", () => { /* ... */ });
});
```

- [ ] **Step 2: AgentApp 유닛 (fake session·fake ptys) → RED → 구현 → GREEN (행동 단위 반복)**

```ts
describe("AgentApp — 역할: 서버 명령과 PTY의 배선, Kill Switch", () => {
  it("open-terminal을 받으면 PTY를 열고 terminal-opened를 회신한다", () => { /* ... */ });
  it("입력 프레임을 받으면 해당 PTY에 쓴다", () => { /* ... */ });
  it("Kill Switch가 켜져 있으면 입력 프레임을 PTY에 쓰지 않는다", () => {
    /* setKillSwitch(true) → server-data 주입 → fake ptys.writes 비어 있음 */
  });
  it("PTY 출력은 출력 프레임으로 session에 전달된다", () => { /* ... */ });
  it("PTY exit은 terminal-closed 메시지가 된다", () => { /* ... */ });
});
```

- [ ] **Step 3: MetaCollector integration → RED → 구현 → GREEN**

```ts
describe("MetaCollector — 역할: 터미널 카드 자동 맥락 수집", () => {
  it("실제 PTY의 cwd와 fgProcess를 수집한다 (git 저장소면 브랜치 포함)", async () => {
    /* 임시 디렉터리에 git init -b test-branch → PTY에서 cd → 폴링 1회 강제 →
       meta.cwd가 임시 디렉터리, meta.gitBranch === "test-branch" 확인.
       darwin lsof 실패 환경이면 cwd null 허용하되 fgProcess는 non-null 단언 */
  });
});
```

- [ ] **Step 4: index.ts 엔트리 조립 (판단 로직 없음 — 스모크는 e2e가 담당)**

`index.ts`: `parseCli` → invalid면 사용법 출력 + exit 1. join이면 WsAgentTransport(ws 기반 `AgentTransport` 구현, 이 파일 옆 `ws-agent-transport.ts`) + 시스템 clock으로 AgentSession·PtyManager·AgentApp·MetaCollector 조립. 상태 표시는 `onStatus`를 stdout 한 줄로. stdin raw mode에서 `k` 키로 Kill Switch 토글(토글 상태 출력), Ctrl+C(SIGINT)로 `closeAll → stop → exit 0`.

- [ ] **Step 5: 전체 GREEN + 커밋**

Run: `pnpm --filter @ttyroom/agent test && pnpm --filter @ttyroom/agent test:integration`

```bash
git add packages/agent
git commit -m "feat(agent): CLI·Kill Switch·meta 수집과 배선"
```

---

## Phase F — 플로우 e2e와 CI

### Task 18: e2e 하네스 + 협업 시나리오

**Files:**
- Create: `packages/e2e/package.json`(devDeps: `@ttyroom/server`, `@ttyroom/protocol`, `ws`, `tsx`, `vitest`; script `test:e2e`: `vitest run --config vitest.e2e.config.ts`), `vitest.e2e.config.ts`(`include: ["src/**/*.e2e.ts"]`, `fileParallelism: false`, `testTimeout: 30000`)
- Create: `packages/e2e/src/harness.ts`
- Test: `packages/e2e/src/collab.e2e.ts`

**Interfaces:**
- Consumes: `startServer`(Task 14), agent CLI(Task 17), protocol 전부
- Produces:
  ```ts
  // harness.ts — given/assert DSL (스펙 6항)
  export interface TestRoom { roomId: string; token: string; joinUrl: string; baseUrl: string }
  export interface Given {
    server(policy?: Partial<Policy>): Promise<{ room(): Promise<TestRoom>; close(): Promise<void> }>;
    // in-process startServer(port 0). policy 오버라이드는 짧은 유예 테스트용
    agent(room: TestRoom, name?: string): Promise<AgentHandle>;
    // 자식 프로세스: `tsx packages/agent/src/index.ts join <joinUrl> --name <name>`
    // host-connected 이벤트를 관찰자 참여자로 확인할 때까지 대기 후 반환
    participant(room: TestRoom, name: string, clientId?: string): Promise<ParticipantClient>;
  }
  export interface AgentHandle { hostId: string; kill(signal?: string): void }
  export interface ParticipantClient {
    clientId: string;
    snapshot(): RoomSnapshot;                         // welcome + room-event 반영 유지
    openTerminal(hostId: string): Promise<number>;    // terminal-opened 이벤트 대기 → terminalId
    acquire(terminalId: number): Promise<LeaseResult>;
    type(terminalId: number, text: string): void;     // 입력 프레임 전송 (보유 leaseId 사용)
    outputText(terminalId: number): string;           // 수신 출력 프레임 누적 디코딩
    syncedSeq(terminalId: number): number;             // 마지막 sync 메시지의 seq
    lastMessages(): ServerMessage[];
    close(): void; reconnect(): Promise<void>;         // 같은 clientId로 재접속
  }
  export function waitUntil(cond: () => boolean, opts?: { timeoutMs?: number }): Promise<void>;
  ```

- [ ] **Step 1: 첫 시나리오 작성 (하네스는 이 시나리오가 요구하는 만큼만 구현)**

`collab.e2e.ts`:
```ts
describe("협업 플로우 — A 입력을 B가 본다", () => {
  it("참여자 A가 agent 터미널에 입력하면 B 화면에 출력이 도착한다", async () => {
    const server = await given.server();
    const room = await server.room();
    const agent = await given.agent(room, "host-a");
    const alice = await given.participant(room, "alice");
    const bob = await given.participant(room, "bob");

    const terminalId = await alice.openTerminal(agent.hostId);
    await alice.acquire(terminalId);
    alice.type(terminalId, "echo collab-ok\n");

    await waitUntil(() => bob.outputText(terminalId).includes("collab-ok"));
    await waitUntil(() => alice.outputText(terminalId).includes("collab-ok"));
    await server.close();
  });

  it("늦게 합류한 참여자는 기존 출력을 replay로 받는다", async () => {
    /* alice가 echo 후 carol 합류 → carol.outputText에 이전 출력 포함
       + carol.syncedSeq(terminalId) > 0 */
  });

  it("점유된 터미널의 acquire는 denied와 소유자 정보를 받는다", async () => { /* ... */ });

  it("shared 모드 전환은 후속 — MVP e2e는 exclusive만 다룬다", () => { expect(true).toBe(true); });
  // ↑ 자리표시가 아니라 의도적 스코프 결정의 기록. shared e2e는 web 트랙에서 UI와 함께.
});
```

- [ ] **Step 2: RED 확인 → 하네스 구현 → GREEN**

Run: `pnpm --filter @ttyroom/e2e run test:e2e`
Expected: RED(harness 없음) → 구현 → PASS. 하네스 구현 요점: ParticipantClient는 ws + `parseServerMessage` + `decodeDataFrame`으로 수신 라우팅, welcome·room-event를 로컬 snapshot에 반영. `given.agent`은 `node --import tsx` 자식 프로세스로 실행하고 teardown에서 반드시 kill (`try/finally`).

- [ ] **Step 3: 커밋**

```bash
git add packages/e2e
git commit -m "test(e2e): 협업 플로우 하네스와 핵심 시나리오"
```

---

### Task 19: 회복 탄력성 e2e + CI + 의존성 검사

**Files:**
- Create: `packages/e2e/src/resilience.e2e.ts`
- Create: `.github/workflows/ci.yml`, `.dependency-cruiser.cjs`
- Modify: 루트 `package.json` (`depcruise` 스크립트, devDep `dependency-cruiser`)

**Interfaces:**
- Consumes: Task 18 하네스 (`policy` 오버라이드로 짧은 유예)
- Produces: 없음 (최종 태스크)

- [ ] **Step 1: 회복 시나리오 작성 → RED → 하네스 보강 → GREEN**

`resilience.e2e.ts`:
```ts
describe("회복 탄력성 — 단절과 유예", () => {
  it("참여자가 유예 내 재접속하면 임대가 유지된다", async () => {
    const server = await given.server({ participantGraceMs: 3000 });
    /* alice acquire → alice.close() → alice.reconnect() →
       snapshot().leases에 alice 임대 존재 */
  });

  it("agent 프로세스를 죽이면 host-offline 후 유예가 지나 host-removed가 된다", async () => {
    const server = await given.server({ hostGraceMs: 1000 });
    /* agent.kill() → waitUntil(bob snapshot host online:false) →
       waitUntil(snapshot에서 host 제거 + 터미널 제거) */
  });

  it("agent가 재접속하는 동안 실행 중이던 프로세스의 출력은 이어진다", async () => {
    /* 터미널에서 `sh -c 'for i in 1 2 3 4 5; do echo tick-$i; sleep 1; done'` 실행 →
       (서버는 그대로, 참여자만 close/reconnect) → 재접속 후 tick-5까지 수신 확인
       — "브라우저 새로고침이 로컬 프로세스를 죽이지 않는다" 품질 기준의 e2e 대응물 */
  });
});
```

- [ ] **Step 2: dependency-cruiser 규칙 작성 + 검사 통과 확인**

`.dependency-cruiser.cjs` — 스펙의 의존 방향 규칙을 그대로 코드화:
```js
module.exports = {
  forbidden: [
    { name: "domain은 바깥을 모른다", severity: "error",
      from: { path: "^packages/server/src/domain" },
      to: { path: "^packages/server/src/(usecases|adapters|ports)" } },
    { name: "usecases는 어댑터를 모른다", severity: "error",
      from: { path: "^packages/server/src/usecases" },
      to: { path: "^packages/server/src/adapters" } },
    { name: "순환 금지", severity: "error", from: {}, to: { circular: true } },
  ],
  options: { doNotFollow: { path: "node_modules" } },
};
```
루트 스크립트: `"depcruise": "depcruise packages/*/src"`. Run: `pnpm depcruise` → 통과 확인 (위반이 나오면 코드가 아니라 위반을 고친다).

- [ ] **Step 3: CI 워크플로 작성**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  pull_request:
  push: { branches: [main] }
jobs:
  check:   # PR 게이트 — 유닛+프로토콜 (스펙 10항)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm format
      - run: pnpm depcruise
      - run: pnpm test
  full:    # main 머지 시 전체 — integration(실제 PTY/WS) + e2e
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r --if-present run build
      - run: pnpm test:integration
      - run: pnpm test:e2e
```

- [ ] **Step 4: 전체 검증 + 커밋**

Run: `pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:e2e && pnpm depcruise`
Expected: 전부 PASS

```bash
git add packages/e2e .github .dependency-cruiser.cjs package.json pnpm-lock.yaml
git commit -m "test(e2e): 회복 탄력성 시나리오 + CI·의존성 방향 검사"
```

---

## 스펙 커버리지 맵 (self-review용)

| 스펙 요구 | 태스크 |
|---|---|
| 데이터 프레임 레이아웃·불투명 payload | 1, 10 |
| 제어 메시지·버전 협상·PROTOCOL.md | 2, 6, 15 |
| Room·Host·Terminal·Quick Room 소멸 | 3, 11 |
| Lease 불변식(선착순·1인1임대·멱등·shared) | 4, 8, 9 |
| 포트 4종 + Policy 3층 설정 | 5, 14 |
| 유즈케이스 9종 | 6~12 |
| 백프레셔(참여자 드롭·sync·rate limit) | 10, 16 |
| 단절 유예·복원·room-not-found | 11, 14, 19 |
| 늦은 합류 replay | 12, 18 |
| Transport 계약 스위트 공유 | 13 |
| Room 생성 HTTP·--print-config | 14 |
| Agent 얇음·재접속·Kill Switch·meta | 15~17 |
| 플로우 e2e(given/assert DSL) | 18, 19 |
| CI 게이트(PR=유닛, main=전체)·의존 방향 강제 | 19 |
| Web UI | 범위 외 — 별도 트랙 |

