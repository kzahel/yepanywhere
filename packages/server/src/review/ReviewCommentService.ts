/**
 * ReviewCommentService — canonical source-review sites, entries, and drafts.
 *
 * Disk state is version 2 even though the established comments endpoint still
 * receives a version-1 projection. Version-1 files migrate before any later
 * write, preserving all comments and batches while marking their unavailable
 * comment-time source captures honestly.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_RESPONSE_FILE_BYTES,
  MAX_REVIEW_SUBMISSION_NAME_LENGTH,
  REVIEW_SUBMISSION_REQUEST_VERSION,
  type ReviewBatch,
  type ReviewCapture,
  type ReviewComment,
  type ReviewCommentAnchor,
  type ReviewCommentsFile,
  type ReviewEntryRef,
  type ReviewReviewerEntry,
  type ReviewSourceProjection,
  type ReviewStoreFile,
  type ReviewSubmissionRelocation,
  type ReviewSubmissionRequest,
  type ReviewSubmissionResponse,
  type ReviewSubmissionSummary,
  emptyReviewStoreFile,
  parseReviewStoreFile,
  parseReviewSubmissionRequest,
  parseReviewSubmissionResponse,
  projectLegacyReviewComments,
} from "@yep-anywhere/shared";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";
import { HttpError } from "../middleware/error-handler.js";
import { getDataDir } from "../config.js";
import {
  ProjectStoragePolicy,
  type ProjectStorageTransitionParticipant,
} from "../projects/projectStoragePolicy.js";
import type { ProjectDirectoryStorage } from "../services/ServerSettingsService.js";
import { syncDirectory } from "../utils/syncDirectory.js";

const REVIEW_COMMENTS_FILENAME = "review-comments.json";
const SOURCE_REVIEW_DIR = "source-review";
const REQUEST_FILENAME = "request.json";
const RESPONSE_FILENAME = "response.json";
const DEFAULT_MAX_RETAINED_STORE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RETAINED_STORE_AGE_MS = 10 * 60 * 1000;
const REVIEW_STORAGE_METADATA_VERSION = 1;
const REVIEW_STORAGE_METADATA_KEY = "yaStorage";

interface ReviewStorageMetadata {
  version: typeof REVIEW_STORAGE_METADATA_VERSION;
  logicalRevision: number;
  stateSha256: string;
}

interface PersistedReviewStore extends ReviewStoreFile {
  [REVIEW_STORAGE_METADATA_KEY]: ReviewStorageMetadata;
}

interface LoadedReviewStore {
  state: ReviewStoreFile;
  logicalRevision: number;
  stateSha256: string;
  sourcePath: string;
}

interface LoadedSubmissionRequest {
  request: ReviewSubmissionRequest;
  sourcePath: string;
  bytes: Buffer;
}

class InvalidSubmissionRequestError extends HttpError {
  constructor() {
    super(409, "Submission request manifest is invalid");
    this.name = "InvalidSubmissionRequestError";
  }
}

class ReviewStorageConflictError extends HttpError {
  constructor() {
    super(
      409,
      "Source Review state has conflicting copies at the same logical revision",
    );
    this.name = "ReviewStorageConflictError";
  }
}

interface ProjectStore {
  projectPath: string;
  state: ReviewStoreFile;
  logicalRevision: number;
  hasPersistedState: boolean;
  loadPromise: Promise<void> | null;
  loaded: boolean;
  save: () => Promise<void>;
  mutationTail: Promise<void>;
  /** Mutations and saves in flight; a store is releasable only at zero. */
  activeOperations: number;
  /** A rejected write makes the in-memory state unsafe to reuse. */
  writeFailed: boolean;
  writeFailure: unknown;
  lastAccessMs: number;
  estimatedBytes: number;
}

export interface ReviewCaptureWriter {
  capture(
    projectPath: string,
    projection: ReviewSourceProjection,
  ): Promise<ReviewCapture>;
}

export interface AddReviewCommentInput {
  anchor: ReviewCommentAnchor;
  text: string;
}

export interface UpdateReviewCommentInput {
  text?: string;
  anchor?: ReviewCommentAnchor;
}

export interface AddReviewFollowUpInput {
  anchor: ReviewCommentAnchor;
  text: string;
}

export interface ArchiveReviewCommentsInput {
  commentIds: string[];
  targetSessionId: string;
  /** Defaults to now; injectable for deterministic tests. */
  submittedAt?: string;
}

export interface PrepareReviewSubmissionInput {
  submissionId: string;
  name?: string;
  commentIds: string[];
  requestedTarget: "new" | string;
  relocations: Map<string, ReviewSubmissionRelocation>;
}

export interface AcceptReviewSubmissionInput {
  submissionId: string;
  targetSessionId?: string;
  responseTurnLimit: number;
  deliveryStatus: "queued" | "delivered";
}

export type ReviewResponseReadStatus =
  | "missing"
  | "invalid"
  | "unchanged"
  | "ingested";

/** Deps let tests stub the clock, ids, and git capture boundary. */
export interface ReviewCommentServiceOptions {
  now?: () => string;
  newId?: () => string;
  captureWriter?: ReviewCaptureWriter;
  storagePolicy?: ProjectStoragePolicy;
  /** Projects whose durable mutable state must be preflighted before a toggle. */
  listProjectPaths?: () => Promise<string[]>;
  /** Byte budget for retained clean project stores. */
  maxRetainedStoreBytes?: number;
  /** Release a clean store untouched for this long even when under budget. */
  maxRetainedStoreAgeMs?: number;
  monotonicNowMs?: () => number;
}

export interface ReviewStoreRetentionMetrics {
  retainedStores: number;
  retainedBytes: number;
  releases: number;
  releasesByAge: number;
  protectedSkips: number;
  reloadsAfterRelease: number;
  /** Bumped by every accepted mutation; source version for projections. */
  stateRevision: number;
}

export class ReviewCommentService
  implements ProjectStorageTransitionParticipant
{
  private stores = new Map<string, ProjectStore>();
  private now: () => string;
  private newId: () => string;
  private captureWriter?: ReviewCaptureWriter;
  private storagePolicy: ProjectStoragePolicy;
  private readonly listProjectPaths: () => Promise<string[]>;
  private readonly maxRetainedStoreBytes: number;
  private readonly maxRetainedStoreAgeMs: number;
  private readonly monotonicNowMs: () => number;
  private retainedBytes = 0;
  private stateRevision = 0;
  private releases = 0;
  private releasesByAge = 0;
  private protectedSkips = 0;
  private reloadsAfterRelease = 0;
  private releasedKeys = new Set<string>();
  private activeStorageOperations = 0;
  private storageOperationsDrained: Promise<void> = Promise.resolve();
  private resolveStorageOperationsDrained: (() => void) | null = null;
  private storageTransitionBarrier: Promise<void> | null = null;

  constructor(options: ReviewCommentServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
    this.captureWriter = options.captureWriter;
    this.maxRetainedStoreBytes = Math.max(
      0,
      options.maxRetainedStoreBytes ?? DEFAULT_MAX_RETAINED_STORE_BYTES,
    );
    this.maxRetainedStoreAgeMs = Math.max(
      0,
      options.maxRetainedStoreAgeMs ?? DEFAULT_MAX_RETAINED_STORE_AGE_MS,
    );
    this.monotonicNowMs = options.monotonicNowMs ?? Date.now;
    this.storagePolicy =
      options.storagePolicy ??
      new ProjectStoragePolicy({
        dataDir: getDataDir(),
        getMode: () => "app-data",
      });
    this.listProjectPaths = options.listProjectPaths ?? (async () => []);
  }

  /** Stable version-1 projection for established clients. */
  async getFile(projectPath: string): Promise<ReviewCommentsFile> {
    return this.withStorageOperation(async () => {
      const store = await this.getStore(projectPath);
      return cloneLegacyFile(projectLegacyReviewComments(store.state));
    });
  }

  /** Canonical site/entry/submission state for new routes. */
  async getStoreFile(projectPath: string): Promise<ReviewStoreFile> {
    return this.withStorageOperation(async () => {
      const store = await this.getStore(projectPath);
      return cloneStoreFile(store.state);
    });
  }

  async listComments(projectPath: string): Promise<ReviewComment[]> {
    return (await this.getFile(projectPath)).comments;
  }

  async listPending(projectPath: string): Promise<ReviewComment[]> {
    return (await this.listComments(projectPath)).filter(
      (comment) => comment.status === "pending",
    );
  }

  async getComment(
    projectPath: string,
    id: string,
  ): Promise<ReviewComment | null> {
    return (
      (await this.listComments(projectPath)).find((item) => item.id === id) ??
      null
    );
  }

  async addComment(
    projectPath: string,
    input: AddReviewCommentInput,
  ): Promise<ReviewComment> {
    return this.withMutation(projectPath, async (store) => {
      if (store.state.drafts.length >= MAX_REVIEW_COMMENTS) {
        throw new HttpError(
          413,
          `Review comment limit reached (${MAX_REVIEW_COMMENTS}); submit or delete drafts first.`,
        );
      }
      const entryId = this.newId();
      const siteId = `site-${entryId}`;
      const createdAt = this.now();
      const entry: ReviewReviewerEntry = {
        id: entryId,
        anchor: cloneAnchor(input.anchor),
        text: input.text,
        capture: await this.capture(projectPath, input.anchor),
        createdAt,
      };
      store.state.sites.push({
        id: siteId,
        path: input.anchor.path,
        createdAt,
        entries: [entry],
        outcomes: [],
      });
      store.state.drafts.push({ siteId, entryId });
      await store.save();
      return canonicalEntryToComment(entry, true);
    });
  }

  /** Edit an active draft. Submitted reviewer entries are immutable. */
  async updateComment(
    projectPath: string,
    id: string,
    patch: UpdateReviewCommentInput,
  ): Promise<ReviewComment | null> {
    return this.withMutation(projectPath, async (store) => {
      const found = findDraftEntry(store.state, id);
      if (!found) return null;
      const nextCapture = patch.anchor
        ? await this.capture(projectPath, patch.anchor)
        : undefined;
      if (patch.text !== undefined) found.entry.text = patch.text;
      if (patch.anchor !== undefined && nextCapture) {
        found.entry.anchor = cloneAnchor(patch.anchor);
        found.entry.capture = nextCapture;
        found.site.path = patch.anchor.path;
      }
      await store.save();
      return canonicalEntryToComment(found.entry, true);
    });
  }

  /** Discard an active draft. Historical submitted entries are retained. */
  async deleteComment(projectPath: string, id: string): Promise<boolean> {
    return this.withMutation(projectPath, async (store) => {
      const draftIndex = store.state.drafts.findIndex(
        (ref) => ref.entryId === id,
      );
      if (draftIndex === -1) return false;
      const [draft] = store.state.drafts.splice(draftIndex, 1);
      const site = store.state.sites.find((item) => item.id === draft?.siteId);
      if (site) {
        site.entries = site.entries.filter((entry) => entry.id !== id);
        if (site.entries.length === 0 && site.outcomes.length === 0) {
          store.state.sites = store.state.sites.filter(
            (item) => item.id !== site.id,
          );
        }
      }
      await store.save();
      return true;
    });
  }

  /**
   * Compatibility archive path. New transactional acceptance builds the same
   * canonical summary with a client-supplied id in the next stage.
   */
  async archiveComments(
    projectPath: string,
    input: ArchiveReviewCommentsInput,
  ): Promise<ReviewBatch> {
    return this.withMutation(projectPath, async (store) => {
      const submittedAt = input.submittedAt ?? this.now();
      const batchId = this.newId();
      const requested = new Set(input.commentIds);
      const consumed: string[] = [];
      const entryRefs: ReviewEntryRef[] = [];

      for (let index = store.state.drafts.length - 1; index >= 0; index--) {
        const ref = store.state.drafts[index];
        if (!ref || !requested.has(ref.entryId)) continue;
        const found = findEntry(store.state, ref);
        if (!found) continue;
        found.entry.submittedAt = submittedAt;
        found.entry.submissionId = batchId;
        consumed.unshift(ref.entryId);
        entryRefs.unshift({ ...ref });
        store.state.drafts.splice(index, 1);
      }

      const summary: ReviewSubmissionSummary = {
        id: batchId,
        submittedAt,
        requestedTarget: input.targetSessionId,
        targetSessionId: input.targetSessionId,
        entryRefs,
        status: "legacy",
        responseRevision: 0,
        acknowledgedRevision: 0,
      };
      store.state.submissions.push(summary);
      await store.save();
      return {
        id: batchId,
        submittedAt,
        targetSessionId: input.targetSessionId,
        commentIds: consumed,
      };
    });
  }

  /**
   * Reserve draft entries and freeze their immutable request manifest. Existing
   * manifests bind an id to the same request, so a retry cannot retarget it.
   */
  async prepareSubmission(
    projectPath: string,
    input: PrepareReviewSubmissionInput,
  ): Promise<ReviewSubmissionRequest> {
    validateSubmissionInput(input);
    return this.withMutation(projectPath, async (store) => {
      let existingSummary = store.state.submissions.find(
        (item) => item.id === input.submissionId,
      );
      let existingRequest: ReviewSubmissionRequest | null;
      try {
        existingRequest = await this.readSubmissionRequest(
          projectPath,
          input.submissionId,
        );
      } catch (error) {
        if (
          !(error instanceof InvalidSubmissionRequestError) ||
          (existingSummary && existingSummary.status !== "prepared")
        ) {
          throw error;
        }
        await this.removeSubmissionRequest(projectPath, input.submissionId);
        if (existingSummary) {
          store.state.submissions = store.state.submissions.filter(
            (item) => item.id !== input.submissionId,
          );
          await store.save();
          existingSummary = undefined;
        }
        existingRequest = null;
      }

      if (existingRequest) {
        assertSameSubmissionRequest(existingRequest, input);
        if (!existingSummary) {
          this.reserveRequestEntries(store.state, existingRequest);
          store.state.submissions.push(summaryFromRequest(existingRequest));
          await store.save();
        }
        return cloneSubmissionRequest(existingRequest);
      }
      if (existingSummary) {
        // Startup recovery rolls back this incomplete durable reservation. The
        // caller can immediately prepare the same id again from still-live drafts.
        store.state.submissions = store.state.submissions.filter(
          (item) => item.id !== input.submissionId,
        );
        await store.save();
      }

      const requested = new Set(input.commentIds);
      const reservedElsewhere = new Set(
        store.state.submissions
          .filter((item) => item.status === "prepared")
          .flatMap((item) => item.entryRefs.map((ref) => entryRefKey(ref))),
      );
      const refs = store.state.drafts.filter(
        (ref) =>
          requested.has(ref.entryId) &&
          !reservedElsewhere.has(entryRefKey(ref)),
      );
      if (refs.length !== requested.size) {
        throw new HttpError(
          409,
          "One or more review comments are no longer pending or are being submitted",
        );
      }
      const submittedAt = this.now();
      const request: ReviewSubmissionRequest = {
        version: REVIEW_SUBMISSION_REQUEST_VERSION,
        submissionId: input.submissionId,
        submittedAt,
        requestedTarget: input.requestedTarget,
        entries: refs.map((ref) => {
          const found = findEntry(store.state, ref);
          const relocation = input.relocations.get(ref.entryId);
          if (!found || !relocation) {
            throw new HttpError(
              409,
              "Review comment changed before submission",
            );
          }
          return {
            ...ref,
            text: found.entry.text,
            anchor: cloneAnchor(found.entry.anchor),
            capture: cloneCapture(found.entry.capture),
            relocation: cloneRelocation(relocation),
          };
        }),
        ...(input.name ? { name: input.name } : {}),
      };
      store.state.submissions.push(summaryFromRequest(request));
      await store.save();
      try {
        await this.writeSubmissionRequest(projectPath, request);
      } catch (error) {
        store.state.submissions = store.state.submissions.filter(
          (item) => item.id !== input.submissionId,
        );
        await store.save();
        throw error;
      }
      return cloneSubmissionRequest(request);
    });
  }

  /** Archive a prepared submission after the launcher accepted its keyed turn. */
  async acceptSubmission(
    projectPath: string,
    input: AcceptReviewSubmissionInput,
  ): Promise<ReviewSubmissionSummary | null> {
    return this.withMutation(projectPath, async (store) => {
      const summary = store.state.submissions.find(
        (item) => item.id === input.submissionId,
      );
      if (!summary) return null;
      if (summary.status === "accepted") {
        let changed = false;
        if (
          input.deliveryStatus === "delivered" &&
          summary.deliveryStatus !== "delivered"
        ) {
          summary.deliveryStatus = "delivered";
          changed = true;
        }
        if (
          input.targetSessionId &&
          summary.targetSessionId !== input.targetSessionId
        ) {
          summary.targetSessionId = input.targetSessionId;
          setOutcomeSession(store.state, summary.id, input.targetSessionId);
          changed = true;
        }
        if (changed) await store.save();
        return cloneSubmission(summary);
      }
      const request = await this.readSubmissionRequest(
        projectPath,
        input.submissionId,
      );
      if (!request) {
        throw new HttpError(409, "Submission request manifest is missing");
      }
      summary.status = "accepted";
      summary.deliveryStatus = input.deliveryStatus;
      summary.responseTurnsObserved = 0;
      summary.responseTurnLimit = input.responseTurnLimit;
      if (input.targetSessionId)
        summary.targetSessionId = input.targetSessionId;
      const acceptedKeys = new Set(summary.entryRefs.map(entryRefKey));
      store.state.drafts = store.state.drafts.filter(
        (ref) => !acceptedKeys.has(entryRefKey(ref)),
      );
      for (const ref of summary.entryRefs) {
        const found = findEntry(store.state, ref);
        if (!found) continue;
        found.entry.submittedAt = summary.submittedAt;
        found.entry.submissionId = summary.id;
      }
      await store.save();
      return cloneSubmission(summary);
    });
  }

  /** Release a reservation after the launcher rejects before acceptance. */
  async releaseSubmission(
    projectPath: string,
    submissionId: string,
  ): Promise<boolean> {
    return this.withMutation(projectPath, async (store) => {
      const summary = store.state.submissions.find(
        (item) => item.id === submissionId,
      );
      if (summary?.status !== "prepared") return false;
      store.state.submissions = store.state.submissions.filter(
        (item) => item.id !== submissionId,
      );
      await store.save();
      return true;
    });
  }

  /** Attach the eventual canonical YA id to a previously queued submission. */
  async associateSubmissionSession(
    projectPath: string,
    submissionId: string,
    sessionId: string,
  ): Promise<ReviewSubmissionSummary | null> {
    return this.withMutation(projectPath, async (store) => {
      const summary = store.state.submissions.find(
        (item) => item.id === submissionId,
      );
      if (!summary || summary.status === "legacy") return null;
      summary.targetSessionId = sessionId;
      setOutcomeSession(store.state, submissionId, sessionId);
      await store.save();
      return cloneSubmission(summary);
    });
  }

  /** Check every still-bounded submission associated with this YA session. */
  async observeAssistantTurn(
    projectPath: string,
    sessionId: string,
  ): Promise<
    Array<{ submissionId: string; status: ReviewResponseReadStatus }>
  > {
    return this.withMutation(projectPath, async (store) => {
      const submissions = store.state.submissions.filter(
        (submission) =>
          submission.status === "accepted" &&
          submission.deliveryStatus === "delivered" &&
          submission.targetSessionId === sessionId &&
          submission.responseTurnsObserved !== undefined &&
          submission.responseTurnLimit !== undefined &&
          submission.responseTurnsObserved < submission.responseTurnLimit,
      );
      const results = [];
      for (const submission of submissions) {
        submission.responseTurnsObserved =
          (submission.responseTurnsObserved ?? 0) + 1;
        results.push({
          submissionId: submission.id,
          status: await this.ingestSubmissionResponse(
            projectPath,
            store.state,
            submission,
          ),
        });
      }
      if (submissions.length > 0) await store.save();
      return results;
    });
  }

  /** User-triggered response check, including after the automatic window. */
  async refreshSubmissionResponse(
    projectPath: string,
    submissionId: string,
  ): Promise<ReviewResponseReadStatus | null> {
    return this.withMutation(projectPath, async (store) => {
      const submission = store.state.submissions.find(
        (item) => item.id === submissionId,
      );
      if (!submission) return null;
      const status = await this.ingestSubmissionResponse(
        projectPath,
        store.state,
        submission,
      );
      if (status === "ingested") await store.save();
      return status;
    });
  }

  /** Move persisted delivery associations from a provisional YA id. */
  async remapSubmissionSession(
    projectPath: string,
    oldSessionId: string,
    newSessionId: string,
  ): Promise<number> {
    return this.withMutation(projectPath, async (store) => {
      let changed = 0;
      const remappedSubmissionIds = new Set<string>();
      for (const submission of store.state.submissions) {
        if (submission.targetSessionId !== oldSessionId) continue;
        submission.targetSessionId = newSessionId;
        remappedSubmissionIds.add(submission.id);
        changed++;
      }
      for (const site of store.state.sites) {
        for (const outcome of site.outcomes) {
          if (
            outcome.sessionId === oldSessionId &&
            remappedSubmissionIds.has(outcome.submissionId)
          ) {
            outcome.sessionId = newSessionId;
          }
        }
      }
      if (changed > 0) await store.save();
      return changed;
    });
  }

  /** Create a fresh active entry at an existing discussion site. */
  async addFollowUp(
    projectPath: string,
    siteId: string,
    input: AddReviewFollowUpInput,
  ): Promise<ReviewReviewerEntry | null> {
    return this.withMutation(projectPath, async (store) => {
      if (store.state.drafts.length >= MAX_REVIEW_COMMENTS) {
        throw new HttpError(
          413,
          `Review comment limit reached (${MAX_REVIEW_COMMENTS}); submit or delete drafts first.`,
        );
      }
      const site = store.state.sites.find((item) => item.id === siteId);
      if (!site) return null;
      if (store.state.drafts.some((draft) => draft.siteId === siteId)) {
        throw new HttpError(
          409,
          "This review site already has an active draft",
        );
      }
      const entryId = this.newId();
      const entry: ReviewReviewerEntry = {
        id: entryId,
        anchor: cloneAnchor(input.anchor),
        text: input.text,
        capture: await this.capture(projectPath, input.anchor),
        createdAt: this.now(),
      };
      site.entries.push(entry);
      site.path = input.anchor.path;
      delete site.resolvedAt;
      store.state.drafts.push({ siteId, entryId });
      await store.save();
      return cloneReviewerEntry(entry);
    });
  }

  async resolveSite(projectPath: string, siteId: string): Promise<boolean> {
    return this.withMutation(projectPath, async (store) => {
      const site = store.state.sites.find((item) => item.id === siteId);
      if (!site) return false;
      if (store.state.drafts.some((draft) => draft.siteId === siteId)) {
        throw new HttpError(
          409,
          "Submit or discard the pending follow-up before resolving this site",
        );
      }
      site.resolvedAt = this.now();
      await store.save();
      return true;
    });
  }

  async acknowledgeSubmission(
    projectPath: string,
    submissionId: string,
  ): Promise<ReviewSubmissionSummary | null> {
    return this.withMutation(projectPath, async (store) => {
      const submission = store.state.submissions.find(
        (item) => item.id === submissionId,
      );
      if (!submission) return null;
      submission.acknowledgedRevision = submission.responseRevision;
      await store.save();
      return cloneSubmission(submission);
    });
  }

  filePathFor(projectPath: string): string {
    return this.storagePolicy.writePath(projectPath, REVIEW_COMMENTS_FILENAME);
  }

  submissionDirectoryFor(projectPath: string, submissionId: string): string {
    validateSubmissionId(submissionId);
    return this.storagePolicy.writePath(
      projectPath,
      SOURCE_REVIEW_DIR,
      submissionId,
    );
  }

  async existingSubmissionDirectoryFor(
    projectPath: string,
    submissionId: string,
  ): Promise<string> {
    return this.withStorageOperation(async () => {
      const request = await this.readSubmissionRequestRecord(
        projectPath,
        submissionId,
      );
      return request
        ? path.dirname(request.sourcePath)
        : this.submissionDirectoryFor(projectPath, submissionId);
    });
  }

  requestPathFor(projectPath: string, submissionId: string): string {
    return path.join(
      this.submissionDirectoryFor(projectPath, submissionId),
      REQUEST_FILENAME,
    );
  }

  responsePathFor(projectPath: string, submissionId: string): string {
    return path.join(
      this.submissionDirectoryFor(projectPath, submissionId),
      RESPONSE_FILENAME,
    );
  }

  reset(): void {
    this.stores.clear();
    this.releasedKeys.clear();
    this.retainedBytes = 0;
  }

  private async capture(
    projectPath: string,
    anchor: ReviewCommentAnchor,
  ): Promise<ReviewCapture> {
    return anchor.projection && this.captureWriter
      ? this.captureWriter.capture(projectPath, anchor.projection)
      : { status: "legacy-missing" };
  }

  private async ingestSubmissionResponse(
    projectPath: string,
    state: ReviewStoreFile,
    submission: ReviewSubmissionSummary,
  ): Promise<ReviewResponseReadStatus> {
    let requestRecord: LoadedSubmissionRequest | null;
    try {
      requestRecord = await this.readSubmissionRequestRecord(
        projectPath,
        submission.id,
      );
    } catch {
      return "invalid";
    }
    if (!requestRecord) return "invalid";

    let bytes: Buffer;
    try {
      const bounded = await readFileBounded(
        path.join(path.dirname(requestRecord.sourcePath), RESPONSE_FILENAME),
        MAX_REVIEW_RESPONSE_FILE_BYTES,
      );
      if (!bounded) return "invalid";
      bytes = bounded;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "missing"
        : "invalid";
    }

    let response: ReviewSubmissionResponse | null;
    try {
      response = parseReviewSubmissionResponse(
        JSON.parse(bytes.toString("utf-8")),
      );
    } catch {
      return "invalid";
    }
    if (!response || response.submissionId !== submission.id) return "invalid";
    const request = requestRecord.request;
    const expected = new Set(request.entries.map(entryRefKey));
    if (expected.size !== request.entries.length) return "invalid";
    const actual = new Set(response.outcomes.map(entryRefKey));
    if (
      response.outcomes.length !== expected.size ||
      actual.size !== expected.size ||
      [...actual].some((key) => !expected.has(key))
    ) {
      return "invalid";
    }

    const resolved = response.outcomes.map((outcome) => ({
      outcome,
      found: findEntry(state, outcome),
    }));
    if (resolved.some((item) => !item.found)) return "invalid";

    const responseHash = createHash("sha256").update(bytes).digest("hex");
    if (responseHash === submission.lastResponseHash) return "unchanged";
    const observedAt = this.now();
    for (const { outcome, found } of resolved) {
      if (!found) continue;
      const previous = found.site.outcomes
        .filter((item) => item.entryId === outcome.entryId)
        .at(-1);
      if (
        previous?.disposition === outcome.disposition &&
        previous.text === outcome.text
      ) {
        continue;
      }
      found.site.outcomes.push({
        submissionId: submission.id,
        entryId: outcome.entryId,
        disposition: outcome.disposition,
        text: outcome.text,
        observedAt,
        responseHash,
        ...(submission.targetSessionId
          ? { sessionId: submission.targetSessionId }
          : {}),
      });
    }
    submission.lastResponseHash = responseHash;
    submission.responseRevision += 1;
    return "ingested";
  }

  private reserveRequestEntries(
    state: ReviewStoreFile,
    request: ReviewSubmissionRequest,
  ): void {
    const draftKeys = new Set(state.drafts.map(entryRefKey));
    for (const entry of request.entries) {
      if (!draftKeys.has(entryRefKey(entry))) {
        throw new HttpError(409, "Submission entries are no longer pending");
      }
    }
  }

  private async readSubmissionRequest(
    projectPath: string,
    submissionId: string,
  ): Promise<ReviewSubmissionRequest | null> {
    return (
      (await this.readSubmissionRequestRecord(projectPath, submissionId))
        ?.request ?? null
    );
  }

  private async readSubmissionRequestRecord(
    projectPath: string,
    submissionId: string,
  ): Promise<LoadedSubmissionRequest | null> {
    const records: LoadedSubmissionRequest[] = [];
    for (const sourcePath of this.storagePolicy.readPaths(
      projectPath,
      SOURCE_REVIEW_DIR,
      submissionId,
      REQUEST_FILENAME,
    )) {
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(sourcePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf-8"));
      } catch {
        throw new InvalidSubmissionRequestError();
      }
      const request = parseReviewSubmissionRequest(value);
      if (!request || request.submissionId !== submissionId) {
        throw new InvalidSubmissionRequestError();
      }
      records.push({ request, sourcePath, bytes });
    }
    const selected = records[0];
    if (!selected) return null;
    if (records.some((record) => !record.bytes.equals(selected.bytes))) {
      throw new InvalidSubmissionRequestError();
    }
    return selected;
  }

  private async hasSubmissionRequest(
    projectPath: string,
    submissionId: string,
  ): Promise<boolean> {
    for (const requestPath of this.storagePolicy.readPaths(
      projectPath,
      SOURCE_REVIEW_DIR,
      submissionId,
      REQUEST_FILENAME,
    )) {
      try {
        await fs.access(requestPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  private async writeSubmissionRequest(
    projectPath: string,
    request: ReviewSubmissionRequest,
  ): Promise<void> {
    await this.storagePolicy.ensureWriteDirectory(projectPath);
    const directory = this.submissionDirectoryFor(
      projectPath,
      request.submissionId,
    );
    await fs.mkdir(directory, { recursive: true });
    const requestPath = this.requestPathFor(projectPath, request.submissionId);
    const temporaryPath = `${requestPath}.${randomUUID()}.tmp`;
    const file = await fs.open(temporaryPath, "wx");
    try {
      await file.writeFile(`${JSON.stringify(request, null, 2)}\n`, "utf-8");
      await file.sync();
    } finally {
      await file.close();
    }
    let publicationError: unknown;
    try {
      await fs.link(temporaryPath, requestPath);
    } catch (error) {
      publicationError = error;
    }
    let cleanupError: unknown;
    try {
      await fs.unlink(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        cleanupError = error;
      }
    }
    if (publicationError && cleanupError) {
      throw new AggregateError(
        [publicationError, cleanupError],
        "Failed to publish and clean up submission request manifest",
      );
    }
    if (publicationError) throw publicationError;
    if (cleanupError) throw cleanupError;
    await syncDirectory(directory);
  }

  private async removeSubmissionRequest(
    projectPath: string,
    submissionId: string,
  ): Promise<void> {
    for (const requestPath of this.storagePolicy.readPaths(
      projectPath,
      SOURCE_REVIEW_DIR,
      submissionId,
      REQUEST_FILENAME,
    )) {
      try {
        await fs.unlink(requestPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async getStore(
    projectPath: string,
    pinOperation = false,
  ): Promise<ProjectStore> {
    const storeKey = this.filePathFor(projectPath);
    let store = this.stores.get(storeKey);
    if (store?.writeFailed) {
      if (store.activeOperations > 0) throw store.writeFailure;
      this.releaseStore(storeKey, store);
      store = undefined;
    }
    if (!store) {
      if (this.releasedKeys.has(storeKey)) this.reloadsAfterRelease += 1;
      const created: ProjectStore = {
        projectPath,
        state: emptyReviewStoreFile(),
        logicalRevision: 0,
        hasPersistedState: false,
        loadPromise: null,
        loaded: false,
        save: () => Promise.resolve(),
        mutationTail: Promise.resolve(),
        activeOperations: 0,
        writeFailed: false,
        writeFailure: undefined,
        lastAccessMs: this.monotonicNowMs(),
        estimatedBytes: 0,
      };
      const saver = createCoalescingSaver(() =>
        this.doSave(projectPath, created),
      );
      // A save in flight pins the store: releasing it would strand the only
      // copy of state the writer has not yet reached disk with.
      created.save = () => {
        created.activeOperations += 1;
        // In-memory state has already changed by the time a save is issued, and
        // getStoreFile reads that state, so retained projections go stale here
        // rather than when the write lands.
        this.stateRevision += 1;
        created.logicalRevision += 1;
        return saver
          .save()
          .catch((error) => {
            created.writeFailed = true;
            created.writeFailure = error;
            throw error;
          })
          .finally(() => {
            created.activeOperations -= 1;
            this.measureStore(created);
            this.releaseFailedStore(storeKey, created);
          });
      };
      this.stores.set(storeKey, created);
      store = created;
    }
    store.lastAccessMs = this.monotonicNowMs();
    if (pinOperation) store.activeOperations += 1;
    try {
      if (!store.loaded) {
        if (!store.loadPromise)
          store.loadPromise = this.load(projectPath, store);
        await store.loadPromise;
        this.measureStore(store);
      }
      this.releaseIdleStores(storeKey);
      return store;
    } catch (error) {
      if (pinOperation) store.activeOperations -= 1;
      this.releaseFailedStore(storeKey, store);
      throw error;
    }
  }

  private async withMutation<T>(
    projectPath: string,
    mutate: (store: ProjectStore) => Promise<T>,
  ): Promise<T> {
    const releaseStorageOperation = await this.acquireStorageOperation();
    try {
      // Pin synchronously with store acquisition, before loading or another
      // project's budget enforcement can release this operation's owner.
      const storeKey = this.filePathFor(projectPath);
      const store = await this.getStore(projectPath, true);
      const runMutation = (): Promise<T> => {
        if (store.writeFailed) return Promise.reject(store.writeFailure);
        return mutate(store);
      };
      const run = store.mutationTail.then(runMutation, runMutation);
      store.mutationTail = run.then(
        () => undefined,
        () => undefined,
      );
      return await run.finally(() => {
        store.activeOperations -= 1;
        if (this.stores.get(storeKey) === store) {
          this.measureStore(store);
          this.releaseFailedStore(storeKey, store);
        }
      });
    } finally {
      releaseStorageOperation();
    }
  }

  private async withStorageOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquireStorageOperation();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async acquireStorageOperation(): Promise<() => void> {
    while (this.storageTransitionBarrier) {
      await this.storageTransitionBarrier;
    }
    if (this.activeStorageOperations === 0) {
      this.storageOperationsDrained = new Promise<void>((resolve) => {
        this.resolveStorageOperationsDrained = resolve;
      });
    }
    this.activeStorageOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeStorageOperations -= 1;
      if (this.activeStorageOperations === 0) {
        this.resolveStorageOperationsDrained?.();
        this.resolveStorageOperationsDrained = null;
      }
    };
  }

  async withStorageTransition<T>(
    targetMode: ProjectDirectoryStorage,
    commit: () => Promise<T>,
  ): Promise<T> {
    let releaseBarrier!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const previousBarrier = this.storageTransitionBarrier ?? Promise.resolve();
    const currentBarrier = previousBarrier.then(() => gate);
    this.storageTransitionBarrier = currentBarrier;

    await previousBarrier;
    if (this.activeStorageOperations > 0) {
      await this.storageOperationsDrained;
    }
    try {
      const storesByProject = new Map(
        [...this.stores.values()].map((store) => [store.projectPath, store]),
      );
      const projectPaths = new Set([
        ...storesByProject.keys(),
        ...(await this.listProjectPaths()),
      ]);
      for (const projectPath of projectPaths) {
        const retained = storesByProject.get(projectPath);
        const store =
          retained?.loaded && !retained.writeFailed
            ? retained
            : await this.getStore(projectPath);
        if (!store.hasPersistedState) continue;
        await this.writeStoreToMode(store, targetMode);
      }
      const result = await commit();
      if (this.storagePolicy.mode !== targetMode) {
        throw new Error("Review storage transition did not change modes");
      }
      this.releaseAllStores();
      return result;
    } finally {
      releaseBarrier();
      if (this.storageTransitionBarrier === currentBarrier) {
        this.storageTransitionBarrier = null;
      }
    }
  }

  /** Monotonic marker every retained review projection can key against. */
  getStateRevision(): number {
    return this.stateRevision;
  }

  getRetentionMetrics(): ReviewStoreRetentionMetrics {
    return {
      retainedStores: this.stores.size,
      retainedBytes: this.retainedBytes,
      releases: this.releases,
      releasesByAge: this.releasesByAge,
      protectedSkips: this.protectedSkips,
      reloadsAfterRelease: this.reloadsAfterRelease,
      stateRevision: this.stateRevision,
    };
  }

  private measureStore(store: ProjectStore): void {
    const bytes = Buffer.byteLength(JSON.stringify(store.state));
    this.retainedBytes += bytes - store.estimatedBytes;
    store.estimatedBytes = bytes;
  }

  private isReleasable(store: ProjectStore): boolean {
    return store.loaded && store.activeOperations === 0;
  }

  /**
   * Release clean, inactive project stores. One Inbox pass must not keep every
   * project's sites, entries, and outcomes resident for the server's lifetime.
   */
  private releaseIdleStores(keepKey: string): void {
    const now = this.monotonicNowMs();
    if (this.maxRetainedStoreAgeMs > 0) {
      for (const [key, store] of this.stores) {
        if (key === keepKey) continue;
        if (now - store.lastAccessMs < this.maxRetainedStoreAgeMs) continue;
        if (!this.isReleasable(store)) {
          this.protectedSkips += 1;
          continue;
        }
        this.releaseStore(key, store);
        this.releasesByAge += 1;
      }
    }
    if (this.retainedBytes <= this.maxRetainedStoreBytes) return;

    const releasable = [...this.stores]
      .filter(([key, store]) => key !== keepKey && this.isReleasable(store))
      .sort(([, left], [, right]) => left.lastAccessMs - right.lastAccessMs);
    for (const [key, store] of releasable) {
      if (this.retainedBytes <= this.maxRetainedStoreBytes) return;
      this.releaseStore(key, store);
    }
  }

  private releaseStore(key: string, store: ProjectStore): void {
    this.retainedBytes -= store.estimatedBytes;
    this.stores.delete(key);
    this.releasedKeys.add(key);
    this.releases += 1;
  }

  private releaseAllStores(): void {
    for (const [key, store] of this.stores) {
      this.releaseStore(key, store);
    }
  }

  private releaseFailedStore(key: string, store: ProjectStore): void {
    if (
      !store.writeFailed ||
      store.activeOperations !== 0 ||
      this.stores.get(key) !== store
    ) {
      return;
    }
    this.releaseStore(key, store);
  }

  private async load(projectPath: string, store: ProjectStore): Promise<void> {
    let needsSave = false;
    const candidates: LoadedReviewStore[] = [];
    for (const sourcePath of this.storagePolicy.readPaths(
      projectPath,
      REVIEW_COMMENTS_FILENAME,
    )) {
      try {
        candidates.push(await readPersistedReviewStore(sourcePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(
            `[ReviewCommentService] Failed to read review state at ${sourcePath}:`,
            error,
          );
        }
      }
    }
    if (candidates.length === 0) return this.finishEmptyLoad(store);

    candidates.sort(
      (left, right) => right.logicalRevision - left.logicalRevision,
    );
    const selected = candidates[0];
    if (!selected) return this.finishEmptyLoad(store);
    const conflicting = candidates.find(
      (candidate) =>
        candidate.logicalRevision === selected.logicalRevision &&
        candidate.stateSha256 !== selected.stateSha256,
    );
    if (conflicting) throw new ReviewStorageConflictError();

    store.state = selected.state;
    store.logicalRevision = selected.logicalRevision;
    store.hasPersistedState = true;
    const recovered: ReviewSubmissionSummary[] = [];
    for (const submission of store.state.submissions) {
      if (submission.status !== "prepared") {
        recovered.push(submission);
        continue;
      }
      if (await this.hasSubmissionRequest(projectPath, submission.id)) {
        recovered.push(submission);
      } else {
        needsSave = true;
      }
    }
    store.state.submissions = recovered;
    store.loaded = true;
    if (needsSave) await store.save();
  }

  private async doSave(
    _projectPath: string,
    store: ProjectStore,
  ): Promise<void> {
    await this.writeStoreToMode(store, this.storagePolicy.mode);
  }

  private async writeStoreToMode(
    store: ProjectStore,
    mode: ProjectDirectoryStorage,
  ): Promise<void> {
    const filePath = await this.storagePolicy.ensureParentForWriteFor(
      mode,
      store.projectPath,
      REVIEW_COMMENTS_FILENAME,
    );
    await writePersistedReviewStore(
      filePath,
      store.state,
      store.logicalRevision,
    );
    const verified = await readPersistedReviewStore(filePath);
    const expectedSha256 = reviewStoreSha256(store.state);
    if (
      verified.logicalRevision !== store.logicalRevision ||
      verified.stateSha256 !== expectedSha256
    ) {
      throw new Error("Source Review state verification failed after write");
    }
    store.hasPersistedState = true;
  }

  private finishEmptyLoad(store: ProjectStore): void {
    store.state = emptyReviewStoreFile();
    store.logicalRevision = 0;
    store.hasPersistedState = false;
    store.loaded = true;
  }
}

function reviewStoreSha256(state: unknown): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

async function readPersistedReviewStore(
  sourcePath: string,
): Promise<LoadedReviewStore> {
  const content = await fs.readFile(sourcePath, "utf-8");
  const value = JSON.parse(content) as unknown;
  const persistedRecord =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const metadata = persistedRecord?.[REVIEW_STORAGE_METADATA_KEY];
  let stateValue: unknown = value;
  if (persistedRecord) {
    const storedState: Record<string, unknown> = { ...persistedRecord };
    delete storedState[REVIEW_STORAGE_METADATA_KEY];
    stateValue = storedState;
  }
  const stateSha256 = reviewStoreSha256(stateValue);
  const state = parseReviewStoreFile(stateValue);
  if (metadata === undefined) {
    return { state, logicalRevision: 0, stateSha256, sourcePath };
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Source Review storage metadata is invalid");
  }
  const record = metadata as Record<string, unknown>;
  if (
    record.version !== REVIEW_STORAGE_METADATA_VERSION ||
    typeof record.logicalRevision !== "number" ||
    !Number.isSafeInteger(record.logicalRevision) ||
    record.logicalRevision < 0 ||
    typeof record.stateSha256 !== "string" ||
    record.stateSha256 !== stateSha256
  ) {
    throw new Error("Source Review storage metadata is invalid");
  }
  return {
    state,
    logicalRevision: record.logicalRevision,
    stateSha256,
    sourcePath,
  };
}

async function writePersistedReviewStore(
  filePath: string,
  state: ReviewStoreFile,
  logicalRevision: number,
): Promise<void> {
  const persisted: PersistedReviewStore = {
    ...state,
    [REVIEW_STORAGE_METADATA_KEY]: {
      version: REVIEW_STORAGE_METADATA_VERSION,
      logicalRevision,
      stateSha256: reviewStoreSha256(state),
    },
  };
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const file = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(persisted, null, 2)}\n`, "utf-8");
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporaryPath, filePath);
    published = true;
    await syncDirectory(path.dirname(filePath));
  } finally {
    if (!published) {
      await fs.unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

async function readFileBounded(
  filePath: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (stats.size > maxBytes) return null;
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function findEntry(store: ReviewStoreFile, ref: ReviewEntryRef) {
  const site = store.sites.find((item) => item.id === ref.siteId);
  const entry = site?.entries.find((item) => item.id === ref.entryId);
  return site && entry ? { site, entry } : null;
}

function setOutcomeSession(
  store: ReviewStoreFile,
  submissionId: string,
  sessionId: string,
): void {
  for (const site of store.sites) {
    for (const outcome of site.outcomes) {
      if (outcome.submissionId === submissionId) {
        outcome.sessionId = sessionId;
      }
    }
  }
}

function validateSubmissionId(submissionId: string): void {
  if (
    submissionId.length === 0 ||
    submissionId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(submissionId)
  ) {
    throw new HttpError(400, "Invalid review submission id");
  }
}

function validateSubmissionInput(input: PrepareReviewSubmissionInput): void {
  validateSubmissionId(input.submissionId);
  if (
    input.name !== undefined &&
    (input.name.trim().length === 0 ||
      input.name.length > MAX_REVIEW_SUBMISSION_NAME_LENGTH)
  ) {
    throw new HttpError(400, "Invalid review submission name");
  }
}

function entryRefKey(ref: ReviewEntryRef): string {
  return `${ref.siteId}\0${ref.entryId}`;
}

function summaryFromRequest(
  request: ReviewSubmissionRequest,
): ReviewSubmissionSummary {
  return {
    id: request.submissionId,
    submittedAt: request.submittedAt,
    requestedTarget: request.requestedTarget,
    entryRefs: request.entries.map(({ siteId, entryId }) => ({
      siteId,
      entryId,
    })),
    status: "prepared",
    responseRevision: 0,
    acknowledgedRevision: 0,
    ...(request.name ? { name: request.name } : {}),
  };
}

function assertSameSubmissionRequest(
  request: ReviewSubmissionRequest,
  input: PrepareReviewSubmissionInput,
): void {
  const requestedIds = [...new Set(input.commentIds)].sort();
  const frozenIds = request.entries.map((entry) => entry.entryId).sort();
  if (
    request.requestedTarget !== input.requestedTarget ||
    (request.name ?? "") !== (input.name ?? "") ||
    JSON.stringify(requestedIds) !== JSON.stringify(frozenIds)
  ) {
    throw new HttpError(
      409,
      "Submission id is already bound to another request",
    );
  }
}

function cloneCapture(capture: ReviewCapture): ReviewCapture {
  return capture.status === "captured"
    ? { ...capture, projection: { ...capture.projection } }
    : { status: "legacy-missing" };
}

function cloneRelocation(
  relocation: ReviewSubmissionRelocation,
): ReviewSubmissionRelocation {
  return { ...relocation };
}

function cloneSubmissionRequest(
  request: ReviewSubmissionRequest,
): ReviewSubmissionRequest {
  return {
    ...request,
    entries: request.entries.map((entry) => ({
      ...entry,
      anchor: cloneAnchor(entry.anchor),
      capture: cloneCapture(entry.capture),
      relocation: cloneRelocation(entry.relocation),
    })),
  };
}

function findDraftEntry(store: ReviewStoreFile, entryId: string) {
  const ref = store.drafts.find((item) => item.entryId === entryId);
  return ref ? findEntry(store, ref) : null;
}

function cloneAnchor(anchor: ReviewCommentAnchor): ReviewCommentAnchor {
  return {
    ...anchor,
    revision: { ...anchor.revision },
    ...(anchor.projection ? { projection: { ...anchor.projection } } : {}),
  };
}

function canonicalEntryToComment(
  entry: ReviewReviewerEntry,
  pending: boolean,
): ReviewComment {
  return {
    id: entry.id,
    anchor: cloneAnchor(entry.anchor),
    text: entry.text,
    status: pending ? "pending" : "archived",
    createdAt: entry.createdAt,
    ...(!pending && entry.submittedAt ? { archivedAt: entry.submittedAt } : {}),
    ...(!pending && entry.submissionId ? { batchId: entry.submissionId } : {}),
  };
}

function cloneReviewerEntry(entry: ReviewReviewerEntry): ReviewReviewerEntry {
  return {
    ...entry,
    anchor: cloneAnchor(entry.anchor),
    capture:
      entry.capture.status === "captured"
        ? {
            ...entry.capture,
            projection: { ...entry.capture.projection },
          }
        : { status: "legacy-missing" },
  };
}

function cloneSubmission(
  submission: ReviewSubmissionSummary,
): ReviewSubmissionSummary {
  return {
    ...submission,
    entryRefs: submission.entryRefs.map((ref) => ({ ...ref })),
  };
}

function cloneLegacyFile(file: ReviewCommentsFile): ReviewCommentsFile {
  return {
    version: file.version,
    comments: file.comments.map((comment) => ({
      ...comment,
      anchor: cloneAnchor(comment.anchor),
    })),
    batches: file.batches.map((batch) => ({
      ...batch,
      commentIds: [...batch.commentIds],
    })),
  };
}

function cloneStoreFile(file: ReviewStoreFile): ReviewStoreFile {
  return {
    version: file.version,
    sites: file.sites.map((site) => ({
      ...site,
      entries: site.entries.map(cloneReviewerEntry),
      outcomes: site.outcomes.map((outcome) => ({ ...outcome })),
    })),
    drafts: file.drafts.map((draft) => ({ ...draft })),
    submissions: file.submissions.map(cloneSubmission),
  };
}
