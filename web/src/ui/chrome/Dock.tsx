import { useRef, useState } from "react";
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
  addHost,
}: {
  readonly terminals: readonly DockTerminal[];
  readonly participants: readonly string[];
  readonly activeTerminalId: number | null;
  readonly restore: (terminalId: number) => void;
  readonly hosts: readonly DockHost[];
  readonly addTerminal: (hostId: string) => void;
  readonly addHost: (opener?: HTMLElement) => void;
}) {
  const [hostMenuOpen, setHostMenuOpen] = useState(false);
  const terminalButtons = useRef(new Map<number, HTMLButtonElement>());
  const addTerminalButton = useRef<HTMLButtonElement>(null);

  function requestTerminal(): void {
    if (hosts.length === 0) {
      addHost(addTerminalButton.current ?? undefined);
      return;
    }
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
          ref={addTerminalButton}
          type="button"
          className="add-terminal"
          aria-expanded={hostMenuOpen}
          onClick={requestTerminal}
          onKeyDown={(event) => {
            if (event.key !== "Tab" || !event.shiftKey || terminals.length === 0) return;
            event.preventDefault();
            terminalButtons.current.get(terminals.at(-1)!.terminalId)?.focus();
          }}
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
            ref={(button) => {
              if (button) terminalButtons.current.set(terminal.terminalId, button);
              else terminalButtons.current.delete(terminal.terminalId);
            }}
            type="button"
            key={terminal.terminalId}
            className={activeTerminalId === terminal.terminalId ? "dock-active" : undefined}
            aria-label={`${terminal.minimized ? "Restore" : "Focus"} ${terminal.title}`}
            onClick={() => restore(terminal.terminalId)}
            onKeyDown={(event) => {
              if (
                event.key === "Tab" &&
                !event.shiftKey &&
                terminal.terminalId === terminals.at(-1)?.terminalId
              ) {
                event.preventDefault();
                addTerminalButton.current?.focus();
              }
            }}
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
