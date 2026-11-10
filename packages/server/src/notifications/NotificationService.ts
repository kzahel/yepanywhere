/** Session seen state is canonical per-row SQLite data, shared across tabs. */
import * as path from "node:path";
import type { SqliteDatabase } from "../storage/sqlite.js";
import type { EventBus, SessionSeenEvent } from "../watcher/EventBus.js";
import { SessionLastSeen } from "./session-last-seen.js";
export type { SessionSeenEvent };

export interface LastSeenEntry {
  timestamp: string;
  messageId?: string;
}
/** Legacy import/export shape; the live service does not retain this map. */
export interface NotificationState {
  lastSeen: Record<string, LastSeenEntry>;
  version: number;
}
export interface NotificationServiceOptions {
  database: SqliteDatabase;
  dataDir?: string;
  eventBus?: EventBus;
}
export class NotificationService {
  /** One listener per collection-query owner, removed on owner retirement. */
  private readonly changeListeners = new Set<(sessionId: string) => void>();
  private readonly rows: SessionLastSeen;
  private readonly filePath: string;
  private readonly legacyFilePath: string;
  constructor(private readonly options: NotificationServiceOptions) {
    const dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.rows = new SessionLastSeen(options.database);
    this.filePath = path.join(dataDir, "discovery.sqlite");
    this.legacyFilePath = path.join(dataDir, "notifications.json");
  }
  subscribeChanges(listener: (sessionId: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  private changed(sessionId: string): void {
    for (const listener of this.changeListeners) listener(sessionId);
  }
  async initialize(): Promise<void> {
    await this.rows.importLegacy(this.legacyFilePath);
  }
  async markSeen(
    sessionId: string,
    timestamp?: string,
    messageId?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const provided = timestamp ?? now;
    const ts = provided > now ? provided : now;
    const changed = this.options.database.transaction(() => {
      const existing = this.rows.get(sessionId);
      if (existing && existing.timestamp >= ts) return false;
      this.rows.put(sessionId, { timestamp: ts, messageId });
      return true;
    });
    if (!changed) return;
    this.changed(sessionId);
    this.options.eventBus?.emit({
      type: "session-seen",
      sessionId,
      timestamp: ts,
      messageId,
    });
  }
  getLastSeen(sessionId: string): LastSeenEntry | undefined {
    return this.rows.get(sessionId);
  }
  /** Explicit complete export; normal unread reads are indexed points. */
  getAllLastSeen(): Record<string, LastSeenEntry> {
    return this.rows.all();
  }
  hasUnread(sessionId: string, updatedAt: string): boolean {
    const seen = this.rows.get(sessionId);
    return !seen || updatedAt > seen.timestamp;
  }
  async clearSession(sessionId: string): Promise<void> {
    if (this.options.database.transaction(() => this.rows.remove(sessionId)))
      this.changed(sessionId);
  }
  getFilePath(): string {
    return this.filePath;
  }
  /** Every mutation resolves after its synchronous commit; nothing is deferred. */
  async flush(): Promise<void> {}
  dispose(): void {
    this.changeListeners.clear();
    this.rows.dispose();
  }
}
