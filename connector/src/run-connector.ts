import type { HelloMessage } from "@ttyroom/protocol";
import { ConnectorApp } from "./connector-app.js";
import { MetaCollector } from "./meta-collector.js";
import { PtyManager } from "./pty-manager.js";
import { ConnectorSession } from "./session.js";
import { systemClock } from "./system-clock.js";
import { WsConnectorTransport } from "./ws-connector-transport.js";

// Policy 기본값과 동일 (Global Constraints outputRateLimitBytesPerSec) — 서버 드롭 임계 아래로 유지
const OUTPUT_RATE_LIMIT_BYTES_PER_SEC = 4_194_304;

// 5초 폴링 — cwd·브랜치는 천천히 변하고, lsof·git 실행 비용을 터미널 수에 비례해 치른다
const META_INTERVAL_MS = 5000;

export function runConnector(wsUrl: string, hello: HelloMessage): void {
  const onStatus = (line: string): void => console.log(`[ttyroom] ${line}`);
  // app은 ptys·session 콜백에서 늦게 바인딩된다 — 콜백 호출은 전부 start() 이후
  let app: ConnectorApp;

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

  const session = new ConnectorSession(
    { transport: new WsConnectorTransport(), clock: systemClock },
    {
      wsUrl: wsUrl,
      hello,
      onEvent: (event) => app.handleEvent(event),
    },
  );

  const collector = new MetaCollector(
    { ptys, clock: systemClock },
    {
      intervalMs: META_INTERVAL_MS,
      onMeta: (terminalId, meta) => session.send({ type: "terminal-meta", terminalId, meta }),
    },
  );

  app = new ConnectorApp(
    { session, ptys },
    { onStatus, onTerminalOpened: (terminalId) => collector.track(terminalId) },
  );

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
    `TTYRoom Connector — Room ${hello.roomId}에 "${hello.name}"(으)로 접속합니다 — Kill Switch: k, 종료: Ctrl+C`,
  );
  session.start();
}
