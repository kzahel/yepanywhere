/**
 * Session class provides a unified interface for session operations on the server.
 *
 * Extends SessionView (from shared) with server-side I/O capabilities:
 * - Reading/writing custom titles
 * - Refreshing from disk
 * - Archive/star status management
 *
 * Usage:
 *   const session = await Session.load(sessionId, projectId, deps);
 *   console.log(session.displayTitle);  // inherited from SessionView
 *   await session.rename("New name");   // server-only
 */

import {
  type AppSessionSummary,
  SessionView,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { ISessionIndexService } from "../indexes/types.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { ISessionReader } from "./types.js";

/**
 * Dependencies required by Session for I/O operations.
 * Passed via constructor or load() for testability.
 *
 * These are provider-agnostic interfaces, allowing Session to work
 * with any provider (Claude, Codex, Gemini, etc.).
 */
export interface SessionDeps {
  indexService: ISessionIndexService;
  metadataService: SessionMetadataService;
  reader: ISessionReader;
  sessionDir: string;
}

/**
 * Session extends SessionView with server-side capabilities.
 */
export class Session extends SessionView {
  private deps: SessionDeps;

  private constructor(summary: AppSessionSummary, deps: SessionDeps) {
    super(
      summary.id,
      summary.projectId,
      summary.title,
      summary.fullTitle,
      summary.customTitle,
      summary.createdAt,
      summary.updatedAt,
      summary.messageCount,
      summary.status,
      summary.isArchived ?? false,
      summary.isStarred ?? false,
      summary.pendingInputType,
      summary.processState,
      summary.lastSeenAt,
      summary.hasUnread ?? false,
      summary.contextUsage,
      summary.provider,
    );
    this.deps = deps;
  }

  /**
   * Load a session by ID, combining data from cache and metadata services.
   *
   * @param sessionId - The session ID
   * @param projectId - The project ID
   * @param deps - Service dependencies for I/O
   * @returns Session instance or null if not found
   */
  static async load(
    sessionId: string,
    projectId: UrlProjectId,
    deps: SessionDeps,
  ): Promise<Session | null> {
    // Get full summary to check if session exists
    const summary = await deps.reader.getSessionSummary(sessionId, projectId);

    // Return null if session doesn't exist
    if (!summary) {
      return null;
    }

    // Get custom metadata to merge in
    const metadata = deps.metadataService.getMetadata(sessionId);

    // Merge metadata into summary
    const enrichedSummary: AppSessionSummary = {
      ...summary,
      customTitle: metadata?.customTitle,
      isArchived: metadata?.isArchived,
      isStarred: metadata?.isStarred,
    };

    return new Session(enrichedSummary, deps);
  }

  /**
   * Create a Session from an existing AppSessionSummary (already loaded data).
   * Useful when you've already fetched the summary via other means.
   */
  static fromSummary(summary: AppSessionSummary, deps: SessionDeps): Session {
    return new Session(summary, deps);
  }

  /**
   * Set a custom title for this session.
   * Pass undefined or empty string to clear the custom title.
   */
  async rename(title: string | undefined): Promise<void> {
    await this.deps.metadataService.setTitle(this.id, title);
  }

  /**
   * Set the archived status for this session.
   */
  async setArchived(archived: boolean): Promise<void> {
    await this.deps.metadataService.setArchived(this.id, archived);
  }

  /**
   * Set the starred status for this session.
   */
  async setStarred(starred: boolean): Promise<void> {
    await this.deps.metadataService.setStarred(this.id, starred);
  }

  /**
   * Refresh session data from disk.
   * Returns a new Session instance with updated data.
   */
  async refresh(): Promise<Session | null> {
    // Invalidate cache to force re-read
    this.deps.indexService.invalidateSession(this.deps.sessionDir, this.id);

    // Reload
    return Session.load(this.id, this.projectId, this.deps);
  }

  /**
   * Get the auto-generated title (from first user message).
   * This is the title before any custom rename.
   */
  getAutoTitle(): string | null {
    return this.autoTitle;
  }

  /**
   * Convert to a plain object suitable for API responses.
   * Returns the full session summary with all fields.
   */
  toJSON(): AppSessionSummary {
    return {
      id: this.id,
      projectId: this.projectId,
      title: this.autoTitle,
      fullTitle: this.fullTitle,
      customTitle: this.customTitle,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      messageCount: this.messageCount,
      status: this.status,
      isArchived: this.isArchived,
      isStarred: this.isStarred,
      pendingInputType: this.pendingInputType,
      processState: this.processState,
      lastSeenAt: this.lastSeenAt,
      hasUnread: this.hasUnread,
      contextUsage: this.contextUsage,
      provider: this.provider,
    };
  }
}
