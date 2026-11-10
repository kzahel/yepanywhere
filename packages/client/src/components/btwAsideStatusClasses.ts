import styles from "./BtwAsideTranscript.module.css";
export const btwAsideStatusClasses: Readonly<
  Record<string, string | undefined>
> = {
  failed: styles["is-failed"],
  stopped: styles["is-stopped"],
};
