import type { CacheMissBillingRecord } from "@yep-anywhere/shared";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { MessageAge } from "../../components/MessageAge";
import { ButtonBase } from "../../components/ui/Button";
import {
  type CacheMissEventOutcomeFilter,
  useCacheMissEventOutcomeFilter,
} from "../../hooks/useCacheMissEventOutcomeFilter";
import { useRelativeNow } from "../../hooks/useRelativeNow";
import { useI18n } from "../../i18n";
import styles from "./CacheMissEventTable.module.css";

interface EventGroup {
  key: string;
  tuple: string;
  events: CacheMissBillingRecord[];
  misses: number;
  newestTimestampMs: number;
}

function eventTuple(event: CacheMissBillingRecord, unknownModel: string) {
  return `${event.provider} / ${event.model?.trim() || unknownModel}`;
}

function isCacheMiss(event: CacheMissBillingRecord): boolean {
  return event.outcome !== "expected-cache-hit";
}

export function groupCacheMissEvents(
  events: CacheMissBillingRecord[],
  unknownModel: string,
): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const event of events) {
    const tuple = eventTuple(event, unknownModel);
    const timestampMs = Date.parse(event.timestamp);
    const group = groups.get(tuple) ?? {
      key: tuple,
      tuple,
      events: [],
      misses: 0,
      newestTimestampMs: 0,
    };
    group.events.push(event);
    if (isCacheMiss(event)) group.misses += 1;
    if (Number.isFinite(timestampMs)) {
      group.newestTimestampMs = Math.max(group.newestTimestampMs, timestampMs);
    }
    groups.set(tuple, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      events: group.events.sort((a, b) =>
        b.timestamp.localeCompare(a.timestamp),
      ),
    }))
    .sort((a, b) => b.newestTimestampMs - a.newestTimestampMs);
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(tokens);
}

function eventTokenCount(event: CacheMissBillingRecord): number {
  return isCacheMiss(event)
    ? event.wastedInputTokens
    : (event.observedUsage.cacheReadTokens ?? 0);
}

function formatEventTimestamp(timestamp: string): {
  date: string;
  time: string;
  title: string;
} {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return { date: timestamp, time: "", title: timestamp };
  }
  const date = new Date(timestampMs);
  return {
    date: new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date),
    time: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(date),
    title: date.toLocaleString(),
  };
}

function formatIdleDuration(elapsedMs: number | undefined): string {
  if (elapsedMs === undefined) return "—";
  if (elapsedMs < 60_000) return "<1m";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function eventMessageReference(event: CacheMissBillingRecord): string {
  if (event.messageIndex !== undefined) return `#${event.messageIndex}`;
  if (event.messageId) {
    return event.messageId.length > 8
      ? `${event.messageId.slice(0, 8)}…`
      : event.messageId;
  }
  return "—";
}

function eventMatchesOutcomeFilter(
  event: CacheMissBillingRecord,
  filter: CacheMissEventOutcomeFilter,
): boolean {
  if (filter === "all") return true;
  return filter === "misses"
    ? isCacheMiss(event)
    : event.outcome === "expected-cache-hit";
}

function sessionColorStyles(
  events: CacheMissBillingRecord[],
): Map<string, CSSProperties> {
  const sessionIds = [
    ...new Set(events.map((event) => event.sessionId)),
  ].sort();
  return new Map(
    sessionIds.map((sessionId, index) => [
      sessionId,
      {
        "--cache-session-color": `hsl(${(index * 137.508 + 12) % 360} 70% 52%)`,
      } as CSSProperties,
    ]),
  );
}

function compareNewestFirst(
  left: CacheMissBillingRecord,
  right: CacheMissBillingRecord,
): number {
  if (
    left.messageIndex !== undefined &&
    right.messageIndex !== undefined &&
    left.messageIndex !== right.messageIndex
  ) {
    return right.messageIndex - left.messageIndex;
  }
  return right.timestamp.localeCompare(left.timestamp);
}

export function CacheMissEventTable({
  events,
  basePath,
  recencyHours,
}: {
  events: CacheMissBillingRecord[];
  basePath: string;
  recencyHours: number | null;
}) {
  const { t } = useI18n();
  const nowMs = useRelativeNow(60_000);
  const { outcomeFilter, setOutcomeFilter } = useCacheMissEventOutcomeFilter();
  const [tupleFilter, setTupleFilter] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingJumpEventId, setPendingJumpEventId] = useState<string | null>(
    null,
  );
  const eventRows = useRef(new Map<string, HTMLTableRowElement>());
  const outcomeFilteredEvents = useMemo(
    () =>
      events.filter((event) => eventMatchesOutcomeFilter(event, outcomeFilter)),
    [events, outcomeFilter],
  );
  const groups = useMemo(() => {
    const query = tupleFilter.trim().toLocaleLowerCase();
    return groupCacheMissEvents(
      outcomeFilteredEvents,
      t("cacheMissUnknownModel"),
    ).filter(
      (group) => !query || group.tuple.toLocaleLowerCase().includes(query),
    );
  }, [outcomeFilteredEvents, t, tupleFilter]);
  const sessionStyles = useMemo(() => sessionColorStyles(events), [events]);
  const eventNavigation = useMemo(() => {
    const eventsBySession = new Map<string, CacheMissBillingRecord[]>();
    const groupByEventId = new Map<string, string>();
    for (const group of groups) {
      for (const event of group.events) {
        groupByEventId.set(event.id, group.key);
        if (event.messageIndex === undefined) continue;
        const sessionEvents = eventsBySession.get(event.sessionId) ?? [];
        sessionEvents.push(event);
        eventsBySession.set(event.sessionId, sessionEvents);
      }
    }

    const previousByEventId = new Map<string, string>();
    for (const sessionEvents of eventsBySession.values()) {
      sessionEvents.sort(compareNewestFirst);
      for (let index = 0; index + 1 < sessionEvents.length; index += 1) {
        const event = sessionEvents[index];
        const previousEvent = sessionEvents[index + 1];
        if (event && previousEvent) {
          previousByEventId.set(event.id, previousEvent.id);
        }
      }
    }
    return { groupByEventId, previousByEventId };
  }, [groups]);

  useEffect(() => {
    if (!pendingJumpEventId) return;
    const row = eventRows.current.get(pendingJumpEventId);
    if (!row) {
      setPendingJumpEventId(null);
      return;
    }
    row.scrollIntoView?.({ block: "center" });
    row.focus({ preventScroll: true });
    setPendingJumpEventId(null);
  }, [pendingJumpEventId]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const jumpToPreviousSessionEvent = (eventId: string) => {
    const previousEventId = eventNavigation.previousByEventId.get(eventId);
    if (!previousEventId) return;
    const targetGroup = eventNavigation.groupByEventId.get(previousEventId);
    if (targetGroup) {
      setCollapsedGroups((current) => {
        if (!current.has(targetGroup)) return current;
        const next = new Set(current);
        next.delete(targetGroup);
        return next;
      });
    }
    setPendingJumpEventId(previousEventId);
  };
  const shownEventCount = groups.reduce(
    (sum, group) => sum + group.events.length,
    0,
  );
  const visibleCountLabel =
    recencyHours === null
      ? t("cacheMissEventVisibleCount", {
          shown: shownEventCount,
          total: events.length,
        })
      : t("cacheMissEventVisibleCountRecent", {
          shown: shownEventCount,
          total: events.length,
          hours: recencyHours,
        });

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar}>
        <div className={styles.filterControls}>
          <label className={styles.outcomeLabel}>
            <span>{t("cacheMissEventResultHeader")}</span>
            <select
              value={outcomeFilter}
              onChange={(event) =>
                setOutcomeFilter(
                  event.currentTarget.value as CacheMissEventOutcomeFilter,
                )
              }
            >
              <option value="misses">{t("cacheMissEventResultMiss")}</option>
              <option value="hits">{t("cacheMissEventResultHit")}</option>
              <option value="all">{t("cacheMissEventResultAll")}</option>
            </select>
          </label>
          <label className={styles.filterLabel}>
            <span>{t("cacheMissEventFilterLabel")}</span>
            <input
              type="search"
              value={tupleFilter}
              onChange={(event) => setTupleFilter(event.currentTarget.value)}
              placeholder={t("cacheMissEventFilterPlaceholder")}
            />
          </label>
        </div>
        <span className={styles.matchCount}>{visibleCountLabel}</span>
      </div>

      {groups.length === 0 ? (
        <p className="settings-empty">
          {events.length === 0
            ? t("cacheMissBillingEventsEmpty")
            : outcomeFilteredEvents.length === 0
              ? t("activityNoMatches")
              : t("cacheMissEventFilterEmpty")}
        </p>
      ) : (
        <div className={styles.scroller}>
          <table className={styles.table}>
            <colgroup>
              <col className={styles.tupleColumn} />
              <col className={styles.eventTimeColumn} />
              <col className={styles.resultColumn} />
              <col className={styles.gapColumn} />
              <col className={styles.tokensColumn} />
              <col className={styles.kindColumn} />
              <col className={styles.messageColumn} />
              <col className={styles.openColumn} />
            </colgroup>
            <thead>
              <tr>
                <th title={t("cacheMissEventTupleHeaderTitle")}>
                  {t("cacheMissEventTupleHeader")}
                </th>
                <th title={t("cacheMissEventAgeHeaderTitle")}>
                  {t("cacheMissEventAgeHeader")}
                </th>
                <th title={t("cacheMissEventResultHeaderTitle")}>
                  {t("cacheMissEventResultHeader")}
                </th>
                <th title={t("cacheMissEventIdleHeaderTitle")}>
                  {t("cacheMissEventIdleHeader")}
                </th>
                <th title={t("cacheMissEventTokensHeaderTitle")}>
                  {t("cacheMissEventTokensHeader")}
                </th>
                <th title={t("cacheMissEventKindHeaderTitle")}>
                  {t("cacheMissEventKindHeader")}
                </th>
                <th title={t("cacheMissEventMessageHeaderTitle")}>
                  {t("cacheMissEventMessageHeader")}
                </th>
                <th title={t("cacheMissEventSessionHeaderTitle")}>
                  {t("cacheMissEventSessionHeader")}
                </th>
              </tr>
            </thead>
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.key);
              return (
                <tbody key={group.key}>
                  <tr className={styles.groupRow}>
                    <th scope="rowgroup">
                      <ButtonBase
                        className={styles.groupButton}
                        aria-expanded={!collapsed}
                        aria-label={t(
                          collapsed
                            ? "cacheMissEventExpandGroup"
                            : "cacheMissEventCollapseGroup",
                          { tuple: group.tuple },
                        )}
                        onClick={() => toggleGroup(group.key)}
                      >
                        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
                        <span>{group.tuple}</span>
                      </ButtonBase>
                    </th>
                    <td colSpan={7} className={styles.groupSummary}>
                      {t("cacheMissEventGroupSummary", {
                        count: group.events.length,
                        misses: group.misses,
                      })}
                      {group.newestTimestampMs > 0 && (
                        <>
                          {" · "}
                          <MessageAge
                            timestampMs={group.newestTimestampMs}
                            nowMs={nowMs}
                            className={styles.age}
                            formatLabel={(age) =>
                              age === "now"
                                ? t("cacheMissEventNewestNow")
                                : t("cacheMissEventNewestAge", { age })
                            }
                          />
                        </>
                      )}
                    </td>
                  </tr>
                  {!collapsed &&
                    group.events.map((event) => {
                      const eventTimestamp = formatEventTimestamp(
                        event.timestamp,
                      );
                      const previousEventId =
                        eventNavigation.previousByEventId.get(event.id);
                      const navigationTitle = previousEventId
                        ? t("cacheMissPrev")
                        : undefined;
                      const referenceTitle = [event.messageId, navigationTitle]
                        .filter(Boolean)
                        .join("\n");
                      return (
                        <tr
                          className={styles.eventRow}
                          key={event.id}
                          style={sessionStyles.get(event.sessionId)}
                          tabIndex={-1}
                          ref={(row) => {
                            if (row) eventRows.current.set(event.id, row);
                            else eventRows.current.delete(event.id);
                          }}
                        >
                          <td aria-hidden="true" />
                          <td>
                            <time
                              className={styles.eventTimestamp}
                              dateTime={event.timestamp}
                              title={eventTimestamp.title}
                            >
                              <span>{eventTimestamp.date}</span>
                              <span>{eventTimestamp.time}</span>
                            </time>
                          </td>
                          <td
                            className={
                              event.outcome === "expected-cache-hit"
                                ? styles.hit
                                : event.outcome === "expected-cache-expiry"
                                  ? styles.expectedMiss
                                  : styles.miss
                            }
                          >
                            {event.outcome === "expected-cache-hit"
                              ? t("cacheMissEventResultHit")
                              : event.outcome === "expected-cache-expiry"
                                ? t("cacheMissEventResultExpectedMiss")
                                : t("cacheMissEventResultMiss")}
                          </td>
                          <td>
                            {formatIdleDuration(
                              event.elapsedSinceExpectedCacheMs,
                            )}
                          </td>
                          <td className={styles.numeric}>
                            {formatTokenCount(eventTokenCount(event))}
                          </td>
                          <td>
                            {event.expectedCacheSource === "fork"
                              ? t("cacheMissEventKindFork")
                              : t("cacheMissEventKindWarm")}
                          </td>
                          <td className={styles.messageReference}>
                            <span
                              className={styles.sessionMarker}
                              aria-hidden="true"
                            />
                            {previousEventId ? (
                              <ButtonBase
                                className={styles.messageJump}
                                title={referenceTitle || undefined}
                                aria-label={navigationTitle}
                                onClick={() =>
                                  jumpToPreviousSessionEvent(event.id)
                                }
                              >
                                {eventMessageReference(event)}
                              </ButtonBase>
                            ) : (
                              <span title={referenceTitle || undefined}>
                                {eventMessageReference(event)}
                              </span>
                            )}
                          </td>
                          <td>
                            <Link
                              className={styles.openLink}
                              to={`${basePath}${event.sessionPath}`}
                              title={t("cacheMissBillingOpenSession")}
                            >
                              {t("cacheMissEventOpen")}
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
    </div>
  );
}
