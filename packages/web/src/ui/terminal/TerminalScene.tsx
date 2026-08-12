import type { TerminalController } from "../../terminal/terminal-controller.js";
import { Dock } from "../chrome/Dock.js";
import { Overview } from "../chrome/Overview.js";
import { terminalStatusLabel } from "./TerminalStatus.js";
import {
  TerminalWindow,
  type TerminalWindowActions,
  type TerminalWindowModel,
} from "./TerminalWindow.js";

export function TerminalScene({
  terminals,
  controllers,
  participants,
  activeTerminalId,
  actions,
  overview,
}: {
  readonly terminals: readonly TerminalWindowModel[];
  readonly controllers: ReadonlyMap<number, TerminalController>;
  readonly participants: readonly string[];
  readonly activeTerminalId: number | null;
  readonly actions: TerminalWindowActions & {
    readonly exitOverview: () => void;
    readonly addTerminal: () => void;
  };
  readonly overview: boolean;
}) {
  return (
    <>
      <div className={`terminal-scene${overview ? " is-overview" : ""}`}>
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
            />
          );
        })}
        <Overview open={overview} exit={actions.exitOverview} />
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
        activeTerminalId={activeTerminalId}
        restore={(terminalId) => {
          actions.restore(terminalId);
          actions.activate(terminalId);
        }}
        addTerminal={actions.addTerminal}
      />
    </>
  );
}
