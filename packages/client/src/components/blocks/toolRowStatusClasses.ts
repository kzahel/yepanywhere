import styles from "./ToolCallRow.module.css";
export const toolRowStatusClasses: Readonly<
  Record<string, string | undefined>
> = {
  pending: styles["status-pending"],
  complete: styles["status-complete"],
  error: styles["status-error"],
  aborted: styles["status-aborted"],
  incomplete: styles["status-incomplete"],
};
