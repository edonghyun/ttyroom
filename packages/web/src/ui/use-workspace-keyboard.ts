import { useEffect } from "react";

export function useWorkspaceKeyboard({
  overlayOpen,
  closeOverlay,
  releaseLease,
  overview,
  enterOverview,
  exitOverview,
}: {
  readonly overlayOpen: boolean;
  readonly closeOverlay: () => void;
  readonly releaseLease: () => void;
  readonly overview: boolean;
  readonly enterOverview: () => void;
  readonly exitOverview: () => void;
}) {
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === "Tab") return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (overlayOpen) closeOverlay();
        else if (overview) exitOverview();
        else releaseLease();
        return;
      }
      if (event.altKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (overview) exitOverview();
        else enterOverview();
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [closeOverlay, enterOverview, exitOverview, overlayOpen, overview, releaseLease]);
}
