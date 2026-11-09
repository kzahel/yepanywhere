import {
  issueLookupUrl,
  type IssueItem,
  type IssueUrlReference,
} from "@yep-anywhere/shared";
import { type MouseEvent, useCallback, useEffect, useState } from "react";
import { ProviderBadge } from "../../components/ProviderBadge";
import { SessionProviderPhasePill } from "../../components/SessionProviderPhase";
import { NotificationBadge } from "../../components/StatusBadge";
import { ThinkingIndicator } from "../../components/ThinkingIndicator";
import { Badge } from "../../components/ui/Badge";
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
  fetchInboxes,
  type HostAnswer,
  type HostInboxes,
  hostPath,
  type IssueLookup,
  loadAttention,
  lookupIssue,
  lookupSessionIssues,
  type PanelSession,
  type SessionIssues,
  type SessionRoute,
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

// Stored keys predate the Inbox section names; renaming them would reopen
// groups users collapsed.
type GroupKey = "needsYou" | "running" | "background" | "recent";
const GROUP_KEYS: readonly GroupKey[] = [
  "needsYou",
  "running",
  "background",
  "recent",
];

/** What the panel found for the tab's own page, shown above the groups. */
type PageContext =
  | { kind: "idle" }
  | { kind: "lookup"; lookup: IssueLookup }
  | { kind: "session"; issues: SessionIssues };

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
      ? stored.filter((key): key is GroupKey => GROUP_KEYS.includes(key))
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
  if (session.state !== "running") return null;
  // Waiting and background turns name the work holding them, as Inbox rows do.
  const phase = session.providerPhase;
  if (phase && phase.phase !== "generating")
    return <SessionProviderPhasePill providerPhase={phase} />;
  return <ThinkingIndicator variant="pill" />;
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
  // The page lookup and the groups can both report a host; name it once.
  const problems = answers.filter(
    (answer, index) =>
      answer.status !== "ok" &&
      answers.findIndex(
        (other) => other.host.id === answer.host.id && other.status !== "ok",
      ) === index,
  );
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

/** What the panel knows about the YA session page in the tab. */
function SessionContext({
  route,
  session,
  loading,
}: {
  route: SessionRoute;
  session: SessionIssues | null;
  loading: boolean;
}) {
  const { t } = useI18n();
  let text: string;
  if (!session) {
    if (!loading) return null;
    text = t("extensionPanelLookingUp");
  } else if (!session.host) {
    text = t("extensionPanelSessionHostInactive", {
      host: route.relayUsername,
    });
  } else if (session.hosts[0]?.status !== "ok") {
    // HostProblems names what went wrong.
    return null;
  } else if (session.items.length === 0) {
    // Nothing to list takes one line, keeping the groups below in view.
    return (
      <section aria-label={t("extensionPanelThisSession")}>
        <p className={styles.hint}>{t("extensionPanelSessionNoIssues")}</p>
      </section>
    );
  } else {
    text =
      session.items.length === 1
        ? t("extensionPanelSessionIssueCountOne")
        : t("extensionPanelSessionIssueCount", { count: session.items.length });
  }
  return (
    <section
      className={styles.context}
      aria-label={t("extensionPanelThisSession")}
    >
      <p>{text}</p>
    </section>
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
  const [page, setPage] = useState<PageContext>({ kind: "idle" });
  const [groups, setGroups] = useState<AttentionView | null>(null);
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
  // The groups follow the page context on every page; "recent" only narrows
  // which of them show, so it needs no reload.
  const showGroups = settings.panelFallback !== "none";

  // Reload on any input change, on demand, when the panel comes back into
  // view, and while visible. hostKey stands for `hosts`, which is rebuilt on
  // every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshCount is the on-demand trigger and hostKey identifies hosts.
  useEffect(() => {
    if (hosts.length === 0) return;
    const url = tab.url;
    let cancelled = false;
    let inFlight = false;
    let rechecks = 0;
    let followUp: ReturnType<typeof setTimeout> | undefined;
    // While the host is still fetching tracker status, look the session up
    // again shortly. A recheck touches only the page context, so it runs
    // apart from `load` instead of waiting on the groups.
    const lookUpSession = async (sessionRoute: SessionRoute) => {
      const issues = await lookupSessionIssues(sessionRoute, hosts);
      if (cancelled) return;
      setPage({ kind: "session", issues });
      clearTimeout(followUp);
      if (issues.statusRefreshing && rechecks++ < 3)
        followUp = setTimeout(() => void lookUpSession(sessionRoute), 1500);
    };
    const loadPage = async (inboxes?: HostInboxes) => {
      // A session page is the user's own data on a page already readable,
      // so it is always looked up.
      if (route) await lookUpSession(route);
      else if (lookupWanted && url) {
        const lookup = await lookupIssue(url, hosts, {
          includeDismissed: settings.includeDismissed,
          inboxes,
        });
        if (!cancelled && lookup) setPage({ kind: "lookup", lookup });
      } else if (!cancelled) setPage({ kind: "idle" });
    };
    const load = async () => {
      if (cancelled || inFlight) return;
      clearTimeout(followUp);
      rechecks = 0;
      inFlight = true;
      setLoading(true);
      try {
        // The page and the groups load together from one inbox per host.
        const inboxes = showGroups ? fetchInboxes(hosts) : undefined;
        await Promise.all([
          loadPage(inboxes),
          inboxes &&
            loadAttention(hosts, inboxes).then((view) => {
              if (!cancelled) setGroups(view);
            }),
        ]);
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    // Hidden panels skip the timer, so catch up as soon as one is seen.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimeout(followUp);
    };
  }, [
    hostKey,
    tab.url,
    lookupWanted,
    settings.includeDismissed,
    showGroups,
    refreshCount,
  ]);

  // Groups loaded for other hosts, or before the list was turned off, would
  // be stale; drop them rather than show them until the reload lands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hostKey and showGroups are the triggers, not inputs.
  useEffect(() => {
    setGroups(null);
  }, [hostKey, showGroups]);

  // A different page drops only the previous page's context; the groups stay
  // on screen while they reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the URL is the trigger, not an input.
  useEffect(() => {
    setPage({ kind: "idle" });
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
  const lookup = page.kind === "lookup" ? page.lookup : null;
  const session = page.kind === "session" ? page.issues : null;
  const attention = showGroups ? groups : null;
  const answers = [
    ...(lookup?.hosts ?? session?.hosts ?? []),
    ...(attention?.hosts ?? []),
  ];
  const sessionAnswered = !!session?.host && session.hosts[0]?.status === "ok";

  return (
    <div className={styles.panel}>
      {/* Chrome's own panel header already shows the extension's icon and
          name, so this row holds only hosts and controls. */}
      <header className={styles.header}>
        <span className={styles.hosts}>
          {hosts.map((host) => {
            const online = answers.some(
              (item) => item.host.id === host.id && item.status === "ok",
            );
            return (
              <Badge
                key={host.id}
                icon={
                  <span className={online ? styles.online : styles.offline} />
                }
              >
                {host.displayName}
              </Badge>
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
                      : !lookup
                        ? ""
                        : lookup.sessions.length === 0
                          ? // Hosts that failed say so in HostProblems; only
                            // a host that answered can report no mentions.
                            lookup.hosts.some(
                              (answer) => answer.status === "ok",
                            )
                            ? t("extensionPanelNoSessions")
                            : ""
                          : lookup.sessions.length === 1
                            ? t("extensionPanelSessionCountOne")
                            : t("extensionPanelSessionCount", {
                                count: lookup.sessions.length,
                              })}
                </p>
              </section>
            )}

            {reference && !lookupWanted && (
              <Button variant="primary" onClick={() => setManualUrl(tab.url)}>
                {t("extensionPanelLookUp")}
              </Button>
            )}

            {route && (
              <SessionContext
                route={route}
                session={session}
                loading={loading}
              />
            )}

            <HostProblems answers={answers} />

            {lookup && lookup.sessions.length > 0 && (
              <>
                {/* Named apart from the groups, which can list the same
                    sessions. */}
                <ul
                  className={styles.list}
                  aria-label={t("extensionPanelPageSessions", {
                    key: lookup.reference.key,
                  })}
                >
                  {lookup.sessions.map((session) => (
                    <SessionRow
                      key={`${session.host.id}:${session.sessionId}`}
                      session={session}
                      showHost={showHost}
                      onOpen={open}
                    />
                  ))}
                </ul>
                <p className={styles.hint}>{t("extensionPanelCoverage")}</p>
              </>
            )}

            {session?.host && sessionAnswered && session.items.length > 0 && (
              <SessionIssueList
                key={`${session.host.id}:${session.route.sessionId}`}
                items={session.items}
                collapseMerged={settings.collapseMergedPrs}
                onOpen={openIssue}
              />
            )}

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
            sessions: view.needsAttention,
          },
          {
            key: "running",
            heading: t("extensionPanelRunning"),
            sessions: view.active,
          },
          {
            key: "background",
            heading: t("extensionPanelBackground"),
            sessions: view.background,
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
