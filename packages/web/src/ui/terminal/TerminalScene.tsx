import { Dock } from "../chrome/Dock.js";
import { Overview } from "../chrome/Overview.js";
import { WorkspaceCameraControls } from "../chrome/WorkspaceCameraControls.js";
import { useWorkspaceCamera } from "../use-workspace-camera.js";
import { DEFAULT_CAMERA } from "../workspace-camera.js";
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
  hosts,
  activeTerminalId,
  actions,
  overview,
  inputBlocked = false,
}: {
  readonly terminals: readonly TerminalWindowModel[];
  readonly controllers: ReadonlyMap<number, TerminalControllerPort>;
  readonly participants: readonly string[];
  readonly hosts: readonly { readonly hostId: string; readonly name: string }[];
  readonly activeTerminalId: number | null;
  readonly actions: TerminalWindowActions & {
    readonly exitOverview: () => void;
    readonly addTerminal: (hostId: string) => void;
    readonly addHost: (opener?: HTMLElement) => void;
  };
  readonly overview: boolean;
  readonly inputBlocked?: boolean;
}) {
  const canvas = useWorkspaceCamera({
    overview,
    terminalRects: terminals
      .filter((terminal) => !terminal.minimized)
      .map((terminal) => terminal.rect),
  });

  return (
    <>
      <div
        className={`terminal-scene${overview ? " is-overview" : ""}`}
        {...canvas.viewportBindings}
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
