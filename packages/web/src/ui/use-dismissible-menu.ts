import { useEffect, useRef } from "react";

export function useDismissibleMenu(open: boolean, dismiss: () => void) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function dismissOutside(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (trigger.current?.contains(target) || menu.current?.contains(target)) return;
      dismiss();
    }

    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [dismiss, open]);

  return { trigger, menu } as const;
}
