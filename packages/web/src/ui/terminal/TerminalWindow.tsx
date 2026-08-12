import { useEffect, useRef } from "react";
import { Maximize2, Minimize2, RotateCcw, X } from "react-feather";

import type { WindowRect } from "../../windows/window-geometry.js";
import { TerminalStatus, type TerminalStatusValue } from "./TerminalStatus.js";

export interface TerminalWindowModel {
  readonly terminalId: number;
  readonly title: string;
  readonly host: string;
  readonly cwd?: string;
  readonly branch?: string;
  readonly status: TerminalStatusValue;
  readonly rect: WindowRect;
  readonly z: number;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly activity?: string;
}

export interface TerminalWindowActions {
  readonly activate: (terminalId: number) => void;
  readonly takeControl: (terminalId: number) => void;
  readonly move: (terminalId: number, position: Pick<WindowRect, "x" | "y">) => void;
  readonly resize: (terminalId: number, size: Pick<WindowRect, "width" | "height">) => void;
  readonly minimize: (terminalId: number) => void;
  readonly maximize: (terminalId: number) => void;
  readonly restore: (terminalId: number) => void;
  readonly requestClose: (terminalId: number) => void;
  readonly openNew?: (host: string) => void;
}

export interface TerminalControllerPort {
  mount(container: HTMLElement): void;
  setInputAllowed(allowed: boolean): void;
  setVisible(visible: boolean): void;
}

export function TerminalWindow({
  model,
  controller,
  actions,
  active,
  overview,
  inputBlocked = false,
}: {
  readonly model: TerminalWindowModel;
  readonly controller: TerminalControllerPort;
  readonly actions: TerminalWindowActions;
  readonly active: boolean;
  readonly overview?: boolean;
  readonly inputBlocked?: boolean;
}) {
  const terminalRoot = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number; rect: WindowRect } | null>(null);
  const resizeStart = useRef<{ x: number; y: number; rect: WindowRect } | null>(null);
  const inputAllowed = model.status.kind === "mine" || model.status.kind === "shared";

  useEffect(() => {
    if (terminalRoot.current) controller.mount(terminalRoot.current);
  }, [controller]);

  useEffect(() => {
    controller.setInputAllowed(inputAllowed && !overview && !model.minimized && !inputBlocked);
    controller.setVisible(!model.minimized);
  }, [controller, inputAllowed, inputBlocked, model.minimized, overview]);

  useEffect(() => {
    function pointerUp(event: PointerEvent) {
      if (dragStart.current) {
        const start = dragStart.current;
        actions.move(model.terminalId, {
          x: start.rect.x + event.clientX - start.x,
          y: start.rect.y + event.clientY - start.y,
        });
        dragStart.current = null;
      }
      if (resizeStart.current) {
        const start = resizeStart.current;
        actions.resize(model.terminalId, {
          width: start.rect.width + event.clientX - start.x,
          height: start.rect.height + event.clientY - start.y,
        });
        resizeStart.current = null;
      }
    }
    window.addEventListener("pointerup", pointerUp);
    return () => window.removeEventListener("pointerup", pointerUp);
  }, [actions, model]);

  return (
    <article
      className={`terminal-window${active ? " active-window" : ""}${overview ? " overview-window" : ""}`}
      role="group"
      aria-label={`${model.title} terminal`}
      aria-current={active ? "true" : undefined}
      data-terminal-id={model.terminalId}
      data-overview={overview || undefined}
      hidden={model.minimized}
      style={{
        left: model.rect.x,
        top: model.rect.y,
        width: model.rect.width,
        height: model.rect.height,
        zIndex: model.z,
      }}
      onPointerDown={() => actions.activate(model.terminalId)}
    >
      <header
        className="terminal-titlebar"
        onPointerDown={(event) => {
          dragStart.current = { x: event.clientX, y: event.clientY, rect: model.rect };
        }}
      >
        <div className="terminal-heading">
          <strong>{model.title}</strong>
          <span>{[model.host, model.cwd, model.branch].filter(Boolean).join(" · ")}</span>
        </div>
        <TerminalStatus status={model.status} />
        {model.status.kind === "available" && (
          <button
            type="button"
            className="take-control"
            aria-label={`Take control of ${model.title}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => actions.takeControl(model.terminalId)}
          >
            Take control
          </button>
        )}
        {model.status.kind === "exited" && actions.openNew && (
          <button
            type="button"
            className="take-control"
            aria-label={`Open a new terminal on ${model.host}`}
            onClick={() => actions.openNew?.(model.host)}
          >
            New terminal
          </button>
        )}
        <div className="window-actions">
          <button
            type="button"
            aria-label={`Minimize ${model.title}`}
            onClick={() => actions.minimize(model.terminalId)}
          >
            <Minimize2 size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`${model.maximized ? "Restore" : "Maximize"} ${model.title}`}
            onClick={() =>
              model.maximized
                ? actions.restore(model.terminalId)
                : actions.maximize(model.terminalId)
            }
          >
            {model.maximized ? (
              <RotateCcw size={15} strokeWidth={1.5} />
            ) : (
              <Maximize2 size={15} strokeWidth={1.5} />
            )}
          </button>
          <button
            type="button"
            aria-label={`Close ${model.title}`}
            onClick={() => actions.requestClose(model.terminalId)}
          >
            <X size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="terminal-renderer" ref={terminalRoot} aria-label={`${model.title} output`} />
      <button
        className="resize-handle"
        type="button"
        aria-label={`Resize ${model.title}`}
        onPointerDown={(event) => {
          event.stopPropagation();
          resizeStart.current = { x: event.clientX, y: event.clientY, rect: model.rect };
        }}
      />
    </article>
  );
}
