import type {
  AgentActivity,
  AppSessionSummary,
  PendingInputType,
  RetainedSessionCollectionState,
  SessionCreationProvenance,
} from "@yep-anywhere/shared";

/**
 * An item in the inbox representing a session that may need attention.
 */
export interface InboxItem {
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
