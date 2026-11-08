import {
  ALL_PROVIDERS,
  PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  SESSION_CONTENT_SEARCH_CAPABILITY,
  SESSION_CREATION_PROVENANCE_CAPABILITY,
  serverHasCapability,
  providerSupportsBoundedTurnSearch,
  type ProviderName,
} from "@yep-anywhere/shared";
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { createSessionApi } from "../api/sessionClient";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { BulkActionBar } from "../components/BulkActionBar";
import { FilterDropdown } from "../components/FilterDropdown";
import { PageHeader } from "../components/PageHeader";
import { SessionListItem } from "../components/SessionListItem";
import {
  SearchHeader,
  SearchFilters,
  SearchSelection,
  SearchHelp,
} from "../components/session-search/SearchControls";
import {
  SearchPreviews,
  SearchZoomPreview,
  SearchDiagnostics,
  type SearchPreviewTarget,
} from "../components/session-search/SearchPreviews";
import {
  durationMs,
  inTimeRange,
  matchesStatus,
  statuses,
  titleMatches,
  toggleStatus,
  type SearchField,
  type SearchStatus,
  type TimeBasis,
} from "../components/session-search/model";
import { useContentSearch } from "../components/session-search/useContentSearch";
import { SearchTitle } from "../components/session-search/SearchTitle";
import { SearchSessionMatches } from "../components/session-search/SearchSessionMatches";
import {
  searchNeedles,
  useSearchIntersection,
} from "../components/session-search/useSearchIntersection";
import styles from "../components/session-search/SessionSearch.module.css";
import { useGlobalSessionsFeed } from "../hooks/useGlobalSessionsFeed";
import { useProjectQueues } from "../hooks/useProjectQueues";
import { useProcesses } from "../hooks/useProcesses";
import { useProviders } from "../hooks/useProviders";
import { usePublicShareStatus } from "../hooks/usePublicShareStatus";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import { useSessionRightPaneSetting } from "../hooks/useSessionRightPaneSetting";
import { useVersion } from "../hooks/useVersion";
import { Button } from "../components/ui/Button";
import { useModalBackGesture } from "../components/ui/Modal";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { setNewSessionPrefill } from "../lib/newSessionPrefill";
import { groupProjectsForFilter } from "../lib/projectFilterOptions";

import { sessionCollectionRecordsToGlobalSessionItems } from "../lib/sessionCollectionRecords";
import {
  useClientSummarySourceKey,
  useDraftSessionIds,
  useProjectQueuedSessionIds,
  useSessionCollectionQueryRecords,
} from "../lib/clientSummaryStore";
import { getSessionDisplayTitle } from "../utils";

interface SearchHistoryControls {
  sourceKey: string;
  fields: SearchField[];
  basis: TimeBasis;
  young: string;
  old: string;
  limit: string;
  selected: string[];
  onlySelected?: boolean;
  intersection?: boolean;
}

export function GlobalSessionsPage() {
  const sourceKey = useClientSummarySourceKey();
  return <SessionSearchPage key={sourceKey} />;
}

function SessionSearchPage() {
  const { t } = useI18n();
  const runtime = useCurrentSourceRuntime();
  const api = useMemo(
    () => createSessionApi(runtime.transport.fetch.bind(runtime.transport)),
    [runtime],
  );
  const { openSidebar, isWideScreen, setRightPaneExpanded } =
    useNavigationLayout();
  const { sessionRightPaneEnabled } = useSessionRightPaneSetting();
  const [detailHost, setDetailHost] = useState<HTMLDivElement | null>(null);
  const basePath = useRemoteBasePath();
  const navigate = useNavigate();
  const sourceKey = useClientSummarySourceKey();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [remembered] = useState(() => {
    const state = window.history.state?.yaSessionSearch as
      | SearchHistoryControls
      | undefined;
    return state?.sourceKey === sourceKey ? state : undefined;
  });
  const { settings } = useServerSettings();
  const { version } = useVersion();
  const { providers: providerInfo } = useProviders();
  const turnSearchProviders = useMemo(
    () =>
      new Set(
        ALL_PROVIDERS.filter((name) =>
          providerSupportsBoundedTurnSearch(
            name,
            providerInfo.find((provider) => provider.name === name)
              ?.supportsBoundedTurnSearch,
          ),
        ),
      ),
    [providerInfo],
  );
  const supported = serverHasCapability(
    version,
    SESSION_CONTENT_SEARCH_CAPABILITY,
  );
  const creationProvenanceAvailable = serverHasCapability(
    version,
    SESSION_CREATION_PROVENANCE_CAPABILITY,
  );
  const publicShareManagementAvailable = serverHasCapability(
    version,
    PUBLIC_SHARE_MANAGEMENT_CAPABILITY,
  );
  const { status: publicShareStatus } = usePublicShareStatus({
    poll: settings?.publicSharesEnabled ?? false,
  });
  const { processes, terminatedProcesses } = useProcesses();
  const children = useMemo(
    () =>
      new Map(
        [...processes, ...terminatedProcesses]
          .filter((p) => p.providerChildren?.length)
          .map((p) => [p.sessionId, p.providerChildren]),
      ),
    [processes, terminatedProcesses],
  );
  const query = params.get("q") ?? "";
  const [intersection, setIntersection] = useState(
    remembered?.intersection ?? true,
  );
  const needles = useMemo(
    () => searchNeedles(query, intersection),
    [query, intersection],
  );
  const firstNeedle = needles[0] ?? "";
  const project = params.get("project") ?? "";
  const providerParam = params.get("provider") ?? "";
  const executorParam = params.get("executor") ?? "";
  const createdParam = params.get("created") ?? "";
  const statusParam = params.get("status") ?? "unarchived";
  const providers = useMemo(
    () =>
      providerParam
        .split(",")
        .filter((p): p is ProviderName =>
          ALL_PROVIDERS.includes(p as ProviderName),
        ),
    [providerParam],
  );
  const executors = useMemo(
    () => executorParam.split(",").filter(Boolean),
    [executorParam],
  );
  const created = useMemo(
    () =>
      createdParam
        .split(",")
        .filter((value) =>
          ["web", "desktop", "api", "unspecified"].includes(value),
        ),
    [createdParam],
  );
  const filters = useMemo(
    () =>
      statusParam
        .split(",")
        .filter((s): s is SearchStatus =>
          (statuses as readonly string[]).includes(s),
        ),
    [statusParam],
  );
  const [fields, setFields] = useState<SearchField[]>(
    remembered?.fields ?? ["title"],
  );
  const effectiveFields = useMemo(
    () => (supported ? fields : fields.filter((f) => f === "title")),
    [fields, supported],
  );
  const [basis, setBasis] = useState<TimeBasis>(
    remembered?.basis ?? "activity",
  );
  const [young, setYoung] = useState(
    remembered?.young ?? params.get("age") ?? "",
  );
  const [old, setOld] = useState(remembered?.old ?? "");
  const [limit, setLimit] = useState(remembered?.limit ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(remembered?.selected),
  );
  const [onlySelected, setOnlySelected] = useState(
    remembered?.onlySelected ?? false,
  );
  // An empty selection cannot restrict anything, so the toggle waits for one.
  const withinSelection = onlySelected && selected.size > 0;
  useLayoutEffect(() => {
    if (window.history.state?.key !== location.key) return;
    const controls: SearchHistoryControls = {
      sourceKey,
      fields,
      basis,
      young,
      old,
      limit,
      selected: [...selected],
      onlySelected,
      intersection,
    };
    window.history.replaceState(
      { ...window.history.state, yaSessionSearch: controls },
      "",
    );
  }, [
    location.key,
    sourceKey,
    fields,
    basis,
    young,
    old,
    limit,
    selected,
    onlySelected,
    intersection,
  ]);
  const [manage, setManage] = useState(false);
  const [zoomed, setZoomed] = useState<SearchPreviewTarget>();
  const [expanded, setExpanded] = useState<SearchPreviewTarget["session"]>();
  const paneOpen = sessionRightPaneEnabled && !!(zoomed || expanded);
  // One history owner survives switching between the match list and a turn.
  useModalBackGesture(() => {
    setZoomed(undefined);
    setExpanded(undefined);
  }, paneOpen);
  useEffect(() => {
    setRightPaneExpanded?.(paneOpen);
    return () => setRightPaneExpanded?.(false);
  }, [paneOpen, setRightPaneExpanded]);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const changeParam = useCallback(
    (key: string, value: string) =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value || key === "status") next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const onQuery = useCallback(
    (value: string) => changeParam("q", value),
    [changeParam],
  );

  // Keep the catalog independent of filters so hidden selections remain actionable.
  const feed = useGlobalSessionsFeed({
    includeArchived: true,
    includeStats: true,
    limit: 500,
  });
  const records = useSessionCollectionQueryRecords(feed.query);
  const sessions = useMemo(
    () => sessionCollectionRecordsToGlobalSessionItems(records),
    [records],
  );
  const projectGroups = useMemo(
    () => groupProjectsForFilter(feed.projects, sessions, Date.now()),
    [feed.projects, sessions],
  );
  useEffect(() => {
    if (feed.hasMore && !feed.loading && !feed.error) void feed.loadMore();
  }, [feed.hasMore, feed.loading, feed.error, feed.loadMore]);
  const min = durationMs(young, 0),
    max = durationMs(old, Infinity);
  const invalidRange = !Number.isFinite(min) || Number.isNaN(max) || min > max;
  const invalidLimit = limit !== "" && !/^[1-9]\d*$/.test(limit);
  const bounds = useMemo(() => {
    const now = Date.now();
    return {
      after: Number.isFinite(max) ? now - max : undefined,
      before: min > 0 ? now - min : undefined,
    };
  }, [min, max]);
  const exclusions = useMemo(
    () =>
      new Map(
        sessions.map((s) => {
          const reasons: string[] = [];
          if (withinSelection && !selected.has(s.id))
            reasons.push(t("sessionSearchOutsideSelection"));
          if (project && s.projectId !== project)
            reasons.push(t("sessionSearchOutsideProject"));
          if (providers.length && !providers.includes(s.provider))
            reasons.push(t("sessionSearchOutsideProvider"));
          if (executors.length && !executors.includes(s.executor ?? "local"))
            reasons.push(t("sessionSearchOutsideExecutor"));
          if (
            creationProvenanceAvailable &&
            created.length &&
            !created.includes(s.creationProvenance?.surface ?? "unspecified")
          )
            reasons.push(t("sessionSearchOutsideCreation"));
          for (const status of filters) {
            if (!matchesStatus(s, status))
              reasons.push(
                t("sessionSearchOutsideStatus", {
                  status: t(`sessionSearchStatus_${status}`),
                }),
              );
          }
          if (
            basis !== "turns" &&
            !inTimeRange(
              basis === "created" ? s.createdAt : s.updatedAt,
              bounds.after,
              bounds.before,
            )
          )
            reasons.push(t("sessionSearchOutsideTime"));
          return [s.id, reasons];
        }),
      ),
    [
      sessions,
      withinSelection,
      selected,
      project,
      providers,
      executors,
      created,
      creationProvenanceAvailable,
      filters,
      basis,
      bounds,
      t,
    ],
  );
  const candidates = useMemo(
    () => sessions.filter((s) => !exclusions.get(s.id)?.length),
    [sessions, exclusions],
  );
  const [viewportRows, setViewportRows] = useState(Infinity);
  const [helpInline, setHelpInline] = useState(false);
  const contentCandidates = useMemo(
    () =>
      candidates
        .filter((session) => turnSearchProviders.has(session.provider))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [candidates, turnSearchProviders],
  );
  const resultList = useRef<HTMLUListElement>(null);
  const acquisition = useContentSearch(
    contentCandidates,
    firstNeedle,
    effectiveFields,
    supported && !invalidRange,
    basis === "turns" ? bounds.after : undefined,
    basis === "turns" ? bounds.before : undefined,
    viewportRows,
  );
  const filtered = useSearchIntersection(acquisition.matches, needles);
  const partial = useMemo(() => {
    if (!filtered.incomplete?.size) return acquisition.partial;
    const reasons = new Map(acquisition.partial);
    for (const id of filtered.incomplete)
      reasons.set(id, t("sessionSearchIntersectionIncomplete"));
    return reasons;
  }, [acquisition.partial, filtered.incomplete, t]);
  const scan = {
    ...acquisition,
    partial,
    matches: filtered.matches,
    running: acquisition.running || filtered.filtering,
  };
  const discoveryOrder = useRef(new Map<string, number>());
  const orderedNeedle = useRef(query);
  const results = useMemo(() => {
    // Rank is first sighting under the current needle: rows stay put while a
    // scan streams in, and a new needle starts ranking again from catalog
    // order instead of replaying where each session happened to appear first
    // under some earlier search.
    if (orderedNeedle.current !== query) {
      orderedNeedle.current = query;
      discoveryOrder.current = new Map();
    }
    const found = invalidRange
      ? []
      : candidates.flatMap((session) => {
          const turns = scan.matches.get(session.id) ?? [];
          const titles = effectiveFields.includes("title")
            ? titleMatches(
                session,
                firstNeedle,
                basis === "turns" ? bounds.after : undefined,
                basis === "turns" ? bounds.before : undefined,
                needles.slice(1),
              )
            : [];
          const matches = [...titles, ...turns];
          return !query.trim() || matches.length ? [{ session, matches }] : [];
        });
    for (const result of found)
      if (!discoveryOrder.current.has(result.session.id))
        discoveryOrder.current.set(
          result.session.id,
          discoveryOrder.current.size,
        );
    return found.sort(
      (a, b) =>
        discoveryOrder.current.get(a.session.id)! -
        discoveryOrder.current.get(b.session.id)!,
    );
  }, [
    invalidRange,
    candidates,
    scan.matches,
    effectiveFields,
    query,
    firstNeedle,
    needles,
    basis,
    bounds,
  ]);
  const shownIds = useMemo(
    () => new Set(results.map(({ session }) => session.id)),
    [results],
  );
  const drafts = useDraftSessionIds();
  const projectIds = useMemo(
    () => [...new Set(results.map(({ session }) => session.projectId))],
    [results],
  );

  useProjectQueues(projectIds);
  const queuedIds = useProjectQueuedSessionIds(projectIds);
  const queues = queuedIds;

  const select = useCallback(
    (id: string, checked: boolean) =>
      setSelected((previous) => {
        const next = new Set(previous);
        if (checked) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const selectedSessions = useMemo(
    () => sessions.filter((session) => selected.has(session.id)),
    [sessions, selected],
  );
  const apply = async (action: SearchStatus) => {
    if (pending || !selected.size) return;
    setPending(true);
    setActionError(undefined);
    try {
      const ids = [...selected];
      for (let offset = 0; offset < ids.length; offset += 8) {
        await Promise.all(
          ids.slice(offset, offset + 8).map((id) => {
            switch (action) {
              case "archived":
                return api.updateSessionMetadata(id, { archived: true });
              case "unarchived":
                return api.updateSessionMetadata(id, { archived: false });
              case "starred":
                return api.updateSessionMetadata(id, { starred: true });
              case "unstarred":
                return api.updateSessionMetadata(id, { starred: false });
              case "read":
                return api.markSessionSeen(id);
              case "unread":
                return api.markSessionUnread(id);
              default:
                throw new Error(`Unknown session status: ${action}`);
            }
          }),
        );
      }
      setSelected(new Set());
      await feed.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };
  const activeProject = feed.projects.find((p) => p.id === project);
  const startSession = () => {
    if (!project) return;
    if (query.trim()) setNewSessionPrefill(sourceKey, query.trim());
    navigate(
      `${basePath}/new-session?projectId=${encodeURIComponent(project)}`,
    );
  };
  const progress = scan.running || feed.loading || feed.hasMore;
  const limitNumber = !limit || invalidLimit ? Infinity : Number(limit);
  const layoutKey = query;
  const [compactedSearch, setCompactedSearch] = useState<string>();
  const hasTurnFields = effectiveFields.some((field) => field !== "title");
  const updateFields = useCallback(
    (next: SearchField[]) => {
      setFields(next);
      if (!scan.running && scan.scanned > 0) setCompactedSearch(query);
    },
    [scan.running, scan.scanned, query],
  );
  const streamingLayout =
    hasTurnFields && !!query.trim() && compactedSearch !== layoutKey;
  const limitAnchor = useRef<{ element: HTMLElement; top: number } | undefined>(
    undefined,
  );
  const adjustLimit = (delta: number, shown: number, element: HTMLElement) => {
    limitAnchor.current = { element, top: element.getBoundingClientRect().top };
    setLimit(
      String(
        Math.max(
          1,
          (Number.isFinite(limitNumber) ? limitNumber : shown) + delta,
        ),
      ),
    );
    setCompactedSearch(layoutKey);
  };
  useLayoutEffect(() => {
    const anchor = limitAnchor.current;
    limitAnchor.current = undefined;
    const scroller = anchor?.element.closest(".page-scroll-container");
    if (anchor && scroller)
      scroller.scrollTop +=
        anchor.element.getBoundingClientRect().top - anchor.top;
  });
  useEffect(
    () =>
      setCompactedSearch((previous) =>
        previous === layoutKey ? undefined : previous,
      ),
    [layoutKey],
  );
  // Expansion out of the initial streaming shape waits for the scan to finish
  // and for input to go quiet. Completion is re-checked when the quiet period
  // elapses rather than gating entry to this effect: a needle refinement
  // starts a scan, so gating on `scan.running` meant the effect bailed at the
  // moment the needle changed, and the run that would have armed the timer
  // afterwards never arrived. The rows then stayed clamped to one preview per
  // role for good, however long the reader waited (fixed 2026-09-17; the
  // "refines cached turns" browser checks cover it).
  //
  // The quiet period is also measured from completion, not from whenever the
  // timer last happened to be armed. `scan.running` is a dependency again —
  // without the early return that caused the clamp — so a scan finishing
  // rearms a full 500ms. Otherwise a timer armed mid-scan could come due a few
  // milliseconds after the last match arrived and reflow the row in the same
  // breath, which is exactly the "completion alone does not immediately
  // reflow" case the reserved streaming height exists to cover (fixed
  // 2026-09-18; the "reserves arriving matches" browser checks cover it).
  const scanRunning = useRef(scan.running);
  scanRunning.current = scan.running;
  useEffect(() => {
    scanRunning.current = scan.running;
    if (!hasTurnFields || compactedSearch === layoutKey) return;
    let timer: ReturnType<typeof setTimeout>;
    const settle = () => {
      // Still acquiring: wait out another quiet period instead of expanding
      // mid-scan, which is what the streaming shape exists to avoid.
      if (scanRunning.current) {
        idle();
        return;
      }
      startTransition(() => setCompactedSearch(layoutKey));
    };
    const idle = () => {
      clearTimeout(timer);
      timer = setTimeout(settle, 500);
    };
    idle();
    window.addEventListener("pointermove", idle);
    window.addEventListener("keydown", idle);
    window.addEventListener("wheel", idle);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", idle);
      window.removeEventListener("keydown", idle);
      window.removeEventListener("wheel", idle);
    };
  }, [scan.running, layoutKey, compactedSearch, hasTurnFields]);
  const [renderWindow, setRenderWindow] = useState({ query, count: 40 });
  const renderedCount = renderWindow.query === query ? renderWindow.count : 40;
  const more = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!results.length) return;
    const list = resultList.current;
    const row = list?.firstElementChild;
    const main = list?.closest("main");
    if (!list || !row || !main || !streamingLayout) return;
    const measure = () => {
      const height =
        row.getBoundingClientRect().height +
        Number.parseFloat(getComputedStyle(list).rowGap);
      const space =
        main.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
      if (height > 0) setViewportRows(Math.max(1, Math.ceil(space / height)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(main);
    return () => observer.disconnect();
  }, [streamingLayout, results.length]);
  const showMore = useCallback(
    () =>
      startTransition(() =>
        setRenderWindow((previous) => ({
          query,
          count: (previous.query === query ? previous.count : 40) + 40,
        })),
      ),
    [query],
  );
  useEffect(() => {
    if (results.length <= renderedCount) return;
    const element = more.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) showMore();
      },
      { root: element.closest("main"), rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [showMore, renderedCount, results.length]);
  return (
    <MainContent
      isWideScreen={isWideScreen}
      innerClassName={paneOpen ? styles.withDetail : undefined}
    >
      <PageHeader
        title={t("globalSessionsTitle")}
        onOpenSidebar={openSidebar}
        isWideScreen={isWideScreen}
        titleElement={
          <SearchHeader
            query={query}
            onQuery={onQuery}
            intersection={intersection}
            onIntersection={setIntersection}
            fields={effectiveFields}
            onFields={updateFields}
            supported={supported}
            supportKnown={version !== null && version !== undefined}
            sessionCount={
              effectiveFields.includes("title")
                ? candidates.length
                : effectiveFields.length
                  ? contentCandidates.length
                  : 0
            }
            scanning={scan.running}
            acquiring={scan.acquiring || feed.loading || feed.hasMore}
            status={
              scan.running
                ? t("sessionSearchProgress", {
                    count: scan.scanned,
                    total: contentCandidates.length,
                  })
                : scan.limited
                  ? t("sessionSearchCapped", { count: scan.limited })
                  : feed.loading || feed.hasMore
                    ? t("sessionSearchLoadingCatalog")
                    : t("sessionSearchWatching")
            }
          />
        }
      />
      <main className="page-scroll-container">
        <div
          className={`${styles.content} ${selected.size ? styles.withBulkBar : ""}`}
        >
          <SearchFilters
            basis={basis}
            onBasis={setBasis}
            young={young}
            old={old}
            onYoung={setYoung}
            onOld={setOld}
            limit={limit}
            onLimit={setLimit}
            showLimit={effectiveFields.some((field) => field !== "title")}
          >
            <FilterDropdown
              label={t("sessionSearchProjects")}
              className={styles.dropdownContainer}
              placeholder={t("sessionSearchProjects")}
              align="right"
              triggerClassName={styles.dropdown}
              options={[
                // An explicit first row, so returning to every project is a
                // visible choice rather than a re-click on the current one.
                {
                  value: "",
                  label: t("globalSessionsFilterProjectPlaceholder"),
                  clearSelection: true,
                },
                ...projectGroups.current.map((p) => ({
                  value: p.id,
                  label: p.name,
                })),
                ...projectGroups.older.map((p, index) => ({
                  value: p.id,
                  label: p.name,
                  groupLabelBefore:
                    index === 0 && projectGroups.current.length > 0
                      ? t("globalSessionsFilterProjectOlder")
                      : undefined,
                })),
              ]}
              selected={project ? [project] : []}
              onChange={(value) => changeParam("project", value[0] ?? "")}
              multiSelect={false}
            />
            <FilterDropdown
              label={t("sessionSearchProviders")}
              className={styles.dropdownContainer}
              placeholder={t("sessionSearchProviders")}
              align="right"
              triggerClassName={styles.dropdown}
              options={ALL_PROVIDERS.filter((p) =>
                sessions.some((s) => s.provider === p),
              ).map((p) => ({
                value: p,
                label: p,
                description: t(
                  !supported
                    ? "sessionSearchProviderUpgrade"
                    : turnSearchProviders.has(p)
                      ? "sessionSearchProviderBounded"
                      : "sessionSearchProviderTitleOnly",
                ),
              }))}
              selected={providers}
              onChange={(value) => changeParam("provider", value.join(","))}
            />
            {Object.keys(feed.stats.executorCounts).length > 1 && (
              <FilterDropdown
                label={t("globalSessionsFilterExecutor")}
                placeholder={t("globalSessionsFilterMachinePlaceholder")}
                triggerClassName={styles.dropdown}
                options={Object.keys(feed.stats.executorCounts).map(
                  (value) => ({ value, label: value }),
                )}
                selected={executors}
                onChange={(value) => changeParam("executor", value.join(","))}
              />
            )}
            {creationProvenanceAvailable && (
              <FilterDropdown
                label={t("sessionSearchCreatedFrom")}
                placeholder={t("sessionSearchCreatedFromPlaceholder")}
                align="right"
                triggerClassName={styles.dropdown}
                options={[
                  { value: "web", label: t("sessionSearchCreatedWeb") },
                  {
                    value: "desktop",
                    label: t("sessionSearchCreatedDesktop"),
                  },
                  { value: "api", label: t("sessionSearchCreatedApi") },
                  {
                    value: "unspecified",
                    label: t("sessionSearchCreatedUnspecified"),
                  },
                ]}
                selected={created}
                onChange={(value) => changeParam("created", value.join(","))}
              />
            )}
          </SearchFilters>
          <SearchSelection
            helpInline={helpInline}
            onHelpInline={setHelpInline}
            count={selected.size}
            shown={results.length}
            allShownSelected={results.every(({ session }) =>
              selected.has(session.id),
            )}
            filters={filters}
            onToggle={(status) =>
              changeParam("status", toggleStatus(filters, status).join(","))
            }
            onSelectShown={() =>
              setSelected((previous) => new Set([...previous, ...shownIds]))
            }
            onClear={() => setSelected(new Set())}
            onlySelected={onlySelected}
            onOnlySelected={setOnlySelected}
            onManage={() => setManage((value) => !value)}
            pending={pending}
          />
          {activeProject && (
            <div className={`global-sessions-project-cta ${styles.projectCta}`}>
              <div>
                <strong>
                  {t("sidebarNewSession")}{" "}
                  <code className="global-sessions-project-cta__token">
                    {activeProject.name}
                  </code>
                </strong>
                <span>
                  {query.trim()
                    ? t("globalSessionsProjectCtaPromptLabel")
                    : t("globalSessionsProjectCtaHint")}{" "}
                  <code className="global-sessions-project-cta__token">
                    {query.trim() || activeProject.name}
                  </code>
                </span>
              </div>
              <Button variant="primary" onClick={startSession}>
                {t("sidebarNewSession")}
              </Button>
            </div>
          )}
          {invalidRange && (
            <p role="alert" className={styles.error}>
              {t("sessionSearchInvalidRange")}
            </p>
          )}
          {!effectiveFields.length && query.trim() && (
            <p role="status" className={styles.progress}>
              {t("sessionSearchChooseField")}
            </p>
          )}
          {invalidLimit && (
            <p role="alert" className={styles.error}>
              {t("sessionSearchInvalidLimit")}
            </p>
          )}
          {(feed.error || scan.error || actionError) && (
            <p role="alert" className={styles.error}>
              {feed.error?.message ?? scan.error ?? actionError}
            </p>
          )}
          {!progress && !feed.error && !scan.error && !results.length && (
            <p className={styles.progress}>
              {t("globalSessionsNoResultsTitle")}
            </p>
          )}
          <ul ref={resultList} className={styles.results}>
            {results.slice(0, renderedCount).map(({ session, matches }) => (
              <SessionListItem
                key={session.id}
                sessionId={session.id}
                projectId={session.projectId}
                title={getSessionDisplayTitle(session)}
                titleContent={
                  <SearchTitle
                    text={
                      matches.find((match) => match.role === "title")
                        ?.fullText ?? getSessionDisplayTitle(session)
                    }
                    query={effectiveFields.includes("title") ? firstNeedle : ""}
                  />
                }
                fullTitle={session.fullTitle ?? getSessionDisplayTitle(session)}
                initialPrompt={session.initialPrompt}
                hasCustomTitle={!!session.customTitle}
                lastAgentText={session.lastAgentText}
                updatedAt={session.updatedAt}
                createdAt={session.createdAt}
                hasUnread={session.hasUnread}
                activity={session.activity}
                pendingInputType={session.pendingInputType}
                status={session.ownership}
                provider={session.provider}
                model={session.model}
                parentSessionId={session.parentSessionId}
                parentSessionKind={session.parentSessionKind}
                providerChildren={
                  children.get(session.id) ?? session.providerChildren
                }
                executor={session.executor}
                isStarred={session.isStarred}
                isArchived={session.isArchived}
                mode="card"
                showContextUsage={false}
                isSelected={selected.has(session.id)}
                onSelect={select}
                showProjectName={!project}
                projectName={session.projectName}
                basePath={basePath}
                messageCount={session.messageCount}
                hasDraft={drafts.has(session.id)}
                hasProjectQueue={queues.has(session.id)}
                publicShareCreationReady={publicShareStatus?.canCreate ?? false}
                publicShareManagementAvailable={publicShareManagementAvailable}
                openMessageId={matches.find((m) => m.role !== "title")?.id}
                searchPreviews={
                  <SearchPreviews
                    onExpand={() => setExpanded(session)}
                    limit={limitNumber}
                    onAdjustLimit={adjustLimit}
                    session={session}
                    matches={matches}
                    streamingRows={
                      streamingLayout &&
                      turnSearchProviders.has(session.provider)
                        ? Math.min(
                            Number.isFinite(limitNumber) ? limitNumber : 1,
                            effectiveFields.filter((field) => field !== "title")
                              .length,
                          )
                        : 0
                    }
                    query={firstNeedle}
                    basePath={basePath}
                    onZoom={setZoomed}
                  />
                }
              />
            ))}
          </ul>
          {results.length > renderedCount && (
            <Button ref={more} onClick={showMore}>
              {t("sessionSearchMore")}
            </Button>
          )}
          {!helpInline && <SearchHelp />}
          <div className={styles.footer}>
            {manage && (
              <section
                className={styles.manager}
                aria-label={t("sessionSearchManage")}
              >
                <strong>{t("sessionSearchManage")}</strong>
                {sessions
                  .filter(
                    (session) =>
                      // A selected session is always listed, whatever its
                      // provider: this list is the only place a selection made
                      // on a title-search row can be removed.
                      selected.has(session.id) ||
                      turnSearchProviders.has(session.provider),
                  )
                  .map((session) => (
                    <label key={session.id}>
                      <input
                        type="checkbox"
                        checked={selected.has(session.id)}
                        onChange={(e) => select(session.id, e.target.checked)}
                      />
                      <span>
                        {getSessionDisplayTitle(session)}{" "}
                        <small>· {session.provider}</small>{" "}
                        {!shownIds.has(session.id) && (
                          <small>
                            {exclusions.get(session.id)?.join("; ") ||
                              (invalidRange
                                ? t("sessionSearchInvalidRange")
                                : !effectiveFields.length
                                  ? t("sessionSearchChooseField")
                                  : (scan.partial.get(session.id) ??
                                    scan.error ??
                                    t(
                                      scan.running
                                        ? "sessionSearchNotFoundYet"
                                        : "sessionSearchNoTextMatch",
                                    )))}
                          </small>
                        )}
                      </span>
                    </label>
                  ))}
              </section>
            )}
            <SearchDiagnostics
              sessions={sessions}
              partial={scan.partial}
              diagnostics={scan.diagnostics}
              basePath={basePath}
            />
          </div>
          {!supported && (
            <p className={styles.help}>{t("sessionSearchUpgrade")}</p>
          )}
        </div>
        <BulkActionBar
          selectedCount={selected.size}
          onArchive={() => apply("archived")}
          onUnarchive={() => apply("unarchived")}
          onStar={() => apply("starred")}
          onUnstar={() => apply("unstarred")}
          onMarkRead={() => apply("read")}
          onMarkUnread={() => apply("unread")}
          onClearSelection={() => setSelected(new Set())}
          isPending={pending}
          canArchive={selectedSessions.some((s) => !s.isArchived)}
          canUnarchive={selectedSessions.some((s) => s.isArchived)}
          canStar={selectedSessions.some((s) => !s.isStarred)}
          canUnstar={selectedSessions.some((s) => s.isStarred)}
          canMarkRead={selectedSessions.some((s) => s.hasUnread)}
          canMarkUnread={selectedSessions.some((s) => !s.hasUnread)}
        />
      </main>
      {paneOpen && <div ref={setDetailHost} className={styles.detailHost} />}
      {expanded && !(paneOpen && zoomed) && (!paneOpen || detailHost) && (
        <SearchSessionMatches
          session={
            sessions.find((session) => session.id === expanded.id) ?? expanded
          }
          matches={
            results.find(({ session }) => session.id === expanded.id)
              ?.matches ?? []
          }
          query={firstNeedle}
          running={scan.running}
          limited={scan.limitedSessions.has(expanded.id)}
          partial={scan.partial}
          diagnostics={scan.diagnostics}
          basePath={basePath}
          onZoom={setZoomed}
          paneTarget={paneOpen ? detailHost : undefined}
          onClose={() => setExpanded(undefined)}
        />
      )}
      {zoomed && (!paneOpen || detailHost) && (
        <SearchZoomPreview
          target={zoomed}
          paneTarget={paneOpen ? detailHost : undefined}
          query={firstNeedle}
          basePath={basePath}
          onClose={() => setZoomed(undefined)}
        />
      )}
    </MainContent>
  );
}
