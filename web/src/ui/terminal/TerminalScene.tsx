import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, Terminal } from "react-feather";
import { CursorReporter } from "../../collaboration/cursor-reporter.js";
import type { ParticipantCursorMotionSource } from "../../collaboration/participant-cursor-motion.js";
import { Dock } from "../chrome/Dock.js";
import { Overview } from "../chrome/Overview.js";
import { WorkspaceCameraControls } from "../chrome/WorkspaceCameraControls.js";
import { useWorkspaceCamera } from "../use-workspace-camera.js";
import { DEFAULT_CAMERA } from "../workspace-camera.js";
import { viewportPointToWorkspace } from "../workspace-camera.js";
import { terminalStatusLabel } from "./TerminalStatus.js";
import { ParticipantCursorLayer } from "./ParticipantCursorLayer.js";
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
  cursorMotion,
  hosts,
  activeTerminalId,
  actions,
  overview,
  inputBlocked = false,
}: {
  readonly terminals: readonly TerminalWindowModel[];
  readonly controllers: ReadonlyMap<number, TerminalControllerPort>;
  readonly participants: readonly string[];
  readonly cursorMotion: ParticipantCursorMotionSource;
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
  const moveCursor = useRef(actions.moveCursor);
  const cursorReporter = useRef<CursorReporter | null>(null);
  moveCursor.current = actions.moveCursor;
  useEffect(() => {
    const reporter = new CursorReporter((position) => moveCursor.current(position));
    cursorReporter.current = reporter;
    return () => {
      reporter.dispose();
      if (cursorReporter.current === reporter) cursorReporter.current = null;
    };
  }, []);
  useEffect(() => {
    if (overview) cursorReporter.current?.move(null);
  }, [overview]);
  const canvas = useWorkspaceCamera({
    overview,
    terminalRects: terminals
      .filter((terminal) => !terminal.minimized)
      .map((terminal) => terminal.rect),
  });
  const reportCursor = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (overview) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    cursorReporter.current?.move(
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
        onPointerLeave={() => cursorReporter.current?.move(null)}
      >
        <div
          className="terminal-camera"
          style={{
            width: canvas.workspace.width,
            height: canvas.workspace.height,
            transform: `translate(${canvas.camera.x}px, ${canvas.camera.y}px) scale(${canvas.camera.scale})`,
          }}
        >
          <div className="workspace-surface" style={canvas.surfaceStyle} aria-hidden="true" />
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
                workspaceSize={canvas.workspace}
              />
            );
          })}
        </div>
        <ParticipantCursorLayer motion={cursorMotion} camera={canvas.camera} hidden={overview} />
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
                  ? "Run TTYRoom Connector to connect your computer, then open terminals here for everyone to see."
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
