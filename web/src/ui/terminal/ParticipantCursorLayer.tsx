import { useSyncExternalStore, type CSSProperties } from "react";
import { MousePointer } from "react-feather";

import type { ParticipantCursorMotionSource } from "../../collaboration/participant-cursor-motion.js";
import type { WorkspaceCamera } from "../workspace-camera.js";

export function ParticipantCursorLayer({
  motion,
  camera,
  hidden,
}: {
  readonly motion: ParticipantCursorMotionSource;
  readonly camera: WorkspaceCamera;
  readonly hidden: boolean;
}) {
  const cursors = useSyncExternalStore(motion.subscribe, motion.snapshot, motion.snapshot);
  if (hidden) return null;

  return cursors.map((cursor) => {
    const color = participantCursorColor(cursor.clientId);
    return (
      <div
        key={cursor.clientId}
        className="participant-cursor"
        aria-label={`${cursor.name} cursor`}
        style={
          {
            transform: `translate(${camera.x + cursor.position.x * camera.scale}px, ${camera.y + cursor.position.y * camera.scale}px)`,
            "--participant-cursor-color": color,
          } as CSSProperties
        }
      >
        <MousePointer size={20} strokeWidth={2.2} aria-hidden="true" />
        <span>{cursor.name}</span>
      </div>
    );
  });
}

const PARTICIPANT_CURSOR_COLORS = ["#9d6bdb", "#3fb8af", "#e28b4b", "#e06387", "#5b8def"];

function participantCursorColor(clientId: string): string {
  const hash = [...clientId].reduce((value, character) => value + character.charCodeAt(0), 0);
  return PARTICIPANT_CURSOR_COLORS[hash % PARTICIPANT_CURSOR_COLORS.length] ?? "#9d6bdb";
}
