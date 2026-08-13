import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, MousePointer, Terminal } from "react-feather";
import { Dock } from "../chrome/Dock.js";
import { Overview } from "../chrome/Overview.js";
import { WorkspaceCameraControls } from "../chrome/WorkspaceCameraControls.js";
import { useWorkspaceCamera } from "../use-workspace-camera.js";
import { DEFAULT_CAMERA } from "../workspace-camera.js";
import { viewportPointToWorkspace } from "../workspace-camera.js";
import { terminalStatusLabel } from "./TerminalStatus.js";
import {
  TerminalWindow,
  type TerminalWindowActions,
  type TerminalControllerPort,
  type TerminalWindowModel,
} from "./TerminalWindow.js";

export function TerminalScene({
  terminals,
  controllers,
  participants,
  cursors,
  hosts,
  activeTerminalId,
  actions,
  overview,
  inputBlocked = false,
}: {
  readonly terminals: readonly TerminalWindowModel[];
  readonly controllers: ReadonlyMap<number, TerminalControllerPort>;
  readonly participants: readonly string[];
  readonly cursors: readonly {
    readonly clientId: string;
    readonly name: string;
    readonly position: { readonly x: number; readonly y: number };
  }[];
  readonly hosts: readonly { readonly hostId: string; readonly name: string }[];
  readonly activeTerminalId: number | null;
  readonly actions: TerminalWindowActions & {
    readonly exitOverview: () => void;
    readonly addTerminal: (hostId: string) => void;
    readonly addHost: (opener?: HTMLElement) => void;
    readonly moveCursor: (position: { readonly x: number; readonly y: number } | null) => void;
  };
  readonly overview: boolean;
  readonly inputBlocked?: boolean;
}) {
  const lastCursorReportAt = useRef(Number.NEGATIVE_INFINITY);
  const canvas = useWorkspaceCamera({
    overview,
    terminalRects: terminals
      .filter((terminal) => !terminal.minimized)
      .map((terminal) => terminal.rect),
  });
  const reportCursor = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (overview) return;
    const now = performance.now();
    if (now - lastCursorReportAt.current < 40) return;
    lastCursorReportAt.current = now;
    const bounds = event.currentTarget.getBoundingClientRect();
    actions.moveCursor(
      viewportPointToWorkspace(
        { x: event.clientX, y: event.clientY },
        { left: bounds.left, top: bounds.top },
        canvas.camera,
      ),
    );
  };

  return (
    <>
      <div
        className={`terminal-scene${overview ? " is-overview" : ""}`}
        {...canvas.viewportBindings}
        onPointerMove={(event) => {
          canvas.viewportBindings.onPointerMove(event);
          reportCursor(event);
        }}
        onPointerLeave={() => actions.moveCursor(null)}
      >
        <div
          className="terminal-camera"
          style={{
            transform: `translate(${canvas.camera.x}px, ${canvas.camera.y}px) scale(${canvas.camera.scale})`,
          }}
        >
          {terminals.map((model) => {
            const controller = controllers.get(model.terminalId);
            if (!controller) return null;
            return (
              <TerminalWindow
                key={model.terminalId}
                model={model}
                controller={controller}
                actions={actions}
                active={activeTerminalId === model.terminalId}
                overview={overview}
                inputBlocked={inputBlocked}
                viewTransform={overview ? DEFAULT_CAMERA : canvas.camera}
              />
            );
          })}
        </div>
        {!overview &&
          cursors.map((cursor) => {
            const color = participantCursorColor(cursor.clientId);
            return (
              <div
                key={cursor.clientId}
                className="participant-cursor"
                aria-label={`${cursor.name} cursor`}
                style={
                  {
                    transform: `translate(${canvas.camera.x + cursor.position.x * canvas.camera.scale}px, ${canvas.camera.y + cursor.position.y * canvas.camera.scale}px)`,
                    "--participant-cursor-color": color,
                  } as CSSProperties
                }
              >
                <MousePointer size={20} strokeWidth={2.2} aria-hidden="true" />
                <span>{cursor.name}</span>
              </div>
            );
          })}
        {!overview && terminals.length === 0 && (
          <section className="empty-workspace" aria-labelledby="empty-workspace-title">
            <div className="empty-workspace-card">
              <span className="empty-workspace-icon" aria-hidden="true">
                <Terminal size={22} strokeWidth={1.6} />
              </span>
              <p className="empty-workspace-eyebrow">
                {hosts.length === 0
                  ? "Workspace ready"
                  : `${hosts.length} ${hosts.length === 1 ? "host" : "hosts"} connected`}
              </p>
              <h2 id="empty-workspace-title">
                {hosts.length === 0
                  ? "Bring your first terminal into the room"
                  : "Open your first terminal"}
              </h2>
              <p className="empty-workspace-copy">
                {hosts.length === 0
                  ? "Connect a Host Agent to share a local shell, then open terminals here for everyone to see."
                  : "Choose a connected machine. The new shell will open on this shared canvas for everyone in the room."}
              </p>
              {hosts.length === 0 ? (
                <button type="button" onClick={(event) => actions.addHost(event.currentTarget)}>
                  <Terminal size={16} strokeWidth={1.6} aria-hidden="true" />
                  Connect a host
                  <ArrowRight size={15} strokeWidth={1.7} aria-hidden="true" />
                </button>
              ) : (
                <div className="empty-workspace-hosts" aria-label="Connected hosts">
                  {hosts.map((host) => (
                    <button
                      key={host.hostId}
                      type="button"
                      aria-label={`Open terminal on ${host.name}`}
                      onClick={() => actions.addTerminal(host.hostId)}
                    >
                      <Terminal size={16} strokeWidth={1.6} aria-hidden="true" />
                      <span>
                        <strong>{host.name}</strong>
                        <small>Open terminal</small>
                      </span>
                      <ArrowRight size={15} strokeWidth={1.7} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
        <Overview open={overview} exit={actions.exitOverview} />
        {!overview && <WorkspaceCameraControls {...canvas.controls} />}
      </div>
      <Dock
        terminals={terminals.map((terminal) => ({
          terminalId: terminal.terminalId,
          title: terminal.title,
          status: terminalStatusLabel(terminal.status),
          activity: terminal.activity ?? "No recent activity",
          minimized: terminal.minimized,
        }))}
        participants={participants}
        hosts={hosts}
        activeTerminalId={activeTerminalId}
        restore={(terminalId) => {
          actions.restore(terminalId);
          actions.activate(terminalId);
        }}
        addTerminal={actions.addTerminal}
        addHost={actions.addHost}
      />
    </>
  );
}

const PARTICIPANT_CURSOR_COLORS = ["#9d6bdb", "#3fb8af", "#e28b4b", "#e06387", "#5b8def"];

function participantCursorColor(clientId: string): string {
  const hash = [...clientId].reduce((value, character) => value + character.charCodeAt(0), 0);
  return PARTICIPANT_CURSOR_COLORS[hash % PARTICIPANT_CURSOR_COLORS.length] ?? "#9d6bdb";
}
