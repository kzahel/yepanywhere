export type SessionLivenessDerivedStatus =
  | "verified-progressing"
  | "recently-active-unverified"
  | "long-silent-unverified"
  | "verified-waiting-provider"
  | "verified-idle"
  | "needs-attention";

export type SessionActiveWorkKind =
  | "none"
  | "agent-turn"
  | "waiting-input"
  | "terminated"
  | "unknown";

export type SessionLivenessProbeStatus =
  | "active"
  | "idle"
  | "waiting-input"
  | "not-loaded"
  | "system-error"
  | "unavailable"
  | "error";

export type ProviderWorkKind =
  | "shell"
  | "monitor"
  | "subagent"
  | "workflow"
  | "mcp"
  | "cron"
  | "sleep"
  | "other";

/**
 * One piece of provider-held work, normalized across providers. See
 * topics/provider-wait-and-background-work.md for each provider's sources.
 */
export interface ProviderWorkItem {
  /** Provider id: Claude task/cron id, Codex item id. */
  id: string;
  kind: ProviderWorkKind;
  label: string;
  /** Raw provider type, e.g. Claude `local_bash` or Codex `unifiedExecStartup`. */
  providerType?: string;
  command?: string;
  /** ISO time the provider reported, else when YA first observed it. */
  startedAt?: string;
  /** ISO time a sleep is due to end. */
  until?: string;
  schedule?: string;
  recurring?: boolean;
  parentId?: string;
  /** Provider evidence the item came from. */
  source: string;
}

export interface SessionProviderRetentionSnapshot {
  retained: boolean;
  reasons: string[];
  backgroundTaskCount?: number;
  sessionCronCount?: number;
  liveTaskCount?: number;
  lastUpdatedAt?: string | null;
  /**
   * Work that outlives model steps: background processes, subagents and
   * scheduled wakes. Recorded whether or not it retains the session.
   */
  backgroundWork?: ProviderWorkItem[];
  /** Waits the active turn is blocked on: sleeps, foreground commands. */
  foregroundWaits?: ProviderWorkItem[];
}

/**
 * What an active YA-owned session's provider is doing, for session rows:
 * - `generating`: in a turn and not blocked on recorded work;
 * - `waiting`: in a turn, blocked on foreground waits (a long command,
 *   a sleep, a foreground subagent);
 * - `background`: the turn ended and retained background work or a
 *   scheduled wake holds the session.
 * Row `activity` stays `in-turn` for all three. See
 * topics/provider-wait-and-background-work.md.
 */
export type SessionProviderPhaseKind = "generating" | "waiting" | "background";

export interface SessionProviderPhase {
  phase: SessionProviderPhaseKind;
  /** The first few items the phase is about, provider order. */
  work?: ProviderWorkItem[];
  /** All items of that kind, when more than `work` carries. */
  workCount?: number;
}

export const PROVIDER_WORK_ITEM_LIMIT = 64;
const PROVIDER_WORK_TEXT_LIMIT = 500;

const PROVIDER_WORK_KINDS: ReadonlySet<string> = new Set<ProviderWorkKind>([
  "shell",
  "monitor",
  "subagent",
  "workflow",
  "mcp",
  "cron",
  "sleep",
  "other",
]);

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value.length > PROVIDER_WORK_TEXT_LIMIT
    ? `${value.slice(0, PROVIDER_WORK_TEXT_LIMIT)}…`
    : value;
}

/**
 * Validate and bound work items crossing a process or wire boundary.
 * Returns undefined when the input is not a list.
 */
export function normalizeProviderWorkItems(
  value: unknown,
): ProviderWorkItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: ProviderWorkItem[] = [];
  for (const entry of value) {
    if (items.length >= PROVIDER_WORK_ITEM_LIMIT) break;
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const id = boundedText(raw.id);
    const source = boundedText(raw.source);
    if (!id || !source) continue;
    const kind =
      typeof raw.kind === "string" && PROVIDER_WORK_KINDS.has(raw.kind)
        ? (raw.kind as ProviderWorkKind)
        : "other";
    const item: ProviderWorkItem = {
      id,
      kind,
      label: boundedText(raw.label) ?? id,
      source,
    };
    const providerType = boundedText(raw.providerType);
    if (providerType) item.providerType = providerType;
    const command = boundedText(raw.command);
    if (command) item.command = command;
    const startedAt = boundedText(raw.startedAt);
    if (startedAt) item.startedAt = startedAt;
    const until = boundedText(raw.until);
    if (until) item.until = until;
    const schedule = boundedText(raw.schedule);
    if (schedule) item.schedule = schedule;
    if (typeof raw.recurring === "boolean") item.recurring = raw.recurring;
    const parentId = boundedText(raw.parentId);
    if (parentId) item.parentId = parentId;
    items.push(item);
  }
  return items;
}

export type SessionWakeReason =
  | "session-state-running"
  | "session-state-requires-action"
  | "provider-message-after-idle"
  | "user-message"
  | "tool-approval-resolved";

export interface SessionWakeReasonSnapshot {
  at: string;
  fromState: "idle" | "in-turn" | "waiting-input" | "terminated";
  reason: SessionWakeReason;
  messageType?: string;
  messageSubtype?: string;
}

export interface SessionLivenessSnapshot {
  checkedAt: string;
  derivedStatus: SessionLivenessDerivedStatus;
  activeWorkKind: SessionActiveWorkKind;
  state: string;
  evidence: string[];
  lastProviderMessageAt: string | null;
  lastRawProviderEventAt: string | null;
  lastRawProviderEventSource: string | null;
  lastStateChangeAt: string;
  lastVerifiedProgressAt: string | null;
  lastVerifiedIdleAt: string | null;
  lastLivenessProbeAt: string | null;
  lastLivenessProbeStatus: SessionLivenessProbeStatus | null;
  lastLivenessProbeSource: string | null;
  lastLivenessProbeDetail?: string;
  silenceMs: number | null;
  longSilenceThresholdMs: number;
  processAlive?: boolean;
  providerRetention?: SessionProviderRetentionSnapshot;
  lastWakeReason?: SessionWakeReasonSnapshot;
  queueDepth: number;
  deferredQueueDepth: number;
}
