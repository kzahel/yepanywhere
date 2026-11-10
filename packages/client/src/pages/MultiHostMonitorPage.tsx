import styles from "./MultiHostMonitorPage.module.css";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button, buttonClassName } from "../components/ui/Button";
import { YepAnywhereLogo } from "../components/YepAnywhereLogo";
import { type MessageKey, useI18n } from "../i18n";
import { loadSavedHosts, type SavedHost } from "../lib/hostStorage";
import { getRelayBasePath } from "../lib/remoteRoutePaths";
import {
  MultiHostMonitorController,
  type MultiHostMonitorHostSnapshot,
  type MultiHostMonitorHostState,
} from "../lib/multiHostMonitor";

const CARD_CLASSES = {
  connecting: "",
  connected: styles.cardConnected,
  offline: styles.cardOffline,
  "sign-in-required": styles.cardSignInRequired,
};

const STATUS_CLASSES = {
  connecting: styles.statusConnecting,
  connected: styles.statusConnected,
  offline: styles.statusOffline,
  "sign-in-required": styles.statusSignInRequired,
};

const STATUS_TONES: Record<MultiHostMonitorHostState, BadgeTone> = {
  connecting: "info",
  connected: "accent",
  offline: "danger",
  "sign-in-required": "warning",
};

const STATUS_KEYS: Record<MultiHostMonitorHostState, MessageKey> = {
  connecting: "multiHostMonitorStateConnecting",
  connected: "multiHostMonitorStateConnected",
  offline: "multiHostMonitorStateOffline",
  "sign-in-required": "multiHostMonitorStateSignInRequired",
};

function relayLoginPath(host: MultiHostMonitorHostSnapshot): string {
  const params = new URLSearchParams();
  if (host.relayUsername) params.set("u", host.relayUsername);
  const query = params.toString();
  return `/login/relay${query ? `?${query}` : ""}`;
}

function signInPath(host: MultiHostMonitorHostSnapshot): string {
  return host.mode === "relay" ? relayLoginPath(host) : "/login/direct";
}

function sessionPath(
  host: MultiHostMonitorHostSnapshot,
  projectId: string,
  sessionId: string,
): string | null {
  if (!host.relayUsername) return null;
  return `${getRelayBasePath(host.relayUsername)}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

function HostMonitorCard({
  controller,
  host,
}: {
  controller: MultiHostMonitorController;
  host: MultiHostMonitorHostSnapshot;
}) {
  const { t } = useI18n();
  const summary = host.summary;

  return (
    <article
      className={`${styles.card} ${CARD_CLASSES[host.state]}`}
      data-host-name={host.displayName}
      data-host-state={host.state}
    >
      <header className={styles.cardHeader}>
        <div className={styles.cardIdentity}>
          <span
            className={`${styles.status} ${STATUS_CLASSES[host.state]}`}
            aria-hidden="true"
          />
          <div>
            <h2>{host.displayName}</h2>
            {host.relayUsername && (
              <p className={styles.cardEndpoint}>{host.relayUsername}</p>
            )}
          </div>
        </div>
        <Badge tone={STATUS_TONES[host.state]}>
          {t(STATUS_KEYS[host.state])}
        </Badge>
      </header>

      {host.state === "connected" && summary ? (
        <>
          <dl className={styles.metrics}>
            <div>
              <dt>{t("multiHostMonitorActiveAgents")}</dt>
              <dd>{summary.activeAgentCount}</dd>
            </div>
            <div>
              <dt>{t("multiHostMonitorNeedsAttention")}</dt>
              <dd>{summary.needsAttentionCount}</dd>
            </div>
          </dl>
          <div className={styles.sessions}>
            <h3>{t("multiHostMonitorRecentSessions")}</h3>
            {summary.sessions.length > 0 ? (
              <ul>
                {summary.sessions.map((session) => {
                  const path = session.projectId
                    ? sessionPath(host, session.projectId, session.id)
                    : null;
                  return (
                    <li key={`${session.projectId ?? ""}:${session.id}`}>
                      {path ? (
                        <Link to={path}>{session.title}</Link>
                      ) : (
                        <span>{session.title}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={styles.emptySessions}>
                {t("multiHostMonitorNoSessions")}
              </p>
            )}
          </div>
        </>
      ) : (
        <div className={styles.cardAction}>
          {host.state === "offline" && (
            <Button onClick={() => controller.retryHost(host.hostId)}>
              {t("multiHostMonitorRetry")}
            </Button>
          )}
          {host.state === "sign-in-required" && (
            <Link className={buttonClassName()} to={signInPath(host)}>
              {t("multiHostMonitorSignIn")}
            </Link>
          )}
        </div>
      )}
    </article>
  );
}

export function MultiHostMonitorPage() {
  const { t } = useI18n();
  const hosts = useMemo<SavedHost[]>(() => loadSavedHosts().hosts, []);
  const controller = useMemo(
    () => new MultiHostMonitorController(hosts),
    [hosts],
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  return (
    <main className={styles.page} data-testid="multi-host-monitor">
      <div className={styles.shell}>
        <header className={styles.pageHeader}>
          <Link className={styles.brand} to="/login" aria-label="Yep Anywhere">
            <YepAnywhereLogo variant="monitor" />
          </Link>
          <div className={styles.heading}>
            <div className={styles.titleRow}>
              <h1>{t("multiHostMonitorTitle")}</h1>
              <span>{t("multiHostMonitorExperimental")}</span>
            </div>
            <p>{t("multiHostMonitorDescription")}</p>
          </div>
          <Link
            className={buttonClassName({ className: styles.back })}
            to="/login"
          >
            {t("multiHostMonitorBack")}
          </Link>
        </header>

        {snapshot.selectedCount > 0 ? (
          <>
            <p
              className={styles.connectionCount}
              data-testid="multi-host-connected-count"
            >
              {t("multiHostMonitorConnectedCount", {
                connected: snapshot.connectedCount,
                total: snapshot.selectedCount,
              })}
            </p>
            <section
              className={styles.grid}
              aria-label={t("multiHostMonitorTitle")}
            >
              {snapshot.hosts.map((host) => (
                <HostMonitorCard
                  key={host.hostId}
                  controller={controller}
                  host={host}
                />
              ))}
            </section>
          </>
        ) : (
          <section className={styles.empty}>
            <h2>{t("multiHostMonitorEmptyTitle")}</h2>
            <p>{t("multiHostMonitorEmptyDescription")}</p>
            <Link className={buttonClassName()} to="/login">
              {t("multiHostMonitorAddHost")}
            </Link>
          </section>
        )}
      </div>
    </main>
  );
}
