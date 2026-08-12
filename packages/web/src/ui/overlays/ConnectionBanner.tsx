import { CheckCircle, RefreshCw, WifiOff } from "react-feather";

export type ConnectionState = "live" | "reconnecting" | "restoring";

export function ConnectionBanner({ state }: { readonly state: ConnectionState }) {
  const Icon = state === "live" ? CheckCircle : state === "reconnecting" ? WifiOff : RefreshCw;
  const copy =
    state === "live"
      ? "Live"
      : state === "reconnecting"
        ? "Reconnecting… Processes keep running"
        : "Restoring terminals and output…";
  return (
    <div className={`connection-banner banner-${state}`} role="status">
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" /> {copy}
    </div>
  );
}
