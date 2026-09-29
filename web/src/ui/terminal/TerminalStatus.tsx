import { CheckCircle, Eye, Lock, Share2, Terminal, XCircle } from "react-feather";

export type TerminalStatusValue =
  | { readonly kind: "mine"; readonly leaseId: number }
  | { readonly kind: "available" }
  | { readonly kind: "held-by-other"; readonly holderName: string }
  | { readonly kind: "read-only"; readonly reason: "host-disabled" | "host-offline" | "exited" }
  | { readonly kind: "shared" }
  | { readonly kind: "exited"; readonly exitCode: number | null };

export function terminalStatusLabel(status: TerminalStatusValue): string {
  switch (status.kind) {
    case "mine":
      return "You control · Esc to release";
    case "available":
      return "Available";
    case "held-by-other":
      return `${status.holderName} controls · View only`;
    case "read-only":
      return status.reason === "host-disabled"
        ? "Read only · Remote input disabled"
        : status.reason === "host-offline"
          ? "Read only · Host offline"
          : "Read only · Terminal exited";
    case "shared":
      return "Shared input";
    case "exited":
      return `Exited (${status.exitCode ?? "unknown"})`;
  }
}

export function TerminalStatus({ status }: { readonly status: TerminalStatusValue }) {
  const label = terminalStatusLabel(status);
  const Icon =
    status.kind === "mine"
      ? CheckCircle
      : status.kind === "available"
        ? Terminal
        : status.kind === "held-by-other"
          ? Eye
          : status.kind === "shared"
            ? Share2
            : status.kind === "exited"
              ? XCircle
              : Lock;

  return (
    <span className={`terminal-status status-${status.kind}`} role="status" aria-label={label}>
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
