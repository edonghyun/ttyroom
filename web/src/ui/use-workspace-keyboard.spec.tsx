import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useWorkspaceKeyboard } from "./use-workspace-keyboard.js";

describe("useWorkspaceKeyboard", () => {
  it("keeps Tab as navigation and closes the overlay before releasing a lease", () => {
    const closeOverlay = vi.fn();
    const releaseLease = vi.fn();
    const state = { overlayOpen: true };
    const { rerender } = renderHook(() =>
      useWorkspaceKeyboard({
        ...state,
        closeOverlay,
        releaseLease,
        overview: false,
        enterOverview: vi.fn(),
        exitOverview: vi.fn(),
      }),
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(closeOverlay).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closeOverlay).toHaveBeenCalledOnce();
    expect(releaseLease).not.toHaveBeenCalled();

    state.overlayOpen = false;
    rerender();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(releaseLease).toHaveBeenCalledOnce();
  });
});
