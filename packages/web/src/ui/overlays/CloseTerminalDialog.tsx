import { AlertTriangle } from "react-feather";
import { useEffect, useRef } from "react";

export function CloseTerminalDialog({
  open,
  terminalName,
  confirm,
  cancel,
}: {
  readonly open: boolean;
  readonly terminalName: string;
  readonly confirm: () => void;
  readonly cancel: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButton.current?.focus();
    return () => opener?.focus();
  }, [open]);

  useEffect(() => {
    const root = dialog.current;
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
    <div className="dialog-backdrop">
      <section
        ref={dialog}
        className="close-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-title"
        aria-describedby="close-description"
      >
        <AlertTriangle size={22} strokeWidth={1.5} aria-hidden="true" />
        <h2 id="close-title">Close {terminalName}?</h2>
        <p id="close-description">This stops the remote PTY. This action cannot be undone.</p>
        <div className="dialog-actions">
          <button ref={cancelButton} type="button" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="danger-action" onClick={confirm}>
            Close terminal
          </button>
        </div>
      </section>
    </div>
  );
}
