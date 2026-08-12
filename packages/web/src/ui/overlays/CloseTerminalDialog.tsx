import { AlertTriangle } from "react-feather";

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
  if (!open) return null;
  return (
    <div className="dialog-backdrop">
      <section
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
          <button type="button" onClick={cancel}>
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
