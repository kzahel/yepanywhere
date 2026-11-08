import {
  issueLookupUrl,
  type IssueItem,
  type IssueUrlReference,
} from "@yep-anywhere/shared";
import { type MouseEvent, useCallback, useEffect, useState } from "react";
import { ProviderBadge } from "../../components/ProviderBadge";
import { NotificationBadge } from "../../components/StatusBadge";
import { ThinkingIndicator } from "../../components/ThinkingIndicator";
import { Button, ButtonBase, IconButton } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import { formatBriefAge } from "../../lib/sessionAge";
import { loadSavedHosts, type SavedHost } from "../../lib/hostStorage";
import {
  createNewSessionPrefillToken,
  stashNewSessionPrefillToken,
} from "../../lib/newSessionPrefill";
import { resolveSourceKeyForSavedHost } from "../../lib/sourceIdentity";
import { TrackerStatusBadge } from "../../components/TrackerStatusBadge";
import { IssueTypeBadge } from "../../pages/IssueTypeBadge";
import type { Project } from "../../types";
import { focusOrOpenApp, openComposeWindow, openInApp } from "../appTab";
import { getChrome } from "../chrome";
import { withHost } from "../hostLinks";
import {
  type AttentionView,
  type HostAnswer,
  hostPath,
  type IssueLookup,
  loadAttention,
  lookupIssue,
  lookupSessionIssues,
  type PanelSession,
  type SessionIssues,
  sessionPageRoute,
  sessionPath,
} from "../lookup";
import { activeHosts, defaultHost } from "../savedHosts";
import {
  allowlistPermits,
  DEFAULT_EXTENSION_SETTINGS,
  type ExtensionSettings,
  loadExtensionSettings,
  subscribeExtensionSettings,
} from "../settings";
import { DevBuildFooter } from "./DevBuildFooter";
import styles from "./SidePanel.module.css";
import { SiteAccess } from "./SiteAccess";
import { useCurrentTab } from "./useCurrentTab";

const REFRESH_MS = 30_000;
const COLLAPSED_GROUPS_KEY = "ya.extension.panelCollapsedGroups";

type GroupKey = "needsYou" | "running" | "recent";

type Content =
  | { kind: "idle" }
  | { kind: "lookup"; lookup: IssueLookup }
  | { kind: "session"; issues: SessionIssues }
  | { kind: "attention"; view: AttentionView };

function useExtensionSettings(): ExtensionSettings {
  const [settings, setSettings] = useState(DEFAULT_EXTENSION_SETTINGS);
  useEffect(() => {
    void loadExtensionSettings().then(setSettings);
    return subscribeExtensionSettings(setSettings);
  }, []);
  return settings;
}

/** Saved hosts in this extension origin's localStorage, kept current. */
function useSavedHosts(): SavedHost[] {
  const [hosts, setHosts] = useState(() => loadSavedHosts().hosts);
  useEffect(() => {
    const reload = () => setHosts(loadSavedHosts().hosts);
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, []);
  return hosts;
}

function loadCollapsedGroups(): GroupKey[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? "[]",
    );
    return Array.isArray(stored)
      ? stored.filter((key): key is GroupKey =>
          ["needsYou", "running", "recent"].includes(key),
        )
      : [];
  } catch {
    return [];
  }
}

/** Attention groups the user collapsed, remembered across panel opens. */
function useCollapsedGroups(): [GroupKey[], (key: GroupKey) => void] {
  const [collapsed, setCollapsed] = useState(loadCollapsedGroups);
  useEffect(() => {
    const reload = (event: StorageEvent) => {
      if (event.key === COLLAPSED_GROUPS_KEY)
        setCollapsed(loadCollapsedGroups());
    };
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, []);
  const toggle = useCallback((key: GroupKey) => {
    const current = loadCollapsedGroups();
    const next = current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key];
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(next));
    setCollapsed(next);
  }, []);
  return [collapsed, toggle];
}

function StateBadge({ session }: { session: PanelSession }) {
  const { t } = useI18n();
  if (session.state === "approval")
    return (
      <NotificationBadge
        variant="needs-input"
        label={t("extensionPanelApproval")}
      />
    );
  if (session.state === "question")
    return (
      <NotificationBadge
        variant="needs-input"
        label={t("extensionPanelQuestion")}
      />
    );
  if (session.state === "running") return <ThinkingIndicator variant="pill" />;
  return null;
}

function SessionRow({
  session,
  showHost,
  onOpen,
}: {
  session: PanelSession;
  showHost: boolean;
  onOpen: (session: PanelSession, event: MouseEvent) => void;
}) {
  const { t } = useI18n();
  return (
    <li>
      <ButtonBase
        className={styles.row}
        aria-label={t("extensionPanelOpenSession", { title: session.title })}
        onClick={(event) => onOpen(session, event)}
      >
        <span className={styles.rowTop}>
          <span className={styles.rowTitle}>{session.title}</span>
          {session.updatedAt && (
            <span className={styles.age}>
              {formatBriefAge(session.updatedAt)}
            </span>
          )}
        </span>
        <span className={styles.rowMeta}>
          <StateBadge session={session} />
          {session.provider && (
            <ProviderBadge provider={session.provider} model={session.model} />
          )}
          <span>
            {[
              session.projectName,
              showHost ? session.host.displayName : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        {session.lastAgentText && (
          <span className={styles.activity}>{session.lastAgentText}</span>
        )}
        {session.mentions !== undefined && session.mentions > 0 && (
          <span className={styles.mentions}>
            {t("extensionPanelMentions", { count: session.mentions })}
          </span>
        )}
      </ButtonBase>
    </li>
  );
}

function SessionIssueList({
  items,
  collapseMerged,
  onOpen,
}: {
  items: IssueItem[];
  collapseMerged: boolean;
  onOpen: (item: IssueItem) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(!collapseMerged);
  useEffect(() => setExpanded(!collapseMerged), [collapseMerged]);
  const merged = items.filter(
    (item) =>
      item.provider === "github" && item.trackerStatus?.state === "merged",
  );
  const visible = items.filter((item) => !merged.includes(item));
  const rows = (entries: IssueItem[]) =>
    entries.map((item) => (
      <IssueRow key={item.id} item={item} onOpen={() => onOpen(item)} />
    ));
  return (
    <>
      {visible.length > 0 && <ul className={styles.list}>{rows(visible)}</ul>}
      {merged.length > 0 && (
        <section
          aria-label={t("extensionPanelMergedPrs", { count: merged.length })}
        >
          <h3 className={`${styles.groupHeading} ${styles.mergedGroup}`}>
            <ButtonBase
              className={styles.groupToggle}
              aria-expanded={expanded}
              aria-controls="panel-merged-prs"
              onClick={() => setExpanded((value) => !value)}
            >
              <svg
                className={styles.chevron}
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                aria-hidden="true"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
              {t("extensionPanelMergedPrs", { count: merged.length })}
            </ButtonBase>
          </h3>
          <ul id="panel-merged-prs" className={styles.list} hidden={!expanded}>
            {rows(merged)}
          </ul>
        </section>
      )}
    </>
  );
}

function IssueRow({ item, onOpen }: { item: IssueItem; onOpen: () => void }) {
  const { t } = useI18n();
  const title = item.title ?? item.confirmation?.title;
  return (
    <li>
      <ButtonBase
        className={styles.row}
        aria-label={t("extensionPanelOpenIssue", { key: item.key })}
        disabled={!item.url}
        onClick={onOpen}
      >
        <span className={styles.rowTop}>
          <span className={styles.rowTitle}>{title ?? item.key}</span>
        </span>
        <span className={styles.rowMeta}>
          <IssueTypeBadge item={item} />
          <TrackerStatusBadge item={item} />
          {item.trackerStatus?.mergedAt && (
            <span>
              {t("issuesMergedOn", {
                date: new Date(
                  item.trackerStatus.mergedAt,
                ).toLocaleDateString(),
              })}
            </span>
          )}
          {item.trackerStatus?.mergeCommitSha && (
            <span title={item.trackerStatus.mergeCommitSha}>
              {t("issuesMergeCommit", {
                sha: item.trackerStatus.mergeCommitSha.slice(0, 7),
              })}
            </span>
          )}
          <span>
            {[
              title ? item.key : undefined,
              item.sessionCount > 1
                ? t("extensionPanelSessionCount", { count: item.sessionCount })
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </ButtonBase>
    </li>
  );
}

function HostProblems({ answers }: { answers: HostAnswer[] }) {
  const { t } = useI18n();
  const problems = answers.filter((answer) => answer.status !== "ok");
  if (problems.length === 0) return null;
  return (
    <ul className={styles.problems}>
      {problems.map((answer) => (
        <li key={answer.host.id}>
          {answer.status === "sign-in"
            ? t("extensionPanelHostSignIn", { host: answer.host.displayName })
            : answer.status === "issues-off"
              ? t("extensionPanelHostIssuesOff", {
                  host: answer.host.displayName,
                })
              : t("extensionPanelHostError", {
                  host: answer.host.displayName,
                  error: answer.error ?? "",
                })}
        </li>
      ))}
    </ul>
  );
}

function issueBadgeItem(reference: IssueUrlReference): IssueItem {
  return {
    id: reference.identity,
    key: reference.key,
    title: null,
    url: reference.url,
    provider: reference.provider,
    kind: reference.kind,
    sessionCount: 0,
    unresolved: false,
  };
}

/** The project most likely meant for a new session about `reference`. */
async function guessProject(
  host: SavedHost,
  reference: IssueUrlReference,
): Promise<string | undefined> {
  const repository =
    reference.provider === "github"
      ? reference.key.split("#")[0]!.split("/")[1]!.toLowerCase()
      : null;
  if (!repository) return undefined;
  const { projects } = await withHost(host, (connection) =>
    connection.fetch<{ projects: Project[] }>("/projects"),
  );
  return projects.find(
    (project) =>
      project.name.toLowerCase() === repository ||
      project.path.split(/[\\/]/).pop()?.toLowerCase() === repository,
  )?.id;
}

export function SidePanel() {
  const { t } = useI18n();
  const settings = useExtensionSettings();
  const savedHosts = useSavedHosts();
  const hosts = activeHosts(savedHosts, settings);
  const hostKey = hosts
    .map((host) => `${host.id}:${host.session?.sessionId ?? ""}`)
    .join(",");
  const tab = useCurrentTab();
  const [manualUrl, setManualUrl] = useState<string>();
  const [content, setContent] = useState<Content>({ kind: "idle" });
  const [loading, setLoading] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);

  const reference = tab.url ? issueLookupUrl(tab.url) : null;
  const route = tab.url ? sessionPageRoute(tab.url) : null;
  const lookupWanted =
    !!reference &&
    !!tab.url &&
    (tab.clicked ||
      manualUrl === tab.url ||
      (settings.automaticLookup &&
        allowlistPermits(settings.lookupAllowlist, reference.key)));

  // Reload on any input change, on demand, and while visible. hostKey stands
  // for `hosts`, which is rebuilt on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshCount is the on-demand trigger and hostKey identifies hosts.
  useEffect(() => {
    if (hosts.length === 0) return;
    const url = tab.url;
    let cancelled = false;
    let inFlight = false;
    let rechecks = 0;
    let followUp: ReturnType<typeof setTimeout> | undefined;
    const load = async (isRecheck = false) => {
      if (cancelled || inFlight) return;
      if (followUp) clearTimeout(followUp);
      if (!isRecheck) rechecks = 0;
      inFlight = true;
      setLoading(true);
      try {
        // A session page is the user's own data on a page already readable,
        // so it is always looked up.
        if (route) {
          const issues = await lookupSessionIssues(route, hosts);
          if (!cancelled) {
            setContent({ kind: "session", issues });
            if (issues.statusRefreshing && rechecks++ < 3)
              followUp = setTimeout(() => void load(true), 1500);
          }
        } else if (lookupWanted && url) {
          const lookup = await lookupIssue(url, hosts, {
            includeDismissed: settings.includeDismissed,
          });
          if (!cancelled && lookup) setContent({ kind: "lookup", lookup });
        } else if (settings.panelFallback !== "none") {
          const view = await loadAttention(hosts);
          if (!cancelled) setContent({ kind: "attention", view });
        } else if (!cancelled) setContent({ kind: "idle" });
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (followUp) clearTimeout(followUp);
    };
  }, [
    hostKey,
    tab.url,
    lookupWanted,
    settings.includeDismissed,
    settings.panelFallback,
    refreshCount,
  ]);

  // A different page drops the previous page's answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the URL is the trigger, not an input.
  useEffect(() => {
    setContent({ kind: "idle" });
  }, [tab.url]);

  const open = useCallback(
    (session: PanelSession, event: MouseEvent) => {
      void openInApp(sessionPath(session), {
        newTab:
          settings.openSessionsIn === "new-tab" ||
          event.metaKey ||
          event.ctrlKey,
      });
    },
    [settings.openSessionsIn],
  );

  const target = defaultHost(savedHosts, settings);
  const openOptions = () =>
    void openInApp(
      target ? hostPath(target, "settings/browser-extension") : "/login",
    );

  // Ctrl/⌘ opens an ordinary app page instead of the new-session popup.
  const openNewSession = (path: string, newTab: boolean) => {
    if (newTab) void openInApp(path, { newTab: true });
    else void openComposeWindow(path);
  };

  // The new session starts with the page's address in its composer, in the
  // project the address most likely belongs to.
  const startSessionAbout = (
    event: MouseEvent,
    pageReference: IssueUrlReference,
  ) => {
    if (!target) return;
    const newTab = event.metaKey || event.ctrlKey;
    void guessProject(target, pageReference)
      .catch(() => undefined)
      .then((projectId) => {
        const token = createNewSessionPrefillToken();
        stashNewSessionPrefillToken(
          token,
          resolveSourceKeyForSavedHost(target),
          `${pageReference.url}\n\n`,
        );
        const params = new URLSearchParams({ prefillToken: token });
        if (projectId) params.set("projectId", projectId);
        openNewSession(
          hostPath(target, `new-session?${params.toString()}`),
          newTab,
        );
      });
  };

  const openIssue = (item: IssueItem) => {
    const chrome = getChrome();
    if (chrome && item.url) void chrome.tabs.create({ url: item.url });
  };

  const showHost = hosts.length > 1;
  const lookup = content.kind === "lookup" ? content.lookup : null;
  const attention = content.kind === "attention" ? content.view : null;
  const session = content.kind === "session" ? content.issues : null;
  const answers = lookup?.hosts ?? attention?.hosts ?? session?.hosts ?? [];

  return (
    <div className={styles.panel}>
      {/* Chrome's own panel header already shows the extension's icon and
          name, so this row holds only hosts and controls. */}
      <header className={styles.header}>
        <span className={styles.hosts}>
          {hosts.map((host) => {
            const answer = answers.find((item) => item.host.id === host.id);
            return (
              <span key={host.id} className={styles.hostChip}>
                <span
                  className={
                    answer?.status === "ok" ? styles.online : styles.offline
                  }
                  aria-hidden="true"
                />
                {host.displayName}
              </span>
            );
          })}
        </span>
        <IconButton
          className={styles.iconButton}
          label={t("extensionPanelOpenApp")}
          onClick={() => void focusOrOpenApp()}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />
          </svg>
        </IconButton>
        <IconButton
          className={styles.iconButton}
          label={t("extensionPanelRefresh")}
          disabled={loading || hosts.length === 0}
          onClick={() => setRefreshCount((count) => count + 1)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
          </svg>
        </IconButton>
        <IconButton
          className={styles.iconButton}
          label={t("extensionPanelOptions")}
          onClick={openOptions}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </IconButton>
      </header>

      <main className={styles.body}>
        <SiteAccess tab={tab} />
        {hosts.length === 0 ? (
          <section className={styles.context}>
            <p>
              {savedHosts.length === 0
                ? t("extensionPanelNoHosts")
                : t("extensionPanelNoActiveHosts")}
            </p>
            <Button
              variant="primary"
              onClick={
                savedHosts.length === 0
                  ? () => void openInApp("/login")
                  : openOptions
              }
            >
              {savedHosts.length === 0
                ? t("extensionPanelOpenApp")
                : t("extensionPanelOptions")}
            </Button>
          </section>
        ) : (
          <>
            {target && (
              <section
                className={styles.newSession}
                aria-label={t("extensionPanelNewSessionSection")}
              >
                {reference && (
                  <Button
                    variant="primary"
                    onClick={(event) => startSessionAbout(event, reference)}
                  >
                    {t("extensionPanelNewSession")}
                  </Button>
                )}
                <Button
                  className={styles.startSession}
                  onClick={(event) =>
                    openNewSession(
                      hostPath(target, "new-session"),
                      event.metaKey || event.ctrlKey,
                    )
                  }
                >
                  {showHost
                    ? t("extensionPanelStartSessionOn", {
                        host: target.displayName,
                      })
                    : t("extensionPanelStartSession")}
                </Button>
              </section>
            )}

            {reference && (
              <section className={styles.context} aria-label={reference.key}>
                <div className={styles.contextKey}>
                  <IssueTypeBadge item={issueBadgeItem(reference)} />
                  <span>{reference.key}</span>
                </div>
                {lookup?.item &&
                  (lookup.item.title ?? lookup.item.confirmation?.title) && (
                    <h2>
                      {lookup.item.title ?? lookup.item.confirmation?.title}
                    </h2>
                  )}
                <p>
                  {!lookupWanted
                    ? t("extensionPanelLookupOff")
                    : loading && !lookup
                      ? t("extensionPanelLookingUp")
                      : lookup
                        ? lookup.sessions.length === 1
                          ? t("extensionPanelSessionCountOne")
                          : t("extensionPanelSessionCount", {
                              count: lookup.sessions.length,
                            })
                        : ""}
                </p>
              </section>
            )}

            {reference && !lookupWanted && (
              <Button variant="primary" onClick={() => setManualUrl(tab.url)}>
                {t("extensionPanelLookUp")}
              </Button>
            )}

            {route && (
              <section
                className={styles.context}
                aria-label={t("extensionPanelThisSession")}
              >
                <p>
                  {loading && !session
                    ? t("extensionPanelLookingUp")
                    : !session ||
                        (session.host && session.hosts[0]?.status !== "ok")
                      ? ""
                      : !session.host
                        ? t("extensionPanelSessionHostInactive", {
                            host: route.relayUsername,
                          })
                        : session.items.length === 1
                          ? t("extensionPanelSessionIssueCountOne")
                          : t("extensionPanelSessionIssueCount", {
                              count: session.items.length,
                            })}
                </p>
              </section>
            )}

            <HostProblems answers={answers} />

            {lookup && (
              <>
                {lookup.sessions.length === 0 ? (
                  <p className={styles.hint}>{t("extensionPanelNoSessions")}</p>
                ) : (
                  <ul className={styles.list}>
                    {lookup.sessions.map((session) => (
                      <SessionRow
                        key={`${session.host.id}:${session.sessionId}`}
                        session={session}
                        showHost={showHost}
                        onOpen={open}
                      />
                    ))}
                  </ul>
                )}
                <p className={styles.hint}>{t("extensionPanelCoverage")}</p>
              </>
            )}

            {session?.host &&
              session.hosts[0]?.status === "ok" &&
              (session.items.length === 0 ? (
                <p className={styles.hint}>
                  {t("extensionPanelSessionNoIssues")}
                </p>
              ) : (
                <SessionIssueList
                  key={`${session.host.id}:${session.route.sessionId}`}
                  items={session.items}
                  collapseMerged={settings.collapseMergedPrs}
                  onOpen={openIssue}
                />
              ))}

            {tab.url && !reference && !route && (
              <p className={styles.hint}>{t("extensionPanelNoIssue")}</p>
            )}

            {attention && (
              <AttentionGroups
                view={attention}
                fallback={settings.panelFallback}
                showHost={showHost}
                onOpen={open}
              />
            )}
          </>
        )}
      </main>
      {typeof __EXTENSION_DEV_BUILD_ID__ !== "undefined" &&
        __EXTENSION_DEV_BUILD_ID__ && <DevBuildFooter />}
    </div>
  );
}

function AttentionGroups({
  view,
  fallback,
  showHost,
  onOpen,
}: {
  view: AttentionView;
  fallback: ExtensionSettings["panelFallback"];
  showHost: boolean;
  onOpen: (session: PanelSession, event: MouseEvent) => void;
}) {
  const { t } = useI18n();
  const [collapsed, toggle] = useCollapsedGroups();
  const groups: {
    key: GroupKey;
    heading: string;
    sessions: PanelSession[];
  }[] =
    fallback === "recent"
      ? [
          {
            key: "recent",
            heading: t("extensionPanelRecent"),
            sessions: view.recent,
          },
        ]
      : [
          {
            key: "needsYou",
            heading: t("extensionPanelNeedsYou"),
            sessions: view.needsYou,
          },
          {
            key: "running",
            heading: t("extensionPanelRunning"),
            sessions: view.running,
          },
          {
            key: "recent",
            heading: t("extensionPanelRecent"),
            sessions: view.recent.slice(0, 5),
          },
        ];
  const visible = groups.filter((group) => group.sessions.length > 0);
  if (visible.length === 0)
    return <p className={styles.hint}>{t("extensionPanelNothingActive")}</p>;
  return (
    <>
      {visible.map((group) => {
        const expanded = !collapsed.includes(group.key);
        const listId = `panel-group-${group.key}`;
        return (
          <section key={group.key} aria-label={group.heading}>
            <h3 className={styles.groupHeading}>
              <ButtonBase
                className={styles.groupToggle}
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => toggle(group.key)}
              >
                <svg
                  className={styles.chevron}
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m9 6 6 6-6 6" />
                </svg>
                {group.heading}
                <span>{group.sessions.length}</span>
              </ButtonBase>
            </h3>
            <ul id={listId} className={styles.list} hidden={!expanded}>
              {group.sessions.map((session) => (
                <SessionRow
                  key={`${session.host.id}:${session.sessionId}`}
                  session={session}
                  showHost={showHost}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
