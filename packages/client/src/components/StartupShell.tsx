import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import styles from "./StartupShell.module.css";
import { Spinner } from "./ui/Spinner";

export type StartupPhase = "module" | "connection";

const SESSION_PATH_PATTERN =
  /(?:^|\/)projects\/[^/]+\/sessions\/[^/?#]+(?:\/|$)/;

export function isSessionStartupPath(pathname: string): boolean {
  return SESSION_PATH_PATTERN.test(pathname);
}

export function StartupShell({
  children,
  phase,
}: {
  children: ReactNode;
  phase: StartupPhase;
}) {
  const location = useLocation();
  const isSession = isSessionStartupPath(location.pathname);

  const status = (
    <div className={styles.status} role="status" aria-live="polite">
      <Spinner size="large" />
      <span>{children}</span>
    </div>
  );

  return (
    <div
      className={styles.shell}
      data-startup-phase={phase}
      data-startup-shell={isSession ? "session" : "page"}
    >
      {isSession ? (
        <>
          <div className={styles.sessionHeader} aria-hidden="true">
            <span className={styles.headerProject} />
            <span className={styles.headerTitle} />
          </div>
          <main className={styles.messageSlot}>{status}</main>
          <div className={styles.composerSlot} aria-hidden="true">
            <div className={styles.composerFrame}>
              <span className={styles.composerLine} />
              <span className={styles.composerActions} />
            </div>
          </div>
        </>
      ) : (
        <main className={styles.genericContent}>{status}</main>
      )}
    </div>
  );
}
