import { Maximize, MousePointer, Move, ZoomIn, ZoomOut } from "react-feather";

export type WorkspaceTool = "select" | "pan";

export interface WorkspaceCameraControlsProps {
  readonly tool: WorkspaceTool;
  readonly scale: number;
  readonly selectTool: () => void;
  readonly panTool: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly zoomIn: () => void;
  readonly fit: () => void;
}

export function WorkspaceCameraControls({
  tool,
  scale,
  selectTool,
  panTool,
  zoomOut,
  resetZoom,
  zoomIn,
  fit,
}: WorkspaceCameraControlsProps) {
  return (
    <nav className="canvas-controls" aria-label="Canvas controls">
      <div className="canvas-control-group" role="group" aria-label="Canvas tools">
        <button
          type="button"
          className={tool === "select" ? "is-selected" : undefined}
          aria-label="Select tool"
          aria-pressed={tool === "select"}
          title="Select tool (V)"
          onClick={selectTool}
        >
          <MousePointer size={18} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={tool === "pan" ? "is-selected" : undefined}
          aria-label="Pan tool"
          aria-pressed={tool === "pan"}
          title="Pan tool (H)"
          onClick={panTool}
        >
          <Move size={18} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </div>
      <span className="canvas-control-separator" aria-hidden="true" />
      <div className="canvas-control-group" role="group" aria-label="Canvas zoom controls">
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={zoomOut}>
          <ZoomOut size={18} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="canvas-zoom-value"
          aria-label="Reset zoom to 100%"
          title="Reset zoom"
          onClick={resetZoom}
        >
          <span role="status" aria-label="Canvas zoom" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>
        </button>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={zoomIn}>
          <ZoomIn size={18} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <button type="button" aria-label="Fit terminals" title="Fit terminals" onClick={fit}>
          <Maximize size={17} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
