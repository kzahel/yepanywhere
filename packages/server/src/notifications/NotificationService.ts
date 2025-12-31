/**
 * NotificationService manages session notification state (last seen timestamps).
 * This enables "unread" badge tracking across all devices/tabs.
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EventBus, SessionSeenEvent } from "../watcher/EventBus.js";

export type { SessionSeenEvent };

export interface LastSeenEntry {
  /** ISO timestamp of when session was last viewed */
  timestamp: string;
  /** Optional: last message ID that was seen */
  messageId?: string;
}

export interface NotificationState {
  /** Map of sessionId -> last seen info */
  lastSeen: Record<string, LastSeenEntry>;
  /** Schema version for future migrations */
  version: number;
}

const CURRENT_VERSION = 1;

export interface NotificationServiceOptions {
  /** Directory to store notification state (defaults to ~/.claude-anywhere) */
  dataDir?: string;
  /** EventBus for emitting seen events */
  eventBus?: EventBus;
}

export class NotificationService {
  private state: NotificationState;
  private dataDir: string;
  private filePath: string;
  private eventBus?: EventBus;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: NotificationServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".claude-anywhere",
      );
    this.filePath = path.join(this.dataDir, "notifications.json");
    this.eventBus = options.eventBus;
    this.state = { lastSeen: {}, version: CURRENT_VERSION };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory and file if they don't exist.
   */
  async initialize(): Promise<void> {
    try {
      // Ensure data directory exists
      await fs.mkdir(this.dataDir, { recursive: true });

      // Try to load existing state
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as NotificationState;

      // Validate and migrate if needed
      if (parsed.version === CURRENT_VERSION) {
        this.state = parsed;
      } else {
        // Future: handle migrations here
        this.state = {
          lastSeen: parsed.lastSeen ?? {},
          version: CURRENT_VERSION,
        };
        await this.save();
      }
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[NotificationService] Failed to load state, starting fresh:",
          error,
        );
      }
      this.state = { lastSeen: {}, version: CURRENT_VERSION };
    }
  }

  /**
   * Mark a session as seen at the given timestamp.
   * @param sessionId The session ID
   * @param timestamp ISO timestamp (defaults to now)
   * @param messageId Optional message ID that was seen
   */
  async markSeen(
    sessionId: string,
    timestamp?: string,
    messageId?: string,
  ): Promise<void> {
    const ts = timestamp ?? new Date().toISOString();

    // Only update if this is newer than existing entry
    const existing = this.state.lastSeen[sessionId];
    if (existing && existing.timestamp >= ts) {
      return;
    }

    this.state.lastSeen[sessionId] = {
      timestamp: ts,
      messageId,
    };

    // Emit event for other tabs/clients
    if (this.eventBus) {
      this.eventBus.emit({
        type: "session-seen",
        sessionId,
        timestamp: ts,
        messageId,
      });
    }

    await this.save();
  }

  /**
   * Get the last seen entry for a session.
   */
  getLastSeen(sessionId: string): LastSeenEntry | undefined {
    return this.state.lastSeen[sessionId];
  }

  /**
   * Get all last seen entries.
   */
  getAllLastSeen(): Record<string, LastSeenEntry> {
    return { ...this.state.lastSeen };
  }

  /**
   * Check if a session has unread content.
   * @param sessionId The session ID
   * @param updatedAt ISO timestamp of when the session was last updated
   */
  hasUnread(sessionId: string, updatedAt: string): boolean {
    const lastSeen = this.state.lastSeen[sessionId];
    if (!lastSeen) {
      // Never seen = unread (if there's any content)
      return true;
    }
    return updatedAt > lastSeen.timestamp;
  }

  /**
   * Clear the last seen entry for a session.
   * Useful when a session is deleted.
   */
  async clearSession(sessionId: string): Promise<void> {
    if (this.state.lastSeen[sessionId]) {
      delete this.state.lastSeen[sessionId];
      await this.save();
    }
  }

  /**
   * Save state to disk with debouncing to prevent excessive writes.
   */
  private async save(): Promise<void> {
    // If a save is in progress, mark that we need another save
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;

    // If another save was requested while we were saving, do it now
    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[NotificationService] Failed to save state:", error);
      throw error;
    }
  }

  /**
   * Get the file path for testing purposes.
   */
  getFilePath(): string {
    return this.filePath;
  }
}
