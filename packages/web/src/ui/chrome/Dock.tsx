import { Plus, Terminal } from "react-feather";

export interface DockTerminal {
  readonly terminalId: number;
  readonly title: string;
  readonly status: string;
  readonly activity: string;
  readonly minimized: boolean;
}

export function Dock({
  terminals,
  participants,
  activeTerminalId,
  restore,
  addTerminal,
}: {
  readonly terminals: readonly DockTerminal[];
  readonly participants: readonly string[];
  readonly activeTerminalId: number | null;
  readonly restore: (terminalId: number) => void;
  readonly addTerminal: () => void;
}) {
  return (
    <aside className="dock" aria-label="Terminal Dock">
      <div className="dock-terminals">
        {terminals.map((terminal) => (
          <button
            type="button"
            key={terminal.terminalId}
            className={activeTerminalId === terminal.terminalId ? "dock-active" : undefined}
            aria-label={`${terminal.minimized ? "Restore" : "Focus"} ${terminal.title}`}
            onClick={() => restore(terminal.terminalId)}
          >
            <Terminal size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>
              <strong>{terminal.title}</strong>
              <small>{terminal.status}</small>
              <small>{terminal.activity}</small>
            </span>
          </button>
        ))}
        <button type="button" className="add-terminal" onClick={addTerminal}>
          <Plus size={16} strokeWidth={1.5} aria-hidden="true" /> Add terminal
        </button>
      </div>
      <ul className="participant-presence" aria-label="Participant presence">
        {participants.map((presence) => (
          <li key={presence}>{presence}</li>
        ))}
      </ul>
    </aside>
  );
}
