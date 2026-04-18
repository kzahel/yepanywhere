/**
 * ProjectMetadataService manages custom project metadata (added projects).
 * This enables adding new projects before any Claude sessions exist.
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalizeProjectPath, encodeProjectId } from "../projects/paths.js";

export interface ProjectMetadata {
  /** The absolute path to the project directory */
  path: string;
  /** When the project was added */
  addedAt: string;
}

export interface HiddenProjectMetadata {
  /** The absolute path to the project directory */
  path: string;
  /** When the project was hidden */
  hiddenAt: string;
}

export interface ProjectMetadataState {
  /** Map of projectId -> metadata */
  projects: Record<string, ProjectMetadata>;
  /** Map of projectId -> hidden metadata */
  hiddenProjects: Record<string, HiddenProjectMetadata>;
  /** Schema version for future migrations */
  version: number;
}

const CURRENT_VERSION = 2;

export interface ProjectMetadataServiceOptions {
  /** Directory to store metadata state (defaults to ~/.yep-anywhere) */
  dataDir?: string;
}

export class ProjectMetadataService {
  private state: ProjectMetadataState;
  private dataDir: string;
  private filePath: string;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: ProjectMetadataServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "project-metadata.json");
    this.state = {
      projects: {},
      hiddenProjects: {},
      version: CURRENT_VERSION,
    };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory and file if they don't exist.
   */
  async initialize(): Promise<void> {
    console.log(`[ProjectMetadataService] Initializing from: ${this.filePath}`);
    try {
      // Ensure data directory exists
      await fs.mkdir(this.dataDir, { recursive: true });

      // Try to load existing state
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as ProjectMetadataState;
      console.log(
        `[ProjectMetadataService] Loaded ${Object.keys(parsed.projects).length} projects from disk`,
      );

      // Validate and migrate if needed
      this.state = this.normalizeState({
        projects: parsed.projects ?? {},
        hiddenProjects: parsed.hiddenProjects ?? {},
        version: CURRENT_VERSION,
      });
      if (parsed.version !== CURRENT_VERSION) {
        await this.save();
      }
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[ProjectMetadataService] Failed to load state, starting fresh:",
          error,
        );
      }
      this.state = {
        projects: {},
        hiddenProjects: {},
        version: CURRENT_VERSION,
      };
    }
  }

  /**
   * Get metadata for a project.
   */
  getMetadata(projectId: string): ProjectMetadata | undefined {
    return this.state.projects[projectId];
  }

  /**
   * Get all added projects.
   */
  getAllProjects(): Record<string, ProjectMetadata> {
    return { ...this.state.projects };
  }

  /**
   * Get all hidden projects.
   */
  getAllHiddenProjects(): Record<string, HiddenProjectMetadata> {
    return { ...this.state.hiddenProjects };
  }

  /**
   * Add a project. The projectId should be a UrlProjectId (base64url encoded path).
   * If the project was previously hidden, restore it to the visible list.
   */
  async addProject(projectId: string, projectPath: string): Promise<void> {
    const canonicalPath = canonicalizeProjectPath(projectPath);
    const canonicalProjectId = encodeProjectId(canonicalPath);
    if (projectId !== canonicalProjectId) {
      delete this.state.projects[projectId];
      delete this.state.hiddenProjects[projectId];
    }
    delete this.state.hiddenProjects[canonicalProjectId];
    this.state.projects[canonicalProjectId] = {
      path: canonicalPath,
      addedAt: new Date().toISOString(),
    };
    await this.save();
  }

  /**
   * Remove a project from the added list.
   */
  async removeProject(projectId: string): Promise<void> {
    if (this.state.projects[projectId]) {
      const { [projectId]: _, ...rest } = this.state.projects;
      this.state.projects = rest;
      await this.save();
    }
  }

  /**
   * Hide a project from the list without deleting its sessions from disk.
   */
  async hideProject(projectId: string, projectPath: string): Promise<void> {
    const canonicalPath = canonicalizeProjectPath(projectPath);
    const canonicalProjectId = encodeProjectId(canonicalPath);
    delete this.state.projects[projectId];
    delete this.state.projects[canonicalProjectId];
    delete this.state.hiddenProjects[projectId];
    this.state.hiddenProjects[canonicalProjectId] = {
      path: canonicalPath,
      hiddenAt: new Date().toISOString(),
    };
    await this.save();
  }

  /**
   * Check if a project was manually added.
   */
  isAddedProject(projectId: string): boolean {
    return projectId in this.state.projects;
  }

  /**
   * Check if a project is hidden from the visible project list.
   */
  isHiddenProject(projectId: string): boolean {
    return projectId in this.state.hiddenProjects;
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
      console.error("[ProjectMetadataService] Failed to save state:", error);
      throw error;
    }
  }

  /**
   * Get the file path for testing purposes.
   */
  getFilePath(): string {
    return this.filePath;
  }

  private normalizeState(state: ProjectMetadataState): ProjectMetadataState {
    const projects: Record<string, ProjectMetadata> = {};
    const hiddenProjects: Record<string, HiddenProjectMetadata> = {};

    for (const [projectId, metadata] of Object.entries(state.projects ?? {})) {
      const canonicalPath = canonicalizeProjectPath(metadata.path);
      const canonicalProjectId = encodeProjectId(canonicalPath);
      const existing = projects[canonicalProjectId];

      if (
        !existing ||
        new Date(metadata.addedAt).getTime() >
          new Date(existing.addedAt).getTime()
      ) {
        projects[canonicalProjectId] = {
          path: canonicalPath,
          addedAt: metadata.addedAt,
        };
      }

      if (projectId !== canonicalProjectId) {
        console.log(
          `[ProjectMetadataService] Canonicalized project metadata key ${projectId} -> ${canonicalProjectId}`,
        );
      }
    }

    for (const [projectId, metadata] of Object.entries(
      state.hiddenProjects ?? {},
    )) {
      const canonicalPath = canonicalizeProjectPath(metadata.path);
      const canonicalProjectId = encodeProjectId(canonicalPath);
      const existing = hiddenProjects[canonicalProjectId];

      if (
        !existing ||
        new Date(metadata.hiddenAt).getTime() >
          new Date(existing.hiddenAt).getTime()
      ) {
        hiddenProjects[canonicalProjectId] = {
          path: canonicalPath,
          hiddenAt: metadata.hiddenAt,
        };
      }

      if (projectId !== canonicalProjectId) {
        console.log(
          `[ProjectMetadataService] Canonicalized hidden project metadata key ${projectId} -> ${canonicalProjectId}`,
        );
      }
    }

    return {
      projects,
      hiddenProjects,
      version: CURRENT_VERSION,
    };
  }
}
