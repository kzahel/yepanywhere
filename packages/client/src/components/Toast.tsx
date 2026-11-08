import type { CSSProperties } from "react";
import { getToastDurationMs, type Toast as ToastType } from "../hooks/useToast";
import styles from "./Toast.module.css";
import { Button } from "./ui/Button";

interface Props {
  toasts: ToastType[];
  onDismiss: (id: string) => void;
}

const TOAST_TYPE_CLASS = {
  error: styles.error!,
  success: styles.success!,
  info: styles.info!,
} satisfies Record<ToastType["type"], string>;

export function ToastContainer({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className={styles.container}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`${styles.toast} ${TOAST_TYPE_CLASS[toast.type]}`}
          style={
            {
              "--toast-fade-duration": `${getToastDurationMs(toast) / 1000}s`,
            } as CSSProperties
          }
          onClick={() => onDismiss(toast.id)}
          onKeyDown={(e) => e.key === "Enter" && onDismiss(toast.id)}
          role="alert"
        >
          <span className={styles.message}>{toast.message}</span>
          {toast.action && (
            <Button
              size="small"
              className={styles.action}
              onClick={(e) => {
                e.stopPropagation();
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
            >
              {toast.action.label}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
