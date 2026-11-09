import {
  PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH,
  PUBLIC_SHARE_TITLE_MAX_LENGTH,
  type AppSession,
  type PublicSessionShareMode,
} from "@yep-anywhere/shared";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { enforceOwnerOnlyPathPermissionsStrict } from "../utils/filePermissions.js";
import {
  inspectLegacySessionBody,
  type LegacyPublicShareRecord,
  type LegacySessionBody,
  readLegacyPublicShareRecords,
} from "./LegacyPublicShareReader.js";
import {
  atomicWritePublicShareJson,
  ensurePrivateDirectory,
  publicShareAtomicWriteCommitted,
  removeOwnedAtomicControlTemps,
  syncDirectory,
} from "./PublicSharePrivateStorage.js";
import {
  PublicShareRevisionLimitError,
  PublicShareRevisionRepository,
  type PublicShareCompressedChunk,
  type PublicShareLinkedFileMode,
  type PublicSharePresentation,
  type PublicShareRevision,
  type PublicShareRevisionDescriptor,
  type PublicShareRevisionRepositoryHooks,
  type PublicShareSource,
} from "./PublicShareRevisionRepository.js";

export {
  PUBLIC_SHARE_REVISION_STREAM_CHUNK_MAX_BYTES,
  cowDescriptorRoot,
  digestStoredSessionProjection,
} from "./PublicShareRevisionRepository.js";
export type {
  PublicShareCompressedChunk,
  PublicShareLinkedFileMode,
  PublicSharePresentation,
  PublicShareRevision,
  PublicShareRevisionDescriptor,
  PublicShareSource,
} from "./PublicShareRevisionRepository.js";

export type PublicShareStoreReadiness =
  | "opening"
  | "migrating"
  | "ready"
  | "failed"
  | "disabled";

export type PublicShareRepresentationAvailability =
  | "available"
  | "repair-required";

export interface PublicShareViewerSnapshot {
  capturedAt: string;
  revisionId?: string;
  linkedFileMode?: PublicShareLinkedFileMode;
  snapshotBytes: number;
  availability?: PublicShareRepresentationAvailability;
}

export interface PublicShareGrant {
  version: 2;
  shareId: string;
  secretHash: string;
  publicUrl?: string;
  shareStateId: string;
  mode: PublicSessionShareMode;
  title: string | null;
  initialPrompt: string | null;
  createdAt: string;
  updatedAt: string;
  capturedAt?: string;
  source: PublicShareSource;
  revisionId?: string;
  linkedFileMode?: PublicShareLinkedFileMode;
  snapshotBytes?: number;
  primaryAvailability?: PublicShareRepresentationAvailability;
  repairRequired?: boolean;
  disconnectedViewerIds?: string[];
  viewerSnapshots?: Record<string, PublicShareViewerSnapshot>;
}

export interface PublicShareStoredCapture {
  snapshot: AppSession;
  sourceRevision: string;
  presentation?: PublicSharePresentation;
  projectRoot?: string;
  derivePresentationFromProjectRoot?: (
    projectRoot: string,
  ) => Promise<PublicSharePresentation>;
  validateBeforeAuthority: () => Promise<void>;
}

interface PublicShareGrantFile {
  version: 2;
  grants: PublicShareGrant[];
}

interface PublicShareCleanupJournal {
  version: 1;
  shareStateIds: string[];
}

export interface PublicShareStoreTestHooks
  extends PublicShareRevisionRepositoryHooks {
  legacySessionMaxBytes?: number;
}

export interface CreateStoredGrantOptions {
  secretHash: string;
  publicUrl?: string;
  mode: PublicSessionShareMode;
  title: string | null;
  initialPrompt: string | null;
  source: PublicShareSource;
  capture?: PublicShareStoredCapture;
}

export interface StoredGrantResult {
  grant: PublicShareGrant;
  revision?: PublicShareRevision;
}

export interface FreezeStoredGrantsOptions {
  matches: (grant: PublicShareGrant) => boolean;
  capture: PublicShareStoredCapture;
  viewerId?: string;
}

const EMPTY_GRANT_FILE: PublicShareGrantFile = { version: 2, grants: [] };
const OPAQUE_ID_REGEX = /^[A-Za-z0-9_-]{16,128}$/;
const REVISION_ID_REGEX = /^[A-Za-z0-9_-]{43}$/;
const SECRET_HASH_REGEX = /^[A-Za-z0-9_-]{86}$/;
const VIEWER_ID_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

function sourceMatches(a: PublicShareSource, b: PublicShareSource): boolean {
  return a.projectId === b.projectId && a.sessionId === b.sessionId;
}

export function getPublicShareViewerSnapshot(
  grant: Pick<PublicShareGrant, "viewerSnapshots">,
  viewerId: string | undefined,
): PublicShareViewerSnapshot | undefined {
  const snapshots = grant.viewerSnapshots;
  if (!viewerId || !snapshots) return undefined;
  return Object.getOwnPropertyDescriptor(snapshots, viewerId)?.value;
}

function copyViewerSnapshots(
  snapshots: PublicShareGrant["viewerSnapshots"],
): NonNullable<PublicShareGrant["viewerSnapshots"]> {
  return Object.assign(Object.create(null), snapshots);
}

function isValidGrantText(value: unknown, maxLength: number): boolean {
  return (
    value === null || (typeof value === "string" && value.length <= maxLength)
  );
}

function withDowngradeRepairMarker(grant: PublicShareGrant): PublicShareGrant {
  const repairRequired =
    grant.primaryAvailability === "repair-required" ||
    Object.values(grant.viewerSnapshots ?? {}).some(
      (snapshot) => snapshot.availability === "repair-required",
    );
  if (repairRequired) {
    return grant.repairRequired ? grant : { ...grant, repairRequired: true };
  }
  if (grant.repairRequired === undefined) return grant;
  const { repairRequired: _repairRequired, ...withoutRepairMarker } = grant;
  return withoutRepairMarker;
}

export class PublicShareStore {
  private readonly root: string;
  private readonly legacyPath: string;
  private readonly legacyBackupPath: string;
  private readonly migrationPath: string;
  private readonly grantsPath: string;
  private readonly cleanupPath: string;
  private readonly testHooks: PublicShareStoreTestHooks;
  private readonly revisions: PublicShareRevisionRepository;
  private grants = new Map<string, PublicShareGrant>();
  private cleanupJournal = new Set<string>();
  private readiness: PublicShareStoreReadiness = "opening";
  private readinessError: string | null = null;
  private desiredEnabled = true;
  private disableRequired = false;
  private lifecycleRequest = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private openPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(dataDir: string, testHooks: PublicShareStoreTestHooks = {}) {
    this.testHooks = testHooks;
    this.revisions = new PublicShareRevisionRepository(dataDir, testHooks);
    this.root = path.join(dataDir, "public-shares");
    this.legacyPath = path.join(dataDir, "public-shares.json");
    this.legacyBackupPath = path.join(
      dataDir,
      "public-shares.legacy-backup.json",
    );
    this.migrationPath = path.join(this.root, "migration.json");
    this.grantsPath = path.join(this.root, "grants.json");
    this.cleanupPath = path.join(this.root, "cleanup.json");
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await atomicWritePublicShareJson(filePath, value, this.testHooks);
  }

  getReadiness(): { state: PublicShareStoreReadiness; error: string | null } {
    return { state: this.readiness, error: this.readinessError };
  }

  isCleanupPending(): boolean {
    return this.cleanupJournal.size > 0;
  }

  initialize(enabled = true): Promise<void> {
    return this.requestLifecycle(enabled, !enabled, async (request) => {
      await this.ensureOpened();
      if (enabled) {
        if (this.disableRequired) await this.reconcileDisabled(request);
        if (!this.isCurrentLifecycleRequest(request, true)) return;
        await this.reconcileEnabled(request);
      } else {
        await this.reconcileDisabled(request);
      }
    });
  }

  disable(): Promise<number> {
    return this.requestLifecycle(false, true, async (request) => {
      await this.ensureOpened();
      return await this.reconcileDisabled(request);
    });
  }

  enable(): Promise<void> {
    return this.requestLifecycle(true, false, async (request) => {
      await this.ensureOpened();
      if (this.disableRequired) await this.reconcileDisabled(request);
      if (!this.isCurrentLifecycleRequest(request, true)) return;
      await this.reconcileEnabled(request);
    });
  }

  private requestLifecycle<T>(
    enabled: boolean,
    mustApply: boolean,
    operation: (request: number) => Promise<T>,
  ): Promise<T> {
    this.desiredEnabled = enabled;
    if (!enabled) this.disableRequired = true;
    const request = ++this.lifecycleRequest;
    this.readiness = "opening";
    this.readinessError = null;
    const previous = this.lifecycleTail;
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        if (!mustApply && !this.isCurrentLifecycleRequest(request, enabled)) {
          return undefined as T;
        }
        try {
          return await operation(request);
        } catch (error) {
          this.readiness = "failed";
          this.readinessError =
            error instanceof Error
              ? error.message
              : "Failed to change public share store state";
          throw error;
        }
      });
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isCurrentLifecycleRequest(
    request: number,
    enabled: boolean,
  ): boolean {
    return this.lifecycleRequest === request && this.desiredEnabled === enabled;
  }

  private async ensureOpened(): Promise<void> {
    this.openPromise ??= this.openControlState();
    await this.openPromise;
  }

  private async openControlState(): Promise<void> {
    await ensurePrivateDirectory(this.root);
    await removeOwnedAtomicControlTemps(this.root, [
      "grants.json",
      "cleanup.json",
      "migration.json",
    ]);
    await this.revisions.initialize();
    let grantFile = EMPTY_GRANT_FILE;
    try {
      await enforceOwnerOnlyPathPermissionsStrict(this.grantsPath, "file");
      grantFile = JSON.parse(
        await fs.readFile(this.grantsPath, "utf8"),
      ) as PublicShareGrantFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeJson(this.grantsPath, EMPTY_GRANT_FILE);
    }
    if (
      grantFile.version !== 2 ||
      !Array.isArray(grantFile.grants) ||
      !grantFile.grants.every((grant) => this.isGrant(grant))
    ) {
      throw new Error("Invalid public share grant store");
    }
    const secretHashes = new Set(
      grantFile.grants.map((grant) => grant.secretHash),
    );
    const shareIds = new Set(grantFile.grants.map((grant) => grant.shareId));
    const sourceStates = new Map<string, string>();
    for (const grant of grantFile.grants) {
      const sourceKey = JSON.stringify([
        grant.source.projectId,
        grant.source.sessionId,
      ]);
      const existingState = sourceStates.get(sourceKey);
      if (existingState && existingState !== grant.shareStateId) {
        throw new Error(
          "Public share grants assign one source session to multiple states",
        );
      }
      sourceStates.set(sourceKey, grant.shareStateId);
    }
    if (
      secretHashes.size !== grantFile.grants.length ||
      shareIds.size !== grantFile.grants.length
    ) {
      throw new Error("Duplicate public share grant identifier");
    }
    this.grants = new Map(
      grantFile.grants.map((grant) => [grant.secretHash, grant]),
    );
    await this.loadCleanupJournal();
  }

  private async reconcileDisabled(request: number): Promise<number> {
    return await this.withMutation(async () => {
      await this.writeJson(this.migrationPath, {
        version: 1,
        status: "disabled",
        completedAt: new Date().toISOString(),
        legacyBackup: path.basename(this.legacyBackupPath),
      });
      const revoked = [...this.grants.values()];
      await this.enqueueCleanup(revoked.map((grant) => grant.shareStateId));
      this.grants.clear();
      if (revoked.length > 0) {
        try {
          await this.writeGrants();
        } catch (error) {
          if (!publicShareAtomicWriteCommitted(error)) {
            for (const grant of revoked) {
              this.grants.set(grant.secretHash, grant);
            }
          }
          throw error;
        }
      }
      await this.moveLegacySourceToBackup();
      await this.drainCleanupJournal(false);
      this.disableRequired = false;
      if (this.isCurrentLifecycleRequest(request, false)) {
        this.readiness = "disabled";
        this.readinessError = null;
      }
      return revoked.length;
    });
  }

  private async reconcileEnabled(request: number): Promise<void> {
    await this.withMutation(async () => {
      const migration = await this.readMigrationMarker();
      if (migration?.status === "disabled") {
        await this.finishInterruptedDisable();
        if (!this.isCurrentLifecycleRequest(request, true)) return;
        await this.writeJson(this.migrationPath, {
          version: 1,
          status: "complete",
          completedAt: new Date().toISOString(),
          legacyBackup: (await this.privateFileExists(this.legacyBackupPath))
            ? path.basename(this.legacyBackupPath)
            : null,
        });
      } else {
        await this.drainCleanupJournal(false);
        await this.upgradeGrantAvailability();
        if (!this.isCurrentLifecycleRequest(request, true)) return;
        const legacyExists = await this.privateFileExists(this.legacyPath);
        const backupExists = await this.privateFileExists(
          this.legacyBackupPath,
        );
        if (migration?.status === "complete") {
          if (legacyExists) {
            throw new Error(
              "Legacy public share source remains after completed migration",
            );
          }
          // A completed migration never reads the backup again, but a lost
          // marker would re-migrate from it and restore revoked grants. The
          // migrating reconcile keeps it; a later one that finds the marker
          // already complete (next start or enable) deletes it, best effort.
          // The marker's `legacyBackup` name is history only.
          if (backupExists) {
            await fs
              .rm(this.legacyBackupPath, { force: true })
              .then(() => syncDirectory(path.dirname(this.legacyBackupPath)))
              .catch((error: unknown) =>
                console.warn(
                  "[public-shares] Could not remove the legacy backup",
                  error,
                ),
              );
          }
        } else if (legacyExists || backupExists) {
          this.readiness = "migrating";
          const completed = await this.migrateLegacy(
            legacyExists ? this.legacyPath : this.legacyBackupPath,
            () => this.isCurrentLifecycleRequest(request, true),
          );
          if (!completed) return;
        } else {
          await this.writeJson(this.migrationPath, {
            version: 1,
            status: "complete",
            completedAt: new Date().toISOString(),
            legacyBackup: null,
          });
        }
      }
      await this.drainCleanupJournal(false);
      if (this.isCurrentLifecycleRequest(request, true)) {
        this.readiness = "ready";
        this.readinessError = null;
      }
    });
  }

  private async finishInterruptedDisable(): Promise<void> {
    const revoked = [...this.grants.values()];
    await this.enqueueCleanup(revoked.map((grant) => grant.shareStateId));
    this.grants.clear();
    if (revoked.length > 0) {
      try {
        await this.writeGrants();
      } catch (error) {
        if (!publicShareAtomicWriteCommitted(error)) {
          for (const grant of revoked) {
            this.grants.set(grant.secretHash, grant);
          }
        }
        throw error;
      }
    }
    await this.moveLegacySourceToBackup();
    await this.drainCleanupJournal(true);
  }

  private async moveLegacySourceToBackup(): Promise<void> {
    const legacyExists = await this.privateFileExists(this.legacyPath);
    const backupExists = await this.privateFileExists(this.legacyBackupPath);
    if (!legacyExists) return;
    if (backupExists) {
      throw new Error(
        "Cannot disable public shares while both legacy source and backup exist",
      );
    }
    await fs.rename(this.legacyPath, this.legacyBackupPath);
    await syncDirectory(path.dirname(this.legacyPath));
  }

  private async privateFileExists(filePath: string): Promise<boolean> {
    try {
      await enforceOwnerOnlyPathPermissionsStrict(filePath, "file");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  getAllGrants(): PublicShareGrant[] {
    return [...this.grants.values()];
  }

  getGrantBySecretHash(secretHash: string): PublicShareGrant | null {
    return this.grants.get(secretHash) ?? null;
  }

  async createGrant(
    options: CreateStoredGrantOptions,
  ): Promise<StoredGrantResult> {
    return await this.withMutation(async () => {
      this.assertReady();
      if (this.grants.has(options.secretHash)) {
        throw new Error("Public share secret hash is already in use");
      }
      if (
        !isValidGrantText(options.title, PUBLIC_SHARE_TITLE_MAX_LENGTH) ||
        !isValidGrantText(
          options.initialPrompt,
          PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH,
        )
      ) {
        throw new Error("Public share grant text is invalid");
      }
      const now = new Date().toISOString();
      const matchingGrant = [...this.grants.values()].find((grant) =>
        sourceMatches(grant.source, options.source),
      );
      const shareStateId =
        matchingGrant?.shareStateId ?? randomBytes(16).toString("base64url");
      let revision: PublicShareRevision | undefined;
      await this.enqueueCleanup([shareStateId]);
      try {
        if (options.mode === "frozen") {
          if (!options.capture) {
            throw new Error("Frozen shares require a complete session capture");
          }
          revision = await this.revisions.commitRevision({
            shareStateId,
            source: options.source,
            snapshot: options.capture.snapshot,
            sourceRevision: options.capture.sourceRevision,
            presentation: options.capture.presentation,
            projectRoot: options.capture.projectRoot,
            derivePresentationFromProjectRoot:
              options.capture.derivePresentationFromProjectRoot,
            capturedAt: now,
          });
          await options.capture.validateBeforeAuthority();
        } else {
          await this.revisions.ensureState(shareStateId, options.source, now);
        }
      } catch (error) {
        await this.drainCleanupJournal(false);
        throw error;
      }

      const grant: PublicShareGrant = {
        version: 2,
        shareId: randomBytes(12).toString("base64url"),
        secretHash: options.secretHash,
        ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
        shareStateId,
        mode: options.mode,
        title: options.title,
        initialPrompt: options.initialPrompt,
        createdAt: now,
        updatedAt: now,
        ...(revision
          ? {
              capturedAt: revision.capturedAt,
              revisionId: revision.revisionId,
              linkedFileMode: revision.linkedFileMode,
              snapshotBytes: revision.snapshotBytes,
              primaryAvailability: "available" as const,
            }
          : {}),
        source: options.source,
      };
      this.grants.set(grant.secretHash, grant);
      try {
        await this.writeGrants();
      } catch (error) {
        if (!publicShareAtomicWriteCommitted(error)) {
          this.grants.delete(grant.secretHash);
        }
        await this.drainCleanupJournal(false);
        throw error;
      }
      await this.drainCleanupJournal(false);
      return { grant, revision };
    });
  }

  async revokeMatching(
    matches: (grant: PublicShareGrant) => boolean,
  ): Promise<PublicShareGrant[]> {
    return await this.withMutation(async () => {
      this.assertReady();
      const revoked = [...this.grants.values()].filter(matches);
      if (revoked.length === 0) return [];
      await this.enqueueCleanup(revoked.map((grant) => grant.shareStateId));
      for (const grant of revoked) {
        this.grants.delete(grant.secretHash);
      }
      try {
        await this.writeGrants();
      } catch (error) {
        if (!publicShareAtomicWriteCommitted(error)) {
          for (const grant of revoked) {
            this.grants.set(grant.secretHash, grant);
          }
        }
        throw error;
      } finally {
        await this.drainCleanupJournal(false);
      }
      return revoked;
    });
  }

  async freezeMatching(
    options: FreezeStoredGrantsOptions,
  ): Promise<PublicShareGrant[]> {
    return await this.withMutation(async () => {
      this.assertReady();
      const matching = [...this.grants.values()].filter(
        (grant) => grant.mode === "live" && options.matches(grant),
      );
      if (matching.length === 0) return [];
      const first = matching[0]!;
      const now = new Date().toISOString();
      await this.enqueueCleanup([first.shareStateId]);
      let revision: PublicShareRevision;
      try {
        revision = await this.revisions.commitRevision({
          shareStateId: first.shareStateId,
          source: first.source,
          snapshot: options.capture.snapshot,
          sourceRevision: options.capture.sourceRevision,
          presentation: options.capture.presentation,
          projectRoot: options.capture.projectRoot,
          derivePresentationFromProjectRoot:
            options.capture.derivePresentationFromProjectRoot,
          capturedAt: now,
        });
        await options.capture.validateBeforeAuthority();
      } catch (error) {
        await this.drainCleanupJournal(false);
        throw error;
      }
      const previous = new Map(
        matching.map((grant) => [grant.secretHash, grant]),
      );
      for (const grant of matching) {
        const updated: PublicShareGrant = options.viewerId
          ? {
              ...grant,
              updatedAt: now,
              viewerSnapshots: {
                ...grant.viewerSnapshots,
                [options.viewerId]: {
                  capturedAt: now,
                  revisionId: revision.revisionId,
                  linkedFileMode: revision.linkedFileMode,
                  snapshotBytes: revision.snapshotBytes,
                  availability: "available",
                },
              },
            }
          : {
              ...grant,
              mode: "frozen",
              updatedAt: now,
              capturedAt: now,
              revisionId: revision.revisionId,
              linkedFileMode: revision.linkedFileMode,
              snapshotBytes: revision.snapshotBytes,
              primaryAvailability: "available",
              repairRequired: undefined,
              viewerSnapshots: undefined,
            };
        this.grants.set(updated.secretHash, updated);
      }
      try {
        await this.writeGrants();
      } catch (error) {
        if (!publicShareAtomicWriteCommitted(error)) {
          for (const [secretHash, grant] of previous) {
            this.grants.set(secretHash, grant);
          }
        }
        await this.drainCleanupJournal(false);
        throw error;
      }
      await this.drainCleanupJournal(false);
      return matching.map((grant) => this.grants.get(grant.secretHash)!);
    });
  }

  async disconnectViewer(
    matches: (grant: PublicShareGrant) => boolean,
    viewerId: string,
  ): Promise<boolean> {
    return await this.withMutation(async () => {
      this.assertReady();
      const matching = [...this.grants.values()].filter(matches);
      const updates = new Map<string, PublicShareGrant>();
      for (const grant of matching) {
        const disconnectedViewerIds = new Set(
          grant.disconnectedViewerIds ?? [],
        );
        const hadViewer = disconnectedViewerIds.has(viewerId);
        disconnectedViewerIds.add(viewerId);
        const remainingSnapshots = copyViewerSnapshots(grant.viewerSnapshots);
        const removed =
          Object.getOwnPropertyDescriptor(remainingSnapshots, viewerId) !==
          undefined;
        delete remainingSnapshots[viewerId];
        if (!hadViewer || removed) {
          updates.set(grant.secretHash, {
            ...grant,
            disconnectedViewerIds: [...disconnectedViewerIds],
            viewerSnapshots:
              Object.keys(remainingSnapshots).length > 0
                ? remainingSnapshots
                : undefined,
          });
        }
      }
      if (updates.size === 0) return false;
      await this.enqueueCleanup(matching.map((grant) => grant.shareStateId));
      for (const [secretHash, grant] of updates) {
        this.grants.set(secretHash, grant);
      }
      try {
        await this.writeGrants();
      } catch (error) {
        if (!publicShareAtomicWriteCommitted(error)) {
          for (const grant of matching) {
            this.grants.set(grant.secretHash, grant);
          }
        }
        throw error;
      } finally {
        await this.drainCleanupJournal(false);
      }
      return true;
    });
  }

  getRevisionDirectory(grant: PublicShareGrant, revisionId: string): string {
    return this.revisions.getRevisionDirectory(grant, revisionId);
  }

  async getRevisionDescriptor(
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<PublicShareRevisionDescriptor | null> {
    return await this.revisions.getRevisionDescriptor(grant, revisionId);
  }

  async readRevisionCompressedChunk(
    grant: PublicShareGrant,
    revisionId: string,
    offset: number,
    maxBytes: number,
  ): Promise<PublicShareCompressedChunk> {
    return await this.revisions.readRevisionCompressedChunk(
      grant,
      revisionId,
      offset,
      maxBytes,
    );
  }

  async getRevisionSessionStream(
    grant: PublicShareGrant,
    revisionId: string,
  ): ReturnType<PublicShareRevisionRepository["getRevisionSessionStream"]> {
    return await this.revisions.getRevisionSessionStream(grant, revisionId);
  }

  async getRevisionSessionChunks(
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<AsyncIterable<Uint8Array>> {
    return await this.revisions.getRevisionSessionChunks(grant, revisionId);
  }

  async readRevisionSession(
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<AppSession> {
    return await this.revisions.readRevisionSession(grant, revisionId);
  }

  async readPresentation(
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<PublicSharePresentation> {
    return await this.revisions.readPresentation(grant, revisionId);
  }

  async getRevisionProjectRoot(
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<string> {
    return await this.revisions.getRevisionProjectRoot(grant, revisionId);
  }

  private async loadCleanupJournal(): Promise<void> {
    let journal: PublicShareCleanupJournal;
    try {
      await enforceOwnerOnlyPathPermissionsStrict(this.cleanupPath, "file");
      journal = JSON.parse(
        await fs.readFile(this.cleanupPath, "utf8"),
      ) as PublicShareCleanupJournal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journal = { version: 1, shareStateIds: [] };
      await this.writeJson(this.cleanupPath, journal);
    }
    if (
      journal.version !== 1 ||
      !Array.isArray(journal.shareStateIds) ||
      !journal.shareStateIds.every(
        (shareStateId) =>
          typeof shareStateId === "string" &&
          OPAQUE_ID_REGEX.test(shareStateId),
      )
    ) {
      throw new Error("Invalid public share cleanup journal");
    }
    this.cleanupJournal = new Set(journal.shareStateIds);
  }

  private async replaceCleanupJournal(candidate: Set<string>): Promise<void> {
    try {
      await this.writeJson(this.cleanupPath, {
        version: 1,
        shareStateIds: [...candidate].sort(),
      } satisfies PublicShareCleanupJournal);
      this.cleanupJournal = candidate;
    } catch (error) {
      if (publicShareAtomicWriteCommitted(error))
        this.cleanupJournal = candidate;
      throw error;
    }
  }

  private async enqueueCleanup(shareStateIds: string[]): Promise<void> {
    const candidate = new Set(this.cleanupJournal);
    for (const shareStateId of shareStateIds) candidate.add(shareStateId);
    if (candidate.size !== this.cleanupJournal.size) {
      await this.replaceCleanupJournal(candidate);
    }
  }

  private async drainCleanupJournal(required: boolean): Promise<void> {
    const pendingShareStateIds = Array.from(this.cleanupJournal);
    for (const shareStateId of pendingShareStateIds) {
      try {
        await this.collectUnreferenced(shareStateId);
        const candidate = new Set(this.cleanupJournal);
        candidate.delete(shareStateId);
        await this.replaceCleanupJournal(candidate);
      } catch (error) {
        if (required) throw error;
      }
    }
    if (required && this.cleanupJournal.size > 0) {
      throw new Error("Public share cleanup remains pending");
    }
  }

  private async collectUnreferenced(shareStateId: string): Promise<void> {
    const remaining = [...this.grants.values()].filter(
      (grant) => grant.shareStateId === shareStateId,
    );
    if (remaining.length === 0) {
      await this.revisions.collectUnreferenced(shareStateId, null);
      return;
    }

    const referencedRevisionIds = new Set<string>();
    for (const grant of remaining) {
      if (grant.revisionId) referencedRevisionIds.add(grant.revisionId);
      for (const snapshot of Object.values(grant.viewerSnapshots ?? {})) {
        if (snapshot.revisionId) {
          referencedRevisionIds.add(snapshot.revisionId);
        }
      }
    }
    await this.revisions.collectUnreferenced(
      shareStateId,
      referencedRevisionIds,
    );
  }

  private async upgradeGrantAvailability(): Promise<void> {
    let changed = false;
    for (const grant of this.grants.values()) {
      let primaryAvailability = grant.primaryAvailability;
      if (grant.revisionId && primaryAvailability === undefined) {
        primaryAvailability = await this.inspectRevisionAvailability(
          grant,
          grant.revisionId,
        );
      }
      const viewerSnapshots = Object.fromEntries(
        await Promise.all(
          Object.entries(grant.viewerSnapshots ?? {}).map(
            async ([viewerId, snapshot]) => [
              viewerId,
              snapshot.availability === undefined
                ? {
                    ...snapshot,
                    availability: snapshot.revisionId
                      ? await this.inspectRevisionAvailability(
                          grant,
                          snapshot.revisionId,
                        )
                      : "repair-required",
                  }
                : snapshot,
            ],
          ),
        ),
      );
      const upgraded = withDowngradeRepairMarker({
        ...grant,
        ...(primaryAvailability ? { primaryAvailability } : {}),
        ...(Object.keys(viewerSnapshots).length > 0 ? { viewerSnapshots } : {}),
      });
      if (JSON.stringify(upgraded) !== JSON.stringify(grant)) {
        this.grants.set(upgraded.secretHash, upgraded);
        changed = true;
      }
    }
    if (changed) await this.writeGrants();
  }

  private async inspectRevisionAvailability(
    grant: PublicShareGrant,
    revisionId: string,
  ): Promise<PublicShareRepresentationAvailability> {
    const inspection = await inspectLegacySessionBody(
      await this.getRevisionSessionStream(grant, revisionId),
    );
    return inspection.repairRequired ? "repair-required" : "available";
  }

  private async readMigrationMarker(): Promise<{
    status: "complete" | "disabled";
  } | null> {
    try {
      await enforceOwnerOnlyPathPermissionsStrict(this.migrationPath, "file");
      const value = JSON.parse(
        await fs.readFile(this.migrationPath, "utf8"),
      ) as { version?: unknown; status?: unknown };
      if (
        value.version !== 1 ||
        (value.status !== "complete" && value.status !== "disabled")
      ) {
        throw new Error("Invalid public share migration marker");
      }
      return { status: value.status };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async migrateLegacy(
    sourcePath: string,
    shouldContinue: () => boolean,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const sourceBytes = (await fs.stat(sourcePath)).size;
    let peakHeapUsedBytes = process.memoryUsage().heapUsed;
    const temporaryDirectory = path.join(this.root, ".migration-work");
    await fs.rm(temporaryDirectory, { recursive: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await ensurePrivateDirectory(temporaryDirectory);
    let recordCount = 0;
    let migratedBodyBytes = 0;
    try {
      for await (const record of readLegacyPublicShareRecords(
        sourcePath,
        temporaryDirectory,
        this.testHooks.legacySessionMaxBytes,
      )) {
        if (!shouldContinue()) return false;
        const result = await this.importLegacyRecord(record);
        recordCount += 1;
        migratedBodyBytes += result.bodyBytes;
        peakHeapUsedBytes = Math.max(
          peakHeapUsedBytes,
          process.memoryUsage().heapUsed,
        );
        for (const body of [
          record.frozenSession,
          ...Object.values(record.viewerSnapshots ?? {}).map(
            (snapshot) => snapshot.body,
          ),
        ]) {
          if (body?.filePath) {
            await fs.rm(body.filePath).catch(() => undefined);
          }
        }
      }
      if (!shouldContinue()) return false;
      if (sourcePath === this.legacyPath) {
        const backupAlreadyExists = await fs
          .stat(this.legacyBackupPath)
          .then(() => true)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return false;
            throw error;
          });
        if (backupAlreadyExists) {
          throw new Error(
            "Legacy public share backup already exists before migration rename",
          );
        }
        await fs.rename(this.legacyPath, this.legacyBackupPath);
        await enforceOwnerOnlyPathPermissionsStrict(
          this.legacyBackupPath,
          "file",
        );
        await syncDirectory(path.dirname(this.legacyPath));
      }
      await this.writeJson(this.migrationPath, {
        version: 1,
        status: "complete",
        completedAt: new Date().toISOString(),
        legacyBackup: path.basename(this.legacyBackupPath),
        recordCount,
        sourceByteOffset: sourceBytes,
        sourceBytes,
        migratedBodyBytes,
        elapsedMs: Date.now() - startedAt,
        peakHeapUsedBytes,
      });
      console.log(
        `[public-shares] Migrated ${recordCount} legacy grant(s), ${sourceBytes}/${sourceBytes} source byte(s), ${migratedBodyBytes} body byte(s), peak heap ${peakHeapUsedBytes} byte(s) in ${Date.now() - startedAt}ms`,
      );
      return true;
    } finally {
      await fs
        .rm(temporaryDirectory, { recursive: true })
        .catch(() => undefined);
    }
  }

  private async importLegacyRecord(
    record: LegacyPublicShareRecord,
  ): Promise<{ bodyBytes: number }> {
    const existing = this.grants.get(record.secretHash);
    if (existing) {
      if (
        existing.mode !== record.mode ||
        !sourceMatches(existing.source, record.source)
      ) {
        throw new Error(
          "Conflicting migrated public share grant for an existing secret hash",
        );
      }
      return { bodyBytes: 0 };
    }
    const matchingGrant = [...this.grants.values()].find((grant) =>
      sourceMatches(grant.source, record.source),
    );
    const shareStateId =
      matchingGrant?.shareStateId ?? randomBytes(16).toString("base64url");
    await this.enqueueCleanup([shareStateId]);
    let bodyBytes = 0;
    const importBody = async (
      body: LegacySessionBody,
      capturedAt: string,
    ): Promise<{
      revision?: PublicShareRevision;
      availability: PublicShareRepresentationAvailability;
    }> => {
      bodyBytes += body.snapshotBytes;
      if (body.oversized || !body.filePath) {
        await this.revisions.ensureState(
          shareStateId,
          record.source,
          capturedAt,
        );
        return { availability: "repair-required" };
      }
      const inspection = await inspectLegacySessionBody(body.filePath);
      try {
        return {
          revision: await this.revisions.commitLegacyRevision({
            shareStateId,
            source: record.source,
            bodyPath: body.filePath,
            capturedAt,
          }),
          availability: inspection.repairRequired
            ? "repair-required"
            : "available",
        };
      } catch (error) {
        if (error instanceof PublicShareRevisionLimitError) {
          return { availability: "repair-required" };
        }
        throw error;
      }
    };

    let primaryRevision: PublicShareRevision | undefined;
    let primaryAvailability: PublicShareRepresentationAvailability | undefined;
    if (record.frozenSession) {
      const imported = await importBody(
        record.frozenSession,
        record.capturedAt ?? record.updatedAt,
      );
      primaryRevision = imported.revision;
      primaryAvailability = imported.availability;
    } else {
      await this.revisions.ensureState(
        shareStateId,
        record.source,
        record.createdAt,
      );
    }
    const viewerSnapshots = copyViewerSnapshots(undefined);
    for (const [viewerId, snapshot] of Object.entries(
      record.viewerSnapshots ?? {},
    )) {
      const imported = await importBody(snapshot.body, snapshot.capturedAt);
      viewerSnapshots[viewerId] = {
        capturedAt: snapshot.capturedAt,
        snapshotBytes: snapshot.body.snapshotBytes,
        availability: imported.availability,
        ...(imported.revision
          ? {
              revisionId: imported.revision.revisionId,
              linkedFileMode: "live" as const,
            }
          : {}),
      };
    }
    const grant: PublicShareGrant = withDowngradeRepairMarker({
      version: 2,
      shareId: randomBytes(12).toString("base64url"),
      secretHash: record.secretHash,
      shareStateId,
      mode: record.mode,
      title: record.title ?? null,
      initialPrompt: null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      capturedAt: record.capturedAt,
      source: record.source,
      disconnectedViewerIds: record.disconnectedViewerIds,
      ...(primaryRevision
        ? {
            revisionId: primaryRevision.revisionId,
            linkedFileMode: "live" as const,
            snapshotBytes: primaryRevision.snapshotBytes,
          }
        : record.frozenSession && primaryAvailability === "repair-required"
          ? { snapshotBytes: record.frozenSession.snapshotBytes }
          : {}),
      ...(primaryAvailability ? { primaryAvailability } : {}),
      ...(Object.keys(viewerSnapshots).length > 0 ? { viewerSnapshots } : {}),
    });
    this.grants.set(grant.secretHash, grant);
    try {
      await this.writeGrants();
    } catch (error) {
      if (!publicShareAtomicWriteCommitted(error)) {
        this.grants.delete(grant.secretHash);
      }
      await this.drainCleanupJournal(false);
      throw error;
    }
    await this.drainCleanupJournal(false);
    return { bodyBytes };
  }

  private async writeGrants(): Promise<void> {
    const grants = [...this.grants.values()].map(withDowngradeRepairMarker);
    const candidate = new Map(grants.map((grant) => [grant.secretHash, grant]));
    try {
      await this.writeJson(this.grantsPath, {
        version: 2,
        grants,
      } satisfies PublicShareGrantFile);
      this.grants = candidate;
    } catch (error) {
      if (publicShareAtomicWriteCommitted(error)) this.grants = candidate;
      throw error;
    }
  }

  private assertReady(): void {
    if (this.readiness !== "ready") {
      throw new Error(`Public share store is ${this.readiness}`);
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private isGrant(value: unknown): value is PublicShareGrant {
    if (!value || typeof value !== "object") return false;
    const grant = value as Partial<PublicShareGrant>;
    return (
      grant.version === 2 &&
      typeof grant.shareId === "string" &&
      OPAQUE_ID_REGEX.test(grant.shareId) &&
      typeof grant.secretHash === "string" &&
      SECRET_HASH_REGEX.test(grant.secretHash) &&
      (grant.publicUrl === undefined ||
        (typeof grant.publicUrl === "string" &&
          grant.publicUrl.length <= 4096 &&
          URL.canParse(grant.publicUrl))) &&
      typeof grant.shareStateId === "string" &&
      OPAQUE_ID_REGEX.test(grant.shareStateId) &&
      (grant.mode === "live" || grant.mode === "frozen") &&
      isValidGrantText(grant.title, PUBLIC_SHARE_TITLE_MAX_LENGTH) &&
      isValidGrantText(
        grant.initialPrompt,
        PUBLIC_SHARE_INITIAL_PROMPT_MAX_LENGTH,
      ) &&
      typeof grant.createdAt === "string" &&
      typeof grant.updatedAt === "string" &&
      !!grant.source &&
      typeof grant.source.projectId === "string" &&
      typeof grant.source.sessionId === "string" &&
      (grant.revisionId === undefined ||
        (typeof grant.revisionId === "string" &&
          REVISION_ID_REGEX.test(grant.revisionId))) &&
      (grant.mode === "live" ||
        typeof grant.revisionId === "string" ||
        (grant.primaryAvailability === "repair-required" &&
          grant.revisionId === undefined &&
          grant.linkedFileMode === undefined &&
          Number.isSafeInteger(grant.snapshotBytes) &&
          grant.snapshotBytes! >= 0)) &&
      (grant.linkedFileMode === undefined ||
        grant.linkedFileMode === "cow" ||
        grant.linkedFileMode === "live") &&
      (grant.snapshotBytes === undefined ||
        (Number.isSafeInteger(grant.snapshotBytes) &&
          grant.snapshotBytes >= 0)) &&
      (grant.primaryAvailability === undefined ||
        grant.primaryAvailability === "available" ||
        grant.primaryAvailability === "repair-required") &&
      (grant.repairRequired === undefined || grant.repairRequired === true) &&
      (grant.disconnectedViewerIds === undefined ||
        (Array.isArray(grant.disconnectedViewerIds) &&
          grant.disconnectedViewerIds.every(
            (viewerId) =>
              typeof viewerId === "string" && VIEWER_ID_REGEX.test(viewerId),
          ))) &&
      (grant.viewerSnapshots === undefined ||
        (!!grant.viewerSnapshots &&
          typeof grant.viewerSnapshots === "object" &&
          !Array.isArray(grant.viewerSnapshots) &&
          Object.entries(grant.viewerSnapshots).every(
            ([viewerId, snapshot]) =>
              VIEWER_ID_REGEX.test(viewerId) &&
              !!snapshot &&
              typeof snapshot.capturedAt === "string" &&
              Number.isSafeInteger(snapshot.snapshotBytes) &&
              snapshot.snapshotBytes >= 0 &&
              (snapshot.availability === undefined ||
                snapshot.availability === "available" ||
                snapshot.availability === "repair-required") &&
              ((typeof snapshot.revisionId === "string" &&
                REVISION_ID_REGEX.test(snapshot.revisionId) &&
                (snapshot.linkedFileMode === "cow" ||
                  snapshot.linkedFileMode === "live")) ||
                (snapshot.availability === "repair-required" &&
                  snapshot.revisionId === undefined &&
                  snapshot.linkedFileMode === undefined)),
          )))
    );
  }
}
