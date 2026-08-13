import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lock, Maximize2, Minimize2, MoreHorizontal, RotateCcw, Users, X } from "react-feather";

import {
  clampRect,
  snapRect,
  type SnapZone,
  type Viewport,
  type WindowRect,
} from "../../windows/window-geometry.js";
import { TerminalStatus, type TerminalStatusValue } from "./TerminalStatus.js";

const SNAP_EDGE_PX = 32;
const IDENTITY_VIEW_TRANSFORM: WorkspaceViewTransform = { x: 0, y: 0, scale: 1 };

export interface WorkspaceViewTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

interface DragState {
  readonly x: number;
  readonly y: number;
  readonly rect: WindowRect;
  readonly workspace: Viewport & { readonly left: number; readonly top: number };
  readonly viewTransform: WorkspaceViewTransform;
}

interface InteractionPreviewState {
  readonly kind: "move" | "resize";
  readonly zone: SnapZone | null;
  readonly rect: WindowRect;
  readonly left: number;
  readonly top: number;
  readonly viewTransform: WorkspaceViewTransform;
}

export interface TerminalWindowModel {
  readonly terminalId: number;
  readonly title: string;
  readonly host: string;
  readonly cwd?: string;
  readonly branch?: string;
  readonly status: TerminalStatusValue;
  readonly mode: "exclusive" | "shared";
  readonly focusedParticipants: readonly { readonly clientId: string; readonly name: string }[];
  readonly controlAction?: "take" | "switch";
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
  readonly setMode: (terminalId: number, mode: "exclusive" | "shared") => void;
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
  viewTransform = IDENTITY_VIEW_TRANSFORM,
}: {
  readonly model: TerminalWindowModel;
  readonly controller: TerminalControllerPort;
  readonly actions: TerminalWindowActions;
  readonly active: boolean;
  readonly overview?: boolean;
  readonly inputBlocked?: boolean;
  readonly viewTransform?: WorkspaceViewTransform;
}) {
  const terminalRoot = useRef<HTMLDivElement>(null);
  const dragStart = useRef<DragState | null>(null);
  const resizeStart = useRef<DragState | null>(null);
  const interactionTarget = useRef<InteractionPreviewState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [interactionPreview, setInteractionPreview] = useState<InteractionPreviewState | null>(
    null,
  );
  const inputAllowed = model.status.kind === "mine" || model.status.kind === "shared";

  useEffect(() => {
    if (terminalRoot.current) controller.mount(terminalRoot.current);
  }, [controller]);

  useEffect(() => {
    controller.setInputAllowed(inputAllowed && !overview && !model.minimized && !inputBlocked);
    controller.setVisible(overview || !model.minimized);
  }, [controller, inputAllowed, inputBlocked, model.minimized, overview]);

  useEffect(() => {
    if (!interactionPreview) return;
    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor =
      interactionPreview.kind === "move" ? "grabbing" : "nwse-resize";
    return () => {
      document.documentElement.style.cursor = previousCursor;
    };
  }, [interactionPreview?.kind]);

  useEffect(() => {
    const preview = (next: InteractionPreviewState | null) => {
      interactionTarget.current = next;
      setInteractionPreview(next);
    };

    function pointerMove(event: PointerEvent) {
      const start = dragStart.current;
      if (start) {
        const viewport = { width: start.workspace.width, height: start.workspace.height };
        const zone = snapZoneAt(
          {
            x:
              (event.clientX - start.workspace.left - start.viewTransform.x) /
              start.viewTransform.scale,
            y:
              (event.clientY - start.workspace.top - start.viewTransform.y) /
              start.viewTransform.scale,
          },
          viewport,
        );
        preview({
          kind: "move",
          zone,
          rect: zone
            ? snapRect(zone, viewport)
            : clampRect(
                {
                  ...start.rect,
                  x: start.rect.x + (event.clientX - start.x) / start.viewTransform.scale,
                  y: start.rect.y + (event.clientY - start.y) / start.viewTransform.scale,
                },
                viewport,
              ),
          left: start.workspace.left,
          top: start.workspace.top,
          viewTransform: start.viewTransform,
        });
        return;
      }

      const resizing = resizeStart.current;
      if (!resizing) return;
      const viewport = { width: resizing.workspace.width, height: resizing.workspace.height };
      preview({
        kind: "resize",
        zone: null,
        rect: clampRect(
          {
            ...resizing.rect,
            width:
              resizing.rect.width + (event.clientX - resizing.x) / resizing.viewTransform.scale,
            height:
              resizing.rect.height + (event.clientY - resizing.y) / resizing.viewTransform.scale,
          },
          viewport,
        ),
        left: resizing.workspace.left,
        top: resizing.workspace.top,
        viewTransform: resizing.viewTransform,
      });
    }

    function pointerUp() {
      if (dragStart.current) {
        const target = interactionTarget.current;
        if (target?.zone) {
          actions.move(model.terminalId, { x: target.rect.x, y: target.rect.y });
          actions.resize(model.terminalId, {
            width: target.rect.width,
            height: target.rect.height,
          });
        } else if (target) {
          const start = dragStart.current;
          if (target.rect.x !== start.rect.x || target.rect.y !== start.rect.y) {
            actions.move(model.terminalId, {
              x: target.rect.x,
              y: target.rect.y,
            });
          }
        }
        dragStart.current = null;
        preview(null);
      }
      if (resizeStart.current) {
        const target = interactionTarget.current;
        if (target) {
          const start = resizeStart.current;
          if (target.rect.width !== start.rect.width || target.rect.height !== start.rect.height) {
            actions.resize(model.terminalId, {
              width: target.rect.width,
              height: target.rect.height,
            });
          }
        }
        resizeStart.current = null;
        preview(null);
      }
    }

    function pointerCancel() {
      dragStart.current = null;
      resizeStart.current = null;
      preview(null);
    }
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
    };
  }, [actions, model]);

  return (
    <>
      <article
        className={`terminal-window${active ? " active-window" : ""}${overview ? " overview-window" : ""}`}
        role="group"
        tabIndex={0}
        aria-label={`${model.title} terminal`}
        aria-current={active ? "true" : undefined}
        data-terminal-id={model.terminalId}
        data-overview={overview || undefined}
        data-interacting={interactionPreview?.kind}
        hidden={model.minimized && !overview}
        style={{
          left: model.rect.x,
          top: model.rect.y,
          width: model.rect.width,
          height: model.rect.height,
          zIndex: model.z,
        }}
        onPointerDown={() => actions.activate(model.terminalId)}
        onFocus={(event) => {
          if (event.target === event.currentTarget) actions.activate(model.terminalId);
        }}
        onKeyDown={(event) => {
          if (
            overview &&
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            actions.activate(model.terminalId);
          }
        }}
      >
        <header
          className="terminal-titlebar"
          onPointerDown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("button, [role='menu'], .terminal-focus-presence")
            ) {
              return;
            }
            const scene = event.currentTarget.closest(".terminal-scene");
            const bounds = scene?.getBoundingClientRect();
            const start = {
              x: event.clientX,
              y: event.clientY,
              rect: model.rect,
              workspace: bounds
                ? {
                    left: bounds.left,
                    top: bounds.top,
                    width: bounds.width,
                    height: bounds.height,
                  }
                : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
              viewTransform,
            };
            dragStart.current = start;
            const next = {
              kind: "move" as const,
              zone: null,
              rect: model.rect,
              left: start.workspace.left,
              top: start.workspace.top,
              viewTransform: start.viewTransform,
            };
            interactionTarget.current = next;
            setInteractionPreview(next);
          }}
        >
          <div className="terminal-heading">
            <strong>{model.title}</strong>
            <span>{[model.host, model.cwd, model.branch].filter(Boolean).join(" · ")}</span>
          </div>
          <span
            className={`terminal-mode terminal-mode-${model.mode}`}
            role="img"
            aria-label={`${model.mode === "exclusive" ? "Exclusive" : "Shared"} input mode`}
          >
            {model.mode === "exclusive" ? (
              <Lock size={12} strokeWidth={1.7} aria-hidden="true" />
            ) : (
              <Users size={12} strokeWidth={1.7} aria-hidden="true" />
            )}
            <span>{model.mode === "exclusive" ? "Exclusive" : "Shared"}</span>
          </span>
          <TerminalStatus status={model.status} />
          {model.focusedParticipants.length > 0 && (
            <span
              className="terminal-focus-presence"
              role="group"
              tabIndex={0}
              aria-label={`Focused by ${model.focusedParticipants.map(({ name }) => name).join(", ")}`}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Users size={13} strokeWidth={1.7} aria-hidden="true" />
              <span aria-hidden="true">{model.focusedParticipants.length}</span>
              <span className="terminal-focus-tooltip" role="tooltip">
                {model.focusedParticipants.map(({ name }) => name).join(", ")}
              </span>
            </span>
          )}
          {model.status.kind === "available" && (
            <button
              type="button"
              className="take-control"
              aria-label={`${model.controlAction === "switch" ? "Switch control to" : "Take control of"} ${model.title}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => actions.takeControl(model.terminalId)}
            >
              {model.controlAction === "switch" ? "Switch" : "Take control"}
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
              aria-label={`Open ${model.title} menu`}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={15} strokeWidth={1.5} aria-hidden="true" />
            </button>
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
          {menuOpen && (
            <div className="terminal-menu" role="menu" aria-label={`${model.title} actions`}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  actions.setMode(
                    model.terminalId,
                    model.mode === "exclusive" ? "shared" : "exclusive",
                  );
                  setMenuOpen(false);
                }}
              >
                Use {model.mode === "exclusive" ? "shared" : "exclusive"} input
              </button>
            </div>
          )}
        </header>
        <div
          className="terminal-renderer"
          ref={terminalRoot}
          aria-label={`${model.title} output`}
        />
        <button
          className="resize-handle"
          type="button"
          aria-label={`Resize ${model.title}`}
          onPointerDown={(event) => {
            event.stopPropagation();
            const scene = event.currentTarget.closest(".terminal-scene");
            const bounds = scene?.getBoundingClientRect();
            const start = {
              x: event.clientX,
              y: event.clientY,
              rect: model.rect,
              workspace: bounds
                ? {
                    left: bounds.left,
                    top: bounds.top,
                    width: bounds.width,
                    height: bounds.height,
                  }
                : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
              viewTransform,
            };
            resizeStart.current = start;
            const next = {
              kind: "resize" as const,
              zone: null,
              rect: model.rect,
              left: start.workspace.left,
              top: start.workspace.top,
              viewTransform: start.viewTransform,
            };
            interactionTarget.current = next;
            setInteractionPreview(next);
          }}
        />
      </article>
      {interactionPreview &&
        createPortal(
          <div
            className={`window-interaction-ghost window-interaction-${interactionPreview.kind}${interactionPreview.zone ? " snap-preview" : ""}`}
            role={interactionPreview.zone ? "status" : undefined}
            aria-label={
              interactionPreview.zone ? `Snap preview: ${interactionPreview.zone}` : undefined
            }
            aria-hidden={interactionPreview.zone ? undefined : true}
            style={{
              left:
                interactionPreview.left +
                interactionPreview.viewTransform.x +
                interactionPreview.rect.x * interactionPreview.viewTransform.scale,
              top:
                interactionPreview.top +
                interactionPreview.viewTransform.y +
                interactionPreview.rect.y * interactionPreview.viewTransform.scale,
              width: interactionPreview.rect.width * interactionPreview.viewTransform.scale,
              height: interactionPreview.rect.height * interactionPreview.viewTransform.scale,
            }}
          >
            <div className="window-interaction-ghost-title">
              <strong>{model.title}</strong>
              <span>
                {interactionPreview.kind === "move" ? "Moving" : "Resizing"} ·{" "}
                {Math.round(interactionPreview.rect.width)} ×{" "}
                {Math.round(interactionPreview.rect.height)}
              </span>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function snapZoneAt(position: Pick<WindowRect, "x" | "y">, viewport: Viewport): SnapZone | null {
  const side =
    position.x <= SNAP_EDGE_PX
      ? "left"
      : position.x >= viewport.width - SNAP_EDGE_PX
        ? "right"
        : null;
  if (!side) return null;
  if (position.y <= viewport.height / 3) return `top-${side}`;
  if (position.y >= (viewport.height * 2) / 3) return `bottom-${side}`;
  return side;
}
