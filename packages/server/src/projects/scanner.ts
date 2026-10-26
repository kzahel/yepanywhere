import type { Dirent } from "node:fs";
import { isTransientFileReadError } from "../utils/fileReadError.js";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  DEFAULT_PROVIDER,
  isClaudeProviderName,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { ProjectMetadataService } from "../metadata/index.js";
import type { WorkstreamService } from "../services/WorkstreamService.js";
import type { Project } from "../supervisor/types.js";
import type { EventBus, FileChangeEvent } from "../watcher/index.js";
import { CODEX_SESSIONS_DIR, CodexSessionScanner } from "./codex-scanner.js";
import { GEMINI_TMP_DIR, GeminiSessionScanner } from "./gemini-scanner.js";
import {
  CLAUDE_PROJECTS_DIR,
  canonicalizeProjectPath,
  decodeProjectId,
  encodeProjectId,
  getProjectIdentityKey,
  getProjectName,
  isAbsolutePath,
  normalizeProjectPathForDedup,
  readCwdFromSessionFile,
} from "./paths.js";

export interface ScannerOptions {
  projectsDir?: string; // override for testing
  codexSessionsDir?: string; // override for testing
  geminiSessionsDir?: string; // override for testing
  projectScanCachePath?: string; // optional persistent cache path
  codexScanner?: CodexSessionScanner | null; // shared provider scanner
  geminiScanner?: GeminiSessionScanner | null; // shared provider scanner
  enableCodex?: boolean; // whether to include Codex projects (default: true)
  enableGemini?: boolean; // whether to include Gemini projects (default: true)
  projectMetadataService?: ProjectMetadataService; // for persisting added projects
  workstreamService?: WorkstreamService; // for grouping lane checkouts
  /** Optional EventBus for watcher-driven cache invalidation */
  eventBus?: EventBus;
  /** Project snapshot TTL in milliseconds (default: 5000) */
  cacheTtlMs?: number;
  /**
   * Claude transcript directories inside session sandboxes, by project id.
   * Read on every project read, since sandboxes are not in the scanned tree.
   */
  getSandboxSessionDirs?: () => ReadonlyMap<string, readonly string[]>;
}

export interface GetProjectOptions {
  /**
   * Reuse an already-resolved project identity even when aggregate project
   * metadata is stale. Path-only routes use this to avoid making an unrelated
   * provider-session inventory scan part of their foreground latency.
   */
  allowStaleSnapshot?: boolean;
}

const CLAUDE_PROJECT_SCAN_BATCH_SIZE = 16;
const CWD_SCAN_BATCH_SIZE = 8;
const PROJECT_SCAN_CACHE_VERSION = 4;

interface ProjectScanSourceState {
  projectsDir: string;
  projectsDirMtimeMs: number | null;
  projectsDirExists: boolean;
  projectsDirEntries: string[];
  codexSessionsDir: string;
  codexSessionsDirMtimeMs: number | null;
  codexSessionsDirExists: boolean;
  geminiSessionsDir: string;
  geminiSessionsDirMtimeMs: number | null;
  geminiSessionsDirExists: boolean;
  projectMetadataFilePath: string | null;
  projectMetadataFileMtimeMs: number | null;
  projectMetadataFileExists: boolean;
  workstreamFilePath: string | null;
  workstreamFileMtimeMs: number | null;
  workstreamFileExists: boolean;
  enableCodex: boolean;
  enableGemini: boolean;
}

interface CachedProjectSnapshotData {
  cacheVersion: number;
  generatedAt: number;
  sourceState: ProjectScanSourceState;
  projects: Project[];
}

interface ProjectSnapshot {
  projects: Project[];
  byId: Map<string, Project>;
  byIdentityKey: Map<string, Project>;
  bySessionDirSuffix: Map<string, Project>;
  timestamp: number;
}

interface ClaudeProjectDirectory {
  projectPath: string;
  sessionCount: number;
  lastActivity: string | null;
}

function cloneSessionCountsByProvider(
  counts: Project["sessionCountsByProvider"],
): Project["sessionCountsByProvider"] {
  return counts ? { ...counts } : undefined;
}

function addProviderSessionCount(
  project: Project,
  provider: ProviderName,
  count: number,
): void {
  project.sessionCount += count;
  project.sessionCountsByProvider = {
    ...project.sessionCountsByProvider,
    [provider]: (project.sessionCountsByProvider?.[provider] ?? 0) + count,
  };
}

function latestActivity(
  current: string | null,
  next: string | null,
): string | null {
  if (!next) return current;
  if (!current) return next;
  return next > current ? next : current;
}

function withProviderSessionCounts(project: Project): Project {
  return {
    ...project,
    sessionCountsByProvider: {
      ...project.sessionCountsByProvider,
      [project.provider]:
        project.sessionCountsByProvider?.[project.provider] ??
        project.sessionCount,
    },
  };
}

export class ProjectScanner {
  private projectsDir: string;
  private codexSessionsDir: string;
  private geminiSessionsDir: string;
  private codexScanner: CodexSessionScanner | null;
  private geminiScanner: GeminiSessionScanner | null;
  private enableCodex: boolean;
  private enableGemini: boolean;
  private projectMetadataService: ProjectMetadataService | null;
  private projectMetadataFilePath: string | null;
  private workstreamService: WorkstreamService | null;
  private workstreamFilePath: string | null;
  private projectScanCachePath: string | null;
  private cacheTtlMs: number;
  private getSandboxSessionDirs:
    | (() => ReadonlyMap<string, readonly string[]>)
    | null;
  private cacheRevision = 0;
  private cleanRevision = 0;
  private snapshot: ProjectSnapshot | null = null;
  private claudeDirectories: Map<string, ClaudeProjectDirectory> | null = null;
  private changedClaudeDirectories = new Set<string>();
  private claudeDiscoveryEpoch = 0;
  private claudeDiscovery: Promise<Map<string, ClaudeProjectDirectory>> | null =
    null;
  private inFlightScan: {
    promise: Promise<ProjectSnapshot>;
    revision: number;
  } | null = null;
  private pendingSnapshotSave: {
    snapshot: ProjectSnapshot;
    revision: number;
  } | null = null;
  private snapshotSavePromise: Promise<void> | null = null;
  private retainedInitialization: Promise<void> | null = null;
  private retainedRefresh: Promise<void> | null = null;
  private retainedTimer: ReturnType<typeof setTimeout> | null = null;
  private retainedNeedsRefresh = true;
  private retainedRetryAfter = 0;
  private retainedRefreshError: string | undefined;
  private eventBus: EventBus | undefined;
  private unsubscribeEventBus: (() => void) | null = null;
  private disposed = false;

  constructor(options: ScannerOptions = {}) {
    this.projectsDir = options.projectsDir ?? CLAUDE_PROJECTS_DIR;
    this.codexSessionsDir = options.codexSessionsDir ?? CODEX_SESSIONS_DIR;
    this.geminiSessionsDir = options.geminiSessionsDir ?? GEMINI_TMP_DIR;
    this.enableCodex = options.enableCodex ?? true;
    this.enableGemini = options.enableGemini ?? true;
    this.codexScanner = this.enableCodex
      ? (options.codexScanner ??
        new CodexSessionScanner({
          sessionsDir: this.codexSessionsDir,
        }))
      : null;
    this.geminiScanner = this.enableGemini
      ? (options.geminiScanner ??
        new GeminiSessionScanner({
          sessionsDir: this.geminiSessionsDir,
        }))
      : null;
    this.projectMetadataService = options.projectMetadataService ?? null;
    this.projectMetadataFilePath =
      this.projectMetadataService?.getFilePath?.() ?? null;
    this.workstreamService = options.workstreamService ?? null;
    this.workstreamFilePath = this.workstreamService?.getFilePath?.() ?? null;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 5000);
    this.projectScanCachePath = options.projectScanCachePath ?? null;
    this.getSandboxSessionDirs = options.getSandboxSessionDirs ?? null;
    this.eventBus = options.eventBus;

    if (options.eventBus) {
      this.unsubscribeEventBus = options.eventBus.subscribe((event) => {
        if (event.type === "file-change") {
          this.handleFileChange(event);
        } else if (event.type === "workstreams-changed") {
          this.invalidateCache();
        }
      });
    }
  }

  /**
   * Set the project metadata service (for late initialization).
   */
  setProjectMetadataService(service: ProjectMetadataService): void {
    this.projectMetadataService = service;
    this.projectMetadataFilePath = service.getFilePath?.() ?? null;
    this.invalidateCache();
  }

  /**
   * The projects the last scan found, without scanning: empty before the
   * first scan. For synchronous callers that can tolerate a stale list.
   */
  cachedProjects(): readonly Pick<Project, "id" | "path">[] {
    return this.snapshot?.projects ?? [];
  }

  async listProjects(): Promise<Project[]> {
    const snapshot = await this.getSnapshot();
    const sandboxDirs = this.sandboxSessionDirs();
    return Promise.all(
      snapshot.projects.map((project) =>
        this.readProject(project, sandboxDirs),
      ),
    );
  }

  /** Retained project reads never wait for provider discovery or sandbox counts. */
  async readRetainedProjects(): Promise<{
    projects: Project[];
    complete: boolean;
    refreshing: boolean;
    refreshError?: string;
  }> {
    await this.initializeRetainedProjects();
    if (this.disposed) throw new Error("Project scanner is disposed");
    this.scheduleRetainedRefresh();
    const sandboxDirs = this.sandboxSessionDirs();
    const projects = new Map(
      (this.snapshot?.projects ?? []).map((project) => [
        getProjectIdentityKey(project.path),
        this.cloneProject(project, sandboxDirs),
      ]),
    );
    for (const project of projects.values()) delete project.ownerUsername;
    for (const metadata of Object.values(
      this.projectMetadataService?.getAllProjects() ?? {},
    )) {
      const path = canonicalizeProjectPath(metadata.path);
      const identity = getProjectIdentityKey(path);
      // Once discovery has run, registration cannot resurrect an absent directory.
      if (this.snapshot && !projects.has(identity)) continue;
      const project =
        projects.get(identity) ??
        this.registeredProject(path, metadata.addedAt);
      project.ownerUsername = metadata.ownerUsername;
      project.name = this.displayName(project);
      projects.set(identity, project);
    }
    return {
      projects: [...projects.values()].filter(
        (project) => !this.isHiddenProjectPath(project.path),
      ),
      complete: this.snapshot !== null,
      refreshing: Boolean(this.retainedRefresh || this.retainedTimer),
      ...(this.retainedRefreshError
        ? { refreshError: this.retainedRefreshError }
        : {}),
    };
  }

  private registeredProject(path: string, addedAt: string): Project {
    return {
      id: encodeProjectId(path),
      path,
      name: getProjectName(path),
      sessionCount: 0,
      sessionCountsByProvider: { claude: 0 },
      sessionDir: join(this.projectsDir, path.replace(/[/\\:]/g, "-")),
      hasCodexSessions: false,
      hasGeminiSessions: false,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: addedAt,
      provider: "claude",
    };
  }

  /** Resolve retained directory identity without scanning any provider store. */
  getRetainedProjectBySessionDirSuffix(dirSuffix: string): Project | null {
    const project = this.snapshot?.bySessionDirSuffix.get(
      this.normalizeDirSuffix(dirSuffix),
    );
    return project && !this.isHiddenProjectPath(project.path)
      ? this.cloneProject(project)
      : null;
  }

  private initializeRetainedProjects(): Promise<void> {
    this.retainedInitialization ??= Promise.resolve().then(async () => {
      if (this.disposed) throw new Error("Project scanner is disposed");
      if (this.snapshot) return;
      const snapshot = await this.loadSnapshotFromDisk(Date.now(), true);
      // A complete read may have published while the saved snapshot was read.
      if (!this.disposed && !this.snapshot && snapshot) {
        this.snapshot = snapshot;
        // Retention is display evidence, never a fresh complete-read cache hit.
        this.cleanRevision = -1;
      }
    });
    return this.retainedInitialization;
  }

  private scheduleRetainedRefresh(): void {
    if (
      !this.retainedInitialization ||
      this.disposed ||
      this.retainedRefresh ||
      this.retainedTimer ||
      Date.now() < this.retainedRetryAfter ||
      (!this.retainedNeedsRefresh && this.cleanRevision === this.cacheRevision)
    )
      return;
    this.retainedTimer = setTimeout(
      () => {
        this.retainedTimer = null;
        void this.refreshRetainedProjects();
      },
      this.snapshot ? 300 : 0,
    );
    this.retainedTimer.unref?.();
  }

  /** One finite refresh owns retained project discovery and its notification. */
  refreshRetainedProjects(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.retainedRefresh) return this.retainedRefresh;
    if (this.retainedTimer) clearTimeout(this.retainedTimer);
    this.retainedTimer = null;
    this.retainedNeedsRefresh = false;
    this.retainedRefreshError = undefined;
    const previousIds =
      this.snapshot?.projects.map((project) => project.id) ?? [];
    this.retainedRefresh = this.initializeRetainedProjects()
      .then(() => this.getSnapshot(true))
      .then(() => undefined)
      .catch((error: unknown) => {
        if (this.disposed) return;
        this.retainedNeedsRefresh = true;
        this.retainedRetryAfter = Date.now() + 5_000;
        this.retainedRefreshError =
          error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.retainedRefresh = null;
        if (this.disposed) return;
        this.eventBus?.emit({
          type: "projects-changed",
          collectionRefresh: true,
          projectIds: [
            ...new Set([
              ...previousIds,
              ...(this.snapshot?.projects.map((project) => project.id) ?? []),
            ]),
          ],
          timestamp: new Date().toISOString(),
        });
        this.scheduleRetainedRefresh();
      });
    return this.retainedRefresh;
  }

  /**
   * Mark the project snapshot stale so next read triggers a rescan.
   */
  invalidateCache(): void {
    this.resetClaudeDiscovery();
    this.codexScanner?.invalidateCache();
    this.geminiScanner?.invalidateCache();
    this.invalidateProjectSnapshot();
  }

  private resetClaudeDiscovery(): void {
    this.claudeDiscoveryEpoch += 1;
    this.claudeDirectories = null;
    this.changedClaudeDirectories.clear();
  }

  private invalidateProjectSnapshot(): void {
    this.cacheRevision += 1;
    this.scheduleRetainedRefresh();
  }

  private async getSnapshot(forceRefresh = false): Promise<ProjectSnapshot> {
    if (this.disposed) throw new Error("Project scanner is disposed");
    const now = Date.now();
    const scanRevision = this.cacheRevision;
    const isFresh =
      this.snapshot &&
      this.cleanRevision === scanRevision &&
      now - this.snapshot.timestamp < this.cacheTtlMs;

    if (!forceRefresh && isFresh && this.snapshot) {
      return this.snapshot;
    }

    if (this.inFlightScan?.revision === scanRevision) {
      return this.inFlightScan.promise;
    }

    const scanPromise = this.scanFromCacheOrFilesystem(
      now,
      forceRefresh,
      scanRevision,
    )
      .then(({ snapshot, shouldPersist }) => {
        if (!this.disposed && this.cacheRevision === scanRevision) {
          this.snapshot = snapshot;
          this.cleanRevision = scanRevision;
          if (shouldPersist) {
            this.scheduleSnapshotSave(snapshot, scanRevision);
          }
        }
        return snapshot;
      })
      .catch((error: unknown) => {
        if (isTransientFileReadError(error) && this.snapshot && !forceRefresh) {
          // A TTL refresh may have discarded the directory map before failing.
          // Retry the filesystem rather than accepting an older disk snapshot.
          this.cacheRevision += 1;
          this.cleanRevision = -1;
          return this.snapshot;
        }
        throw error;
      })
      .finally(() => {
        if (this.inFlightScan?.promise === scanPromise) {
          this.inFlightScan = null;
        }
      });

    this.inFlightScan = { promise: scanPromise, revision: scanRevision };
    return scanPromise;
  }

  private async scanFromCacheOrFilesystem(
    now: number,
    forceRefresh: boolean,
    scanRevision: number,
  ): Promise<{ snapshot: ProjectSnapshot; shouldPersist: boolean }> {
    if (!forceRefresh && this.cleanRevision === scanRevision) {
      const cached = await this.loadSnapshotFromDisk(now);
      if (cached) {
        return { snapshot: cached, shouldPersist: false };
      }
    }

    const reuseUnchangedProviders = this.cleanRevision !== scanRevision;
    if (!reuseUnchangedProviders) this.resetClaudeDiscovery();
    const projects = await this.scanProjects(reuseUnchangedProviders);
    const snapshot = this.buildSnapshot(projects);
    return { snapshot, shouldPersist: true };
  }

  private buildSnapshot(
    projects: Project[],
    timestamp = Date.now(),
  ): ProjectSnapshot {
    const byId = new Map<string, Project>();
    const byIdentityKey = new Map<string, Project>();
    const bySessionDirSuffix = new Map<string, Project>();

    for (const project of projects) {
      byId.set(project.id, project);
      byIdentityKey.set(getProjectIdentityKey(project.path), project);

      const primarySuffix = this.normalizeDirSuffix(
        this.sessionDirToSuffix(project.sessionDir),
      );
      if (primarySuffix) {
        bySessionDirSuffix.set(primarySuffix, project);
      }

      for (const mergedDir of project.mergedSessionDirs ?? []) {
        const mergedSuffix = this.normalizeDirSuffix(
          this.sessionDirToSuffix(mergedDir),
        );
        if (mergedSuffix) {
          bySessionDirSuffix.set(mergedSuffix, project);
        }
      }
    }

    return {
      projects,
      byId,
      byIdentityKey,
      bySessionDirSuffix,
      timestamp,
    };
  }

  private async loadSnapshotFromDisk(
    now: number,
    allowStale = false,
  ): Promise<ProjectSnapshot | null> {
    if (!this.projectScanCachePath) return null;

    try {
      const content = await readFile(this.projectScanCachePath, "utf-8");
      const parsed = JSON.parse(content) as unknown;
      if (!this.isValidCachedSnapshot(parsed)) {
        return null;
      }

      if (!allowStale && now - parsed.generatedAt > this.cacheTtlMs) {
        return null;
      }

      if (allowStale) {
        const source = parsed.sourceState;
        if (
          source.projectsDir !== this.projectsDir ||
          source.codexSessionsDir !== this.codexSessionsDir ||
          source.geminiSessionsDir !== this.geminiSessionsDir ||
          source.projectMetadataFilePath !== this.projectMetadataFilePath ||
          source.workstreamFilePath !== this.workstreamFilePath ||
          source.enableCodex !== this.enableCodex ||
          source.enableGemini !== this.enableGemini
        )
          return null;
      } else {
        const currentSourceState = await this.getSourceState();
        if (
          !this.areSourceStatesCompatible(
            currentSourceState,
            parsed.sourceState,
          )
        ) {
          return null;
        }
      }

      if (parsed.projects.length === 0) {
        return null;
      }

      const projects: Project[] = [];
      for (const project of parsed.projects) {
        if (!this.isValidCachedProject(project)) {
          return null;
        }
        projects.push({
          ...project,
          mergedSessionDirs: project.mergedSessionDirs
            ? [...project.mergedSessionDirs]
            : undefined,
          sessionCountsByProvider: cloneSessionCountsByProvider(
            project.sessionCountsByProvider,
          ),
        });
      }

      return this.buildSnapshot(projects, parsed.generatedAt);
    } catch {
      return null;
    }
  }

  private scheduleSnapshotSave(
    snapshot: ProjectSnapshot,
    revision: number,
  ): void {
    if (this.disposed || !this.projectScanCachePath) return;
    this.pendingSnapshotSave = { snapshot, revision };
    this.startSnapshotSave();
  }

  private startSnapshotSave(): void {
    if (this.snapshotSavePromise || !this.pendingSnapshotSave) return;

    const savePromise = this.drainSnapshotSaves();
    this.snapshotSavePromise = savePromise;
    void savePromise
      .catch((error) => {
        console.warn(
          "[ProjectScanner] failed to persist project scan cache:",
          error,
        );
      })
      .finally(() => {
        if (this.snapshotSavePromise === savePromise) {
          this.snapshotSavePromise = null;
        }
        this.startSnapshotSave();
      });
  }

  private async drainSnapshotSaves(): Promise<void> {
    while (this.pendingSnapshotSave) {
      const pending = this.pendingSnapshotSave;
      this.pendingSnapshotSave = null;
      await this.saveSnapshotToDisk(pending.snapshot, pending.revision);
    }
  }

  private async saveSnapshotToDisk(
    snapshot: ProjectSnapshot,
    revision: number,
  ): Promise<void> {
    if (!this.projectScanCachePath) return;
    if (this.cacheRevision !== revision || this.cleanRevision !== revision) {
      return;
    }

    const sourceState = await this.getSourceState();
    const data: CachedProjectSnapshotData = {
      cacheVersion: PROJECT_SCAN_CACHE_VERSION,
      generatedAt: snapshot.timestamp,
      sourceState,
      projects: snapshot.projects,
    };

    await mkdir(dirname(this.projectScanCachePath), { recursive: true });
    const tempPath = `${this.projectScanCachePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    try {
      await writeFile(tempPath, JSON.stringify(data), "utf-8");
      if (this.cacheRevision !== revision || this.cleanRevision !== revision) {
        await unlink(tempPath).catch(() => {
          // Best-effort cleanup for an invalidated snapshot.
        });
        return;
      }
      await rename(tempPath, this.projectScanCachePath);
    } catch (error) {
      await unlink(tempPath).catch(() => {
        // Best-effort cleanup for failed atomic writes.
      });
      throw error;
    }
  }

  private async getSourceState(): Promise<ProjectScanSourceState> {
    const [
      projectsDirEntries,
      projectsDirState,
      codexSessionsState,
      geminiSessionsState,
      metadataState,
      workstreamState,
    ] = await Promise.all([
      this.getDirectoryEntries(this.projectsDir),
      this.getPathState(this.projectsDir),
      this.getPathState(this.codexSessionsDir),
      this.getPathState(this.geminiSessionsDir),
      this.projectMetadataFilePath
        ? this.getPathState(this.projectMetadataFilePath)
        : Promise.resolve({ exists: false, mtimeMs: null }),
      this.workstreamFilePath
        ? this.getPathState(this.workstreamFilePath)
        : Promise.resolve({ exists: false, mtimeMs: null }),
    ]);

    return {
      projectsDir: this.projectsDir,
      projectsDirMtimeMs: projectsDirState.mtimeMs,
      projectsDirExists: projectsDirState.exists,
      projectsDirEntries,
      codexSessionsDir: this.codexSessionsDir,
      codexSessionsDirMtimeMs: codexSessionsState.mtimeMs,
      codexSessionsDirExists: codexSessionsState.exists,
      geminiSessionsDir: this.geminiSessionsDir,
      geminiSessionsDirMtimeMs: geminiSessionsState.mtimeMs,
      geminiSessionsDirExists: geminiSessionsState.exists,
      projectMetadataFilePath: this.projectMetadataFilePath,
      projectMetadataFileMtimeMs: metadataState.mtimeMs,
      projectMetadataFileExists: metadataState.exists,
      workstreamFilePath: this.workstreamFilePath,
      workstreamFileMtimeMs: workstreamState.mtimeMs,
      workstreamFileExists: workstreamState.exists,
      enableCodex: this.enableCodex,
      enableGemini: this.enableGemini,
    };
  }

  private async getDirectoryEntries(targetPath: string): Promise<string[]> {
    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async getPathState(
    targetPath: string,
  ): Promise<{ exists: boolean; mtimeMs: number | null }> {
    try {
      const stats = await stat(targetPath);
      return { exists: true, mtimeMs: stats.mtimeMs };
    } catch {
      return { exists: false, mtimeMs: null };
    }
  }

  private areSourceStatesCompatible(
    current: ProjectScanSourceState,
    cached: ProjectScanSourceState,
  ): boolean {
    return (
      current.projectsDir === cached.projectsDir &&
      current.projectsDirExists === cached.projectsDirExists &&
      current.projectsDirMtimeMs === cached.projectsDirMtimeMs &&
      current.projectsDirEntries.length === cached.projectsDirEntries.length &&
      current.projectsDirEntries.every(
        (entry, index) => entry === cached.projectsDirEntries[index],
      ) &&
      current.codexSessionsDir === cached.codexSessionsDir &&
      current.codexSessionsDirExists === cached.codexSessionsDirExists &&
      current.codexSessionsDirMtimeMs === cached.codexSessionsDirMtimeMs &&
      current.geminiSessionsDir === cached.geminiSessionsDir &&
      current.geminiSessionsDirExists === cached.geminiSessionsDirExists &&
      current.geminiSessionsDirMtimeMs === cached.geminiSessionsDirMtimeMs &&
      current.projectMetadataFilePath === cached.projectMetadataFilePath &&
      current.projectMetadataFileExists === cached.projectMetadataFileExists &&
      current.projectMetadataFileMtimeMs ===
        cached.projectMetadataFileMtimeMs &&
      current.workstreamFilePath === cached.workstreamFilePath &&
      current.workstreamFileExists === cached.workstreamFileExists &&
      current.workstreamFileMtimeMs === cached.workstreamFileMtimeMs &&
      current.enableCodex === cached.enableCodex &&
      current.enableGemini === cached.enableGemini
    );
  }

  private isValidCachedSnapshot(
    value: unknown,
  ): value is CachedProjectSnapshotData {
    if (typeof value !== "object" || value === null) return false;

    const snapshot = value as Partial<CachedProjectSnapshotData>;
    if (snapshot.cacheVersion !== PROJECT_SCAN_CACHE_VERSION) return false;
    if (typeof snapshot.generatedAt !== "number") return false;
    if (!Array.isArray(snapshot.projects)) return false;
    if (!this.isValidSourceState(snapshot.sourceState)) return false;

    return true;
  }

  private isValidSourceState(value: unknown): value is ProjectScanSourceState {
    if (typeof value !== "object" || value === null) return false;
    const state = value as Partial<ProjectScanSourceState>;

    return (
      typeof state.projectsDir === "string" &&
      (state.projectsDirMtimeMs === null ||
        typeof state.projectsDirMtimeMs === "number") &&
      typeof state.projectsDirExists === "boolean" &&
      Array.isArray(state.projectsDirEntries) &&
      state.projectsDirEntries.every((entry) => typeof entry === "string") &&
      typeof state.codexSessionsDir === "string" &&
      (state.codexSessionsDirMtimeMs === null ||
        typeof state.codexSessionsDirMtimeMs === "number") &&
      typeof state.codexSessionsDirExists === "boolean" &&
      typeof state.geminiSessionsDir === "string" &&
      (state.geminiSessionsDirMtimeMs === null ||
        typeof state.geminiSessionsDirMtimeMs === "number") &&
      typeof state.geminiSessionsDirExists === "boolean" &&
      (state.projectMetadataFilePath === null ||
        typeof state.projectMetadataFilePath === "string") &&
      (state.projectMetadataFileMtimeMs === null ||
        typeof state.projectMetadataFileMtimeMs === "number") &&
      typeof state.projectMetadataFileExists === "boolean" &&
      (state.workstreamFilePath === null ||
        typeof state.workstreamFilePath === "string") &&
      (state.workstreamFileMtimeMs === null ||
        typeof state.workstreamFileMtimeMs === "number") &&
      typeof state.workstreamFileExists === "boolean" &&
      typeof state.enableCodex === "boolean" &&
      typeof state.enableGemini === "boolean"
    );
  }

  private isValidCachedProject(value: unknown): value is Project {
    if (typeof value !== "object" || value === null) return false;
    const project = value as Partial<Project>;

    return (
      typeof project.id === "string" &&
      typeof project.path === "string" &&
      typeof project.name === "string" &&
      typeof project.sessionDir === "string" &&
      typeof project.sessionCount === "number" &&
      (project.sessionCountsByProvider === undefined ||
        (typeof project.sessionCountsByProvider === "object" &&
          project.sessionCountsByProvider !== null &&
          Object.values(project.sessionCountsByProvider).every(
            (count) => typeof count === "number",
          ))) &&
      typeof project.activeOwnedCount === "number" &&
      typeof project.activeExternalCount === "number" &&
      (project.lastActivity === null ||
        typeof project.lastActivity === "string") &&
      typeof project.provider === "string" &&
      (project.mergedSessionDirs === undefined ||
        (Array.isArray(project.mergedSessionDirs) &&
          project.mergedSessionDirs.every(
            (item) => typeof item === "string",
          ))) &&
      (project.hasCodexSessions === undefined ||
        typeof project.hasCodexSessions === "boolean") &&
      (project.hasGeminiSessions === undefined ||
        typeof project.hasGeminiSessions === "boolean")
    );
  }

  private sessionDirToSuffix(sessionDir: string): string {
    // Claude session dirs live under projectsDir; codex/gemini do not.
    const relative = sessionDir.startsWith(this.projectsDir)
      ? sessionDir.slice(this.projectsDir.length)
      : sessionDir;
    return relative.replace(/^[\\/]+/, "");
  }

  private normalizeDirSuffix(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  /**
   * A user-chosen name replaces the path-derived one on every project read,
   * so the snapshot keeps the path name and the override applies at once.
   */
  private displayName(project: Pick<Project, "id" | "name">): string {
    return (
      this.projectMetadataService?.getProjectNameOverride(project.id) ??
      project.name
    );
  }

  /**
   * Sandboxed sessions keep their Claude transcripts in a YA-private provider
   * root, never in the scanned host tree, and a new one can appear at any
   * time. So they are joined to every project read rather than to the cached
   * scan, as further transcript directories of that project.
   * topics/session-sandboxing.md § Runtime state and scratch space.
   */
  private sandboxSessionDirs(): ReadonlyMap<string, readonly string[]> {
    return this.getSandboxSessionDirs?.() ?? new Map();
  }

  private mergedSessionDirsFor(
    project: Project,
    sandboxDirs: ReadonlyMap<string, readonly string[]>,
  ): string[] | undefined {
    const sandbox = isClaudeProviderName(project.provider)
      ? (sandboxDirs.get(project.id) ?? [])
      : [];
    if (!project.mergedSessionDirs && sandbox.length === 0) return undefined;
    return [
      ...new Set([
        ...(project.mergedSessionDirs ?? []),
        ...sandbox.filter((dir) => dir !== project.sessionDir),
      ]),
    ];
  }

  private cloneProject(
    project: Project,
    sandboxDirs = this.sandboxSessionDirs(),
  ): Project {
    return {
      ...project,
      name: this.displayName(project),
      mergedSessionDirs: this.mergedSessionDirsFor(project, sandboxDirs),
      sessionCountsByProvider: cloneSessionCountsByProvider(
        project.sessionCountsByProvider,
      ),
      hasCodexSessions: project.hasCodexSessions,
      hasGeminiSessions: project.hasGeminiSessions,
    };
  }

  /**
   * A project as read: its sandbox directories joined, and their sessions
   * counted with its own, so a project whose only sessions ran sandboxed does
   * not read as empty. Only a project with sandbox directories touches disk.
   */
  private async readProject(
    project: Project,
    sandboxDirs = this.sandboxSessionDirs(),
  ): Promise<Project> {
    const read = this.cloneProject(project, sandboxDirs);
    const scanned = new Set([
      project.sessionDir,
      ...(project.mergedSessionDirs ?? []),
    ]);
    for (const dir of read.mergedSessionDirs ?? []) {
      if (scanned.has(dir)) continue;
      const info = await this.getSandboxDirInfo(dir);
      if (!info) continue;
      addProviderSessionCount(read, "claude", info.sessionCount);
      read.lastActivity = latestActivity(read.lastActivity, info.lastActivity);
    }
    return read;
  }

  private async getSandboxDirInfo(
    dir: string,
  ): Promise<{ sessionCount: number; lastActivity: string } | null> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const dirStat = await stat(dir);
      return {
        sessionCount: entries.filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".jsonl") &&
            !entry.name.startsWith("agent-"),
        ).length,
        lastActivity: new Date(dirStat.mtimeMs).toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private handleFileChange(event: FileChangeEvent): void {
    if (event.fileType !== "session" && event.fileType !== "agent-session") {
      return;
    }

    if (event.provider === "claude") {
      const parts = relative(this.projectsDir, event.path).split(sep);
      const first = parts[0] ?? "";
      const depth = first.startsWith("-") || /^[a-zA-Z]--/.test(first) ? 1 : 2;
      if (first === ".." || parts.length <= depth) {
        this.resetClaudeDiscovery();
      } else {
        this.changedClaudeDirectories.add(
          join(this.projectsDir, ...parts.slice(0, depth)),
        );
      }
    }
    this.invalidateProjectSnapshot();
    if (event.provider === "codex") {
      this.codexScanner?.invalidateCache(event.path);
    } else if (event.provider === "gemini") {
      this.geminiScanner?.invalidateCache(event.path);
    }
  }

  private resolveProjectPathForKnownWorkstream(rawProjectPath: string): string {
    const resolved = this.workstreamService?.resolvePath(rawProjectPath);
    if (!resolved) return rawProjectPath;
    try {
      return decodeProjectId(resolved.projectId);
    } catch {
      return rawProjectPath;
    }
  }

  private async scanProjects(
    reuseUnchangedProviders = false,
  ): Promise<Project[]> {
    const projects: Project[] = [];
    const seenPaths = new Set<string>();
    const seenIdentityKeys = new Set<string>();
    // Map from normalized path to project index for cross-machine dedup
    const normalizedIndex = new Map<string, number>();

    const findProjectByIdentity = (projectPath: string): Project | undefined =>
      projects.find(
        (project) =>
          getProjectIdentityKey(project.path) ===
          getProjectIdentityKey(projectPath),
      );

    // Helper to add a Claude project, merging cross-machine duplicates
    const addOrMerge = (
      rawProjectPath: string,
      sessionDir: string,
      sessionCount: number,
      lastActivity: string | null,
    ) => {
      const projectPath = canonicalizeProjectPath(
        this.resolveProjectPathForKnownWorkstream(rawProjectPath),
      );
      if (this.isHiddenProjectPath(projectPath)) return;
      seenPaths.add(projectPath);
      seenIdentityKeys.add(getProjectIdentityKey(projectPath));

      const normalized = normalizeProjectPathForDedup(projectPath);
      const existingIdx = normalizedIndex.get(normalized);

      if (existingIdx !== undefined) {
        // Cross-machine duplicate — merge into existing project
        const existing = projects[existingIdx];
        if (!existing) return;
        const existingSessionCount = existing.sessionCount;
        addProviderSessionCount(existing, "claude", sessionCount);
        if (!existing.mergedSessionDirs) {
          existing.mergedSessionDirs = [];
        }
        if (!existing.mergedSessionDirs.includes(sessionDir)) {
          existing.mergedSessionDirs.push(sessionDir);
        }
        existing.lastActivity = latestActivity(
          existing.lastActivity,
          lastActivity,
        );

        // Prefer the local path for session creation.
        // Remote executor sessions (rsynced) may store a foreign cwd
        // (e.g., /Users/... on a Linux host). Swap to the local path
        // so new sessions can actually spawn in an existing directory.
        const localHome = homedir();
        const localHomePrefix = `${localHome}/`;
        const localHomePrefixWin = `${localHome}\\`;
        const existingIsLocal =
          existing.path.startsWith(localHomePrefix) ||
          existing.path.startsWith(localHomePrefixWin);
        const newIsLocal =
          projectPath.startsWith(localHomePrefix) ||
          projectPath.startsWith(localHomePrefixWin);
        const candidateHasMoreSessions =
          getProjectIdentityKey(existing.path) ===
            getProjectIdentityKey(projectPath) &&
          sessionCount > existingSessionCount;
        const candidateIsEquallyCommonAndLexicalFirst =
          getProjectIdentityKey(existing.path) ===
            getProjectIdentityKey(projectPath) &&
          sessionCount === existingSessionCount &&
          projectPath < existing.path;
        if (
          (!existingIsLocal && newIsLocal) ||
          (existingIsLocal === newIsLocal &&
            (candidateHasMoreSessions ||
              candidateIsEquallyCommonAndLexicalFirst))
        ) {
          existing.path = projectPath;
          existing.id = encodeProjectId(projectPath);
          existing.name = getProjectName(projectPath);
        }
      } else {
        normalizedIndex.set(normalized, projects.length);
        projects.push({
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: getProjectName(projectPath),
          sessionCount,
          sessionCountsByProvider: { claude: sessionCount },
          sessionDir,
          hasCodexSessions: false,
          hasGeminiSessions: false,
          activeOwnedCount: 0, // populated by route
          activeExternalCount: 0, // populated by route
          lastActivity,
          provider: "claude",
        });
      }
    };

    // Acquire independent inputs together, but drain both before releasing a
    // failed refresh and preserve Claude-first merge precedence below.
    const [claudeResult, codexResult] = await Promise.allSettled([
      this.readClaudeDirectories(),
      this.codexScanner?.listProjects({
        allowStaleSnapshot: reuseUnchangedProviders,
      }) ?? Promise.resolve([]),
    ]);
    if (claudeResult.status === "rejected") throw claudeResult.reason;
    if (codexResult.status === "rejected") throw codexResult.reason;

    for (const [dir, info] of claudeResult.value) {
      addOrMerge(info.projectPath, dir, info.sessionCount, info.lastActivity);
    }

    // Merge Codex projects if enabled
    if (this.codexScanner) {
      for (const codexProject of codexResult.value) {
        const projectPath = canonicalizeProjectPath(
          this.resolveProjectPathForKnownWorkstream(codexProject.path),
        );
        if (this.isHiddenProjectPath(projectPath)) continue;
        const existing = findProjectByIdentity(projectPath);
        if (existing) {
          addProviderSessionCount(
            existing,
            codexProject.provider,
            codexProject.sessionCount,
          );
          existing.hasCodexSessions = true;
          existing.lastActivity = latestActivity(
            existing.lastActivity,
            codexProject.lastActivity,
          );
          seenPaths.add(projectPath);
          seenIdentityKeys.add(getProjectIdentityKey(projectPath));
          continue;
        }
        seenPaths.add(projectPath);
        seenIdentityKeys.add(getProjectIdentityKey(projectPath));
        projects.push({
          ...withProviderSessionCounts(codexProject),
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: getProjectName(projectPath),
          hasCodexSessions: true,
          hasGeminiSessions: false,
        });
      }
    }

    // Merge Gemini projects if enabled
    if (this.geminiScanner) {
      // Register known paths for hash resolution before scanning
      await this.geminiScanner.registerKnownPaths(Array.from(seenPaths));

      const geminiProjects = await this.geminiScanner.listProjects({
        allowStaleSnapshot: reuseUnchangedProviders,
      });
      for (const geminiProject of geminiProjects) {
        const projectPath = canonicalizeProjectPath(
          this.resolveProjectPathForKnownWorkstream(geminiProject.path),
        );
        if (this.isHiddenProjectPath(projectPath)) continue;
        const existing = findProjectByIdentity(projectPath);
        if (existing) {
          addProviderSessionCount(
            existing,
            geminiProject.provider,
            geminiProject.sessionCount,
          );
          existing.hasGeminiSessions = true;
          existing.lastActivity = latestActivity(
            existing.lastActivity,
            geminiProject.lastActivity,
          );
          seenPaths.add(projectPath);
          seenIdentityKeys.add(getProjectIdentityKey(projectPath));
          continue;
        }
        seenPaths.add(projectPath);
        seenIdentityKeys.add(getProjectIdentityKey(projectPath));
        projects.push({
          ...withProviderSessionCounts(geminiProject),
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: getProjectName(projectPath),
          hasCodexSessions: false,
          hasGeminiSessions: true,
        });
      }
    }

    // Merge manually added projects (from ProjectMetadataService)
    if (this.projectMetadataService) {
      const addedProjects = this.projectMetadataService.getAllProjects();
      for (const metadata of Object.values(addedProjects)) {
        const projectPath = canonicalizeProjectPath(metadata.path);
        if (this.isHiddenProjectPath(projectPath)) continue;
        // Skip if we've already seen this path from another source
        if (seenIdentityKeys.has(getProjectIdentityKey(projectPath))) continue;

        // Verify the directory still exists
        try {
          const stats = await stat(projectPath);
          if (!stats.isDirectory()) continue;
        } catch {
          // Directory no longer exists, skip it
          continue;
        }

        seenPaths.add(projectPath);
        seenIdentityKeys.add(getProjectIdentityKey(projectPath));
        projects.push(this.registeredProject(projectPath, metadata.addedAt));
      }
    }

    // Fallback: if no projects were found from any source, include the user's
    // home directory so sessions can always be created even if detection is broken
    if (projects.length === 0) {
      const home = homedir();
      const encodedPath = home.replace(/[/\\:]/g, "-");
      projects.push({
        id: encodeProjectId(home),
        path: home,
        name: basename(home) || "Home",
        sessionCount: 0,
        sessionCountsByProvider: { claude: 0 },
        sessionDir: join(this.projectsDir, encodedPath),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "claude",
      });
    }

    // One pass over the finished list rather than per discovery branch: a
    // project a limited user added is also found by the session-directory
    // scans once it has sessions, and its owner must survive that.
    // topics/limited-users.md § Delivery v1 — Project creation.
    if (this.projectMetadataService) {
      const ownerByIdentity = new Map<string, string>();
      for (const metadata of Object.values(
        this.projectMetadataService.getAllProjects(),
      )) {
        if (!metadata.ownerUsername) continue;
        ownerByIdentity.set(
          getProjectIdentityKey(canonicalizeProjectPath(metadata.path)),
          metadata.ownerUsername,
        );
      }
      if (ownerByIdentity.size > 0) {
        for (const project of projects) {
          const owner = ownerByIdentity.get(
            getProjectIdentityKey(project.path),
          );
          if (owner) project.ownerUsername = owner;
        }
      }
    }

    return projects;
  }

  async getProject(
    projectId: string,
    options?: GetProjectOptions,
  ): Promise<Project | null> {
    const snapshot =
      options?.allowStaleSnapshot && this.snapshot
        ? this.snapshot
        : await this.getSnapshot();
    let project = snapshot.byId.get(projectId);
    if (!project) {
      try {
        project = snapshot.byIdentityKey.get(
          getProjectIdentityKey(decodeProjectId(projectId as UrlProjectId)),
        );
      } catch {
        project = undefined;
      }
    }
    if (!project || this.isHiddenProjectPath(project.path)) {
      return null;
    }
    return this.readProject(project);
  }

  private isHiddenProjectPath(projectPath: string): boolean {
    if (!this.projectMetadataService) return false;
    return this.projectMetadataService.isHiddenProjectPath(projectPath);
  }

  /**
   * Get a project by ID, or create a virtual project entry if the path exists on disk
   * but hasn't been used with Claude yet.
   *
   * This allows starting sessions in new directories without requiring prior Claude usage.
   */
  async getOrCreateProject(
    projectId: string,
    preferredProvider?: "claude" | "codex" | "gemini",
  ): Promise<Project | null> {
    let resolvedProjectId = projectId;

    // First check if project already exists
    const existing = await this.getProject(resolvedProjectId);
    if (existing) return existing;

    // Decode the projectId to get the path
    let projectPath: string;
    try {
      projectPath = decodeProjectId(resolvedProjectId as UrlProjectId);
    } catch {
      return null;
    }

    const canonicalProjectPath = canonicalizeProjectPath(
      this.resolveProjectPathForKnownWorkstream(projectPath),
    );
    if (canonicalProjectPath !== projectPath) {
      const canonicalId = encodeProjectId(canonicalProjectPath);
      const canonicalProject = await this.getProject(canonicalId);
      if (canonicalProject) {
        return canonicalProject;
      }
      projectPath = canonicalProjectPath;
      resolvedProjectId = canonicalId;
    }

    // Validate path is absolute
    if (!isAbsolutePath(projectPath)) {
      return null;
    }

    // Check if the directory exists on disk
    try {
      const stats = await stat(projectPath);
      if (!stats.isDirectory()) {
        return null;
      }
    } catch {
      return null;
    }

    // Determine provider: use preferred if specified, otherwise check for Codex/Gemini sessions
    let provider: ProviderName = preferredProvider ?? DEFAULT_PROVIDER;
    if (!preferredProvider) {
      // Check if Codex sessions exist for this path
      if (this.codexScanner) {
        const codexSessions =
          await this.codexScanner.getSessionsForProject(projectPath);
        if (codexSessions.length > 0) {
          provider = "codex";
        }
      }

      // Check if Gemini sessions exist for this path (only if no Codex sessions)
      if (provider === "claude" && this.geminiScanner) {
        const geminiSessions =
          await this.geminiScanner.getSessionsForProject(projectPath);
        if (geminiSessions.length > 0) {
          provider = "gemini";
        }
      }
    }

    // Create a virtual project entry
    // The session directory will be created by the SDK when the first session starts
    const encodedPath = projectPath.replace(/[/\\:]/g, "-");

    // Determine the session directory based on provider
    let sessionDir: string;
    if (provider === "codex") {
      sessionDir = CODEX_SESSIONS_DIR;
    } else if (provider === "gemini") {
      sessionDir = GEMINI_TMP_DIR;
    } else {
      sessionDir = join(this.projectsDir, encodedPath);
    }

    return this.readProject({
      id: resolvedProjectId as UrlProjectId,
      path: projectPath,
      name: getProjectName(projectPath),
      sessionCount: 0,
      sessionCountsByProvider: { [provider]: 0 },
      sessionDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider,
    });
  }

  /**
   * Find a project by matching the session directory suffix.
   *
   * This is used by ExternalSessionTracker which extracts the directory-based
   * project identifier from file paths (e.g., "-home-user-project" or
   * "hostname/-home-user-project") rather than the base64url-encoded projectId.
   */
  async getProjectBySessionDirSuffix(
    dirSuffix: string,
  ): Promise<Project | null> {
    const snapshot = await this.getSnapshot();
    const normalizedSuffix = this.normalizeDirSuffix(dirSuffix);
    const project = snapshot.bySessionDirSuffix.get(normalizedSuffix);
    return project ? this.readProject(project) : null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.retainedTimer) clearTimeout(this.retainedTimer);
    this.retainedTimer = null;
    this.unsubscribeEventBus?.();
    this.unsubscribeEventBus = null;
    await this.retainedRefresh;
    await Promise.allSettled([
      this.inFlightScan?.promise,
      this.claudeDiscovery,
    ]);
    this.claudeDirectories = null;
    this.changedClaudeDirectories.clear();
    this.pendingSnapshotSave = null;
    await this.snapshotSavePromise;
  }

  /** Reconcile changed Claude directories without rereading unrelated projects. */
  private async readClaudeDirectories(): Promise<
    Map<string, ClaudeProjectDirectory>
  > {
    if (this.disposed) throw new Error("Project scanner is disposed");
    if (this.claudeDiscovery) {
      await this.claudeDiscovery;
      return this.readClaudeDirectories();
    }
    if (this.claudeDirectories && this.changedClaudeDirectories.size === 0) {
      return this.claudeDirectories;
    }
    const epoch = this.claudeDiscoveryEpoch;
    const accepted = this.claudeDirectories;
    const changed = [...this.changedClaudeDirectories];
    this.changedClaudeDirectories.clear();
    const work = (async () => {
      const next = new Map(accepted);
      const directories = accepted
        ? changed
        : await this.listClaudeDirectories();
      for (
        let i = 0;
        i < directories.length;
        i += CLAUDE_PROJECT_SCAN_BATCH_SIZE
      ) {
        const batch = directories.slice(i, i + CLAUDE_PROJECT_SCAN_BATCH_SIZE);
        const rows = await Promise.all(
          batch.map(async (dir) => ({
            dir,
            info: await this.getProjectDirInfo(dir),
          })),
        );
        for (const { dir, info } of rows) {
          if (info) next.set(dir, info);
          else next.delete(dir);
        }
      }
      if (!this.disposed && this.claudeDiscoveryEpoch === epoch) {
        this.claudeDirectories = next;
      }
      return next;
    })();
    this.claudeDiscovery = work;
    try {
      return await work;
    } catch (error) {
      if (this.claudeDiscoveryEpoch === epoch) {
        for (const dir of changed) this.changedClaudeDirectories.add(dir);
      }
      throw error;
    } finally {
      if (this.claudeDiscovery === work) this.claudeDiscovery = null;
    }
  }

  private async listClaudeDirectories(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.projectsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const directories: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.projectsDir, entry.name);
      if (entry.name.startsWith("-") || /^[a-zA-Z]--/.test(entry.name)) {
        directories.push(dir);
      } else {
        try {
          const children = await readdir(dir, { withFileTypes: true });
          for (const child of children) {
            if (child.isDirectory()) directories.push(join(dir, child.name));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    return directories;
  }

  private async getProjectDirInfo(
    projectDirPath: string,
  ): Promise<ClaudeProjectDirectory | null> {
    try {
      const entries = await readdir(projectDirPath, { withFileTypes: true });
      const jsonlFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name);

      if (jsonlFiles.length === 0) return null;

      // Count non-agent sessions
      const sessionCount = jsonlFiles.filter(
        (f) => !f.startsWith("agent-"),
      ).length;

      // Use directory mtime as lastActivity (updated when files are added/removed)
      const dirStat = await stat(projectDirPath);
      const lastActivity = new Date(dirStat.mtimeMs).toISOString();

      // Read cwd from session files in small batches and return early on first match.
      // Most project dirs have a session file with cwd near the top of the first file.
      const regularSessionFiles = jsonlFiles.filter(
        (f) => !f.startsWith("agent-"),
      );
      const orderedFiles =
        regularSessionFiles.length > 0
          ? [
              ...regularSessionFiles,
              ...jsonlFiles.filter((f) => f.startsWith("agent-")),
            ]
          : jsonlFiles;

      for (let i = 0; i < orderedFiles.length; i += CWD_SCAN_BATCH_SIZE) {
        const batch = orderedFiles.slice(i, i + CWD_SCAN_BATCH_SIZE);
        const batchCwds = await Promise.all(
          batch.map((file) =>
            readCwdFromSessionFile(join(projectDirPath, file)),
          ),
        );

        for (const cwd of batchCwds) {
          if (cwd) {
            return { projectPath: cwd, sessionCount, lastActivity };
          }
        }
      }

      return null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  }
}

// Singleton for convenience
export const projectScanner = new ProjectScanner();
