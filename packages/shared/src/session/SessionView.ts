/**
 * SessionView provides a unified interface for session display in the UI.
 *
 * This class encapsulates all the data needed to render session UI components:
 * - Title handling (auto, custom, display priority)
 * - Metadata (starred, archived)
 * - Notification state (unread, pending input)
 * - Process state (running, idle, waiting)
 * - Context usage
 *
 * Used by:
 * - Client: Instantiate from API responses for consistent UI rendering
 * - Server: Extended by Session class which adds I/O capabilities
 */

import type {
  AgentActivity,
  AppSessionSummary,
  ContextUsage,
  PendingInputType,
  SessionOwnership,
} from "../app-types.js";
import type { UrlProjectId } from "../projectId.js";
import { DEFAULT_PROVIDER, type ProviderName } from "../types.js";

/** Maximum length for truncated titles */
export const SESSION_TITLE_MAX_LENGTH = 120;

// biome-ignore lint/complexity/useRegexLiterals: constructor form keeps deliberate control-character ranges explicit
const UNSAFE_TITLE_CHARACTERS = new RegExp(
  String.raw`[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]`,
  "gu",
);

/**
 * Sanitize text before it is reused as a session/browser title.
 *
 * Titles are shown in multiple browser/OS surfaces, so strip invisible
 * controls and bidi formatting rather than trying to preserve exact input.
 */
export function sanitizeSessionTitle(title: string): string {
  return title
    .normalize("NFC")
    .replace(UNSAFE_TITLE_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Titles are often whole first prompts, and list routes truncate one per row
 * on every read, so sanitize only a prefix when that already decides the
 * result. Sanitizing is local (per character, whitespace runs, NFC), so a
 * prefix and the whole title agree except within a few characters of the
 * prefix's end; a prefix comfortably longer than the limit after
 * sanitizing therefore yields the same truncation.
 */
const TITLE_PREFIX_LENGTH = SESSION_TITLE_MAX_LENGTH * 2 + 64;

export function truncateSessionTitle(title: string): string {
  let sanitized =
    title.length > TITLE_PREFIX_LENGTH
      ? sanitizeSessionTitle(title.slice(0, TITLE_PREFIX_LENGTH))
      : sanitizeSessionTitle(title);
  if (
    title.length > TITLE_PREFIX_LENGTH &&
    sanitized.length <= SESSION_TITLE_MAX_LENGTH + 16
  ) {
    // The prefix collapsed (long whitespace or control runs): read it all.
    sanitized = sanitizeSessionTitle(title);
  }
  if (sanitized.length <= SESSION_TITLE_MAX_LENGTH) return sanitized;
  return `${sanitized.slice(0, SESSION_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

export class SessionView {
  constructor(
    /** Session identifier */
    readonly id: string,
    /** Project this session belongs to */
    readonly projectId: UrlProjectId,
    /** Auto-generated title from first user message (truncated to 120 chars) */
    readonly autoTitle: string | null,
    /** Full first user message (for hover tooltips) */
    readonly fullTitle: string | null,
    /** User's custom title (overrides autoTitle for display) */
    readonly customTitle: string | undefined,
    /** When session was created */
    readonly createdAt: string,
    /** When session was last updated */
    readonly updatedAt: string,
    /** Number of messages in the session */
    readonly messageCount: number,
    /** Session ownership - who controls the session */
    readonly ownership: SessionOwnership,
    /** Whether session is archived (hidden from default list) */
    readonly isArchived: boolean,
    /** Whether session is starred/favorited */
    readonly isStarred: boolean,
    /** Type of pending input if session needs user action */
    readonly pendingInputType: PendingInputType | undefined,
    /** Current agent activity (in-turn, idle, waiting-input, terminated) */
    readonly activity: AgentActivity | undefined,
    /** When the session was last viewed */
    readonly lastSeenAt: string | undefined,
    /** Whether session has new content since last viewed */
    readonly hasUnread: boolean,
    /** Context window usage information */
    readonly contextUsage: ContextUsage | undefined,
    /** AI provider for this session */
    readonly provider: ProviderName,
  ) {}

  // ===========================================================================
  // Title Getters
  // ===========================================================================

  /**
   * Get the title to display in the UI.
   * Priority: customTitle > autoTitle > "Untitled"
   */
  get displayTitle(): string {
    return this.customTitle ?? this.autoTitle ?? "Untitled";
  }

  /**
   * Check if the session has a user-defined custom title.
   */
  get hasCustomTitle(): boolean {
    return !!this.customTitle;
  }

  /**
   * Get the title for tooltips.
   * Priority: customTitle > fullTitle > autoTitle
   */
  get tooltipTitle(): string | null {
    return this.customTitle ?? this.fullTitle ?? this.autoTitle;
  }

  /**
   * Check if the auto-generated title was truncated.
   */
  get isTruncated(): boolean {
    if (!this.autoTitle || !this.fullTitle) return false;
    return this.autoTitle !== this.fullTitle;
  }

  // ===========================================================================
  // Ownership Getters
  // ===========================================================================

  /**
   * Check if the session is currently owned by this server.
   */
  get isOwned(): boolean {
    return this.ownership.owner === "self";
  }

  /**
   * Check if the session is controlled by an external process.
   */
  get isExternal(): boolean {
    return this.ownership.owner === "external";
  }

  /**
   * Check if the session has no owner (no active process).
   */
  get isUnowned(): boolean {
    return this.ownership.owner === "none";
  }

  /**
   * Check if the session is waiting for user input.
   */
  get isWaitingForInput(): boolean {
    return this.activity === "waiting-input";
  }

  /**
   * Check if the agent is currently in a turn.
   */
  get isInTurn(): boolean {
    return this.activity === "in-turn";
  }

  /**
   * Check if the session needs attention (pending input or unread).
   */
  get needsAttention(): boolean {
    return this.hasUnread || !!this.pendingInputType;
  }

  // ===========================================================================
  // Factory Methods
  // ===========================================================================

  /**
   * Create a SessionView from an API session summary response.
   */
  static from(summary: AppSessionSummary): SessionView {
    return new SessionView(
      summary.id,
      summary.projectId,
      summary.title,
      summary.fullTitle,
      summary.customTitle,
      summary.createdAt,
      summary.updatedAt,
      summary.messageCount,
      summary.ownership,
      summary.isArchived ?? false,
      summary.isStarred ?? false,
      summary.pendingInputType,
      summary.activity,
      summary.lastSeenAt,
      summary.hasUnread ?? false,
      summary.contextUsage,
      summary.provider,
    );
  }

  /**
   * Create a SessionView from partial data.
   * Useful for creating views from cached or incomplete data.
   */
  static fromPartial(data: {
    id: string;
    projectId?: UrlProjectId;
    title?: string | null;
    fullTitle?: string | null;
    customTitle?: string;
    createdAt?: string;
    updatedAt?: string;
    messageCount?: number;
    ownership?: SessionOwnership;
    isArchived?: boolean;
    isStarred?: boolean;
    pendingInputType?: PendingInputType;
    activity?: AgentActivity;
    lastSeenAt?: string;
    hasUnread?: boolean;
    contextUsage?: ContextUsage;
    provider?: ProviderName;
  }): SessionView {
    const now = new Date().toISOString();
    return new SessionView(
      data.id,
      data.projectId ?? ("" as UrlProjectId),
      data.title ?? null,
      data.fullTitle ?? null,
      data.customTitle,
      data.createdAt ?? now,
      data.updatedAt ?? now,
      data.messageCount ?? 0,
      data.ownership ?? { owner: "none" },
      data.isArchived ?? false,
      data.isStarred ?? false,
      data.pendingInputType,
      data.activity,
      data.lastSeenAt,
      data.hasUnread ?? false,
      data.contextUsage,
      data.provider ?? DEFAULT_PROVIDER,
    );
  }
}

/**
 * Standalone utility function for getting display title from session-like objects.
 * Useful when you don't need a full SessionView instance.
 *
 * @param session - Object with optional title fields
 * @returns The display title (customTitle > title > "Untitled")
 */
export function getSessionDisplayTitle(
  session: { customTitle?: string; title?: string | null } | null | undefined,
): string {
  if (!session) return "Untitled";
  return session.customTitle ?? session.title ?? "Untitled";
}
