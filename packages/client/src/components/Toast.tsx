import { type CSSProperties, useEffect } from "react";
import {
  getToastDurationMs,
  isPriorityToast,
  type Toast as ToastType,
} from "../hooks/useToast";
import { useI18n } from "../i18n";
import styles from "./Toast.module.css";
import { Button, IconButton } from "./ui/Button";

interface Props {
  toasts: ToastType[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: Props) {
  const priority = toasts.filter(isPriorityToast);
  const routine = toasts.find((toast) => !isPriorityToast(toast));

  return (
    <div className={styles.container}>
      {priority.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
      <div className={styles.routine} role="status">
        {routine && (
          <ToastItem key={routine.id} toast={routine} onDismiss={onDismiss} />
        )}
      </div>
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastType;
  onDismiss: Props["onDismiss"];
}) {
  const { id, type, message, action } = toast;
  const duration = getToastDurationMs(toast);
  const priority = isPriorityToast(toast);

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), duration);
    return () => clearTimeout(timer);
  }, [duration, id, onDismiss]);

  return (
    <div
      className={
        type === "error" ? `${styles.toast} ${styles.error}` : styles.toast
      }
      style={{ "--toast-fade-duration": `${duration}ms` } as CSSProperties}
    >
      <div className={styles.label}>
        {type === "success" && (
          <svg className={styles.check} viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="m3 8 3 3 7-7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        <span role={priority ? "alert" : undefined}>{message}</span>
      </div>
      {priority && (
        <ToastControls action={action} dismiss={() => onDismiss(id)} />
      )}
    </div>
  );
}

function ToastControls({
  action,
  dismiss,
}: {
  action: ToastType["action"];
  dismiss: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className={styles.controls}>
      {action && (
        <Button
          size="small"
          textFlow="wrap"
          onClick={() => {
            action.onClick();
            dismiss();
          }}
        >
          {action.label}
        </Button>
      )}
      <IconButton label={t("toastDismiss")} size="small" onClick={dismiss}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="m4 4 8 8m0-8-8 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </IconButton>
    </div>
  );
}
