import rowsStyles from "./SettingsRows.module.css";
import type { CacheMissBillingRecord } from "@yep-anywhere/shared";
import { useI18n } from "../../i18n";
import styles from "./CacheMissInactivityChart.module.css";

export interface InactivityBucket {
  /** Inclusive lower edge in minutes. */
  fromMinutes: number;
  /** Exclusive upper edge in minutes. */
  toMinutes: number;
  misses: number;
  hits: number;
  wastedTokens: number;
  events: CacheMissBillingRecord[];
}

function isCacheMiss(event: CacheMissBillingRecord): boolean {
  return event.outcome !== "expected-cache-hit";
}

export function bucketByInactivity(
  events: CacheMissBillingRecord[],
): InactivityBucket[] {
  const buckets = new Map<number, InactivityBucket>();

  for (const event of events) {
    if (event.elapsedSinceExpectedCacheMs === undefined) continue;
    const minutes = event.elapsedSinceExpectedCacheMs / 60_000;
    if (!Number.isFinite(minutes) || minutes < 0) continue;
    const fromMinutes =
      minutes < 0.5
        ? 0
        : minutes < 1
          ? 0.5
          : 2 ** Math.floor(Math.log2(minutes));
    const toMinutes = fromMinutes === 0 ? 0.5 : fromMinutes * 2;
    const bucket = buckets.get(fromMinutes) ?? {
      fromMinutes,
      toMinutes,
      misses: 0,
      hits: 0,
      wastedTokens: 0,
      events: [],
    };
    bucket.events.push(event);
    if (isCacheMiss(event)) {
      bucket.misses += 1;
      bucket.wastedTokens += event.wastedInputTokens;
    } else {
      bucket.hits += 1;
    }
    buckets.set(fromMinutes, bucket);
  }
  return [...buckets.values()].sort(
    (left, right) => left.fromMinutes - right.fromMinutes,
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function formatBucketEdge(minutes: number): string {
  if (minutes === 0) return "0";
  if (minutes < 1) return `${minutes * 60}s`;
  return `${minutes}m`;
}

function bucketLabel(bucket: InactivityBucket): string {
  const from = formatBucketEdge(bucket.fromMinutes);
  return `${from}–${formatBucketEdge(bucket.toMinutes)}`;
}

function providerModelTuple(
  event: CacheMissBillingRecord,
  unknownModel: string,
): string {
  return `${event.provider} / ${event.model?.trim() || unknownModel}`;
}

function tupleTooltip(
  events: CacheMissBillingRecord[],
  unknownModel: string,
  heading: string,
  empty: string,
): string {
  const tuples = [
    ...new Set(events.map((event) => providerModelTuple(event, unknownModel))),
  ].sort();
  return tuples.length > 0 ? `${heading}\n${tuples.join("\n")}` : empty;
}

function missRate(bucket: Pick<InactivityBucket, "misses" | "hits">): number {
  const total = bucket.misses + bucket.hits;
  return total === 0 ? 0 : bucket.misses / total;
}

function formatMissRate(rate: number): string {
  const percentage = rate * 100;
  if (percentage === 0) return "0%";
  if (percentage < 0.1) return `${percentage.toFixed(2)}%`;
  if (percentage < 10) return `${percentage.toFixed(1)}%`;
  return `${Math.round(percentage)}%`;
}

/** Logarithmic display keeps sub-percent empirical rates visible. */
export function logarithmicRateWidth(rate: number): number {
  if (rate <= 0) return 0;
  return (Math.log10(1 + Math.min(1, rate) * 999) / 3) * 100;
}

/**
 * Where re-reads actually happen, by how long the session sat idle first.
 * Bar length is the tokens a warm cache should have served; the count beside
 * it is misses over observations, so a bucket with one miss in twenty reads
 * differently from one where every turn missed.
 */
export function CacheMissInactivityChart({
  events,
}: {
  events: CacheMissBillingRecord[];
}) {
  const { t } = useI18n();
  const tooltip = (bucketEvents: CacheMissBillingRecord[]) =>
    tupleTooltip(
      bucketEvents,
      t("cacheMissUnknownModel"),
      t("cacheMissTupleTooltipHeading"),
      t("cacheMissTupleTooltipEmpty"),
    );
  const buckets = bucketByInactivity(events);
  if (buckets.length === 0) {
    return <p className={rowsStyles.empty}>{t("cacheMissChartEmpty")}</p>;
  }

  const peak = Math.max(...buckets.map((bucket) => bucket.wastedTokens), 1);
  const totalWasted = buckets.reduce(
    (sum, bucket) => sum + bucket.wastedTokens,
    0,
  );

  return (
    <div className={styles.chart}>
      <p className={rowsStyles.hint}>
        {t("cacheMissChartTotal", { tokens: formatTokens(totalWasted) })}
      </p>
      <ol className={styles.bars}>
        {buckets.map((bucket) => (
          <li
            className={styles.bar}
            key={bucket.fromMinutes}
            title={tooltip(bucket.events)}
          >
            <span className={styles.barLabel}>{bucketLabel(bucket)}</span>
            <span className={styles.barTrack}>
              <span
                className={styles.barFill}
                style={{
                  width: `${Math.round((bucket.wastedTokens / peak) * 100)}%`,
                }}
                data-empty={bucket.wastedTokens === 0 ? "" : undefined}
              />
            </span>
            <span className={styles.barValue}>
              {formatTokens(bucket.wastedTokens)}
            </span>
            <span className={styles.barCount}>
              {t("cacheMissChartRatio", {
                misses: String(bucket.misses),
                total: String(bucket.misses + bucket.hits),
              })}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Empirical miss probability from records whose sampler retained every hit. */
export function CacheMissProbabilityChart({
  events,
}: {
  events: CacheMissBillingRecord[];
}) {
  const { t } = useI18n();
  const tooltip = (bucketEvents: CacheMissBillingRecord[]) =>
    tupleTooltip(
      bucketEvents,
      t("cacheMissUnknownModel"),
      t("cacheMissTupleTooltipHeading"),
      t("cacheMissTupleTooltipEmpty"),
    );
  const completeEvents = events.filter(
    (event) => event.completeProbabilitySample === true,
  );
  const buckets = bucketByInactivity(completeEvents);
  if (buckets.length === 0) {
    return <p className={rowsStyles.empty}>{t("cacheMissProbabilityEmpty")}</p>;
  }

  return (
    <div className={styles.chart}>
      <p className={rowsStyles.hint}>{t("cacheMissProbabilitySampleNote")}</p>
      <ol className={styles.bars}>
        {buckets.map((bucket) => {
          const rate = missRate(bucket);
          return (
            <li
              className={styles.bar}
              key={bucket.fromMinutes}
              title={tooltip(bucket.events)}
            >
              <span className={styles.barLabel}>{bucketLabel(bucket)}</span>
              <span className={styles.barTrack}>
                <span
                  className={`${styles.barFill} ${styles.probabilityFill}`}
                  style={{ width: `${logarithmicRateWidth(rate)}%` }}
                  data-empty={rate === 0 ? "" : undefined}
                />
              </span>
              <span className={styles.barValue}>{formatMissRate(rate)}</span>
              <span className={styles.barCount}>
                {t("cacheMissChartRatio", {
                  misses: String(bucket.misses),
                  total: String(bucket.misses + bucket.hits),
                })}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface ProviderBucket {
  provider: string;
  misses: number;
  hits: number;
  events: CacheMissBillingRecord[];
}

function bucketByProvider(events: CacheMissBillingRecord[]): ProviderBucket[] {
  const buckets = new Map<string, ProviderBucket>();
  for (const event of events) {
    if (event.completeProbabilitySample !== true) continue;
    const bucket = buckets.get(event.provider) ?? {
      provider: event.provider,
      misses: 0,
      hits: 0,
      events: [],
    };
    bucket.events.push(event);
    if (isCacheMiss(event)) bucket.misses += 1;
    else bucket.hits += 1;
    buckets.set(event.provider, bucket);
  }
  return [...buckets.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
}

export function CacheMissProviderChart({
  events,
}: {
  events: CacheMissBillingRecord[];
}) {
  const { t } = useI18n();
  const tooltip = (bucketEvents: CacheMissBillingRecord[]) =>
    tupleTooltip(
      bucketEvents,
      t("cacheMissUnknownModel"),
      t("cacheMissTupleTooltipHeading"),
      t("cacheMissTupleTooltipEmpty"),
    );
  const buckets = bucketByProvider(events);
  if (buckets.length === 0) {
    return <p className={rowsStyles.empty}>{t("cacheMissProviderEmpty")}</p>;
  }

  return (
    <div className={styles.chart}>
      <p className={rowsStyles.hint}>{t("cacheMissProbabilitySampleNote")}</p>
      <ol className={styles.bars}>
        {buckets.map((bucket) => {
          const rate = missRate(bucket);
          return (
            <li
              className={styles.bar}
              key={bucket.provider}
              title={tooltip(bucket.events)}
            >
              <span className={styles.barLabel}>{bucket.provider}</span>
              <span className={styles.barTrack}>
                <span
                  className={`${styles.barFill} ${styles.providerFill}`}
                  style={{ width: `${logarithmicRateWidth(rate)}%` }}
                  data-empty={rate === 0 ? "" : undefined}
                />
              </span>
              <span className={styles.barValue}>{formatMissRate(rate)}</span>
              <span className={styles.barCount}>
                {t("cacheMissChartRatio", {
                  misses: String(bucket.misses),
                  total: String(bucket.misses + bucket.hits),
                })}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
