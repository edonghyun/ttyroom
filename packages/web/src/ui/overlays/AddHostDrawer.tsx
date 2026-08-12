import { useEffect, useRef, type RefObject } from "react";
import { CheckCircle, Copy, Terminal, X, XCircle } from "react-feather";

export type AddHostState =
  | { readonly kind: "waiting" }
  | { readonly kind: "connected"; readonly hostName: string }
  | { readonly kind: "failed"; readonly message: string };

export function AddHostDrawer({
  open,
  command,
  state,
  copy,
  close,
  opener,
}: {
  readonly open: boolean;
  readonly command: string;
  readonly state: AddHostState;
  readonly copy: (command: string) => void;
  readonly close: () => void;
  readonly opener?: RefObject<HTMLElement | null>;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeButton.current?.focus();
    else opener?.current?.focus();
  }, [open, opener]);
  if (!open) return null;

  return (
    <aside className="drawer-backdrop">
      <section
        className="add-host-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-host-title"
      >
        <header>
          <h2 id="add-host-title">
            <Terminal size={18} strokeWidth={1.5} aria-hidden="true" /> Add Host
          </h2>
          <button ref={closeButton} type="button" aria-label="Close Add Host" onClick={close}>
            <X size={17} strokeWidth={1.5} />
          </button>
        </header>
        <p>Run this command on the machine you want to share.</p>
        <pre>
          <code>{command}</code>
        </pre>
        <button type="button" onClick={() => copy(command)}>
          <Copy size={16} strokeWidth={1.5} /> Copy command
        </button>
        <div className={`drawer-state state-${state.kind}`} role="status">
          {state.kind === "waiting" ? (
            <>
              <span className="activity-pulse" aria-hidden="true" /> Waiting for Agent…
            </>
          ) : state.kind === "connected" ? (
            <>
              <CheckCircle size={16} strokeWidth={1.5} /> {state.hostName} connected
            </>
          ) : (
            <>
              <XCircle size={16} strokeWidth={1.5} /> {state.message}
            </>
          )}
        </div>
        <p className="overlay-note">Ctrl+C stops the Host Agent and its PTYs.</p>
      </section>
    </aside>
  );
}
