import type * as fs from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  isClaudeProviderName,
  type NativeSessionFamily,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { Project } from "../supervisor/types.js";
import { watchSharedDirectory } from "./SharedDirectoryWatcher.js";

type WatchProvider = NativeSessionFamily;
type ChangeSource = "fs-watch" | "poll";

interface ChangeCheckRequest {
  source: ChangeSource;
  sourceObservedAtMs: number;
}

interface CodexSessionInfo {
  id: string;
  filePath: string;
}

interface GeminiSessionInfo {
  id: string;
  filePath: string;
}

interface SessionWatchTarget {
  controller: AbortController;
  key: string;
  sessionId: string;
  projectId: UrlProjectId;
  providerHint?: string;
  subscribers: Map<number, (event: FocusedSessionWatchEvent) => void>;
  filePath: string | null;
  fileName: string | null;
  additionalFilePaths: readonly string[];
  knownVersion: string | null;
  provider: WatchProvider | null;
  knownMtimeMs: number | null;
  knownSize: number | null;
  watchDir: string | null;
  pollTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  resolveRetryTimer: NodeJS.Timeout | null;
  resolving: boolean;
  checkInProgress: boolean;
  pendingCheck: ChangeCheckRequest | null;
}

interface FocusedDirectoryWatch {
  targets: Set<SessionWatchTarget>;
  watcher: fs.FSWatcher;
}

export interface FocusedSessionWatchRequest {
  sessionId: string;
  projectId: UrlProjectId;
  providerHint?: string;
}

export interface FocusedSessionWatchEvent {
  type: "session-watch-change";
  sessionId: string;
  projectId: UrlProjectId;
  provider: WatchProvider;
  path: string;
  source: ChangeSource;
  changeVersion: number;
  sourceObservedAt: string;
  mtimeMs: number;
  size: number;
  timestamp: string;
}

export interface FocusedSessionWatchManagerOptions {
  /** Undefined retains legacy discovery; null is a stored but unreadable source. */
  resolveStoredSessionFile?: (
    request: FocusedSessionWatchRequest,
    signal: AbortSignal,
  ) => Promise<ResolvedSessionFile | null | undefined>;
  scanner: {
    getProject(projectId: string): Promise<Project | null>;
    getOrCreateProject(projectId: string): Promise<Project | null>;
  };
  codexScanner: {
    getSessionsForProject(projectPath: string): Promise<CodexSessionInfo[]>;
  };
  geminiScanner: {
    getSessionsForProject(projectPath: string): Promise<GeminiSessionInfo[]>;
  };
  pollMs?: number;
  debounceMs?: number;
}

export interface ResolvedSessionFile {
  filePath: string;
  /** Fixed same-directory companions, e.g. the native SQLite WAL. */
  additionalFilePaths?: readonly string[];
  provider: WatchProvider;
}

/**
 * Focused, per-session file watcher with polling fallback.
 *
 * This is designed for "open session" UI views where missing updates is
 * catastrophic. Watches are reference-counted per (projectId, sessionId).
 */
export class FocusedSessionWatchManager {
  private static readonly LOG_EVENTS =
    process.env.SESSION_FOCUSED_WATCH_LOG_EVENTS === "true";
  private readonly scanner: FocusedSessionWatchManagerOptions["scanner"];
  private readonly codexScanner: FocusedSessionWatchManagerOptions["codexScanner"];
  private readonly geminiScanner: FocusedSessionWatchManagerOptions["geminiScanner"];
  private readonly resolveStoredSessionFile: FocusedSessionWatchManagerOptions["resolveStoredSessionFile"];
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private readonly targets = new Map<string, SessionWatchTarget>();
  private readonly directoryWatches = new Map<string, FocusedDirectoryWatch>();
  private nextSubscriberId = 1;
  private nextChangeVersion = 1;

  constructor(options: FocusedSessionWatchManagerOptions) {
    this.scanner = options.scanner;
    this.codexScanner = options.codexScanner;
    this.geminiScanner = options.geminiScanner;
    this.resolveStoredSessionFile = options.resolveStoredSessionFile;
    this.pollMs = Math.max(250, options.pollMs ?? 1500);
    this.debounceMs = Math.max(50, options.debounceMs ?? 200);
  }

  subscribe(
    request: FocusedSessionWatchRequest,
    onChange: (event: FocusedSessionWatchEvent) => void,
  ): () => void {
    const key = this.getKey(request);
    let target = this.targets.get(key);
    if (!target) {
      target = this.createTarget(request);
      this.targets.set(key, target);
    }

    const subscriberId = this.nextSubscriberId++;
    target.subscribers.set(subscriberId, onChange);

    if (target.subscribers.size === 1) {
      void this.ensureWatching(target);
    }

    return () => {
      const current = this.targets.get(key);
      if (!current) return;
      current.subscribers.delete(subscriberId);
      if (current.subscribers.size === 0) {
        this.teardownTarget(current);
        this.targets.delete(key);
      }
    };
  }

  dispose(): void {
    for (const target of this.targets.values()) {
      this.teardownTarget(target);
    }
    this.targets.clear();
  }

  private getKey(request: FocusedSessionWatchRequest): string {
    return `${request.projectId}:${request.sessionId}`;
  }

  private createTarget(
    request: FocusedSessionWatchRequest,
  ): SessionWatchTarget {
    return {
      controller: new AbortController(),
      key: this.getKey(request),
      sessionId: request.sessionId,
      projectId: request.projectId,
      providerHint: request.providerHint,
      subscribers: new Map(),
      filePath: null,
      fileName: null,
      additionalFilePaths: [],
      knownVersion: null,
      provider: null,
      knownMtimeMs: null,
      knownSize: null,
      watchDir: null,
      pollTimer: null,
      debounceTimer: null,
      resolveRetryTimer: null,
      resolving: false,
      checkInProgress: false,
      pendingCheck: null,
    };
  }

  private async ensureWatching(target: SessionWatchTarget): Promise<void> {
    if (target.resolving || target.subscribers.size === 0) {
      return;
    }
    target.resolving = true;
    try {
      const resolved = await this.resolveSessionFile(target);
      if (!resolved) {
        if (this.isTargetActive(target)) {
          this.ensureResolveRetry(target);
        }
        return;
      }
      if (!this.isTargetActive(target)) return;

      this.clearResolveRetry(target);

      if (
        target.filePath === resolved.filePath &&
        target.watchDir &&
        this.directoryWatches.get(target.watchDir)?.targets.has(target)
      ) {
        return;
      }

      await this.attachTargetToFile(target, resolved);
    } finally {
      target.resolving = false;
    }
  }

  private ensureResolveRetry(target: SessionWatchTarget): void {
    if (target.resolveRetryTimer) return;
    target.resolveRetryTimer = setInterval(
      () => {
        void this.ensureWatching(target);
      },
      Math.max(this.pollMs * 2, 2000),
    );
  }

  private clearResolveRetry(target: SessionWatchTarget): void {
    if (!target.resolveRetryTimer) return;
    clearInterval(target.resolveRetryTimer);
    target.resolveRetryTimer = null;
  }

  private async attachTargetToFile(
    target: SessionWatchTarget,
    resolved: ResolvedSessionFile,
  ): Promise<void> {
    this.teardownRuntime(target);

    target.filePath = resolved.filePath;
    target.fileName = basename(resolved.filePath);
    target.provider = resolved.provider;

    target.additionalFilePaths = (resolved.additionalFilePaths ?? [])
      .filter(
        (path) =>
          dirname(path) === dirname(resolved.filePath) &&
          path !== resolved.filePath,
      )
      .slice(0, 3);
    const snapshot = await this.sourceSnapshot(target);
    target.knownVersion = snapshot?.version ?? null;
    target.knownMtimeMs = snapshot?.mtimeMs ?? null;
    target.knownSize = snapshot?.size ?? null;
    if (!this.isTargetActive(target)) return;

    this.attachDirectoryWatch(target, dirname(resolved.filePath));

    target.pollTimer = setInterval(() => {
      this.requestCheck(target, "poll", Date.now());
    }, this.pollMs);

    if (FocusedSessionWatchManager.LOG_EVENTS) {
      console.log(
        `[FocusedSessionWatch] Watching session=${target.sessionId} project=${target.projectId} file=${resolved.filePath}`,
      );
    }
  }

  private async sourceSnapshot(target: SessionWatchTarget) {
    if (!target.filePath || target.controller.signal.aborted) return null;
    const files = await Promise.all(
      [target.filePath, ...target.additionalFilePaths].map((path) =>
        stat(path).catch(() => null),
      ),
    );
    if (!files[0] || target.controller.signal.aborted) return null;
    return {
      version: files
        .map((file) =>
          file
            ? `${file.dev}:${file.ino}:${file.mtimeMs}:${file.ctimeMs}:${file.size}`
            : "missing",
        )
        .join("|"),
      mtimeMs: Math.max(...files.map((file) => file?.mtimeMs ?? 0)),
      size: files.reduce((sum, file) => sum + (file?.size ?? 0), 0),
    };
  }

  private isTargetActive(target: SessionWatchTarget): boolean {
    return (
      target.subscribers.size > 0 && this.targets.get(target.key) === target
    );
  }

  private attachDirectoryWatch(
    target: SessionWatchTarget,
    watchDir: string,
  ): void {
    let directoryWatch = this.directoryWatches.get(watchDir);
    if (!directoryWatch) {
      try {
        const watcher = watchSharedDirectory(
          watchDir,
          {},
          (_eventType, filename) => {
            this.notifyDirectoryTargets(watchDir, filename?.toString());
          },
        );
        directoryWatch = { targets: new Set(), watcher };
        watcher.on("error", () => {
          this.notifyDirectoryTargets(watchDir);
        });
        this.directoryWatches.set(watchDir, directoryWatch);
      } catch (error) {
        console.warn(
          `[FocusedSessionWatch] Failed to start fs.watch for ${watchDir}:`,
          error,
        );
        return;
      }
    }

    directoryWatch.targets.add(target);
    target.watchDir = watchDir;
  }

  private notifyDirectoryTargets(watchDir: string, changedName?: string): void {
    const directoryWatch = this.directoryWatches.get(watchDir);
    if (!directoryWatch) return;
    const sourceObservedAtMs = Date.now();
    for (const target of directoryWatch.targets) {
      if (
        changedName &&
        changedName !== target.fileName &&
        !target.additionalFilePaths.some(
          (path) => basename(path) === changedName,
        )
      )
        continue;
      this.requestCheck(target, "fs-watch", sourceObservedAtMs);
      this.scheduleDebouncedCheck(target, "fs-watch", sourceObservedAtMs);
    }
  }

  private releaseDirectoryWatch(target: SessionWatchTarget): void {
    const watchDir = target.watchDir;
    target.watchDir = null;
    if (!watchDir) return;
    const directoryWatch = this.directoryWatches.get(watchDir);
    if (!directoryWatch) return;
    directoryWatch.targets.delete(target);
    if (directoryWatch.targets.size > 0) return;
    directoryWatch.watcher.close();
    this.directoryWatches.delete(watchDir);
  }

  private scheduleDebouncedCheck(
    target: SessionWatchTarget,
    source: ChangeSource,
    sourceObservedAtMs = Date.now(),
  ): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
    }
    target.debounceTimer = setTimeout(() => {
      target.debounceTimer = null;
      this.requestCheck(target, source, sourceObservedAtMs);
    }, this.debounceMs);
  }

  private requestCheck(
    target: SessionWatchTarget,
    source: ChangeSource,
    sourceObservedAtMs = Date.now(),
  ): void {
    if (target.subscribers.size === 0) return;
    const request = { source, sourceObservedAtMs };
    if (target.checkInProgress) {
      this.queuePendingCheck(target, request);
      return;
    }
    void this.checkForChanges(target, request);
  }

  private queuePendingCheck(
    target: SessionWatchTarget,
    request: ChangeCheckRequest,
  ): void {
    const pending = target.pendingCheck;
    if (
      !pending ||
      (pending.source === "poll" && request.source === "fs-watch")
    ) {
      target.pendingCheck = request;
      return;
    }
    if (pending.source === request.source) {
      pending.sourceObservedAtMs = Math.min(
        pending.sourceObservedAtMs,
        request.sourceObservedAtMs,
      );
    }
  }

  private async checkForChanges(
    target: SessionWatchTarget,
    request: ChangeCheckRequest,
  ): Promise<void> {
    if (target.subscribers.size === 0) {
      return;
    }
    if (target.checkInProgress) {
      this.queuePendingCheck(target, request);
      return;
    }
    target.checkInProgress = true;

    try {
      const filePath = target.filePath;
      if (!filePath || !target.provider) {
        await this.ensureWatching(target);
        return;
      }

      const snapshot = await this.sourceSnapshot(target);
      if (!this.isTargetActive(target)) return;
      if (!snapshot) {
        target.knownVersion = "missing";
        target.knownMtimeMs = null;
        target.knownSize = null;
        await this.ensureWatching(target);
        return;
      }
      const changed =
        target.knownVersion !== null &&
        target.knownVersion !== snapshot.version;
      target.knownVersion = snapshot.version;
      target.knownMtimeMs = snapshot.mtimeMs;
      target.knownSize = snapshot.size;
      const nextMtimeMs = snapshot.mtimeMs;
      const nextSize = snapshot.size;

      if (!changed) {
        return;
      }

      const event: FocusedSessionWatchEvent = {
        type: "session-watch-change",
        sessionId: target.sessionId,
        projectId: target.projectId,
        provider: target.provider,
        path: filePath,
        source: request.source,
        changeVersion: this.nextChangeVersion++,
        sourceObservedAt: new Date(request.sourceObservedAtMs).toISOString(),
        mtimeMs: nextMtimeMs,
        size: nextSize,
        timestamp: new Date().toISOString(),
      };

      if (FocusedSessionWatchManager.LOG_EVENTS) {
        console.log(
          `[FocusedSessionWatch] change session=${event.sessionId} project=${event.projectId} source=${event.source} file=${event.path}`,
        );
      }

      for (const callback of target.subscribers.values()) {
        try {
          callback(event);
        } catch (error) {
          console.error(
            "[FocusedSessionWatch] subscriber callback failed:",
            error,
          );
        }
      }
    } finally {
      target.checkInProgress = false;
      const pendingCheck = target.pendingCheck;
      target.pendingCheck = null;
      if (pendingCheck && target.subscribers.size > 0) {
        queueMicrotask(() =>
          this.requestCheck(
            target,
            pendingCheck.source,
            pendingCheck.sourceObservedAtMs,
          ),
        );
      }
    }
  }

  private async resolveSessionFile(
    target: SessionWatchTarget,
  ): Promise<ResolvedSessionFile | null> {
    const stored = await this.resolveStoredSessionFile?.(
      {
        sessionId: target.sessionId,
        projectId: target.projectId,
        providerHint: target.providerHint,
      },
      target.controller.signal,
    );
    if (stored !== undefined) return stored;
    const project =
      (await this.scanner.getProject(target.projectId)) ??
      (await this.scanner.getOrCreateProject(target.projectId));

    if (!project) {
      return null;
    }

    const providerCandidates = this.getProviderCandidates(
      target.providerHint,
      project.provider,
    );

    for (const provider of providerCandidates) {
      if (provider === "claude") {
        const dirs = [project.sessionDir, ...(project.mergedSessionDirs ?? [])];
        for (const dir of dirs) {
          const candidate = join(dir, `${target.sessionId}.jsonl`);
          if (await this.fileExists(candidate)) {
            return { filePath: candidate, provider };
          }
        }
        continue;
      }

      if (provider === "codex") {
        const sessions = await this.codexScanner.getSessionsForProject(
          project.path,
        );
        const match = sessions.find(
          (session) => session.id === target.sessionId,
        );
        if (match) {
          return { filePath: match.filePath, provider };
        }
        continue;
      }

      if (provider === "gemini") {
        const sessions = await this.geminiScanner.getSessionsForProject(
          project.path,
        );
        const match = sessions.find(
          (session) => session.id === target.sessionId,
        );
        if (match) {
          return { filePath: match.filePath, provider };
        }
      }
    }

    return null;
  }

  private getProviderCandidates(
    providerHint: string | undefined,
    projectProvider: string | undefined,
  ): WatchProvider[] {
    const candidates: WatchProvider[] = [];
    const pushCandidate = (candidate: WatchProvider | null) => {
      if (!candidate || candidates.includes(candidate)) return;
      candidates.push(candidate);
    };

    pushCandidate(this.normalizeProvider(providerHint));
    pushCandidate(this.normalizeProvider(projectProvider));
    pushCandidate("claude");
    pushCandidate("codex");
    pushCandidate("gemini");
    return candidates;
  }

  private normalizeProvider(
    provider: string | undefined,
  ): WatchProvider | null {
    if (!provider) return null;
    if (provider === "codex" || provider === "codex-oss") return "codex";
    if (provider === "gemini" || provider === "gemini-acp") return "gemini";
    if (isClaudeProviderName(provider) || provider === "opencode") {
      return "claude";
    }
    return null;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private teardownRuntime(target: SessionWatchTarget): void {
    this.releaseDirectoryWatch(target);
    if (target.pollTimer) {
      clearInterval(target.pollTimer);
      target.pollTimer = null;
    }
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }
    target.pendingCheck = null;
  }

  private teardownTarget(target: SessionWatchTarget): void {
    target.controller.abort();
    this.teardownRuntime(target);
    this.clearResolveRetry(target);
  }
}
