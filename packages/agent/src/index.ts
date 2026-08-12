#!/usr/bin/env node
// bin 엔트리 — 경계 책임만: 인자 파싱, 조립, 시그널·키 입력, 상태 출력 (가이드라인 §1.6)
// 판단 로직은 전부 스펙된 컴포넌트에 있고, 이 파일의 스모크는 플로우 e2e가 담당한다 (계획 Task 17)
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { PROTOCOL_VERSION, type HelloMessage } from "@ttyroom/protocol";
import { AgentApp } from "./agent-app.js";
import { parseCli } from "./cli.js";
import { MetaCollector } from "./meta-collector.js";
import { PtyManager } from "./pty-manager.js";
import { AgentSession } from "./session.js";
import { systemClock } from "./system-clock.js";
import { WsAgentTransport } from "./ws-agent-transport.js";

// Policy 기본값과 동일 (Global Constraints outputRateLimitBytesPerSec) — 서버 드롭 임계 아래로 유지
const OUTPUT_RATE_LIMIT_BYTES_PER_SEC = 4_194_304;

// 5초 폴링 — cwd·브랜치는 천천히 변하고, lsof·git 실행 비용을 터미널 수에 비례해 치른다
const META_INTERVAL_MS = 5000;

const command = parseCli(process.argv.slice(2), { hostname: hostname() });
if (command.kind === "invalid") {
  console.error(command.reason);
  process.exit(1);
}

const onStatus = (line: string): void => console.log(`[ttyroom] ${line}`);

const hello: HelloMessage = {
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  roomId: command.roomId,
  token: command.token,
  // 프로세스 수명 동안 고정 — 재접속 유예(같은 clientId 복귀)에 충분하다.
  // 파일 보관(스펙 §신원)은 계획 범위 밖의 후속.
  clientId: randomUUID(),
  name: command.name,
  role: "host",
};

// app은 ptys·session 콜백에서 늦게 바인딩된다 — 콜백 호출은 전부 start() 이후
let app: AgentApp;

const ptys = new PtyManager(
  { clock: systemClock },
  {
    rateLimitBytesPerSec: OUTPUT_RATE_LIMIT_BYTES_PER_SEC,
    onOutput: (terminalId, chunk) => app.handlePtyOutput(terminalId, chunk),
    onExit: (terminalId, exitCode) => {
      collector.untrack(terminalId);
      app.handlePtyExit(terminalId, exitCode);
    },
  },
);

const session = new AgentSession(
  { transport: new WsAgentTransport(), clock: systemClock },
  {
    wsUrl: command.wsUrl,
    hello,
    onEvent: (event) => {
      app.handleEvent(event);
      if (event.kind === "server-message" && event.message.type === "open-terminal") {
        collector.track(event.message.terminalId);
      }
    },
  },
);

const collector = new MetaCollector(
  { ptys, clock: systemClock },
  {
    intervalMs: META_INTERVAL_MS,
    onMeta: (terminalId, meta) => session.send({ type: "terminal-meta", terminalId, meta }),
  },
);

app = new AgentApp({ session, ptys }, { onStatus });

function shutdown(): void {
  onStatus("종료 중 — 모든 터미널을 닫습니다");
  ptys.closeAll();
  session.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// raw mode에서는 Ctrl+C가 SIGINT로 오지 않고 0x03 바이트로 온다
const KEY_KILL_SWITCH = 0x6b; // 'k'
const KEY_CTRL_C = 0x03;

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (bytes: Buffer) => {
    for (const byte of bytes) {
      if (byte === KEY_KILL_SWITCH) app.setKillSwitch(!app.killSwitch());
      if (byte === KEY_CTRL_C) shutdown();
    }
  });
}

onStatus(
  `Room ${command.roomId}에 "${command.name}"(으)로 접속합니다 — Kill Switch: k, 종료: Ctrl+C`,
);
session.start();
