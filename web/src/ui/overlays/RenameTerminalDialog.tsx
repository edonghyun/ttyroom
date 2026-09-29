import { Edit3 } from "react-feather";
import { useEffect, useRef, useState } from "react";

export function RenameTerminalDialog({
  open,
  terminalName,
  confirm,
  cancel,
}: {
  readonly open: boolean;
  readonly terminalName: string;
  readonly confirm: (title: string) => void;
  readonly cancel: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(terminalName);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTitle(terminalName);
    input.current?.focus();
    input.current?.select();
    return () => opener?.focus();
  }, [open, terminalName]);

  useEffect(() => {
    const root = dialog.current;
    if (!open || !root) return;
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const controls = [
        ...root!.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled])"),
      ];
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
  const normalizedTitle = title.trim();
  const unchanged = normalizedTitle === terminalName;

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialog}
        className="close-dialog rename-terminal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-terminal-title"
        aria-describedby="rename-terminal-description"
      >
        <Edit3 size={22} strokeWidth={1.5} aria-hidden="true" />
        <h2 id="rename-terminal-title">Rename terminal</h2>
        <p id="rename-terminal-description">Everyone in this room will see the new name.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!normalizedTitle || unchanged) return;
            confirm(normalizedTitle);
          }}
        >
          <label htmlFor="terminal-name">Terminal name</label>
          <input
            ref={input}
            id="terminal-name"
            value={title}
            maxLength={80}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          <div className="dialog-actions">
            <button type="button" onClick={cancel}>
              Cancel
            </button>
            <button type="submit" disabled={!normalizedTitle || unchanged}>
              Save name
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
