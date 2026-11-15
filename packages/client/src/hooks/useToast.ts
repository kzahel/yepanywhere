export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: "error" | "success" | "info";
  action?: ToastAction;
}

const TOAST_TIMEOUT_MS = 4500;
const ACTION_TOAST_TIMEOUT_MS = 7000;
const ERROR_TOAST_TIMEOUT_MS = 12_000;

export function getToastDurationMs(
  toast: Pick<Toast, "type" | "action">,
): number {
  if (toast.type === "error") return ERROR_TOAST_TIMEOUT_MS;
  return toast.action ? ACTION_TOAST_TIMEOUT_MS : TOAST_TIMEOUT_MS;
}
