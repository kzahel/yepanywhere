import styles from "./SessionPage.module.css";

/** Shared grid identity and its DOM boundaries move with the session chrome. */
export function sessionSplitAppearance(withAside: boolean, collapsed: boolean) {
  return {
    className: [
      styles.sessionSplit,
      styles["session-split"],
      withAside ? styles["session-split-with-aside"] : "",
      withAside && collapsed ? styles["session-split-aside-collapsed"] : "",
    ].join(" "),
    "data-session-split": true,
    "data-session-split-with-aside": withAside || undefined,
    "data-session-split-aside-collapsed": (withAside && collapsed) || undefined,
  };
}
