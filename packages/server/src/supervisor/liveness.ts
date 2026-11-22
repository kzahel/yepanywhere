import type {
  ProviderName,
  SessionActiveWorkKind,
  SessionLivenessDerivedStatus,
  SessionLivenessProbeStatus,
  SessionLivenessSnapshot,
  SessionProviderRetentionSnapshot,
  SessionWakeReasonSnapshot,
} from "@yep-anywhere/shared";
import type { ProviderRetentionSnapshot } from "../sdk/types.js";

export type LivenessProcessState =
  | { type: "in-turn" }
  | { type: "idle"; since: Date }
  | { type: "waiting-input" }
  | { type: "terminated"; reason: string };

export interface BuildSessionLivenessSnapshotInput {
  provider: ProviderName;
  state: LivenessProcessState;
  startedAt: Date;
  lastStateChangeAt: Date;
  lastProviderMessageAt: Date | null;
  lastRawProviderEventAt?: Date | null;
  lastRawProviderEventSource?: string | null;
  lastLivenessProbe: LivenessProbeResult | null;
  processAlive?: boolean;
  providerRetention?: ProviderRetentionSnapshot;
  lastWakeReason?: SessionWakeReasonSnapshot | null;
  queueDepth: number;
  deferredQueueDepth: number;
  now?: Date;
  longSilenceThresholdMs?: number;
}

export interface LivenessProbeResult {
  checkedAt: Date;
  status: SessionLivenessProbeStatus;
  source: string;
  detail?: string;
}

const DEFAULT_LONG_SILENCE_THRESHOLD_MS = 5 * 60 * 1000;

function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function elapsedMs(now: Date, then: Date | null | undefined): number | null {
  return then ? Math.max(0, now.getTime() - then.getTime()) : null;
}

function serializeProviderRetention(
  snapshot: ProviderRetentionSnapshot | undefined,
): SessionProviderRetentionSnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }
  return {
    retained: snapshot.retained,
    reasons: snapshot.reasons,
    ...(snapshot.backgroundTaskCount !== undefined
      ? { backgroundTaskCount: snapshot.backgroundTaskCount }
      : {}),
    ...(snapshot.sessionCronCount !== undefined
      ? { sessionCronCount: snapshot.sessionCronCount }
      : {}),
    ...(snapshot.liveTaskCount !== undefined
      ? { liveTaskCount: snapshot.liveTaskCount }
      : {}),
    ...(snapshot.lastUpdatedAt !== undefined
      ? { lastUpdatedAt: isoOrNull(snapshot.lastUpdatedAt) }
      : {}),
    ...(snapshot.backgroundWork?.length
      ? { backgroundWork: snapshot.backgroundWork }
      : {}),
    ...(snapshot.foregroundWaits?.length
      ? { foregroundWaits: snapshot.foregroundWaits }
      : {}),
  };
}

export function buildSessionLivenessSnapshot({
  provider,
  state,
  startedAt,
  lastStateChangeAt,
  lastProviderMessageAt,
  lastRawProviderEventAt = null,
  lastRawProviderEventSource = null,
  lastLivenessProbe,
  processAlive,
  providerRetention,
  lastWakeReason = null,
  queueDepth,
  deferredQueueDepth,
  now = new Date(),
  longSilenceThresholdMs = DEFAULT_LONG_SILENCE_THRESHOLD_MS,
}: BuildSessionLivenessSnapshotInput): SessionLivenessSnapshot {
  const evidence = [`state:${state.type}`, `provider:${provider}`];
  const serializedProviderRetention =
    serializeProviderRetention(providerRetention);
  const silenceMs = elapsedMs(now, lastProviderMessageAt);
  const activeSilenceAnchor =
    lastProviderMessageAt ?? lastStateChangeAt ?? startedAt;
  const activeSilenceMs = elapsedMs(now, activeSilenceAnchor) ?? 0;
  const rawProviderEventAgeMs = elapsedMs(now, lastRawProviderEventAt);
  let derivedStatus: SessionLivenessDerivedStatus;
  let activeWorkKind: SessionActiveWorkKind;
  let lastVerifiedProgressAt = lastProviderMessageAt;
  let lastVerifiedIdleAt: Date | null = null;
  const probeAppliesToCurrentState =
    lastLivenessProbe !== null &&
    lastLivenessProbe.checkedAt.getTime() >= lastStateChangeAt.getTime();
  const probeAgeMs = lastLivenessProbe
    ? elapsedMs(now, lastLivenessProbe.checkedAt)
    : null;
  const probeIsRecent =
    probeAgeMs !== null && probeAgeMs <= longSilenceThresholdMs;

  if (processAlive !== undefined) {
    evidence.push(processAlive ? "process:alive" : "process:dead");
  }
  if (providerRetention?.retained) {
    evidence.push("provider-retained");
    for (const reason of providerRetention.reasons) {
      evidence.push(`provider-retention:${reason}`);
    }
  }
  if (providerRetention?.backgroundWork?.length) {
    evidence.push(
      `provider-background-work:${providerRetention.backgroundWork.length}`,
    );
  }
  if (providerRetention?.foregroundWaits?.length) {
    evidence.push(
      `provider-foreground-waits:${providerRetention.foregroundWaits.length}`,
    );
  }
  if (lastLivenessProbe) {
    evidence.push(`probe:${lastLivenessProbe.status}`);
    evidence.push(`probe-source:${lastLivenessProbe.source}`);
  }
  if (lastRawProviderEventAt) {
    evidence.push("raw-provider-event-observed");
    if (lastRawProviderEventSource) {
      evidence.push(`raw-provider-event-source:${lastRawProviderEventSource}`);
    }
    if (
      rawProviderEventAgeMs !== null &&
      rawProviderEventAgeMs <= longSilenceThresholdMs
    ) {
      evidence.push("raw-provider-event-recent");
    }
  }

  switch (state.type) {
    case "idle":
      if (providerRetention?.detachedReply?.status === "progressing") {
        activeWorkKind = "agent-turn";
        const observed = providerRetention.detachedReply.at;
        if (!lastVerifiedProgressAt || observed > lastVerifiedProgressAt)
          lastVerifiedProgressAt = observed;
        derivedStatus =
          now.getTime() - lastVerifiedProgressAt.getTime() <
          longSilenceThresholdMs
            ? "verified-progressing"
            : "long-silent-unverified";
        evidence.push("provider-detached-reply");
      } else if (providerRetention?.detachedReply?.status === "unverified") {
        derivedStatus =
          now.getTime() - providerRetention.detachedReply.at.getTime() <
          longSilenceThresholdMs
            ? "recently-active-unverified"
            : "long-silent-unverified";
        activeWorkKind = "agent-turn";
        evidence.push("provider-detached-reply-unverified");
      } else if (providerRetention?.retained) {
        derivedStatus = "verified-waiting-provider";
        activeWorkKind = "agent-turn";
        lastVerifiedProgressAt =
          providerRetention.lastUpdatedAt ?? lastProviderMessageAt;
      } else if (
        probeAppliesToCurrentState &&
        probeIsRecent &&
        lastLivenessProbe?.status === "active"
      ) {
        derivedStatus = "needs-attention";
        activeWorkKind = "agent-turn";
        evidence.push("probe-active-while-idle");
      } else {
        derivedStatus = "verified-idle";
        activeWorkKind = "none";
        const settled =
          provider === "antigravity"
            ? (providerRetention?.lastUpdatedAt ??
              providerRetention?.detachedReply?.at)
            : providerRetention?.detachedReply?.at;
        lastVerifiedIdleAt =
          settled && settled > state.since ? settled : state.since;
        evidence.push("idle-boundary");
      }
      break;
    case "waiting-input":
      derivedStatus = "needs-attention";
      activeWorkKind = "waiting-input";
      evidence.push("waiting-input");
      break;
    case "terminated":
      derivedStatus = "needs-attention";
      activeWorkKind = "terminated";
      evidence.push("terminated");
      break;
    case "in-turn":
      activeWorkKind = "agent-turn";
      if (processAlive === false) {
        derivedStatus = "needs-attention";
        evidence.push("active-process-dead");
        break;
      }
      if (probeAppliesToCurrentState && probeIsRecent) {
        if (lastLivenessProbe?.status === "idle") {
          derivedStatus = "needs-attention";
          evidence.push("probe-idle-while-in-turn");
          lastVerifiedProgressAt = null;
          break;
        }
        if (lastLivenessProbe?.status === "waiting-input") {
          derivedStatus = "needs-attention";
          activeWorkKind = "waiting-input";
          evidence.push("probe-waiting-input");
          break;
        }
        if (
          lastLivenessProbe?.status === "not-loaded" ||
          lastLivenessProbe?.status === "system-error" ||
          lastLivenessProbe?.status === "unavailable" ||
          lastLivenessProbe?.status === "error"
        ) {
          derivedStatus = "needs-attention";
          evidence.push("probe-unhealthy");
          break;
        }
      }
      if (lastProviderMessageAt) {
        if ((silenceMs ?? 0) >= longSilenceThresholdMs) {
          if (
            probeAppliesToCurrentState &&
            probeIsRecent &&
            lastLivenessProbe?.status === "active"
          ) {
            derivedStatus = "verified-waiting-provider";
            evidence.push("provider-probe-active");
          } else {
            derivedStatus = "long-silent-unverified";
            evidence.push("provider-message-stale");
          }
        } else {
          derivedStatus = "verified-progressing";
          evidence.push("provider-message-recent");
        }
      } else if (activeSilenceMs >= longSilenceThresholdMs) {
        if (
          probeAppliesToCurrentState &&
          probeIsRecent &&
          lastLivenessProbe?.status === "active"
        ) {
          derivedStatus = "verified-waiting-provider";
          evidence.push("provider-probe-active");
        } else {
          derivedStatus = "long-silent-unverified";
          evidence.push("no-provider-message-observed");
        }
      } else {
        derivedStatus = "recently-active-unverified";
        evidence.push("recent-state-change-no-provider-message");
      }
      break;
    default:
      derivedStatus = "needs-attention";
      activeWorkKind = "unknown";
      evidence.push("unknown-state");
      lastVerifiedProgressAt = null;
  }

  return {
    checkedAt: now.toISOString(),
    derivedStatus,
    activeWorkKind,
    state: state.type,
    evidence,
    lastProviderMessageAt: isoOrNull(lastProviderMessageAt),
    lastRawProviderEventAt: isoOrNull(lastRawProviderEventAt),
    lastRawProviderEventSource,
    lastStateChangeAt: lastStateChangeAt.toISOString(),
    lastVerifiedProgressAt: isoOrNull(lastVerifiedProgressAt),
    lastVerifiedIdleAt: isoOrNull(lastVerifiedIdleAt),
    lastLivenessProbeAt: isoOrNull(lastLivenessProbe?.checkedAt),
    lastLivenessProbeStatus: lastLivenessProbe?.status ?? null,
    lastLivenessProbeSource: lastLivenessProbe?.source ?? null,
    ...(lastLivenessProbe?.detail
      ? { lastLivenessProbeDetail: lastLivenessProbe.detail }
      : {}),
    silenceMs,
    longSilenceThresholdMs,
    ...(processAlive !== undefined ? { processAlive } : {}),
    ...(serializedProviderRetention
      ? { providerRetention: serializedProviderRetention }
      : {}),
    ...(lastWakeReason ? { lastWakeReason } : {}),
    queueDepth,
    deferredQueueDepth,
  };
}
