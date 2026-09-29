import { X } from "react-feather";

export function Overview({ open, exit }: { readonly open: boolean; readonly exit: () => void }) {
  if (!open) return null;
  return (
    <section className="overview-overlay" aria-label="Terminal overview">
      <p>Overview · Select a terminal to return to its saved position</p>
      <button type="button" aria-label="Exit overview" onClick={exit}>
        <X size={16} strokeWidth={1.5} aria-hidden="true" /> Exit overview
      </button>
    </section>
  );
}
