import "@fontsource-variable/fira-code";
import "@fontsource-variable/inter";
import "@xterm/xterm/css/xterm.css";
import "../../src/ui/theme.css";
import "../../src/ui/app.css";

import { createRoot } from "react-dom/client";

import { RoomApp, RoomAppRuntime, type RoomAppSession } from "../../src/app/room-app.js";
import { RoomProjection } from "../../src/projection/room-projection.js";
import type { RoomSessionEvent } from "../../src/session/room-session.js";
import { TerminalController } from "../../src/terminal/terminal-controller.js";
import { XtermAdapter } from "../../src/terminal/xterm-adapter.js";
import { WindowManager } from "../../src/windows/window-manager.js";
import { REFERENCE_LAYOUT, REFERENCE_OUTPUT, REFERENCE_ROOM } from "./reference-room.js";

class ReferenceRoomSession implements RoomAppSession {
  readonly #subscribers = new Set<(event: RoomSessionEvent) => void>();

  constructor(private readonly projection: RoomProjection) {}

  start(): void {
    this.projection.applyServerMessage({
      type: "welcome",
      selfClientId: "donghyeon",
      snapshot: REFERENCE_ROOM,
    });
    for (const terminal of REFERENCE_ROOM.terminals) {
      const output = REFERENCE_OUTPUT.get(terminal.terminalId) ?? "";
      const effects = this.projection.applyOutput({
        kind: "output",
        terminalId: terminal.terminalId,
        seq: 1,
        payload: new TextEncoder().encode(output),
      });
      for (const effect of effects) {
        if (effect.kind === "terminal-output" || effect.kind === "reset-terminal-output") {
          for (const subscriber of this.#subscribers) subscriber(effect);
        }
      }
      this.projection.applyServerMessage({ type: "sync", terminalId: terminal.terminalId, seq: 1 });
    }
    for (const subscriber of this.#subscribers) {
      subscriber({ kind: "lease-acquired", terminalId: 1 });
    }
  }

  stop(): void {
    this.#subscribers.clear();
  }

  subscribe(subscriber: (event: RoomSessionEvent) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  takeControl(): void {}
  releaseControl(): void {}
  closeTerminal(): void {}
  openTerminal(): void {}
  resize(): void {}
  updateGeometry(): void {}
  renameTerminal(): void {}
  setMode(): void {}
  focusTerminal(): void {}
}

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("visual reference root is missing");

const projection = new RoomProjection();
const windowManager = new WindowManager({
  viewport: { width: window.innerWidth, height: Math.max(1, window.innerHeight - 194) },
});
windowManager.restoreLayout(REFERENCE_LAYOUT);

const runtime = new RoomAppRuntime({
  route: { kind: "room", roomId: REFERENCE_ROOM.roomId, token: "visual-token" },
  identity: {
    clientId: () => "donghyeon",
    nickname: () => "Donghyeon",
    saveNickname: () => undefined,
  },
  projection,
  windowManager,
  createSession: () => new ReferenceRoomSession(projection),
  createController: (terminalId) =>
    new TerminalController(
      {
        adapterFactory: { create: () => new XtermAdapter() },
        frameScheduler: {
          schedule: (callback) => {
            const frame = requestAnimationFrame(callback);
            return () => cancelAnimationFrame(frame);
          },
        },
      },
      { terminalId, sendInput: () => undefined, resize: () => undefined },
    ),
  createRoom: () => undefined,
  navigate: () => undefined,
  copyInvite: () => undefined,
  copyText: () => undefined,
  inviteUrl: "https://ttyroom.test/rooms/visual-room#visual-token",
});

runtime.join(REFERENCE_ROOM.roomId, "Donghyeon");
createRoot(root).render(<RoomApp runtime={runtime} />);
window.addEventListener("pagehide", () => runtime.dispose(), { once: true });
