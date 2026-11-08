import type { IssueItem, IssueSearchResult } from "@yep-anywhere/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useIssuesEnabled } from "../hooks/useIssuesEnabled";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import { useI18n } from "../i18n";
import { formatBriefAge } from "../lib/sessionAge";
import { IssueIcon } from "./IssueIcon";
import styles from "./SessionIssuesLink.module.css";
import { ButtonBase } from "./ui/Button";
import { IssueMentionLinksContext } from "./IssueMentionText";
import { createIssueMentionLinks } from "../lib/issueMentionLinks";
import {
  TRACKER_STATUS_LABELS,
  TrackerStatusBadge,
} from "./TrackerStatusBadge";

/** One page of the list route supplies the count; a fuller page reads "N+". */
const COUNT_PAGE = 100;
/** Let a burst of new messages settle before asking for a fresh count. */
const SETTLE_MS = 3000;
/** Recheck cadence while the server reports indexing work in flight. */
const INDEXING_MS = 4000;
/**
 * Opening or extending a session queues its text for indexing, so the first
 * answer usually predates the references in it. These delays follow a count
 * until it settles and then stop: a bounded recheck, never a standing poll.
 */
const RECHECK_MS = [2000, 5000, 10000];
/** Recheck cadence while the server is asking the tracker for states. */
const STATUS_MS = 1500;
/** Opening the menu re-reads a list older than this, so states are current. */
const MENU_STALE_MS = 30_000;
/** A header menu stays scannable; the rest stay one click away on the page. */
const MENU_ROWS = 12;
/** Each section keeps this many rows however long the other one is. */
const SECTION_ROWS = MENU_ROWS / 2;
/** Keep the menu off both screen edges on a phone. */
const MENU_MARGIN_PX = 8;

interface KnownIssues {
  items: IssueItem[];
  count: number;
  more: boolean;
}

const SessionIssuesContext = createContext<ReturnType<
  typeof useSessionIssues
> | null>(null);

/** One session-owned read supplies both header controls and transcript links. */
export function SessionIssuesProvider({
  sessionId,
  projectId,
  messageCount,
  children,
}: {
  sessionId: string;
  projectId: string;
  messageCount: number;
  children: ReactNode;
}) {
  const enabled = useIssuesEnabled();
  const state = useSessionIssues(sessionId, projectId, enabled, messageCount);
  const deferredItems = useDeferredValue(state.known?.items);
  const links = useMemo(
    () => (enabled ? createIssueMentionLinks(deferredItems ?? []) : null),
    [deferredItems, enabled],
  );
  return (
    <SessionIssuesContext value={state}>
      <IssueMentionLinksContext value={links}>
        {children}
      </IssueMentionLinksContext>
    </SessionIssuesContext>
  );
}

/**
 * This session's undismissed associations, as the header last read them.
 *
 * Discovery is asynchronous server-side work, so the header keeps the last
 * answer it actually read: it refreshes when the transcript grows and while the
 * indexer reports active work, and reports nothing at all rather than a count
 * it cannot currently confirm. The same page that supplies the count supplies
 * the menu rows, so opening the menu costs no request unless that page is old
 * enough for its tracker states to have moved on.
 */
function useSessionIssues(
  sessionId: string,
  projectId: string,
  enabled: boolean,
  messageCount: number,
): { known: KnownIssues | null; refresh: () => void } {
  const { transport } = useCurrentSourceRuntime();
  const [known, setKnown] = useState<KnownIssues | null>(null);
  const reload = useRef<() => void>(() => {});
  const loaded = useRef<{ transport: unknown; key: string } | null>(null);
  // The transport whose server advertised mention order; until then the page
  // arrives in key order and is reordered here.
  const ordered = useRef<unknown>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: messageCount is the trigger for a fresh count, not an input to the request
  useEffect(() => {
    if (!enabled) {
      setKnown(null);
      loaded.current = null;
      return;
    }
    // A different session or server invalidates the displayed count instead of
    // showing the previous one beside the new header.
    const key = `${projectId} ${sessionId}`;
    const first =
      loaded.current?.transport !== transport || loaded.current.key !== key;
    if (first) setKnown(null);
    loaded.current = { transport, key };
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rechecks = 0;
    let reading = false;
    let readAt = 0;
    const load = async () => {
      let next: number | undefined;
      reading = true;
      try {
        const sorted = ordered.current === transport;
        const result = await transport.fetch<IssueSearchResult>(
          `/issues?${new URLSearchParams({
            sessionId,
            projectId,
            limit: String(COUNT_PAGE),
            ...(sorted ? { sort: "mentioned" } : {}),
          })}`,
        );
        if (disposed) return;
        if (!sorted && result.supportedSorts?.includes("mentioned")) {
          ordered.current = transport;
          // A full key-ordered page can omit the latest references, so ask
          // again in mention order rather than show it.
          if (result.nextOffset !== null) return void load();
        }
        readAt = Date.now();
        next = result.statusRefreshing
          ? STATUS_MS
          : result.coverage.active
            ? INDEXING_MS
            : undefined;
        setKnown({
          items: result.items,
          count: result.items.length,
          more: result.nextOffset !== null,
        });
      } catch {
        // An unreadable count drops the badge rather than keeping a number the
        // server no longer confirms; the remaining rechecks can recover it.
        if (disposed) return;
        setKnown(null);
      } finally {
        reading = false;
      }
      if (disposed) return;
      const delay =
        rechecks < RECHECK_MS.length
          ? (next ?? RECHECK_MS[rechecks])
          : undefined;
      rechecks += 1;
      if (delay !== undefined) timer = setTimeout(() => void load(), delay);
    };
    timer = setTimeout(() => void load(), first ? 0 : SETTLE_MS);
    reload.current = () => {
      if (reading || Date.now() - readAt < MENU_STALE_MS) return;
      if (timer) clearTimeout(timer);
      rechecks = 0;
      void load();
    };
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, messageCount, projectId, sessionId, transport]);
  const refresh = useCallback(() => reload.current(), []);
  return { known, refresh };
}

/** Latest mention first; unknown times keep the server's order, last. */
function byLastMention(items: IssueItem[]): IssueItem[] {
  const time = (item: IssueItem) =>
    item.lastMentionAt ? Date.parse(item.lastMentionAt) || 0 : 0;
  return items
    .map((item, index) => ({ item, index, at: time(item) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * Pull requests first, since they are usually what the session produced, then
 * everything else. Each section keeps half the rows and lends what it does not
 * use to the other, so a long ticket list cannot push every PR out of view.
 */
function menuSections(items: IssueItem[]) {
  const ordered = byLastMention(items);
  const prs = ordered.filter((item) => item.kind === "pr");
  const others = ordered.filter((item) => item.kind !== "pr");
  const prRows = Math.min(
    prs.length,
    Math.max(SECTION_ROWS, MENU_ROWS - others.length),
  );
  return {
    prs: prs.slice(0, prRows),
    others: others.slice(0, MENU_ROWS - prRows),
  };
}

const KIND_LABELS = {
  issue: "issuesKind_issue",
  pr: "issuesKind_pr",
  unknown: "issuesKind_unknown",
} as const;

/**
 * Everything the row cannot show: the full title, where the reference lives,
 * how widely it is mentioned, and what a click will do.
 */
function useItemTooltip(item: IssueItem): string {
  const { t } = useI18n();
  const kindKey = KIND_LABELS[item.kind as keyof typeof KIND_LABELS];
  const lines = [
    item.title ?? item.key,
    [
      item.title ? item.key : null,
      item.provider,
      kindKey ? t(kindKey) : item.kind,
      t(
        item.sessionCount === 1 ? "issuesSingleSession" : "issuesSessionCount",
        {
          count: item.sessionCount,
        },
      ),
    ]
      .filter(Boolean)
      .join(" · "),
    item.unresolved ? t("issuesUnresolved") : null,
    item.trackerStatus && TRACKER_STATUS_LABELS[item.trackerStatus.state]
      ? t("issuesStatusChecked", {
          state: t(TRACKER_STATUS_LABELS[item.trackerStatus.state]),
          age: formatBriefAge(item.trackerStatus.checkedAt) ?? "?",
        })
      : null,
    item.url,
    item.url ? t("issuesMenuOpenHint") : t("issuesMenuNoUrlHint"),
  ];
  return lines.filter(Boolean).join("\n");
}

function IssueMenuRow({
  item,
  fallbackHref,
  onSelect,
}: {
  item: IssueItem;
  /** Where a reference with no known tracker URL goes instead. */
  fallbackHref: string;
  onSelect: () => void;
}) {
  const tooltip = useItemTooltip(item);
  const tooltipProps = useTextTooltipAttributes(tooltip);
  const content = (
    <>
      <IssueIcon size={14} />
      <span className={styles.itemKey}>{item.key}</span>
      {item.title && <span className={styles.itemTitle}>{item.title}</span>}
      <TrackerStatusBadge item={item} className={styles.itemStatus} />
    </>
  );
  // A plain href in both branches keeps the browser's own middle-click and
  // modifier-click handling: a left click navigates, anything else opens a tab.
  // Only the navigating click closes the menu, so several references can be
  // opened into tabs from one opening.
  const onClick = (event: React.MouseEvent) => {
    if (
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    )
      onSelect();
  };
  return item.url ? (
    <a
      className={styles.item}
      role="menuitem"
      href={item.url}
      rel="noreferrer"
      onClick={onClick}
      {...tooltipProps}
    >
      {content}
    </a>
  ) : (
    <Link
      className={styles.item}
      role="menuitem"
      to={fallbackHref}
      onClick={onClick}
      {...tooltipProps}
    >
      {content}
    </Link>
  );
}

export function SessionIssuesLink({
  sessionId,
  projectId,
  messageCount = 0,
  presentation = "header",
  onSelect,
}: {
  sessionId: string;
  projectId: string;
  /** Transcript length; a change asks the server for a fresh count. */
  messageCount?: number;
  presentation?: "header" | "menu";
  onSelect?: () => void;
}) {
  const enabled = useIssuesEnabled();
  const base = useRemoteBasePath();
  const { t } = useI18n();
  const shared = useContext(SessionIssuesContext);
  const standalone = useSessionIssues(
    sessionId,
    projectId,
    enabled && !shared,
    messageCount,
  );
  const { known, refresh } = shared ?? standalone;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sections = menuSections(known?.items ?? []);
  const shown = sections.prs.length + sections.others.length;
  const hidden = known ? known.count - shown : 0;
  const prHeading = useId();
  const otherHeading = useId();

  const openMenu = () => {
    setOpen(true);
    refresh();
  };

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    setPosition(undefined);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // Anchor the menu under the trigger's right edge, flipping above and
  // sliding inward rather than leaving the viewport.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a count that lands while the menu is open changes its height, so the measured rows re-run the placement
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    const below = rect.bottom + 4;
    const fitsBelow = below + height <= window.innerHeight - MENU_MARGIN_PX;
    setPosition({
      top: fitsBelow ? below : Math.max(MENU_MARGIN_PX, rect.top - height - 4),
      left: Math.max(
        MENU_MARGIN_PX,
        Math.min(
          rect.right - width,
          window.innerWidth - width - MENU_MARGIN_PX,
        ),
      ),
    });
  }, [open, shown, hidden]);

  // The first row takes focus so the menu is usable from the keyboard even
  // though the portal sits outside the header's tab order.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onScrollOrResize = () => close(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, close]);

  const badge = known?.more
    ? `${known.count}+`
    : known && known.count > 0
      ? String(known.count)
      : null;
  const label = badge
    ? t(
        known?.count === 1 && !known.more
          ? "issuesForSessionCountOne"
          : "issuesForSessionCountMany",
        { count: badge },
      )
    : t("issuesForSession");
  const triggerTooltip = useTextTooltipAttributes(label);
  if (!enabled) return null;

  const browseHref = `${base}/issues?${new URLSearchParams({ sessionId, projectId })}`;

  if (presentation === "menu") {
    return (
      <Link
        className={styles.menuEntry}
        to={browseHref}
        aria-label={label}
        onClick={onSelect}
      >
        <IssueIcon size={14} />
        {t("issuesForSession")}
        {badge && <span className={styles.count}>{badge}</span>}
      </Link>
    );
  }

  const moveFocus = (step: number, event: React.KeyboardEvent) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      step > 0 ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1;
    items[next]?.focus();
  };

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          className={styles.menu}
          style={{
            position: "fixed",
            top: position?.top ?? -9999,
            left: position?.left ?? -9999,
            visibility: position ? "visible" : "hidden",
          }}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") moveFocus(1, event);
            else if (event.key === "ArrowUp") moveFocus(-1, event);
            else if (event.key === "Tab") close(false);
          }}
        >
          {shown === 0 ? (
            <p className={styles.empty}>{t("issuesMenuEmpty")}</p>
          ) : (
            <>
              <div role="group" aria-labelledby={prHeading}>
                <p id={prHeading} className={styles.section}>
                  {t("issuesMenuPullRequests")}
                </p>
                {sections.prs.length === 0 && (
                  <p className={styles.empty}>
                    {t("issuesMenuNoPullRequests")}
                  </p>
                )}
                {sections.prs.map((item) => (
                  <IssueMenuRow
                    key={item.id}
                    item={item}
                    fallbackHref={browseHref}
                    onSelect={() => close(false)}
                  />
                ))}
              </div>
              {sections.others.length > 0 && (
                <div role="group" aria-labelledby={otherHeading}>
                  <p id={otherHeading} className={styles.section}>
                    {t("issuesMenuIssues")}
                  </p>
                  {sections.others.map((item) => (
                    <IssueMenuRow
                      key={item.id}
                      item={item}
                      fallbackHref={browseHref}
                      onSelect={() => close(false)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {hidden > 0 && (
            <p className={styles.more}>
              {t("issuesMenuMore", { count: hidden })}
            </p>
          )}
          <Link
            className={styles.browse}
            role="menuitem"
            to={browseHref}
            onClick={() => close(false)}
          >
            {t("issuesMenuBrowse")}
          </Link>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <ButtonBase
        ref={triggerRef}
        className={styles.trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        {...triggerTooltip}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <IssueIcon size={14} />
        {badge && <span className={styles.count}>{badge}</span>}
      </ButtonBase>
      {menu}
    </>
  );
}
