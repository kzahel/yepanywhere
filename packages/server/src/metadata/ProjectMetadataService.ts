/**
 * ProjectMetadataService manages custom project metadata.
 * This enables adding new projects before any Claude sessions exist and
 * hiding projects discovered from session logs.
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import {
  canonicalizeProjectPath,
  decodeProjectId,
  encodeProjectId,
  getProjectIdentityKey,
  getProjectName,
} from "../projects/paths.js";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";
import { writeFileAtomically } from "../utils/writeFileAtomically.js";
import {
  normalizeProjectCodeNameMetadata,
  reconcileProjectCodeNames,
  setProjectCodeNameInRegistry,
  type ProjectCodeNameMetadata,
  type ProjectCodeNameUpdate,
} from "./ProjectCodeNameRegistry.js";

export type { ProjectCodeNameMetadata } from "./ProjectCodeNameRegistry.js";

export interface ProjectMetadata {
  /** The absolute path to the project directory */
  path: string;
  /** When the project was added */
  addedAt: string;
  /**
   * Limited user who added this project, when one did. Absent means the
   * superuser added it, which is also what every project predating limited
   * users means. topics/limited-users.md § Delivery v1 — Project creation.
   */
  ownerUsername?: string;
}

export interface HiddenProjectMetadata {
  /** The absolute path to the project directory */
  path: string;
  /** When the project was hidden from YA project lists */
  hiddenAt: string;
  /** The hidden project's `ownerUsername`, restored if it is added again. */
  ownerUsername?: string;
}

export interface ProjectCaptionMetadata {
  /** User-entered caption that overrides the README/manifest derivation. */
  caption: string;
  updatedAt: string;
}

export interface ProjectNameMetadata {
  /** User-chosen name that replaces the path's last component. */
  name: string;
  updatedAt: string;
}

export interface ProjectMetadataState {
  /** Map of projectId -> metadata */
  projects: Record<string, ProjectMetadata>;
  /** Map of projectId -> hidden project metadata */
  hiddenProjects?: Record<string, HiddenProjectMetadata>;
  /** Durable unique labels used in compact project identity surfaces. */
  projectCodeNames?: Record<string, ProjectCodeNameMetadata>;
  /** User caption overrides; absent entries fall back to derived captions. */
  projectCaptions?: Record<string, ProjectCaptionMetadata>;
  /** User name overrides; absent entries use the path's last component. */
  projectNames?: Record<string, ProjectNameMetadata>;
  /** Schema version for future migrations */
  version: number;
}

const CURRENT_VERSION = 4;

/** A stored owner as an entry field; anything but a nonempty name is none. */
function ownerField(ownerUsername: unknown): { ownerUsername?: string } {
  return typeof ownerUsername === "string" && ownerUsername
    ? { ownerUsername }
    : {};
}

export interface ProjectMetadataServiceOptions {
  /** Directory to store metadata state (defaults to ~/.yep-anywhere) */
  dataDir?: string;
}

export class ProjectMetadataService {
  private state: ProjectMetadataState;
  private discoveryRevision = 0;
  /** The owned registry has passed a no-op reconciliation since its last mutation. */
  private codeNamesReconciled = false;
  private dataDir: string;
  private filePath: string;
  /** One identity per hidden project; invalidated when hidden membership changes. */
  private hiddenProjectIdentities?: Set<string>;
  /** One entry per registered/hidden owned project; reset on any state write/reload. */
  private projectOwnersByIdentity?: Map<string, string>;
  private writeState = createCoalescingSaver(() => this.doSave()).save;
  private save = () => {
    this.projectOwnersByIdentity = undefined;
    return this.writeState();
  };

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
      projectCodeNames: {},
      version: CURRENT_VERSION,
    };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory and file if they don't exist.
   */
  async initialize(): Promise<void> {
    this.discoveryRevision++;
    this.codeNamesReconciled = false;
    this.hiddenProjectIdentities = undefined;
    this.projectOwnersByIdentity = undefined;
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
      if (parsed.version === CURRENT_VERSION) {
        this.state = this.normalizeState(parsed);
      } else {
        // Future: handle migrations here
        this.state = this.normalizeState({
          projects: parsed.projects ?? {},
          hiddenProjects: parsed.hiddenProjects ?? {},
          projectCodeNames: parsed.projectCodeNames ?? {},
          projectCaptions: parsed.projectCaptions ?? {},
          projectNames: parsed.projectNames ?? {},
          version: CURRENT_VERSION,
        });
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Project ownership here backs limited users' grants and hidden
        // projects; starting fresh would silently drop both
        // (topics/security.md). The file is left as it is.
        throw new Error(
          `[ProjectMetadataService] ${this.filePath} is unreadable (${error instanceof Error ? error.message : String(error)}). ` +
            "Refusing to start without its project ownership records. " +
            "Restore the file, or delete it to deliberately reset them.",
        );
      }
      this.state = {
        projects: {},
        hiddenProjects: {},
        projectCodeNames: {},
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

  getProjectCodeName(projectId: string): string | undefined {
    return this.state.projectCodeNames?.[this.canonicalProjectId(projectId)]
      ?.codeName;
  }

  getProjectCaptionOverride(projectId: string): string | undefined {
    return this.state.projectCaptions?.[this.canonicalProjectId(projectId)]
      ?.caption;
  }

  getProjectNameOverride(projectId: string): string | undefined {
    return this.state.projectNames?.[this.canonicalProjectId(projectId)]?.name;
  }

  /** The project's display name: the chosen name, else its path's name. */
  getProjectDisplayName(projectPath: string): string {
    return (
      this.getProjectNameOverride(encodeProjectId(projectPath)) ??
      getProjectName(projectPath)
    );
  }

  /**
   * Set or clear (with `null`) the user-chosen project name. The caller
   * normalizes and validates the text.
   */
  async setProjectNameOverride(
    projectId: string,
    name: string | null,
  ): Promise<void> {
    const canonicalProjectId = this.canonicalProjectId(projectId);
    this.state.projectNames ??= {};
    if (name === null) {
      if (!(canonicalProjectId in this.state.projectNames)) return;
      delete this.state.projectNames[canonicalProjectId];
    } else {
      this.state.projectNames[canonicalProjectId] = {
        name,
        updatedAt: new Date().toISOString(),
      };
    }
    await this.save();
  }

  /**
   * Set or clear (with `null`) the user caption override. The caller
   * normalizes and validates the text.
   */
  async setProjectCaptionOverride(
    projectId: string,
    caption: string | null,
  ): Promise<void> {
    const canonicalProjectId = this.canonicalProjectId(projectId);
    this.state.projectCaptions ??= {};
    if (caption === null) {
      if (!(canonicalProjectId in this.state.projectCaptions)) return;
      delete this.state.projectCaptions[canonicalProjectId];
    } else {
      this.state.projectCaptions[canonicalProjectId] = {
        caption,
        updatedAt: new Date().toISOString(),
      };
    }
    await this.save();
  }

  async ensureProjectCodeNames(
    projects: readonly { id: string; name: string }[],
  ): Promise<ProjectCodeNameUpdate> {
    this.state.projectCodeNames ??= {};
    if (this.codeNamesReconciled) {
      const assignments = projects.map((project) => {
        const record =
          this.state.projectCodeNames![this.canonicalProjectId(project.id)];
        return record?.projectName === project.name
          ? { projectId: project.id, codeName: record.codeName }
          : undefined;
      });
      if (
        assignments.every(
          (assignment): assignment is NonNullable<typeof assignment> =>
            assignment !== undefined,
        )
      )
        return { assignments, changedProjectIds: [] };
    }
    this.codeNamesReconciled = false;
    const update = reconcileProjectCodeNames(
      this.state.projectCodeNames,
      projects,
      (projectId) => this.canonicalProjectId(projectId),
    );
    this.codeNamesReconciled = !update.stateChanged;
    if (update.stateChanged) await this.save();
    return {
      assignments: [...update.assignments],
      changedProjectIds: [...update.changedProjectIds],
    };
  }

  async setProjectCodeName(
    projectId: string,
    requestedCodeName: string,
    projects: readonly { id: string; name: string }[],
  ): Promise<ProjectCodeNameUpdate> {
    this.codeNamesReconciled = false;
    this.state.projectCodeNames ??= {};
    const update = setProjectCodeNameInRegistry(
      this.state.projectCodeNames,
      projectId,
      requestedCodeName,
      projects,
      (candidateProjectId) => this.canonicalProjectId(candidateProjectId),
    );
    await this.save();
    return {
      assignments: update.assignments,
      changedProjectIds: update.changedProjectIds,
    };
  }

  /**
   * Add a project, or show a hidden one again. The projectId should be a
   * UrlProjectId (base64url encoded path). Without `ownerUsername` a project
   * that already has an owner, listed or hidden, keeps that owner; the caller
   * decides who may add a project that already exists.
   */
  async addProject(
    projectId: string,
    projectPath: string,
    ownerUsername?: string,
  ): Promise<void> {
    this.codeNamesReconciled = false;
    this.discoveryRevision++;
    const canonicalPath = canonicalizeProjectPath(projectPath);
    const canonicalProjectId = encodeProjectId(canonicalPath);
    const owner = ownerUsername ?? this.getProjectOwner(canonicalPath);
    if (projectId !== canonicalProjectId) {
      delete this.state.projects[projectId];
      const legacyCodeName = this.state.projectCodeNames?.[projectId];
      if (legacyCodeName) {
        this.state.projectCodeNames ??= {};
        this.state.projectCodeNames[canonicalProjectId] = legacyCodeName;
        delete this.state.projectCodeNames[projectId];
      }
    }
    this.deleteProjectsByIdentity(canonicalPath);
    this.deleteHiddenProjectsByIdentity(canonicalPath);
    this.state.projects[canonicalProjectId] = {
      path: canonicalPath,
      addedAt: new Date().toISOString(),
      ...(owner ? { ownerUsername: owner } : {}),
    };
    await this.save();
  }

  /**
   * The limited user owning the project at this path, listed or hidden;
   * undefined for a superuser project or a path that is no project here.
   */
  getProjectOwner(projectPath: string): string | undefined {
    const targetIdentity = getProjectIdentityKey(
      canonicalizeProjectPath(projectPath),
    );
    if (!this.projectOwnersByIdentity) {
      this.projectOwnersByIdentity = new Map();
      for (const metadata of [
        ...Object.values(this.state.projects),
        ...Object.values(this.state.hiddenProjects ?? {}),
      ]) {
        const key = getProjectIdentityKey(metadata.path);
        if (metadata.ownerUsername && !this.projectOwnersByIdentity.has(key))
          this.projectOwnersByIdentity.set(key, metadata.ownerUsername);
      }
    }
    return this.projectOwnersByIdentity.get(targetIdentity);
  }

  /**
   * Remove a project from the added list.
   */
  async removeProject(projectId: string): Promise<void> {
    this.codeNamesReconciled = false;
    const canonicalProjectId = this.canonicalProjectId(projectId);
    const hadCodeName = Boolean(
      this.state.projectCodeNames?.[canonicalProjectId],
    );
    delete this.state.projectCodeNames?.[canonicalProjectId];
    if (this.state.projects[projectId]) {
      this.discoveryRevision++;
      const { [projectId]: _, ...rest } = this.state.projects;
      this.state.projects = rest;
      await this.save();
    } else if (hadCodeName) {
      await this.save();
    }
  }

  /**
   * Hide a project from YA's project list without deleting files or session logs.
   */
  async hideProject(projectId: string, projectPath: string): Promise<void> {
    this.hiddenProjectIdentities = undefined;
    this.codeNamesReconciled = false;
    this.discoveryRevision++;
    const canonicalPath = canonicalizeProjectPath(projectPath);
    const canonicalProjectId = encodeProjectId(canonicalPath);
    const owner = this.getProjectOwner(canonicalPath);

    if (projectId !== canonicalProjectId) {
      delete this.state.projects[projectId];
      delete this.state.hiddenProjects?.[projectId];
    }

    this.deleteProjectsByIdentity(canonicalPath);
    this.deleteHiddenProjectsByIdentity(canonicalPath);
    delete this.state.projectCodeNames?.[canonicalProjectId];
    delete this.state.projectCodeNames?.[projectId];
    delete this.state.projectNames?.[canonicalProjectId];
    delete this.state.projectNames?.[projectId];
    this.state.hiddenProjects ??= {};
    this.state.hiddenProjects[canonicalProjectId] = {
      path: canonicalPath,
      hiddenAt: new Date().toISOString(),
      ...(owner ? { ownerUsername: owner } : {}),
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
   * Check if a project was hidden by the user.
   */
  isHiddenProject(projectId: string): boolean {
    return projectId in (this.state.hiddenProjects ?? {});
  }

  /**
   * Check whether a project path is hidden using the same identity rules as
   * project discovery.
   */
  isHiddenProjectPath(projectPath: string): boolean {
    this.hiddenProjectIdentities ??= new Set(
      Object.values(this.state.hiddenProjects ?? {}).map((metadata) =>
        getProjectIdentityKey(metadata.path),
      ),
    );
    return this.hiddenProjectIdentities.has(getProjectIdentityKey(projectPath));
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await writeFileAtomically(this.filePath, content, { durable: true });
    } catch (error) {
      console.error("[ProjectMetadataService] Failed to save state:", error);
      throw error;
    }
  }

  /**
   * Get the file path for testing purposes.
   */
  getDiscoveryRevision(): number {
    return this.discoveryRevision;
  }

  getFilePath(): string {
    return this.filePath;
  }

  private normalizeState(state: ProjectMetadataState): ProjectMetadataState {
    const projectsByIdentity = new Map<
      string,
      { projectId: string; metadata: ProjectMetadata }
    >();
    const hiddenProjectsByIdentity = new Map<
      string,
      { projectId: string; metadata: HiddenProjectMetadata }
    >();
    const projectCodeNames = new Map<string, ProjectCodeNameMetadata>();
    const projectCaptions = new Map<string, ProjectCaptionMetadata>();
    const projectNames = new Map<string, ProjectNameMetadata>();

    for (const [projectId, metadata] of Object.entries(state.projects ?? {})) {
      const canonicalPath = canonicalizeProjectPath(metadata.path);
      const canonicalProjectId = encodeProjectId(canonicalPath);
      const identity = getProjectIdentityKey(canonicalPath);
      const existing = projectsByIdentity.get(identity);

      if (
        !existing ||
        new Date(metadata.addedAt).getTime() >
          new Date(existing.metadata.addedAt).getTime()
      ) {
        projectsByIdentity.set(identity, {
          projectId: canonicalProjectId,
          metadata: {
            path: canonicalPath,
            addedAt: metadata.addedAt,
            ...ownerField(metadata.ownerUsername),
          },
        });
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
      const identity = getProjectIdentityKey(canonicalPath);
      const existing = hiddenProjectsByIdentity.get(identity);

      if (
        !existing ||
        new Date(metadata.hiddenAt).getTime() >
          new Date(existing.metadata.hiddenAt).getTime()
      ) {
        hiddenProjectsByIdentity.set(identity, {
          projectId: canonicalProjectId,
          metadata: {
            path: canonicalPath,
            hiddenAt: metadata.hiddenAt,
            ...ownerField(metadata.ownerUsername),
          },
        });
      }

      if (projectId !== canonicalProjectId) {
        console.log(
          `[ProjectMetadataService] Canonicalized hidden project metadata key ${projectId} -> ${canonicalProjectId}`,
        );
      }
    }

    for (const hiddenIdentity of hiddenProjectsByIdentity.keys()) {
      projectsByIdentity.delete(hiddenIdentity);
    }

    for (const [projectId, metadata] of Object.entries(
      state.projectCodeNames ?? {},
    )) {
      const normalized = normalizeProjectCodeNameMetadata(metadata);
      if (!normalized) continue;
      const canonicalProjectId = this.canonicalProjectId(projectId);
      const existing = projectCodeNames.get(canonicalProjectId);
      if (
        !existing ||
        new Date(normalized.updatedAt).getTime() >=
          new Date(existing.updatedAt).getTime()
      ) {
        projectCodeNames.set(canonicalProjectId, normalized);
      }
    }

    for (const [projectId, metadata] of Object.entries(
      state.projectCaptions ?? {},
    )) {
      if (
        !metadata ||
        typeof metadata.caption !== "string" ||
        !metadata.caption.trim()
      ) {
        continue;
      }
      const canonicalProjectId = this.canonicalProjectId(projectId);
      const updatedAt = Number.isFinite(new Date(metadata.updatedAt).getTime())
        ? metadata.updatedAt
        : new Date(0).toISOString();
      const existing = projectCaptions.get(canonicalProjectId);
      if (
        !existing ||
        new Date(updatedAt).getTime() >= new Date(existing.updatedAt).getTime()
      ) {
        projectCaptions.set(canonicalProjectId, {
          caption: metadata.caption,
          updatedAt,
        });
      }
    }

    for (const [projectId, metadata] of Object.entries(
      state.projectNames ?? {},
    )) {
      if (
        !metadata ||
        typeof metadata.name !== "string" ||
        !metadata.name.trim()
      ) {
        continue;
      }
      const canonicalProjectId = this.canonicalProjectId(projectId);
      const updatedAt = Number.isFinite(new Date(metadata.updatedAt).getTime())
        ? metadata.updatedAt
        : new Date(0).toISOString();
      const existing = projectNames.get(canonicalProjectId);
      if (
        !existing ||
        new Date(updatedAt).getTime() >= new Date(existing.updatedAt).getTime()
      ) {
        projectNames.set(canonicalProjectId, {
          name: metadata.name,
          updatedAt,
        });
      }
    }

    const projects: Record<string, ProjectMetadata> = {};
    for (const { projectId, metadata } of projectsByIdentity.values()) {
      projects[projectId] = metadata;
    }

    const hiddenProjects: Record<string, HiddenProjectMetadata> = {};
    for (const { projectId, metadata } of hiddenProjectsByIdentity.values()) {
      hiddenProjects[projectId] = metadata;
    }

    return {
      projects,
      hiddenProjects,
      projectCodeNames: Object.fromEntries(projectCodeNames),
      projectCaptions: Object.fromEntries(projectCaptions),
      projectNames: Object.fromEntries(projectNames),
      version: CURRENT_VERSION,
    };
  }

  private canonicalProjectId(projectId: string): string {
    try {
      return encodeProjectId(
        canonicalizeProjectPath(decodeProjectId(projectId as UrlProjectId)),
      );
    } catch {
      return projectId;
    }
  }

  private deleteProjectsByIdentity(projectPath: string): void {
    const targetIdentity = getProjectIdentityKey(projectPath);
    for (const [projectId, metadata] of Object.entries(this.state.projects)) {
      if (getProjectIdentityKey(metadata.path) === targetIdentity) {
        delete this.state.projects[projectId];
      }
    }
  }

  private deleteHiddenProjectsByIdentity(projectPath: string): void {
    this.hiddenProjectIdentities = undefined;
    if (!this.state.hiddenProjects) return;
    const targetIdentity = getProjectIdentityKey(projectPath);
    for (const [projectId, metadata] of Object.entries(
      this.state.hiddenProjects,
    )) {
      if (getProjectIdentityKey(metadata.path) === targetIdentity) {
        delete this.state.hiddenProjects[projectId];
      }
    }
  }
}
