import { AlertCircle, CheckCircle, Info } from "react-feather";

export interface ToastMessage {
  readonly id: string;
  readonly severity: "info" | "success" | "error";
  readonly message: string;
}

export function ToastRegion({ toasts }: { readonly toasts: readonly ToastMessage[] }) {
  return (
    <div className="toast-stack">
      {toasts.map((toast) => {
        const Icon =
          toast.severity === "error"
            ? AlertCircle
            : toast.severity === "success"
              ? CheckCircle
              : Info;
        return (
          <div
            key={toast.id}
            className={`toast toast-${toast.severity}`}
            aria-live={toast.severity === "error" ? "assertive" : "polite"}
          >
            <Icon size={17} strokeWidth={1.5} aria-hidden="true" />
            <span>{toast.message}</span>
          </div>
        );
      })}
    </div>
  );
}
