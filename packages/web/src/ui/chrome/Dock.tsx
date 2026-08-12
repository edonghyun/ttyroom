import { useState } from "react";
import { Plus, Terminal } from "react-feather";

export interface DockTerminal {
  readonly terminalId: number;
  readonly title: string;
  readonly status: string;
  readonly activity: string;
  readonly minimized: boolean;
}

export interface DockHost {
  readonly hostId: string;
  readonly name: string;
}

export function Dock({
  terminals,
  participants,
  activeTerminalId,
  restore,
  hosts,
  addTerminal,
}: {
  readonly terminals: readonly DockTerminal[];
  readonly participants: readonly string[];
  readonly activeTerminalId: number | null;
  readonly restore: (terminalId: number) => void;
  readonly hosts: readonly DockHost[];
  readonly addTerminal: (hostId: string) => void;
}) {
  const [hostMenuOpen, setHostMenuOpen] = useState(false);

  function requestTerminal(): void {
    if (hosts.length === 1) {
      addTerminal(hosts[0]!.hostId);
      return;
    }
    setHostMenuOpen(true);
  }

  return (
    <aside className="dock" aria-label="Terminal Dock">
      <div className="dock-terminals">
        <button
          type="button"
          className="add-terminal"
          aria-expanded={hostMenuOpen}
          onClick={requestTerminal}
        >
          <Plus size={16} strokeWidth={1.5} aria-hidden="true" /> Add terminal
        </button>
        {hostMenuOpen && (
          <div className="host-menu" role="menu" aria-label="Choose host">
            {hosts.map((host) => (
              <button
                key={host.hostId}
                type="button"
                role="menuitem"
                onClick={() => {
                  addTerminal(host.hostId);
                  setHostMenuOpen(false);
                }}
              >
                {host.name}
              </button>
            ))}
          </div>
        )}
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
      </div>
      <ul className="participant-presence" aria-label="Participant presence">
        {participants.map((presence) => (
          <li key={presence}>{presence}</li>
        ))}
      </ul>
    </aside>
  );
}
