import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, CheckCircle, Copy, Terminal, X, XCircle } from "react-feather";

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
  const drawer = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (open) setCopied(false);
  }, [command, open]);
  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      opener?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    closeButton.current?.focus();
    return () => previouslyFocused?.focus();
  }, [open, opener]);

  useEffect(() => {
    const root = drawer.current;
    if (!open || !root) return;
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const controls = [...root!.querySelectorAll<HTMLElement>("button:not([disabled])")];
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    root.addEventListener("keydown", trapFocus);
    return () => root.removeEventListener("keydown", trapFocus);
  }, [open]);
  if (!open) return null;

  return (
    <aside className="drawer-backdrop">
      <section
        ref={drawer}
        className="add-host-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-host-title"
      >
        <header>
          <div>
            <span className="drawer-kicker">Connect a machine</span>
            <h2 id="add-host-title">
              <Terminal size={18} strokeWidth={1.5} aria-hidden="true" /> Add Host
            </h2>
          </div>
          <button ref={closeButton} type="button" aria-label="Close Add Host" onClick={close}>
            <X size={17} strokeWidth={1.5} />
          </button>
        </header>
        <p className="drawer-intro">
          Share a local shell with this room. The Host Agent stays on your machine.
        </p>
        <div className="drawer-step">
          <span className="drawer-step-number" aria-hidden="true">
            1
          </span>
          <div className="drawer-step-content">
            <h3>Run the host command</h3>
            <p>Paste this into the terminal on the machine you want to share.</p>
            <div className="host-command">
              <pre aria-label="Host connection command">
                <code>{command}</code>
              </pre>
              <button
                type="button"
                className={copied ? "is-copied" : undefined}
                onClick={() => {
                  copy(command);
                  setCopied(true);
                }}
              >
                {copied ? (
                  <Check size={16} strokeWidth={1.8} aria-hidden="true" />
                ) : (
                  <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy command"}
              </button>
            </div>
          </div>
        </div>
        <div className="drawer-step">
          <span className="drawer-step-number" aria-hidden="true">
            2
          </span>
          <div className="drawer-step-content">
            <h3>Wait for connection</h3>
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
          </div>
        </div>
      </section>
    </aside>
  );
}
