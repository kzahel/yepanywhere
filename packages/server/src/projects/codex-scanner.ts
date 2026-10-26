/**
 * CodexSessionScanner - Scans Codex sessions and groups them by project (cwd).
 *
 * Unlike Claude which organizes sessions by project directory, Codex stores
 * sessions by date: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Each session file has session_meta as the first line containing the cwd.
 * We scan all sessions and group them by cwd to create virtual "projects".
 *
 * Scan results are cached with a short TTL to avoid redundant filesystem work
 * when multiple callers need session data in the same request cycle.
 */

import { readdir, stat } from "node:fs/promises";
import { isTransientFileReadError } from "../utils/fileReadError.js";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { SessionDiscoveryIndex } from "../indexes/SessionDiscoveryIndex.js";
import { getLogger } from "../logging/logger.js";
import {
  type CodexRolloutDiscoveryStats,
  createCodexSessionDiscoveryIndex,
  createCodexRolloutDiscoveryStats,
  readCodexRolloutMetadata,
} from "../sessions/codex-discovery.js";
import type { Project } from "../supervisor/types.js";
import {
  codexRolloutRepresentation,
  getCodexSessionRoots,
  isCodexRolloutFileName,
  plainCodexRolloutPath,
  preferActiveCodexRollouts,
  preferPlainCodexRollouts,
} from "../utils/codexRolloutFiles.js";
import {
  canonicalizeProjectPath,
  encodeProjectId,
  getProjectIdentityKey,
} from "./paths.js";

export const CODEX_SESSIONS_DIR =
  process.env.CODEX_SESSIONS_DIR ?? getDefaultCodexSessionsDir();
export const CODEX_DIR = process.env.CODEX_HOME ?? join(homedir(), ".codex");

export function getDefaultCodexHomeDir(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function getDefaultCodexSessionsDir(): string {
  return join(getDefaultCodexHomeDir(), "sessions");
}

interface CodexSessionInfo {
  id: string;
  cwd: string;
  filePath: string;
  timestamp: string;
  mtime: number;
  isSubagent: boolean;
}

function chooseDisplayProjectPath(
  variants: Map<string, { count: number; lastActivity: number }>,
): string {
  let bestPath: string | null = null;
  let bestCount = -1;
  let bestLastActivity = -1;

  for (const [path, stats] of variants) {
    if (
      bestPath === null ||
      stats.count > bestCount ||
      (stats.count === bestCount && stats.lastActivity > bestLastActivity) ||
      (stats.count === bestCount &&
        stats.lastActivity === bestLastActivity &&
        path < bestPath)
    ) {
      bestPath = path;
      bestCount = stats.count;
      bestLastActivity = stats.lastActivity;
    }
  }

  return bestPath ?? "";
}

export interface CodexScannerOptions {
  sessionsDir?: string; // override for testing
  dataDir?: string;
  discoveryIndex?: SessionDiscoveryIndex;
  slowLogThresholdMs?: number;
}

/** How long to cache scan results (ms) */
const SCAN_CACHE_TTL = 5_000;
const DEFAULT_SLOW_LOG_THRESHOLD_MS = 250;

export interface CodexScannerMetrics {
  sessionsDir: string;
  durationMs: number;
  sessionsDirExists: boolean;
  directoriesVisited: number;
  directoryReadErrors: number;
  rolloutFilesFound: number;
  rolloutFilesAfterPrecedence: number;
  plainRolloutFiles: number;
  compressedRolloutFiles: number;
  precedenceSkippedCompressed: number;
  sessionsParsed: number;
  failedFiles: number;
  discovery: CodexRolloutDiscoveryStats;
}

export class CodexSessionScanner {
  private sessionsDir: string;
  private discoveryIndex?: SessionDiscoveryIndex;
  private slowLogThresholdMs: number;
  private cachedScan: { result: CodexSessionInfo[]; timestamp: number } | null =
    null;
  private lastScanMetrics: CodexScannerMetrics | null = null;
  private changedFiles = new Set<string>();
  private scanEpoch = 0;
  private inFlightScan: Promise<CodexSessionInfo[]> | null = null;

  constructor(options: CodexScannerOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? CODEX_SESSIONS_DIR;
    this.discoveryIndex =
      options.discoveryIndex ??
      createCodexSessionDiscoveryIndex(options.dataDir, this.sessionsDir);
    this.slowLogThresholdMs = Math.max(
      0,
      options.slowLogThresholdMs ?? DEFAULT_SLOW_LOG_THRESHOLD_MS,
    );
  }

  invalidateCache(filePath?: string): void {
    if (filePath) {
      if (
        getCodexSessionRoots(this.sessionsDir).some((root) => {
          const relativePath = relative(root, filePath);
          return (
            relativePath.split(sep)[0] !== ".." &&
            !isAbsolute(relativePath) &&
            isCodexRolloutFileName(filePath)
          );
        })
      ) {
        this.changedFiles.add(plainCodexRolloutPath(filePath));
        return;
      }
    }
    this.scanEpoch += 1;
    if (this.cachedScan) this.cachedScan.timestamp = 0;
    this.changedFiles.clear();
  }

  getLastScanMetrics(): CodexScannerMetrics | null {
    return this.lastScanMetrics
      ? cloneCodexScannerMetrics(this.lastScanMetrics)
      : null;
  }

  /**
   * Scan all Codex sessions and group them by project (cwd).
   * Returns projects sorted by last activity (most recent first).
   */
  async listProjects(
    options: { allowStaleSnapshot?: boolean } = {},
  ): Promise<Project[]> {
    const sessions = this.selectSessions(
      await this.scanAllSessions(options.allowStaleSnapshot),
    );

    // Group sessions by cwd
    const projectMap = new Map<
      string,
      {
        sessions: CodexSessionInfo[];
        lastActivity: number;
        pathVariants: Map<string, { count: number; lastActivity: number }>;
      }
    >();

    for (const session of sessions) {
      if (session.isSubagent) {
        continue;
      }

      const projectPath = canonicalizeProjectPath(session.cwd);
      const projectKey = getProjectIdentityKey(projectPath);
      const existing = projectMap.get(projectKey);
      if (existing) {
        existing.sessions.push(session);
        if (session.mtime > existing.lastActivity) {
          existing.lastActivity = session.mtime;
        }
        const variant = existing.pathVariants.get(projectPath);
        if (variant) {
          variant.count += 1;
          variant.lastActivity = Math.max(variant.lastActivity, session.mtime);
        } else {
          existing.pathVariants.set(projectPath, {
            count: 1,
            lastActivity: session.mtime,
          });
        }
      } else {
        projectMap.set(projectKey, {
          sessions: [session],
          lastActivity: session.mtime,
          pathVariants: new Map([
            [
              projectPath,
              {
                count: 1,
                lastActivity: session.mtime,
              },
            ],
          ]),
        });
      }
    }

    // Convert to Project[]
    const projects: Project[] = [];
    for (const data of projectMap.values()) {
      const cwd = chooseDisplayProjectPath(data.pathVariants);
      projects.push({
        id: encodeProjectId(cwd),
        path: cwd,
        name: basename(cwd),
        sessionCount: data.sessions.length,
        sessionCountsByProvider: { codex: data.sessions.length },
        sessionDir: this.sessionsDir, // All sessions are in the same tree
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: new Date(data.lastActivity).toISOString(),
        provider: "codex",
      });
    }

    // Sort by last activity descending
    projects.sort((a, b) => {
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return (
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );
    });

    return projects;
  }

  /**
   * Get sessions for a specific project (cwd).
   */
  async getSessionsForProject(
    projectPath: string,
  ): Promise<CodexSessionInfo[]> {
    const sessions = this.selectSessions(await this.scanAllSessions());
    const canonicalProjectPath = canonicalizeProjectPath(projectPath);
    const projectIdentityKey = getProjectIdentityKey(canonicalProjectPath);
    return sessions
      .filter(
        (s) =>
          !s.isSubagent && getProjectIdentityKey(s.cwd) === projectIdentityKey,
      )
      .sort((a, b) => b.mtime - a.mtime);
  }

  async getSessionProjectPath(sessionId: string): Promise<string | null> {
    const session = this.selectSessions(await this.scanAllSessions()).find(
      (candidate) => !candidate.isSubagent && candidate.id === sessionId,
    );
    return session ? canonicalizeProjectPath(session.cwd) : null;
  }

  private selectSessions(sessions: CodexSessionInfo[]): CodexSessionInfo[] {
    const preferredPaths = new Set(
      preferActiveCodexRollouts(
        this.sessionsDir,
        sessions.map((session) => session.filePath),
      ),
    );
    const unique = new Map<string, CodexSessionInfo>();
    for (const session of sessions) {
      if (!preferredPaths.has(session.filePath)) continue;
      const previous = unique.get(session.id);
      if (!previous || session.mtime > previous.mtime)
        unique.set(session.id, session);
    }
    return [...unique.values()];
  }

  /**
   * Scan all session files and extract metadata from the first line.
   * Results are cached for SCAN_CACHE_TTL to avoid redundant filesystem work.
   */
  private async scanAllSessions(
    allowStaleSnapshot = false,
  ): Promise<CodexSessionInfo[]> {
    if (this.inFlightScan) {
      await this.inFlightScan;
      return this.scanAllSessions(allowStaleSnapshot);
    }
    if (
      this.cachedScan &&
      this.cachedScan.timestamp !== 0 &&
      this.changedFiles.size === 0 &&
      (allowStaleSnapshot ||
        Date.now() - this.cachedScan.timestamp < SCAN_CACHE_TTL)
    ) {
      return this.cachedScan.result;
    }

    const epoch = this.scanEpoch;
    const changed = [...this.changedFiles];
    this.changedFiles.clear();
    const accepted = this.cachedScan;
    const scan = (async () => {
      try {
        const incremental = accepted && changed.length > 0;
        const updates = await this.scanFiles(incremental ? changed : null);
        let result = updates;
        if (incremental) {
          const sessions = new Map(
            accepted.result.map((row) => [
              plainCodexRolloutPath(row.filePath),
              row,
            ]),
          );
          for (const filePath of changed) sessions.delete(filePath);
          for (const row of updates)
            sessions.set(plainCodexRolloutPath(row.filePath), row);
          result = [...sessions.values()];
        }
        if (epoch === this.scanEpoch)
          this.cachedScan = { result, timestamp: Date.now() };
        return result;
      } catch (error) {
        if (epoch === this.scanEpoch) {
          for (const filePath of changed) this.changedFiles.add(filePath);
        }
        if (accepted && isTransientFileReadError(error)) {
          accepted.timestamp = 0;
          getLogger().debug({ err: error }, "Codex discovery read deferred");
          return accepted.result;
        }
        throw error;
      }
    })();
    this.inFlightScan = scan;
    try {
      return await scan;
    } finally {
      if (this.inFlightScan === scan) this.inFlightScan = null;
    }
  }

  private async scanFiles(
    changed: string[] | null,
  ): Promise<CodexSessionInfo[]> {
    const metrics = createCodexScannerMetrics(this.sessionsDir);
    const scanStartedAt = Date.now();
    const sessions: CodexSessionInfo[] = [];

    try {
      await stat(this.sessionsDir);
      metrics.sessionsDirExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Sessions directory doesn't exist
      // An archive-only installation is still a valid source of history.
    }

    // Recursively find all Codex rollout files. Codex may compress cold
    // rollouts from rollout-*.jsonl to rollout-*.jsonl.zst.
    // Keep both roots in the raw snapshot so removing an active duplicate
    // can expose its archived copy during an incremental refresh.
    const files = changed
      ? []
      : preferPlainCodexRollouts(
          (
            await Promise.all(
              getCodexSessionRoots(this.sessionsDir).map((root) =>
                this.findJsonlFiles(root, metrics),
              ),
            )
          ).flat(),
        );
    if (changed) {
      for (const plainPath of changed) {
        for (const filePath of [plainPath, `${plainPath}.zst`]) {
          try {
            if (!(await stat(filePath)).isFile()) continue;
            files.push(filePath);
            metrics.rolloutFilesFound += 1;
            if (codexRolloutRepresentation(filePath) === "zstd")
              metrics.compressedRolloutFiles += 1;
            else metrics.plainRolloutFiles += 1;
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      metrics.rolloutFilesAfterPrecedence = files.length;
    }

    getLogger().debug(
      `[CodexScanner] Found ${files.length} .jsonl files in ${this.sessionsDir}`,
    );

    // Read first line of each file in parallel (with concurrency limit)
    const BATCH_SIZE = 50;
    let failCount = 0;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((f) => this.readSessionMeta(f, metrics)),
      );
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        if (result.value) {
          sessions.push(result.value);
        } else {
          failCount++;
        }
      }
    }
    await this.discoveryIndex?.flush();

    if (files.length > 0 && sessions.length === 0) {
      getLogger().warn(
        `[CodexScanner] Found ${files.length} .jsonl files but parsed 0 sessions (${failCount} failed). Session files may use an unsupported format. First file: ${files[0]}`,
      );
    } else if (failCount > 0) {
      getLogger().debug(
        `[CodexScanner] Parsed ${sessions.length} sessions, ${failCount} files skipped`,
      );
    }

    metrics.sessionsParsed = sessions.length;
    metrics.failedFiles = failCount;
    metrics.durationMs = Date.now() - scanStartedAt;
    this.lastScanMetrics = cloneCodexScannerMetrics(metrics);
    this.logScanMetrics(metrics);
    return sessions;
  }

  /**
   * Recursively find all Codex rollout files in a directory.
   */
  private async findJsonlFiles(
    dir: string,
    metrics: CodexScannerMetrics,
  ): Promise<string[]> {
    const files: string[] = [];
    await this.collectJsonlFiles(dir, files, metrics);
    const preferredFiles = preferPlainCodexRollouts(files);
    metrics.rolloutFilesAfterPrecedence += preferredFiles.length;
    metrics.precedenceSkippedCompressed += files.length - preferredFiles.length;
    return preferredFiles;
  }

  private async collectJsonlFiles(
    dir: string,
    files: string[],
    metrics: CodexScannerMetrics,
  ): Promise<void> {
    try {
      metrics.directoriesVisited += 1;
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.collectJsonlFiles(fullPath, files, metrics);
        } else if (entry.isFile() && isCodexRolloutFileName(entry.name)) {
          files.push(fullPath);
          metrics.rolloutFilesFound += 1;
          if (codexRolloutRepresentation(fullPath) === "zstd") {
            metrics.compressedRolloutFiles += 1;
          } else {
            metrics.plainRolloutFiles += 1;
          }
        }
      }
    } catch (error) {
      metrics.directoryReadErrors += 1;
      getLogger().debug(
        `[CodexScanner] Error scanning directory ${dir}: ${error instanceof Error ? error.message : error}`,
      );
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /**
   * Read just the first line of a session file to extract metadata.
   * Reads only the first 4KB to avoid loading large session files.
   */
  private async readSessionMeta(
    filePath: string,
    metrics: CodexScannerMetrics,
  ): Promise<CodexSessionInfo | null> {
    try {
      const session = await readCodexRolloutMetadata({
        sessionsDir: this.sessionsDir,
        filePath,
        ...(this.discoveryIndex ? { discoveryIndex: this.discoveryIndex } : {}),
        metrics: metrics.discovery,
      });
      if (!session) return null;
      return {
        id: session.id,
        cwd: session.cwd,
        filePath,
        timestamp: session.timestamp,
        mtime: session.mtime,
        isSubagent: session.isSubagent,
      };
    } catch (error) {
      getLogger().debug(
        `[CodexScanner] Error reading ${filePath}: ${error instanceof Error ? error.message : error}`,
      );
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private logScanMetrics(metrics: CodexScannerMetrics): void {
    const payload = {
      event: "codex_scanner_scan",
      ...metrics,
    };
    if (metrics.durationMs >= this.slowLogThresholdMs) {
      getLogger().warn(payload, "CODEX_SCANNER: slow scan");
      return;
    }
    getLogger().debug(payload, "CODEX_SCANNER: scan complete");
  }
}

// Singleton for convenience
export const codexSessionScanner = new CodexSessionScanner();

function createCodexScannerMetrics(sessionsDir: string): CodexScannerMetrics {
  return {
    sessionsDir,
    durationMs: 0,
    sessionsDirExists: false,
    directoriesVisited: 0,
    directoryReadErrors: 0,
    rolloutFilesFound: 0,
    rolloutFilesAfterPrecedence: 0,
    plainRolloutFiles: 0,
    compressedRolloutFiles: 0,
    precedenceSkippedCompressed: 0,
    sessionsParsed: 0,
    failedFiles: 0,
    discovery: createCodexRolloutDiscoveryStats(),
  };
}

function cloneCodexScannerMetrics(
  metrics: CodexScannerMetrics,
): CodexScannerMetrics {
  return {
    ...metrics,
    discovery: { ...metrics.discovery },
  };
}
