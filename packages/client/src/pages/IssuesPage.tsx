import { IssueTypeBadge } from "./IssueTypeBadge";
import { TrackerStatusBadge } from "../components/TrackerStatusBadge";
import { formatBriefAge } from "../lib/sessionAge";
import type {
  IssueItem,
  IssueSort,
  IssueSearchResult,
  IssueSessionsResult,
} from "@yep-anywhere/shared";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useIssuesEnabled } from "../hooks/useIssuesEnabled";
import { useLongPress } from "../hooks/useLongPress";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { PageHeader } from "../components/PageHeader";
import {
  Button,
  ButtonBase,
  buttonClassName,
  IconButton,
} from "../components/ui/Button";
import { Banner } from "../components/ui/Banner";
import { Checkbox } from "../components/ui/Checkbox";
import { Field, Select, TextInput } from "../components/ui/Field";
import { MainContent, useNavigationLayout } from "../layouts";
import { useSourceContextMenu } from "../components/SourceContextMenu";
import { IssueSessionRow } from "./IssueSessionRow";
import styles from "./IssuesPage.module.css";

export function IssuesPage() {
  const { t } = useI18n();
  const { isWideScreen } = useNavigationLayout();
  const enabled = useIssuesEnabled();
  const runtime = useCurrentSourceRuntime();
  const [scopeParams] = useSearchParams();
  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader title={t("issuesTitle")} />
      {enabled ? (
        <IssueBrowser key={`${runtime.sourceKey}:${scopeParams.toString()}`} />
      ) : (
        <p className={styles.empty}>{t("issuesDisabled")}</p>
      )}
    </MainContent>
  );
}
function IssueBrowser() {
  const { t } = useI18n();
  const { transport } = useCurrentSourceRuntime();
  const base = useRemoteBasePath();
  const [params] = useSearchParams();
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [result, setResult] = useState<IssueSearchResult>();
  const [selected, setSelected] = useState<IssueItem>();
  const [detail, setDetail] = useState<IssueSessionsResult>();
  const [body, setBody] = useState<{ id: string; text: string }>();
  // The dismissed filter `detail` was fetched under; the checkbox can change
  // before its replacement arrives.
  const [detailIncludesDismissed, setDetailIncludesDismissed] = useState(false);
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sort, setSort] = useState("activity");
  const [issueSort, setIssueSort] = useState<IssueSort>("activity");
  const supportedIssueSort =
    result?.supportedSorts?.includes(issueSort) ?? false;
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{
    item: IssueItem;
    kind: "title" | "url" | "delete";
  }>();
  const [value, setValue] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const sessionId = params.get("sessionId") ?? "";
  const projectId = params.get("projectId") ?? "";
  const menu = useSourceContextMenu(t, {
    menu: t("issuesItemActions"),
  });
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Tracker states arrive shortly after the read that asked for them.
    let statusRechecks = 0;
    const load = async () => {
      try {
        const next = await transport.fetch<IssueSearchResult>(
          `/issues?${new URLSearchParams({ q: query, offset: String(offset), dismissed: dismissed ? "1" : "0", sessionId, projectId, revision: String(revision), ...(supportedIssueSort ? { sort: issueSort } : {}) })}`,
        );
        if (!disposed) {
          setResult(next);
          setSelected((previous) => {
            const current = next.items.find((item) => item.id === previous?.id);
            return current &&
              previous &&
              (current.title !== previous.title ||
                current.url !== previous.url ||
                current.sessionCount !== previous.sessionCount)
              ? current
              : previous;
          });
          if (
            (next.coverage.active || next.contentRefresh?.active) &&
            !document.hidden
          )
            timer = setTimeout(load, 750);
          else if (next.statusRefreshing && statusRechecks++ < 3)
            timer = setTimeout(load, 1500);
        }
      } catch {
        if (!disposed) setError(t("issuesLoadError"));
      }
    };
    timer = setTimeout(() => void load(), 150);
    const visible = () => {
      if (!document.hidden) {
        if (timer) clearTimeout(timer);
        void load();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [
    transport,
    query,
    offset,
    dismissed,
    sessionId,
    projectId,
    revision,
    supportedIssueSort,
    issueSort,
    t,
  ]);
  useEffect(() => {
    let disposed = false;
    if (selected)
      void transport
        .fetch<IssueSessionsResult>(
          `/issues/sessions?${new URLSearchParams({ id: selected.id, offset: String(sessionOffset), sort, dismissed: dismissed ? "1" : "0", revision: String(revision) })}`,
        )
        .then((next) => {
          if (disposed) return;
          setDetail(next);
          setDetailIncludesDismissed(dismissed);
        })
        .catch(() => {
          if (!disposed) setError(t("issuesLoadError"));
        });
    return () => {
      disposed = true;
    };
  }, [transport, selected, sessionOffset, sort, dismissed, revision, t]);
  const action = async (
    path: string,
    method: string,
    body?: unknown,
    saved?: (result: { title?: string | null }) => void,
  ) => {
    setBusy(true);
    setError("");
    try {
      const response = await transport.fetch<{ title?: string | null }>(path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (alive.current) {
        saved?.(response);
        setRevision((x) => x + 1);
        return true;
      }
    } catch {
      if (alive.current) setError(t("issuesSaveError"));
    } finally {
      if (alive.current) setBusy(false);
    }
    return false;
  };
  const select = (item: IssueItem) => {
    setEditing(undefined);
    setSelected(item);
    setSessionOffset(0);
    // Only picking an issue empties the pane. A refresh leaves the rows mounted
    // until the new answer arrives, so an expanded row keeps the mentions it
    // has already loaded.
    if (item.id !== selected?.id) setDetail(undefined);
    if (result?.contentRefresh && !item.unresolved)
      void action("/issues/refresh", "POST", { force: true, id: item.id });
  };
  const supportsContent = result?.contentRefresh !== undefined;
  const refreshing = result?.contentRefresh?.active ?? false;
  useEffect(() => {
    let disposed = false;
    if (selected && supportsContent)
      void transport
        .fetch<{ content: { body: string | null } | null }>(
          `/issues/content?${new URLSearchParams({ id: selected.id, revision: `${revision}:${refreshing}` })}`,
        )
        .then(({ content }) => {
          if (!disposed)
            setBody({ id: selected.id, text: content?.body ?? "" });
        })
        .catch(() => {
          if (!disposed) setError(t("issuesLoadError"));
        });
    return () => {
      disposed = true;
    };
  }, [selected, supportsContent, refreshing, revision, transport, t]);
  const refresh = (force: boolean) => {
    if (busy || refreshing) return;
    if (supportsContent) void action("/issues/refresh", "POST", { force });
    else setRevision((x) => x + 1);
  };
  const refreshPress = useLongPress(() => refresh(true));
  const edit = (item: IssueItem, kind: "title" | "url" | "delete") => {
    if (kind === "url") select(item);
    setEditing({ item, kind });
    setValue(kind === "title" ? (item.title ?? "") : "");
  };
  const saveEdit = async () => {
    if (!editing) return;
    const { item, kind } = editing;
    let ok = false;
    if (kind === "title") {
      ok = await action(
        "/issues/item",
        "PATCH",
        { id: item.id, title: value.trim() || null },
        (response) => {
          setSelected((previous) =>
            previous?.id === item.id
              ? {
                  ...previous,
                  title:
                    response.title !== undefined
                      ? response.title
                      : value.trim() || null,
                }
              : previous,
          );
        },
      );
    } else if (kind === "delete") {
      ok = await action(
        `/issues/item?${new URLSearchParams({ id: item.id })}`,
        "DELETE",
      );
      if (ok)
        setSelected((previous) =>
          previous?.id === item.id ? undefined : previous,
        );
    } else {
      const first = detail?.sessions[0];
      if (first) {
        ok = await action("/issues/resolve", "POST", {
          url: value,
          key: item.key,
          projectId: first.projectId,
          sessionId: first.sessionId,
        });
        if (ok) setSelected(undefined);
      }
    }
    if (ok) setEditing(undefined);
  };
  return (
    <main className={styles.page}>
      <div className={styles.controls}>
        <TextInput
          className={styles.search}
          type="search"
          aria-label={t("issuesSearch")}
          placeholder={t("issuesSearch")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
        <IconButton
          className={styles.toolbarIcon}
          label={t("issuesRefresh")}
          tooltip={supportsContent ? t("issuesRefreshHint") : undefined}
          disabled={busy || refreshing}
          {...refreshPress.handlers}
          onClick={refreshPress.click(() => refresh(false))}
          onKeyDown={(event) => {
            if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              refresh(true);
            }
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 7v5h-5M4 17v-5h5" />
            <path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 17.9 17" />
          </svg>
        </IconButton>
        <Link
          className={buttonClassName({
            variant: "ghost",
            icon: true,
            className: styles.toolbarIcon,
          })}
          to={`${base}/settings/issues`}
          aria-label={t("issuesSettings")}
          title={t("issuesSettings")}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </Link>
      </div>
      {result?.contentRefresh &&
        (result.contentRefresh.active ||
          result.contentRefresh.checked > 0 ||
          result.contentRefresh.error) && (
          <p className={styles.muted} role="status">
            {result.contentRefresh.active
              ? t("issuesRefreshingContent")
              : t("issuesRefreshedContent")}{" "}
            {t("issuesRefreshCounts", {
              checked: result.contentRefresh.checked,
              skipped: result.contentRefresh.skipped,
              failed: result.contentRefresh.failed,
            })}
            {result.contentRefresh.error && ` ${result.contentRefresh.error}`}
          </p>
        )}
      <details className={styles.coverage}>
        <summary>
          {result?.coverage.active
            ? t("issuesIndexing")
            : t("issuesDiscoveryDetails")}
        </summary>
        {result && (
          <p>
            {result.coverage.settings.scope === "viewed"
              ? t("issuesViewedCoverage")
              : t("issuesRecentCoverage", {
                  days: result.coverage.settings.recentDays,
                })}
          </p>
        )}
        <div className={styles.actions}>
          {result?.coverage.counts.map((row) => (
            <span key={row.state}>
              {t(`issuesState_${row.state}` as never)}: {row.count}
            </span>
          ))}
        </div>
        <Checkbox
          className={styles.choice}
          label={t("issuesShowDismissed")}
          checked={dismissed}
          onCheckedChange={(checked) => {
            setDismissed(checked);
            setOffset(0);
            setSessionOffset(0);
          }}
        />
      </details>
      {sessionId && (
        <p>
          {t("issuesSessionFilter")}{" "}
          <Link to={`${base}/issues`}>{t("issuesAll")}</Link>
        </p>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      <div className={`${styles.columns} ${selected ? styles.withDetail : ""}`}>
        <section
          className={`${styles.list} ${editing ? styles.editingList : ""}`}
          aria-label={t("issuesResults")}
        >
          <div className={styles.listHeading}>
            {supportedIssueSort ? (
              <div className={styles.issueSort}>
                <label htmlFor="issues-sort">{t("issuesSortLabel")}</label>
                <Select
                  id="issues-sort"
                  className={styles.issueSortSelect}
                  size="small"
                  value={issueSort}
                  onChange={(e) => {
                    setIssueSort(e.target.value as IssueSort);
                    setOffset(0);
                  }}
                >
                  {result?.supportedSorts?.map((value) => (
                    <option key={value} value={value}>
                      {t(`issuesSort_${value}`)}
                    </option>
                  ))}
                </Select>
              </div>
            ) : (
              t("issuesKeyOrder")
            )}
          </div>
          {result?.items.length === 0 && (
            <p className={styles.empty}>{t("issuesEmpty")}</p>
          )}
          {result?.items.map((item) => (
            <div
              key={item.id}
              className={`${styles.item} ${selected?.id === item.id ? styles.selected : ""}`}
            >
              <div className={styles.itemRow}>
                <ButtonBase
                  className={styles.itemSelect}
                  aria-pressed={selected?.id === item.id}
                  onClick={() => select(item)}
                >
                  <span className={styles.itemTitle}>
                    <strong>{item.key}</strong>
                    <IssueTypeBadge item={item} />
                    <TrackerStatusBadge item={item} />
                  </span>
                  {item.title && item.title !== item.key && (
                    <span className={styles.itemSummary}>{item.title}</span>
                  )}
                  <span className={styles.itemMeta}>
                    {t(
                      item.sessionCount === 1
                        ? "issuesSingleSession"
                        : "issuesSessionCount",
                      { count: item.sessionCount },
                    )}
                    {result?.sort && result.sort !== "key" && (
                      <>
                        {" "}
                        · <IssueActivity item={item} sort={result.sort} />
                      </>
                    )}
                  </span>
                  {item.unresolved && <small>{t("issuesUnresolved")}</small>}
                </ButtonBase>
                <IconButton
                  className={styles.iconButton}
                  label={t("issuesItemMenu", { key: item.key })}
                  onClick={(e) =>
                    menu.openFromButton(e, [
                      {
                        label: t(
                          item.unresolved ? "issuesResolve" : "issuesEditTitle",
                        ),
                        onSelect: () =>
                          edit(item, item.unresolved ? "url" : "title"),
                        disabled: busy,
                      },
                      {
                        label: t("issuesDelete"),
                        onSelect: () => edit(item, "delete"),
                        disabled: busy,
                      },
                    ])
                  }
                >
                  ⋯
                </IconButton>
              </div>
              {editing?.item.id === item.id && (
                <form
                  className={styles.editor}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveEdit();
                  }}
                >
                  {editing.kind === "delete" ? (
                    <p>{t("issuesDeleteHelp")}</p>
                  ) : (
                    <Field
                      id="issue-edit-value"
                      label={t(
                        editing.kind === "title"
                          ? "issuesTitleOverride"
                          : "issuesResolveUrl",
                      )}
                      hint={
                        editing.kind === "url"
                          ? t("issuesResolveHelp")
                          : undefined
                      }
                      required={editing.kind === "url"}
                    >
                      <TextInput
                        type={editing.kind === "title" ? "text" : "url"}
                        maxLength={editing.kind === "title" ? 512 : 4096}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                      />
                    </Field>
                  )}
                  <div className={styles.actions}>
                    <Button
                      variant={editing.kind === "delete" ? "danger" : "primary"}
                      disabled={
                        busy ||
                        (editing.kind === "url" && !detail?.sessions.length)
                      }
                      type="submit"
                    >
                      {t(
                        editing.kind === "title"
                          ? "issuesSaveTitle"
                          : editing.kind === "url"
                            ? "issuesResolve"
                            : "issuesDeleteConfirm",
                      )}
                    </Button>
                    <Button onClick={() => setEditing(undefined)}>
                      {t("issuesCancel")}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          ))}
          <div className={styles.actions}>
            {offset > 0 && (
              <Button onClick={() => setOffset(Math.max(0, offset - 50))}>
                {t("issuesPrevious")}
              </Button>
            )}
            {result?.nextOffset != null && (
              <Button onClick={() => setOffset(result.nextOffset!)}>
                {t("issuesNext")}
              </Button>
            )}
          </div>
        </section>
        {selected && (
          <section
            className={styles.detail}
            aria-label={t("issuesAssociatedSessions")}
          >
            <div className={styles.actions}>
              <h2>{selected.title ?? selected.key}</h2>
              <IconButton
                label={t("issuesClose")}
                onClick={() => setSelected(undefined)}
              >
                ×
              </IconButton>
            </div>
            {selected.url && (
              <a
                className={styles.externalLink}
                href={selected.url}
                target="_blank"
                rel="noreferrer"
              >
                {selected.key} ↗
              </a>
            )}
            {body?.id === selected.id && body.text && (
              <details className={styles.description} open>
                <summary>{t("issuesBodyDescription")}</summary>
                <p className={styles.expandedExcerpt}>{body.text}</p>
              </details>
            )}
            <div className={styles.sessionHeading}>
              <h3>{t("issuesAssociatedSessions")}</h3>
              <Select
                className={styles.sortSelect}
                size="small"
                aria-label={t("issuesSessionSort")}
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setSessionOffset(0);
                }}
              >
                <option value="activity">{t("issuesActivityNewest")}</option>
                <option value="oldest">{t("issuesActivityOldest")}</option>
              </Select>
            </div>
            {!detail && (
              <p className={styles.muted}>{t("issuesLoadingSessions")}</p>
            )}
            {detail?.sessions.length === 0 && (
              <p className={styles.empty}>{t("issuesNoSessions")}</p>
            )}
            {detail?.sessions.map((session) => (
              <IssueSessionRow
                key={`${selected.id}:${session.sessionId}`}
                issueId={selected.id}
                session={session}
                unresolved={selected.unresolved}
                busy={busy}
                includeDismissed={detailIncludesDismissed}
                action={action}
              />
            ))}
            <div className={styles.actions}>
              {sessionOffset > 0 && (
                <Button
                  onClick={() =>
                    setSessionOffset(Math.max(0, sessionOffset - 50))
                  }
                >
                  {t("issuesPreviousSessions")}
                </Button>
              )}
              {detail?.nextOffset != null && (
                <Button onClick={() => setSessionOffset(detail.nextOffset!)}>
                  {t("issuesNextSessions")}
                </Button>
              )}
            </div>
          </section>
        )}
      </div>
      {menu.menu}
    </main>
  );
}

function IssueActivity({ item, sort }: { item: IssueItem; sort: IssueSort }) {
  const { t } = useI18n();
  const timestamp =
    sort === "mentioned" ? item.lastMentionAt : item.lastSessionActivityAt;
  const age = formatBriefAge(timestamp);
  return age ? (
    <time
      dateTime={timestamp ?? undefined}
      title={new Date(timestamp!).toLocaleString()}
    >
      {t(
        sort === "mentioned"
          ? "issuesRecentlyMentionedAge"
          : "issuesSessionActiveAge",
        { age },
      )}
    </time>
  ) : (
    <span>
      {t(
        sort === "mentioned"
          ? "issuesMentionTimeUnknown"
          : "issuesActivityUnknown",
      )}
    </span>
  );
}
