import type { ReactNode } from "react";

import { TopBar, type ConnectionLabel } from "../chrome/TopBar.js";

export interface TerminalSummary {
  readonly terminalId: number;
  readonly title: string;
  readonly host: string;
  readonly cwd?: string;
  readonly branch?: string;
  readonly statusLabel: string;
}

export interface RoomCommands {
  readonly invite: () => void;
  readonly arrange: () => void;
  readonly overview: () => void;
  readonly openMenu: () => void;
  readonly addHost?: () => void;
}

export function RoomWorkspace({
  roomName,
  connection,
  commands,
  terminals,
  children,
}: {
  readonly roomName: string;
  readonly connection: ConnectionLabel;
  readonly commands: RoomCommands;
  readonly terminals: readonly TerminalSummary[];
  readonly children?: ReactNode;
}) {
  return (
    <main className="workspace-shell">
      <TopBar roomName={roomName} connection={connection} {...commands} />
      <section className="terminal-workspace" aria-label="Terminal workspace">
        {children ??
          terminals.map((terminal) => (
            <article
              key={terminal.terminalId}
              className="terminal-summary"
              role="group"
              aria-label={`${terminal.title} terminal`}
            >
              <h2>{terminal.title}</h2>
              <p>{[terminal.host, terminal.cwd, terminal.branch].filter(Boolean).join(" · ")}</p>
              <span>{terminal.statusLabel}</span>
            </article>
          ))}
      </section>
    </main>
  );
}
