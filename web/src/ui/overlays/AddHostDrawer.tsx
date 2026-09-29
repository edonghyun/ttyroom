import { useEffect, useRef, useState, type RefObject } from "react";
import type { HostRegistration } from "../../app/room-api.js";
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
  register,
  close,
  opener,
}: {
  readonly open: boolean;
  readonly command: string;
  readonly state: AddHostState;
  readonly register?: () => Promise<HostRegistration | { kind: "unavailable" }>;
  readonly copy: (command: string) => Promise<void> | void;
  readonly close: () => void;
  readonly opener?: RefObject<HTMLElement | null>;
}) {
  const drawer = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [credentialCopied, setCredentialCopied] = useState(false);
  async function copyValue(text: string, kind: "command" | "credential") {
    setCopyError(null);
    try {
      await copy(text);
      if (kind === "command") setCopied(true);
      else setCredentialCopied(true);
    } catch {
      setCopyError("Copy failed. Allow clipboard access and try again.");
    }
  }
  const [credential, setCredential] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  async function issueCredential() {
    if (!register || issuing) return;
    setIssuing(true);
    setRegistrationError(null);
    try {
      const result = await register();
      if (result.kind === "registered") {
        setCredential(result.credential);
        setCredentialCopied(false);
      } else
        setRegistrationError(
          result.kind === "unavailable"
            ? "Only the room creator can register a host. Open the tab that created this room."
            : "Could not register host. Try again.",
        );
    } catch {
      setRegistrationError("Could not register host. Try again.");
    } finally {
      setIssuing(false);
    }
  }
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (open) {
      setCopied(false);
      setCopyError(null);
    }
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
          TTYRoom Connector connects your computer's terminal to this room.
        </p>
        {register && (
          <div className="drawer-step">
            <div className="drawer-step-content">
              <h3>Host credential</h3>
              <p>
                Generate a credential, run the command below from your checkout, then paste the
                credential at the hidden prompt. Use one credential per Connector process.
              </p>
              <button type="button" disabled={issuing} onClick={() => void issueCredential()}>
                {issuing
                  ? "Registering…"
                  : credential
                    ? "Generate another host credential"
                    : "Generate host credential"}
              </button>
              {credential && (
                <button type="button" onClick={() => void copyValue(credential, "credential")}>
                  {credentialCopied ? "Credential copied" : "Copy host credential"}
                </button>
              )}
              {credential && (
                <p role="status">Host credential ready. Paste it only at the Connector prompt.</p>
              )}
              {registrationError && <p role="alert">{registrationError}</p>}
            </div>
          </div>
        )}
        {copyError && <p role="alert">{copyError}</p>}
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
                onClick={() => void copyValue(command, "command")}
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
                  <span className="activity-pulse" aria-hidden="true" /> Waiting for Connector…
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
            <p className="overlay-note">Ctrl+C stops Connector and its local shells.</p>
          </div>
        </div>
      </section>
    </aside>
  );
}
