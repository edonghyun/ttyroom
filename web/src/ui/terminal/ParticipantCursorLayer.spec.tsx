import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  ParticipantCursorFrame,
  ParticipantCursorMotionSource,
} from "../../collaboration/participant-cursor-motion.js";
import { ParticipantCursorLayer } from "./ParticipantCursorLayer.js";

describe("ParticipantCursorLayer", () => {
  it("subscribes independently and projects workspace positions through the camera", () => {
    const motion = new MutableCursorMotion();
    render(
      <ParticipantCursorLayer
        motion={motion}
        camera={{ x: 10, y: 20, scale: 0.5 }}
        hidden={false}
      />,
    );

    act(() => {
      motion.emit([{ clientId: "bob", name: "Bob", position: { x: 100, y: 40 } }]);
    });

    expect(screen.getByLabelText("Bob cursor")).toHaveStyle({
      transform: "translate(60px, 40px)",
    });
  });
});

class MutableCursorMotion implements ParticipantCursorMotionSource {
  private cursors: readonly ParticipantCursorFrame[] = [];
  private readonly subscribers = new Set<() => void>();

  readonly subscribe = (subscriber: () => void): (() => void) => {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  };

  readonly snapshot = (): readonly ParticipantCursorFrame[] => this.cursors;

  emit(cursors: readonly ParticipantCursorFrame[]): void {
    this.cursors = cursors;
    for (const subscriber of this.subscribers) subscriber();
  }
}
