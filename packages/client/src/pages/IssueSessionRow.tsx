import type {
  IssueEvidence,
  IssueEvidenceResult,
  IssueSession,
} from "@yep-anywhere/shared";
import { useEffect, useRef, useState } from "react";
import { SessionListItem } from "../components/SessionListItem";
import { useSourceContextMenu } from "../components/SourceContextMenu";
import { Banner } from "../components/ui/Banner";
import { Button, IconButton } from "../components/ui/Button";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { formatBriefAge } from "../lib/sessionAge";
import styles from "./IssuesPage.module.css";

/** The server's largest evidence page. */
const MAX_EVIDENCE_PAGE = 100;
/** The page an expanded row asks for when it holds none yet. */
const DEFAULT_EVIDENCE_PAGE = 50;

type IssueTransport = ReturnType<typeof useCurrentSourceRuntime>["transport"];

function fetchIssueEvidence(
  transport: IssueTransport,
  request: {
    issueId: string;
    sessionId: string;
    offset: number;
    limit?: number;
    includeDismissed: boolean;
  },
) {
  return transport.fetch<IssueEvidenceResult>(
    `/issues/evidence?${new URLSearchParams({
      id: request.issueId,
      sessionId: request.sessionId,
      offset: String(request.offset),
      ...(request.limit ? { limit: String(request.limit) } : {}),
      dismissed: request.includeDismissed ? "1" : "0",
    })}`,
  );
}

/** Where the evidence after a session's first page starts, if any remains. */
function evidenceAfterFirstPage(session: IssueSession) {
  return session.evidence.length < session.evidenceCount
    ? session.evidence.length
    : null;
}

/**
 * One associated session in the Issues pane. `session` and `includeDismissed`
 * describe the same answer: the filter is the one that answer was fetched
 * under, not the checkbox's current state.
 */
export function IssueSessionRow({
  issueId,
  session,
  unresolved,
  busy,
  includeDismissed,
  action,
}: {
  issueId: string;
  session: IssueSession;
  unresolved: boolean;
  busy: boolean;
  includeDismissed: boolean;
  action: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const { transport } = useCurrentSourceRuntime();
  const base = useRemoteBasePath();
  const menu = useSourceContextMenu(t, {
    menu: t("issuesAssociationActions"),
  });
  const [expanded, setExpanded] = useState(false);
  // Only the pages this row fetched are held here: the first mention stays a
  // prop. Offsets index the list the current `session` came from, so each new
  // answer re-fetches as many mentions as were loaded rather than keeping
  // pages fetched under another filter or ordering.
  const [loaded, setLoaded] = useState<{
    entries: IssueEvidence[];
    nextOffset: number | null;
  }>({ entries: [], nextOffset: null });
  const evidence = loaded.entries.length
    ? [...session.evidence, ...loaded.entries]
    : session.evidence;
  const nextOffset = loaded.entries.length
    ? loaded.nextOffset
    : evidenceAfterFirstPage(session);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Bumped by every reload and by unmount; a response from an older
  // generation belongs to a list this row no longer shows.
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const shownSession = useRef(session);
  const loadedCount = loaded.entries.length;
  useEffect(() => {
    if (shownSession.current === session) return;
    shownSession.current = session;
    const current = ++generation.current;
    const isCurrent = () => current === generation.current;
    // An expanded row whose first page was still in flight shows one mention
    // and no "more" control, so it asks again rather than stalling.
    const wanted = loadedCount || (expanded ? DEFAULT_EVIDENCE_PAGE : 0);
    if (wanted === 0) {
      setLoading(false);
      return;
    }
    void (async () => {
      setLoading(true);
      setError("");
      const entries: IssueEvidence[] = [];
      let offset = evidenceAfterFirstPage(session);
      try {
        while (offset !== null && entries.length < wanted) {
          const page = await fetchIssueEvidence(transport, {
            issueId,
            sessionId: session.sessionId,
            offset,
            limit: Math.min(MAX_EVIDENCE_PAGE, wanted - entries.length),
            includeDismissed,
          });
          if (!isCurrent()) return;
          entries.push(...page.evidence);
          offset = page.nextOffset;
        }
        setLoaded({ entries, nextOffset: offset });
      } catch {
        if (!isCurrent()) return;
        setLoaded({ entries: [], nextOffset: null });
        setError(t("issuesLoadError"));
      } finally {
        if (isCurrent()) setLoading(false);
      }
    })();
  }, [session, includeDismissed, issueId, loadedCount, expanded, transport, t]);
  const more = async () => {
    if (nextOffset === null || loading) return;
    const current = generation.current;
    setLoading(true);
    setError("");
    try {
      const next = await fetchIssueEvidence(transport, {
        issueId,
        sessionId: session.sessionId,
        offset: nextOffset,
        includeDismissed,
      });
      if (current === generation.current)
        setLoaded((previous) => ({
          entries: [...previous.entries, ...next.evidence],
          nextOffset: next.nextOffset,
        }));
    } catch {
      if (current === generation.current) setError(t("issuesLoadError"));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  };
  const age = formatBriefAge(session.updatedAt);
  const excerpt = (entry: IssueEvidence, compact: boolean) => (
    <div key={entry.id} className={styles.mention}>
      <p className={compact ? styles.excerpt : styles.expandedExcerpt}>
        {entry.excerpt || entry.value}
      </p>
      {entry.sourceTime && (
        <time className={styles.muted} dateTime={entry.sourceTime}>
          {new Date(entry.sourceTime).toLocaleString()}
        </time>
      )}
    </div>
  );
  return (
    <article
      className={styles.session}
      aria-label={session.title ?? session.sessionId}
    >
      <div className={styles.sessionRow}>
        <div className={styles.sessionIdentity}>
          {session.sourceAvailable === false ? (
            <span>
              {session.title ?? session.sessionId} ·{" "}
              {t("issuesSourceUnavailable")}
            </span>
          ) : (
            <SessionListItem
              sessionId={session.sessionId}
              projectId={session.projectId}
              title={session.title ?? session.sessionId}
              initialPrompt={session.initialPrompt}
              lastAgentText={session.lastAgentText}
              provider={session.provider}
              model={session.model}
              status={session.ownership}
              activity={session.activity}
              updatedAt={session.updatedAt}
              createdAt={session.createdAt}
              mode="compact"
              showMenu={false}
              showProjectName
              projectName={session.projectName}
              basePath={base}
            />
          )}
        </div>
        <IconButton
          className={styles.iconButton}
          label={t("issuesAssociationActions")}
          onClick={(e) =>
            menu.openFromButton(e, [
              ...(unresolved ||
              session.state === "confirmed" ||
              session.state === "dismissed"
                ? []
                : [
                    {
                      label: t("issuesConfirm"),
                      disabled: busy,
                      onSelect: () => {
                        void action("/issues/decision", "POST", {
                          id: issueId,
                          sessionId: session.sessionId,
                          state: "confirmed",
                        });
                      },
                    },
                  ]),
              {
                label: t(
                  session.state === "dismissed"
                    ? "issuesRestore"
                    : "issuesDismiss",
                ),
                disabled: busy,
                onSelect: () => {
                  void action("/issues/decision", "POST", {
                    id: issueId,
                    sessionId: session.sessionId,
                    state:
                      session.state === "dismissed"
                        ? "discovered"
                        : "dismissed",
                  });
                },
              },
            ])
          }
        >
          ⋯
        </IconButton>
      </div>
      <div className={styles.sessionMeta}>
        <span
          title={
            session.updatedAt
              ? new Date(session.updatedAt).toLocaleString()
              : undefined
          }
        >
          {age ? t("issuesLastActivity", { age }) : t("issuesActivityUnknown")}
        </span>
        <span>
          {t(
            session.evidenceCount === 1
              ? "issuesSingleMention"
              : "issuesMentionCount",
            { count: session.evidenceCount },
          )}
        </span>
      </div>
      {(expanded ? evidence : evidence.slice(0, 1)).map((entry) =>
        excerpt(entry, !expanded),
      )}
      {session.evidenceCount > 1 && (
        <Button
          variant="ghost"
          size="small"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
            if (!expanded && evidence.length === 1) void more();
          }}
        >
          {t(expanded ? "issuesFewerMentions" : "issuesMoreMentions", {
            count: session.evidenceCount - 1,
          })}
        </Button>
      )}
      {expanded && evidence.length > 1 && nextOffset !== null && (
        <Button
          variant="ghost"
          size="small"
          disabled={loading}
          onClick={() => void more()}
        >
          {t("issuesMoreEvidence")}
        </Button>
      )}
      {loading && (
        <span className={styles.muted}>{t("issuesLoadingMentions")}</span>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      {menu.menu}
    </article>
  );
}
