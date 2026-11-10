import styles from "./TaskPresentation.module.css";

export const taskStatusClasses: Readonly<Record<string, string | undefined>> = {
  running: styles["status-running"],
  completed: styles["status-completed"],
  failed: styles["status-failed"],
  error: styles["status-error"],
  timeout: styles["status-timeout"],
};
