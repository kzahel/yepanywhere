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
      className={`multi-host-card multi-host-card--${host.state}`}
      data-host-name={host.displayName}
      data-host-state={host.state}
    >
      <header className="multi-host-card-header">
        <div className="multi-host-card-identity">
          <span
            className={`multi-host-status multi-host-status--${host.state}`}
            aria-hidden="true"
          />
          <div>
            <h2>{host.displayName}</h2>
            {host.relayUsername && (
              <p className="multi-host-card-endpoint">{host.relayUsername}</p>
            )}
          </div>
        </div>
        <Badge tone={STATUS_TONES[host.state]}>
          {t(STATUS_KEYS[host.state])}
        </Badge>
      </header>

      {host.state === "connected" && summary ? (
        <>
          <dl className="multi-host-metrics">
            <div>
              <dt>{t("multiHostMonitorActiveAgents")}</dt>
              <dd>{summary.activeAgentCount}</dd>
            </div>
            <div>
              <dt>{t("multiHostMonitorNeedsAttention")}</dt>
              <dd>{summary.needsAttentionCount}</dd>
            </div>
          </dl>
          <div className="multi-host-sessions">
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
              <p className="multi-host-empty-sessions">
                {t("multiHostMonitorNoSessions")}
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="multi-host-card-action">
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
    <main className="multi-host-page" data-testid="multi-host-monitor">
      <div className="multi-host-shell">
        <header className="multi-host-page-header">
          <Link
            className="multi-host-brand"
            to="/login"
            aria-label="Yep Anywhere"
          >
            <YepAnywhereLogo />
          </Link>
          <div className="multi-host-heading">
            <div className="multi-host-title-row">
              <h1>{t("multiHostMonitorTitle")}</h1>
              <span>{t("multiHostMonitorExperimental")}</span>
            </div>
            <p>{t("multiHostMonitorDescription")}</p>
          </div>
          <Link
            className={buttonClassName({ className: "multi-host-back" })}
            to="/login"
          >
            {t("multiHostMonitorBack")}
          </Link>
        </header>

        {snapshot.selectedCount > 0 ? (
          <>
            <p
              className="multi-host-connection-count"
              data-testid="multi-host-connected-count"
            >
              {t("multiHostMonitorConnectedCount", {
                connected: snapshot.connectedCount,
                total: snapshot.selectedCount,
              })}
            </p>
            <section
              className="multi-host-grid"
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
          <section className="multi-host-empty">
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
