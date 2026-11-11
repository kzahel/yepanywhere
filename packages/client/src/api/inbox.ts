import type {
  AgentActivity,
  AppSessionSummary,
  PendingInputType,
  RetainedSessionCollectionState,
  SessionCreationProvenance,
  SessionProviderPhase,
  ProviderName,
  ThinkingConfig,
  EffortLevel,
} from "@yep-anywhere/shared";

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
