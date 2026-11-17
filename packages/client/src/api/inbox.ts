import type {
  AgentActivity,
  AppSessionSummary,
  PendingInputType,
  ProviderRuntimeStatus,
  RetainedSessionCollectionState,
  SessionCreationProvenance,
  SessionProviderPhase,
  ProviderName,
  ThinkingConfig,
  EffortLevel,
} from "@yep-anywhere/shared";

type RetryingProviderRuntimeStatus = Extract<
  Exclude<ProviderRuntimeStatus, null>,
  { kind: "retrying" }
>;
type TerminalProviderRuntimeStatus = Extract<
  Exclude<ProviderRuntimeStatus, null>,
  { kind: "terminal" }
>;

/**
 * Inbox row projection of a provider runtime status. It omits per-attempt
 * counters and diagnostics, so a retry that leaves the row's display unchanged
 * does not change the row, and the server caps `message`.
 */
export type InboxProviderRuntimeStatus =
  | Pick<
      RetryingProviderRuntimeStatus,
      | "kind"
      | "provider"
      | "reason"
      | "httpStatus"
      | "startedAt"
      | "retryAt"
      | "source"
      | "message"
    >
  | Pick<
      TerminalProviderRuntimeStatus,
      | "kind"
      | "provider"
      | "reason"
      | "message"
      | "occurredAt"
      | "source"
      | "scope"
    >;

/**
 * An item in the inbox representing a session that may need attention.
 */
export interface InboxItem {
  /** Absent on older servers and when the settings have not been observed. */
  modelConfig?: {
    provider: ProviderName;
    model?: string;
    thinking?: ThinkingConfig;
    effort?: EffortLevel;
  };
  creationProvenance?: SessionCreationProvenance;
  nonHumanUserTurn?: AppSessionSummary["nonHumanUserTurn"];
  asyncQuestions?: AppSessionSummary["asyncQuestions"];
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle?: string | null;
  updatedAt: string;
  customTitle?: string;
  isStarred?: boolean;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  /** What an active session's provider is doing; absent on older servers. */
  providerPhase?: SessionProviderPhase;
  /** Provider retry/stop state (e.g. rate limited); absent when none or on older servers. */
  providerRuntimeStatus?: InboxProviderRuntimeStatus;
  activityInferredFromInboxTier?: boolean;
  hasUnread?: boolean;
}

/**
 * Inbox response with sessions categorized into priority tiers.
 */
export interface InboxResponse {
  catalog?: RetainedSessionCollectionState;
  needsAttention: InboxItem[];
  active: InboxItem[];
  recentActivity: InboxItem[];
  unread8h: InboxItem[];
  unread24h: InboxItem[];
}
