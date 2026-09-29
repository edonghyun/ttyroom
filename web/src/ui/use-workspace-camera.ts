import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type { WindowRect } from "../windows/window-geometry.js";
import type { WorkspaceCameraControlsProps } from "./chrome/WorkspaceCameraControls.js";
import {
  DEFAULT_CAMERA,
  WORKSPACE_SIZE,
  constrainCamera,
  fitCamera,
  panCamera,
  stepCameraZoom,
  zoomCameraAt,
  type WorkspaceCamera,
} from "./workspace-camera.js";

interface PanStart {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly camera: WorkspaceCamera;
}

export function useWorkspaceCamera({
  overview,
  terminalRects,
}: {
  readonly overview: boolean;
  readonly terminalRects: readonly WindowRect[];
}) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const panStart = useRef<PanStart | null>(null);
  const spacePressed = useRef(false);
  const [camera, setCamera] = useState<WorkspaceCamera>(DEFAULT_CAMERA);
  const [tool, setTool] = useState<WorkspaceCameraControlsProps["tool"]>("select");
  const [panning, setPanning] = useState(false);

  useEffect(() => {
    const editableTarget = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest(".terminal-renderer, input, textarea, select, [contenteditable]"));
    const keyDown = (event: KeyboardEvent) => {
      if (
        overview ||
        editableTarget(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (event.code === "Space") {
        event.preventDefault();
        spacePressed.current = true;
      } else if (event.key.toLowerCase() === "h") {
        event.preventDefault();
        setTool("pan");
      } else if (event.key.toLowerCase() === "v") {
        event.preventDefault();
        setTool("select");
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spacePressed.current = false;
    };
    const blur = () => {
      spacePressed.current = false;
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  }, [overview]);

  const sceneCenter = () => {
    const bounds = sceneRef.current?.getBoundingClientRect();
    return { x: (bounds?.width ?? 0) / 2, y: (bounds?.height ?? 0) / 2 };
  };
  const sceneViewport = () => {
    const bounds = sceneRef.current?.getBoundingClientRect();
    return { width: bounds?.width ?? 0, height: bounds?.height ?? 0 };
  };
  const constrainToWorkspace = (next: WorkspaceCamera) =>
    constrainCamera(next, sceneViewport(), WORKSPACE_SIZE);
  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest(".canvas-controls")) return;
    const wantsPan =
      event.button === 1 || (event.button === 0 && (tool === "pan" || spacePressed.current));
    if (!wantsPan || overview) return;
    event.preventDefault();
    event.stopPropagation();
    panStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      camera,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPanning(true);
  };
  const continuePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = panStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setCamera(
      constrainToWorkspace(
        panCamera(start.camera, { x: event.clientX - start.x, y: event.clientY - start.y }),
      ),
    );
  };
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panStart.current?.pointerId !== event.pointerId) return;
    panStart.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setPanning(false);
  };
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (overview) return;
    const target = event.target;
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      target instanceof Element &&
      target.closest(".terminal-renderer")
    )
      return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const focalPoint = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      setCamera((current) =>
        constrainToWorkspace(
          zoomCameraAt(current, current.scale * Math.exp(-event.deltaY * 0.004), focalPoint),
        ),
      );
    } else {
      setCamera((current) =>
        constrainToWorkspace(panCamera(current, { x: -event.deltaX, y: -event.deltaY })),
      );
    }
  };

  const controls: WorkspaceCameraControlsProps = {
    tool,
    scale: camera.scale,
    selectTool: () => setTool("select"),
    panTool: () => setTool("pan"),
    zoomOut: () =>
      setCamera((current) => constrainToWorkspace(stepCameraZoom(current, -1, sceneCenter()))),
    resetZoom: () => setCamera(DEFAULT_CAMERA),
    zoomIn: () =>
      setCamera((current) => constrainToWorkspace(stepCameraZoom(current, 1, sceneCenter()))),
    fit: () => {
      const bounds = sceneRef.current?.getBoundingClientRect();
      if (!bounds) return;
      setCamera(
        constrainCamera(
          fitCamera(terminalRects, { width: bounds.width, height: bounds.height }),
          { width: bounds.width, height: bounds.height },
          WORKSPACE_SIZE,
        ),
      );
    },
  };
  const surfaceStyle: CSSProperties = {
    width: WORKSPACE_SIZE.width,
    height: WORKSPACE_SIZE.height,
    backgroundSize: `${Math.max(12, 15 * camera.scale) / camera.scale}px ${Math.max(12, 15 * camera.scale) / camera.scale}px`,
  };

  return {
    camera,
    workspace: WORKSPACE_SIZE,
    surfaceStyle,
    controls,
    viewportBindings: {
      ref: sceneRef,
      "data-tool": tool,
      "data-panning": panning || undefined,
      onPointerDownCapture: beginPan,
      onPointerMove: continuePan,
      onPointerUp: endPan,
      onPointerCancel: endPan,
      onWheel: handleWheel,
    },
  };
}
