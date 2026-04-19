import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  DEFAULT_PROVIDER,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { ProjectMetadataService } from "../metadata/index.js";
import type { Project } from "../supervisor/types.js";
import type { EventBus, FileChangeEvent } from "../watcher/index.js";
import { CODEX_SESSIONS_DIR, CodexSessionScanner } from "./codex-scanner.js";
import { GEMINI_TMP_DIR, GeminiSessionScanner } from "./gemini-scanner.js";
import {
  CLAUDE_PROJECTS_DIR,
  canonicalizeProjectPath,
  decodeProjectId,
  encodeProjectId,
  isAbsolutePath,
  normalizeProjectPathForDedup,
  readCwdFromSessionFile,
} from "./paths.js";

export interface ScannerOptions {
  projectsDir?: string; // override for testing
  codexSessionsDir?: string; // override for testing
  geminiSessionsDir?: string; // override for testing
  dataDir?: string; // override for persisted snapshot state
  codexScanner?: CodexSessionScanner | null; // shared provider scanner
  geminiScanner?: GeminiSessionScanner | null; // shared provider scanner
  enableCodex?: boolean; // whether to include Codex projects (default: true)
  enableGemini?: boolean; // whether to include Gemini projects (default: true)
  projectMetadataService?: ProjectMetadataService; // for persisting added projects
  /** Optional EventBus for watcher-driven cache invalidation */
  eventBus?: EventBus;
  /** Project snapshot TTL in milliseconds (default: 5000) */
  cacheTtlMs?: number;
}

interface ProjectSnapshot {
  projects: Project[];
  byId: Map<string, Project>;
  bySessionDirSuffix: Map<string, Project>;
  timestamp: number;
}

interface PersistedProjectSnapshot {
  version: 1;
  savedAt: string;
  projects: Project[];
}

export class ProjectScanner {
  private projectsDir: string;
  private dataDir: string;
  private snapshotFilePath: string;
  private codexScanner: CodexSessionScanner | null;
  private geminiScanner: GeminiSessionScanner | null;
  private enableCodex: boolean;
  private enableGemini: boolean;
  private projectMetadataService: ProjectMetadataService | null;
  private cacheTtlMs: number;
  private cacheDirty = true;
  private snapshot: ProjectSnapshot | null = null;
  private inFlightScan: Promise<ProjectSnapshot> | null = null;
  private persistedSnapshotLoaded = false;
  private unsubscribeEventBus: (() => void) | null = null;

  constructor(options: ScannerOptions = {}) {
    this.projectsDir = options.projectsDir ?? CLAUDE_PROJECTS_DIR;
    this.dataDir = options.dataDir ?? join(homedir(), ".yep-anywhere");
    this.snapshotFilePath = join(this.dataDir, "project-snapshot.json");
    this.enableCodex = options.enableCodex ?? true;
    this.enableGemini = options.enableGemini ?? true;
    this.codexScanner = this.enableCodex
      ? (options.codexScanner ??
        new CodexSessionScanner({
          sessionsDir: options.codexSessionsDir ?? CODEX_SESSIONS_DIR,
        }))
      : null;
    this.geminiScanner = this.enableGemini
      ? (options.geminiScanner ??
        new GeminiSessionScanner({
          sessionsDir: options.geminiSessionsDir ?? GEMINI_TMP_DIR,
        }))
      : null;
    this.projectMetadataService = options.projectMetadataService ?? null;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 5000);

    if (options.eventBus) {
      this.unsubscribeEventBus = options.eventBus.subscribe((event) => {
        if (event.type !== "file-change") return;
        this.handleFileChange(event);
      });
    }
  }

  /**
   * Set the project metadata service (for late initialization).
   */
  setProjectMetadataService(service: ProjectMetadataService): void {
    this.projectMetadataService = service;
    this.invalidateCache();
  }

  async listProjects(): Promise<Project[]> {
    const snapshot = await this.getSnapshot();
    return snapshot.projects.map((project) => this.cloneProject(project));
  }

  /**
   * Mark the project snapshot stale so next read triggers a rescan.
   */
  invalidateCache(): void {
    this.cacheDirty = true;
  }

  async prewarm(): Promise<void> {
    await this.getSnapshot(true);
  }

  private async getSnapshot(forceRefresh = false): Promise<ProjectSnapshot> {
    if (!this.persistedSnapshotLoaded) {
      this.persistedSnapshotLoaded = true;
      const persisted = await this.loadPersistedSnapshot();
      if (persisted) {
        this.snapshot = persisted;
        this.cacheDirty = false;
      }
    }

    const now = Date.now();
    const isFresh =
      this.snapshot &&
      !this.cacheDirty &&
      now - this.snapshot.timestamp < this.cacheTtlMs;

    if (!forceRefresh && isFresh && this.snapshot) {
      return this.snapshot;
    }

    if (this.inFlightScan) {
      return this.inFlightScan;
    }

    const scanPromise = this.scanProjects()
      .then((projects) => {
        const snapshot = this.buildSnapshot(projects);
        this.snapshot = snapshot;
        this.cacheDirty = false;
        void this.savePersistedSnapshot(snapshot.projects);
        return snapshot;
      })
      .finally(() => {
        if (this.inFlightScan === scanPromise) {
          this.inFlightScan = null;
        }
      });

    this.inFlightScan = scanPromise;
    return scanPromise;
  }

  private buildSnapshot(projects: Project[]): ProjectSnapshot {
    const byId = new Map<string, Project>();
    const bySessionDirSuffix = new Map<string, Project>();

    for (const project of projects) {
      byId.set(project.id, project);

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
      bySessionDirSuffix,
      timestamp: Date.now(),
    };
  }

  private getHiddenProjectPaths(): Set<string> {
    const hiddenPaths = new Set<string>();
    if (!this.projectMetadataService) return hiddenPaths;

    for (const metadata of Object.values(
      this.projectMetadataService.getAllHiddenProjects(),
    )) {
      hiddenPaths.add(canonicalizeProjectPath(metadata.path));
    }

    return hiddenPaths;
  }

  private filterHiddenProjects(projects: Project[]): Project[] {
    const hiddenPaths = this.getHiddenProjectPaths();
    if (hiddenPaths.size === 0) return projects;

    return projects.filter(
      (project) => !hiddenPaths.has(canonicalizeProjectPath(project.path)),
    );
  }

  private async loadPersistedSnapshot(): Promise<ProjectSnapshot | null> {
    try {
      const raw = await readFile(this.snapshotFilePath, "utf-8");
      const parsed = JSON.parse(raw) as PersistedProjectSnapshot;
      if (parsed.version !== 1 || !Array.isArray(parsed.projects)) {
        return null;
      }
      const snapshot = this.buildSnapshot(
        this.filterHiddenProjects(parsed.projects),
      );
      snapshot.timestamp = Date.now();
      return snapshot;
    } catch {
      return null;
    }
  }

  private async savePersistedSnapshot(projects: Project[]): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const payload: PersistedProjectSnapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        projects,
      };
      await writeFile(this.snapshotFilePath, JSON.stringify(payload), "utf-8");
    } catch {
      // Ignore persistence failures; the in-memory snapshot still helps.
    }
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

  private cloneProject(project: Project): Project {
    return {
      ...project,
      mergedSessionDirs: project.mergedSessionDirs
        ? [...project.mergedSessionDirs]
        : undefined,
      hasCodexSessions: project.hasCodexSessions,
      hasGeminiSessions: project.hasGeminiSessions,
    };
  }

  private handleFileChange(event: FileChangeEvent): void {
    if (event.fileType !== "session" && event.fileType !== "agent-session") {
      return;
    }

    // Any session file delta can affect project existence/count/lastActivity.
    this.invalidateCache();
    if (event.provider === "codex") {
      this.codexScanner?.invalidateCache();
    } else if (event.provider === "gemini") {
      this.geminiScanner?.invalidateCache();
    }
  }

  private async scanProjects(): Promise<Project[]> {
    const projects: Project[] = [];
    const seenPaths = new Set<string>();
    const hiddenPaths = this.getHiddenProjectPaths();
    // Map from normalized path to project index for cross-machine dedup
    const normalizedIndex = new Map<string, number>();

    // ~/.claude/projects/ can have two structures:
    // 1. Projects directly as -home-user-project/
    // 2. Projects under hostname/ as hostname/-home-user-project/
    let dirs: string[] = [];
    try {
      await access(this.projectsDir);
      const entries = await readdir(this.projectsDir, { withFileTypes: true });
      dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // Directory doesn't exist or unreadable — skip Claude project scanning
      // but continue to Codex/Gemini/metadata merge below
    }

    // Helper to add a Claude project, merging cross-machine duplicates
    const addOrMerge = (
      rawProjectPath: string,
      sessionDir: string,
      sessionCount: number,
      lastActivity: string | null,
    ) => {
      const projectPath = canonicalizeProjectPath(rawProjectPath);
      if (hiddenPaths.has(projectPath)) return;
      if (seenPaths.has(projectPath)) return; // exact path duplicate
      seenPaths.add(projectPath);

      const normalized = normalizeProjectPathForDedup(projectPath);
      const existingIdx = normalizedIndex.get(normalized);

      if (existingIdx !== undefined) {
        // Cross-machine duplicate — merge into existing project
        const existing = projects[existingIdx];
        if (!existing) return;
        existing.sessionCount += sessionCount;
        if (!existing.mergedSessionDirs) {
          existing.mergedSessionDirs = [];
        }
        existing.mergedSessionDirs.push(sessionDir);
        if (
          lastActivity &&
          (!existing.lastActivity || lastActivity > existing.lastActivity)
        ) {
          existing.lastActivity = lastActivity;
        }

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
        if (!existingIsLocal && newIsLocal) {
          existing.path = projectPath;
          existing.id = encodeProjectId(projectPath);
          existing.name = basename(projectPath);
        }
      } else {
        normalizedIndex.set(normalized, projects.length);
        projects.push({
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
          sessionCount,
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

    for (const dir of dirs) {
      const dirPath = join(this.projectsDir, dir);

      // Check if this is a project directory
      // On Unix/macOS: /home/user/project → -home-user-project (starts with -)
      // On Windows: C:\Users\kaa\project → c--Users-kaa-project (drive letter + --)
      if (dir.startsWith("-") || /^[a-zA-Z]--/.test(dir)) {
        const info = await this.getProjectDirInfo(dirPath);
        if (info) {
          addOrMerge(
            info.projectPath,
            dirPath,
            info.sessionCount,
            info.lastActivity,
          );
        }
        continue;
      }

      // Otherwise, treat as hostname directory
      // Format: ~/.claude/projects/hostname/-project-path/
      let projectDirs: string[];
      try {
        const subEntries = await readdir(dirPath, { withFileTypes: true });
        projectDirs = subEntries
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }

      for (const projectDir of projectDirs) {
        const projectDirPath = join(dirPath, projectDir);
        const info = await this.getProjectDirInfo(projectDirPath);
        if (!info) continue;
        addOrMerge(
          info.projectPath,
          projectDirPath,
          info.sessionCount,
          info.lastActivity,
        );
      }
    }

    // Merge Codex projects if enabled
    if (this.codexScanner) {
      const codexProjects = await this.codexScanner.listProjects();
      for (const codexProject of codexProjects) {
        const projectPath = canonicalizeProjectPath(codexProject.path);
        if (hiddenPaths.has(projectPath)) continue;
        const existing = projects.find(
          (project) => canonicalizeProjectPath(project.path) === projectPath,
        );
        if (existing) {
          existing.hasCodexSessions = true;
          continue;
        }
        seenPaths.add(projectPath);
        projects.push({
          ...codexProject,
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
          hasCodexSessions: true,
          hasGeminiSessions: false,
        });
      }
    }

    // Merge Gemini projects if enabled
    if (this.geminiScanner) {
      // Register known paths for hash resolution before scanning
      await this.geminiScanner.registerKnownPaths(Array.from(seenPaths));

      const geminiProjects = await this.geminiScanner.listProjects();
      for (const geminiProject of geminiProjects) {
        const projectPath = canonicalizeProjectPath(geminiProject.path);
        if (hiddenPaths.has(projectPath)) continue;
        const existing = projects.find(
          (project) => canonicalizeProjectPath(project.path) === projectPath,
        );
        if (existing) {
          existing.hasGeminiSessions = true;
          continue;
        }
        seenPaths.add(projectPath);
        projects.push({
          ...geminiProject,
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
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
        if (hiddenPaths.has(projectPath)) continue;
        // Skip if we've already seen this path from another source
        if (seenPaths.has(projectPath)) continue;

        // Verify the directory still exists
        try {
          const stats = await stat(projectPath);
          if (!stats.isDirectory()) continue;
        } catch {
          // Directory no longer exists, skip it
          continue;
        }

        seenPaths.add(projectPath);
        const encodedPath = projectPath.replace(/[/\\:]/g, "-");
        projects.push({
          id: encodeProjectId(projectPath),
          path: projectPath,
          name: basename(projectPath),
          sessionCount: 0,
          sessionDir: join(this.projectsDir, encodedPath),
          hasCodexSessions: false,
          hasGeminiSessions: false,
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: metadata.addedAt,
          provider: "claude",
        });
      }
    }

    // Fallback: if no projects were found from any source, include the user's
    // home directory so sessions can always be created even if detection is broken
    if (projects.length === 0) {
      if (hiddenPaths.size > 0) {
        return projects;
      }
      const home = homedir();
      if (hiddenPaths.has(home)) {
        return projects;
      }
      const encodedPath = home.replace(/[/\\:]/g, "-");
      projects.push({
        id: encodeProjectId(home),
        path: home,
        name: basename(home) || "Home",
        sessionCount: 0,
        sessionDir: join(this.projectsDir, encodedPath),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "claude",
      });
    }

    return projects;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const snapshot = await this.getSnapshot();
    const project = snapshot.byId.get(projectId);
    return project ? this.cloneProject(project) : null;
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

    const canonicalProjectPath = canonicalizeProjectPath(projectPath);
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

    return {
      id: resolvedProjectId as UrlProjectId,
      path: projectPath,
      name: basename(projectPath),
      sessionCount: 0,
      sessionDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider,
    };
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
    return project ? this.cloneProject(project) : null;
  }

  dispose(): void {
    this.unsubscribeEventBus?.();
    this.unsubscribeEventBus = null;
  }

  /**
   * Get project info from a session directory in a single readdir pass.
   * Uses directory mtime as a cheap proxy for lastActivity (one stat
   * on the dir itself instead of stat-ing every session file).
   */
  private async getProjectDirInfo(projectDirPath: string): Promise<{
    projectPath: string;
    sessionCount: number;
    lastActivity: string | null;
  } | null> {
    try {
      const files = await readdir(projectDirPath);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      if (jsonlFiles.length === 0) return null;

      // Count non-agent sessions
      const sessionCount = jsonlFiles.filter(
        (f) => !f.startsWith("agent-"),
      ).length;

      // Use directory mtime as lastActivity (updated when files are added/removed)
      const dirStat = await stat(projectDirPath);
      const lastActivity = new Date(dirStat.mtimeMs).toISOString();

      // Read cwd from first available session file
      for (const file of jsonlFiles) {
        const filePath = join(projectDirPath, file);
        const cwd = await readCwdFromSessionFile(filePath);
        if (cwd) {
          return { projectPath: cwd, sessionCount, lastActivity };
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}

// Singleton for convenience
export const projectScanner = new ProjectScanner();
