import type {
  EffortLevel,
  PatchHunk,
  ProviderName,
  ThinkingConfig,
} from "./types.js";

/**
 * Source-review draft comments (topic: source-review-to-session).
 *
 * A reviewer clicks a diff line and leaves a comment; comments accumulate as
 * server-owned drafts in `{projectPath}/.yep/review-comments.json` until
 * "submit review" drains the pending set into an agent session. This module is
 * the wire/persistence contract shared by client and server: the anchor model,
 * a defensive parser (the file outlives bundle versions and is user-visible on
 * disk), and the pure `anchorFromPatch` helper that turns a clicked diff line
 * into an anchor from `structuredPatch` alone — never from the DOM.
 */

/** Compatibility shape returned by the established comments endpoint. */
export const REVIEW_COMMENTS_FILE_VERSION = 1 as const;
/** Canonical on-disk site/entry/submission store. */
export const REVIEW_STORE_FILE_VERSION = 2 as const;

/** Bounds — the file is user-visible on disk and must reject hostile shapes. */
export const MAX_REVIEW_COMMENTS = 2000;
export const MAX_REVIEW_BATCHES = 2000;
export const MAX_REVIEW_COMMENT_TEXT_LENGTH = 20000;
export const MAX_REVIEW_SNIPPET_LENGTH = 8000;
export const MAX_REVIEW_PATH_LENGTH = 4096;
export const MAX_REVIEW_SUBMISSION_NAME_LENGTH = 120;
export const MAX_REVIEW_SUBMISSION_ID_LENGTH = 128;
export const REVIEW_SUBMISSION_REQUEST_VERSION = 1 as const;
export const REVIEW_SUBMISSION_RESPONSE_VERSION = 1 as const;
export const MAX_REVIEW_RESPONSE_FILE_BYTES = 256 * 1024;

/** How many neighbouring diff lines flank the clicked line in the snippet. */
export const DEFAULT_SNIPPET_CONTEXT_RADIUS = 3;

/**
 * Which side of the diff a commented line belongs to. A removed line is
 * `"old"` (gone from the current tree → its SHA is always cited); an added
 * line is `"new"`. A context line exists on both sides — the clicked column
 * decides, defaulting to `"new"` since it is present in the current tree.
 */
export type ReviewCommentSide = "old" | "new";

/**
 * The revision the anchor's line numbers and snippet were captured against.
 * `sha` covers a reviewed commit, a blame origin, or HEAD-at-comment-time;
 * `uncommitted` is a working-tree change with no SHA, timestamped instead.
 */
export type ReviewCommentRevision =
  | { kind: "sha"; sha: string }
  | { kind: "uncommitted"; savedAt: string };

/** Exact source projection rendered when a reviewer entry is created. */
export type ReviewSourceProjection =
  | {
      kind: "worktree";
      path: string;
      side: ReviewCommentSide;
    }
  | {
      kind: "index";
      path: string;
      side: ReviewCommentSide;
    }
  | {
      kind: "revision";
      revision: string;
      path: string;
      side: ReviewCommentSide;
    };

export interface ReviewCommentAnchor {
  /** Repo-relative path of the file the commented line lives in. */
  path: string;
  /** Revision the line numbers and snippet were captured against. */
  revision: ReviewCommentRevision;
  /** Which side of the diff was clicked (see {@link ReviewCommentSide}). */
  side: ReviewCommentSide;
  /**
   * 1-based line number in the old file, or null when the line is purely
   * added. `newLine === null` marks a removed line (gone from the tree).
   */
  oldLine: number | null;
  /**
   * 1-based line number in the new file, or null when the line is purely
   * removed. Used as the primary relocation target for lines still in the tree.
   */
  newLine: number | null;
  /**
   * The clicked line plus a little surrounding diff context, prefixes
   * stripped and newline-joined. Fuels fuzzy relocation and inline display in
   * the seeded turn.
   */
  snippet: string;
  /**
   * 0-based index, within `snippet`'s lines, of the clicked line itself.
   * Relocation extracts that line to search the current tree. Optional for
   * backward compatibility; consumers treat a missing value as 0.
   */
  snippetAnchorOffset?: number;
  /**
   * Exact rendered source projection. Older clients omit it; new servers then
   * retain version-1 behavior and mark the entry's capture unavailable.
   */
  projection?: ReviewSourceProjection;
}

export type ReviewCommentStatus = "pending" | "archived";

export interface ReviewComment {
  /** Stable id, assigned by the server on creation. */
  id: string;
  anchor: ReviewCommentAnchor;
  /** The reviewer's comment text. */
  text: string;
  /** `pending` until a submit consumes it, then `archived`. */
  status: ReviewCommentStatus;
  /** ISO 8601 creation time. */
  createdAt: string;
  /** ISO 8601 time the comment was consumed into a batch (archived only). */
  archivedAt?: string;
  /** Batch this comment was consumed by (archived only). */
  batchId?: string;
  /** Session the batch was delivered to (archived only). */
  targetSessionId?: string;
}

/** A consumed submit: the pending comments drained into one review turn. */
export interface ReviewBatch {
  id: string;
  /** ISO 8601 submit time. */
  submittedAt: string;
  /** Session the review turn went to. */
  targetSessionId: string;
  /** Comments consumed by this batch. */
  commentIds: string[];
}

/** Explicit launch choices when a submitted review starts a fresh session. */
export interface ReviewNewSessionOptions {
  provider?: ProviderName;
  /** Provider model id. Omitted means the provider's normal default. */
  model?: string;
  /** Thinking mode copied from the session that opened Source Control. */
  thinking?: ThinkingConfig;
  /** Reasoning effort copied from the session that opened Source Control. */
  effort?: EffortLevel;
  /**
   * The session that opened Source Control. The server carries its router
   * pool or account (as a new pin), YA sandbox and service tier to the
   * review session; older servers ignore it.
   */
  sourceSessionId?: string;
}

export interface ReviewCommentsFile {
  version: typeof REVIEW_COMMENTS_FILE_VERSION;
  comments: ReviewComment[];
  batches: ReviewBatch[];
}

export type ReviewCapture =
  | {
      status: "captured";
      captureBlobId: string;
      projection: ReviewSourceProjection;
    }
  | { status: "legacy-missing" };

export interface ReviewEntryRef {
  siteId: string;
  entryId: string;
}

export interface ReviewReviewerEntry {
  id: string;
  text: string;
  anchor: ReviewCommentAnchor;
  capture: ReviewCapture;
  createdAt: string;
  submittedAt?: string;
  submissionId?: string;
}

export type ReviewOutcomeDisposition = "done" | "wont_fix" | "question";

export interface ReviewOutcome {
  submissionId: string;
  entryId: string;
  disposition: ReviewOutcomeDisposition;
  text: string;
  observedAt: string;
  responseHash: string;
  sessionId?: string;
}

export interface ReviewSite {
  id: string;
  path: string;
  createdAt: string;
  entries: ReviewReviewerEntry[];
  outcomes: ReviewOutcome[];
  resolvedAt?: string;
}

/** Active, editable entry reference. Submitted history never lives here. */
export interface ReviewDraft extends ReviewEntryRef {}

export type ReviewSubmissionStatus = "legacy" | "prepared" | "accepted";

export interface ReviewSubmissionSummary {
  id: string;
  name?: string;
  submittedAt: string;
  requestedTarget: "new" | string;
  targetSessionId?: string;
  entryRefs: ReviewEntryRef[];
  status: ReviewSubmissionStatus;
  /** Launcher acceptance result, retained so retries return the same shape. */
  deliveryStatus?: "queued" | "delivered";
  /** Monotonic valid response revision, zero until one is ingested. */
  responseRevision: number;
  /** Highest response revision the reviewer explicitly opened. */
  acknowledgedRevision: number;
  /** Completed assistant turns whose response file was checked. */
  responseTurnsObserved?: number;
  /** Frozen observation bound for this delivery. */
  responseTurnLimit?: number;
  /** Last complete response snapshot incorporated into outcome history. */
  lastResponseHash?: string;
}

export type ReviewSourceChangeStatus = "changed" | "unchanged" | "unavailable";

/** Current state for one unresolved review site, independent on both axes. */
export interface ReviewSiteStateSummary {
  siteId: string;
  path: string;
  state: "open" | "addressed";
  changeStatus: ReviewSourceChangeStatus;
}

export type ReviewSubmissionRelocation =
  | {
      status: "relocated";
      path: string;
      line: number;
      snippet: string;
      currentSha: string | null;
      moved: boolean;
    }
  | {
      status: "gone";
      path: string;
      citeSha: string | null;
      snippet: string;
    };

export interface ReviewSubmissionRequestEntry extends ReviewEntryRef {
  text: string;
  anchor: ReviewCommentAnchor;
  relocation: ReviewSubmissionRelocation;
  capture: ReviewCapture;
}

/** Immutable server-authored request at `.yep/source-review/<id>/request.json`. */
export interface ReviewSubmissionRequest {
  version: typeof REVIEW_SUBMISSION_REQUEST_VERSION;
  submissionId: string;
  name?: string;
  submittedAt: string;
  requestedTarget: "new" | string;
  entries: ReviewSubmissionRequestEntry[];
}

export interface ReviewSubmissionResponseOutcome extends ReviewEntryRef {
  disposition: ReviewOutcomeDisposition;
  text: string;
}

/** Agent-authored atomic response snapshot. */
export interface ReviewSubmissionResponse {
  version: typeof REVIEW_SUBMISSION_RESPONSE_VERSION;
  submissionId: string;
  outcomes: ReviewSubmissionResponseOutcome[];
  suggestedTitle?: string;
}

/** Bounded source excerpt read from an immutable capture blob. */
export type ReviewCapturedSource =
  | { status: "legacy-missing" }
  | {
      status: "captured";
      captureBlobId: string;
      content: string;
      startLine: number;
      highlightLine: number;
    }
  | {
      status: "unavailable";
      captureBlobId: string;
      reason: "binary" | "too-large" | "missing";
    };

export interface ReviewEntryCapturedSource extends ReviewEntryRef {
  source: ReviewCapturedSource;
  /** Whitespace-insensitive comparison of this entry's capture to today. */
  changeStatus: ReviewSourceChangeStatus;
}

/** Canonical submission detail returned by the capability-gated reader. */
export interface ReviewSubmissionDetail {
  submission: ReviewSubmissionSummary;
  sites: ReviewSite[];
  capturedSources: ReviewEntryCapturedSource[];
}

export interface ReviewInboxOutcome extends ReviewOutcome {
  siteId: string;
  path: string;
}

/** One unread response revision surfaced in the global Inbox. */
export interface ReviewInboxItem {
  projectId: string;
  projectName: string;
  submissionId: string;
  name?: string;
  targetSessionId?: string;
  responseRevision: number;
  outcomes: ReviewInboxOutcome[];
}

/** First-comment excerpt used both as the name-field prefill and title fallback. */
export function deriveReviewSubmissionName(text: string): string {
  const line = text
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find(Boolean);
  return (line ?? "Source review").slice(0, MAX_REVIEW_SUBMISSION_NAME_LENGTH);
}

export function isReviewSubmissionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REVIEW_SUBMISSION_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)
  );
}

export interface ReviewStoreFile {
  version: typeof REVIEW_STORE_FILE_VERSION;
  sites: ReviewSite[];
  drafts: ReviewDraft[];
  submissions: ReviewSubmissionSummary[];
}

export function emptyReviewStoreFile(): ReviewStoreFile {
  return {
    version: REVIEW_STORE_FILE_VERSION,
    sites: [],
    drafts: [],
    submissions: [],
  };
}

export function emptyReviewCommentsFile(): ReviewCommentsFile {
  return {
    version: REVIEW_COMMENTS_FILE_VERSION,
    comments: [],
    batches: [],
  };
}

function isIsoLikeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function parseRevision(value: unknown): ReviewCommentRevision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "sha") {
    if (typeof record.sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(record.sha))
      return null;
    return { kind: "sha", sha: record.sha };
  }
  if (record.kind === "uncommitted") {
    if (!isIsoLikeString(record.savedAt)) return null;
    return { kind: "uncommitted", savedAt: record.savedAt };
  }
  return null;
}

export function parseReviewSourceProjection(
  value: unknown,
): ReviewSourceProjection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    record.path.length > MAX_REVIEW_PATH_LENGTH ||
    (record.side !== "old" && record.side !== "new")
  ) {
    return null;
  }
  if (record.kind === "worktree" || record.kind === "index") {
    return { kind: record.kind, path: record.path, side: record.side };
  }
  if (
    record.kind === "revision" &&
    typeof record.revision === "string" &&
    /^[0-9a-f]{7,64}$/iu.test(record.revision)
  ) {
    return {
      kind: "revision",
      revision: record.revision,
      path: record.path,
      side: record.side,
    };
  }
  return null;
}

function parseOptionalLine(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  return undefined; // signals invalid
}

/**
 * Validate an anchor from the wire (the client sends one when creating a
 * comment) or from disk. Returns a normalized anchor or null — the single
 * validation entry point shared by the parser and the create-comment route.
 */
export function parseReviewCommentAnchor(
  value: unknown,
): ReviewCommentAnchor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    record.path.length > MAX_REVIEW_PATH_LENGTH
  ) {
    return null;
  }
  const revision = parseRevision(record.revision);
  if (!revision) return null;
  if (record.side !== "old" && record.side !== "new") return null;

  const oldLine = parseOptionalLine(record.oldLine);
  const newLine = parseOptionalLine(record.newLine);
  if (oldLine === undefined || newLine === undefined) return null;
  // A line must exist on at least one side.
  if (oldLine === null && newLine === null) return null;

  if (
    typeof record.snippet !== "string" ||
    record.snippet.length > MAX_REVIEW_SNIPPET_LENGTH
  ) {
    return null;
  }

  const anchor: ReviewCommentAnchor = {
    path: record.path,
    revision,
    side: record.side,
    oldLine,
    newLine,
    snippet: record.snippet,
  };
  if (record.snippetAnchorOffset !== undefined) {
    if (
      typeof record.snippetAnchorOffset !== "number" ||
      !Number.isInteger(record.snippetAnchorOffset) ||
      record.snippetAnchorOffset < 0
    ) {
      return null;
    }
    anchor.snippetAnchorOffset = record.snippetAnchorOffset;
  }
  if (record.projection !== undefined) {
    const projection = parseReviewSourceProjection(record.projection);
    if (!projection) return null;
    anchor.projection = projection;
  }
  return anchor;
}

function parseComment(value: unknown): ReviewComment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (typeof record.id !== "string" || record.id.length === 0) return null;
  const anchor = parseReviewCommentAnchor(record.anchor);
  if (!anchor) return null;
  if (
    typeof record.text !== "string" ||
    record.text.length > MAX_REVIEW_COMMENT_TEXT_LENGTH
  ) {
    return null;
  }
  if (record.status !== "pending" && record.status !== "archived") return null;
  if (!isIsoLikeString(record.createdAt)) return null;

  const comment: ReviewComment = {
    id: record.id,
    anchor,
    text: record.text,
    status: record.status,
    createdAt: record.createdAt,
  };

  if (record.status === "archived") {
    if (record.archivedAt !== undefined) {
      if (!isIsoLikeString(record.archivedAt)) return null;
      comment.archivedAt = record.archivedAt;
    }
    if (record.batchId !== undefined) {
      if (typeof record.batchId !== "string") return null;
      comment.batchId = record.batchId;
    }
    if (record.targetSessionId !== undefined) {
      if (typeof record.targetSessionId !== "string") return null;
      comment.targetSessionId = record.targetSessionId;
    }
  }

  return comment;
}

function parseBatch(value: unknown): ReviewBatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (!isIsoLikeString(record.submittedAt)) return null;
  if (typeof record.targetSessionId !== "string") return null;
  if (!Array.isArray(record.commentIds)) return null;
  const commentIds: string[] = [];
  for (const entry of record.commentIds) {
    if (typeof entry !== "string") return null;
    commentIds.push(entry);
  }
  return {
    id: record.id,
    submittedAt: record.submittedAt,
    targetSessionId: record.targetSessionId,
    commentIds,
  };
}

/**
 * Parse the persisted `.yep/review-comments.json` shape defensively. Garbage,
 * truncated, or wrong-version files reject to an empty store rather than
 * throwing — a malformed draft file must never wedge the review surface. A
 * single malformed comment/batch drops that entry, not the whole file.
 */
export function parseReviewCommentsFile(value: unknown): ReviewCommentsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyReviewCommentsFile();
  }
  const record = value as Record<string, unknown>;
  if (record.version !== REVIEW_COMMENTS_FILE_VERSION) {
    return emptyReviewCommentsFile();
  }

  const comments: ReviewComment[] = [];
  if (Array.isArray(record.comments)) {
    const seen = new Set<string>();
    for (const raw of record.comments) {
      if (comments.length >= MAX_REVIEW_COMMENTS) break;
      const comment = parseComment(raw);
      if (comment && !seen.has(comment.id)) {
        seen.add(comment.id);
        comments.push(comment);
      }
    }
  }

  const batches: ReviewBatch[] = [];
  if (Array.isArray(record.batches)) {
    const seen = new Set<string>();
    for (const raw of record.batches) {
      if (batches.length >= MAX_REVIEW_BATCHES) break;
      const batch = parseBatch(raw);
      if (batch && !seen.has(batch.id)) {
        seen.add(batch.id);
        batches.push(batch);
      }
    }
  }

  return { version: REVIEW_COMMENTS_FILE_VERSION, comments, batches };
}

function parseEntryRef(value: unknown): ReviewEntryRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.siteId !== "string" ||
    record.siteId.length === 0 ||
    typeof record.entryId !== "string" ||
    record.entryId.length === 0
  ) {
    return null;
  }
  return { siteId: record.siteId, entryId: record.entryId };
}

function parseCapture(value: unknown): ReviewCapture | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.status === "legacy-missing") return { status: "legacy-missing" };
  if (
    record.status !== "captured" ||
    typeof record.captureBlobId !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(record.captureBlobId)
  ) {
    return null;
  }
  const projection = parseReviewSourceProjection(record.projection);
  return projection
    ? { status: "captured", captureBlobId: record.captureBlobId, projection }
    : null;
}

function parseSubmissionRelocation(
  value: unknown,
): ReviewSubmissionRelocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    record.path.length > MAX_REVIEW_PATH_LENGTH ||
    typeof record.snippet !== "string" ||
    record.snippet.length > MAX_REVIEW_SNIPPET_LENGTH
  ) {
    return null;
  }
  if (
    record.status === "relocated" &&
    typeof record.line === "number" &&
    Number.isInteger(record.line) &&
    record.line >= 1 &&
    (record.currentSha === null || typeof record.currentSha === "string") &&
    typeof record.moved === "boolean"
  ) {
    return {
      status: "relocated",
      path: record.path,
      line: record.line,
      snippet: record.snippet,
      currentSha: record.currentSha,
      moved: record.moved,
    };
  }
  if (
    record.status === "gone" &&
    (record.citeSha === null || typeof record.citeSha === "string")
  ) {
    return {
      status: "gone",
      path: record.path,
      citeSha: record.citeSha,
      snippet: record.snippet,
    };
  }
  return null;
}

/** Defensively parse the immutable server-authored request manifest. */
export function parseReviewSubmissionRequest(
  value: unknown,
): ReviewSubmissionRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== REVIEW_SUBMISSION_REQUEST_VERSION ||
    !isReviewSubmissionId(record.submissionId) ||
    !isIsoLikeString(record.submittedAt) ||
    typeof record.requestedTarget !== "string" ||
    record.requestedTarget.length === 0 ||
    !Array.isArray(record.entries) ||
    record.entries.length === 0 ||
    record.entries.length > MAX_REVIEW_COMMENTS ||
    (record.name !== undefined &&
      (typeof record.name !== "string" ||
        record.name.length === 0 ||
        record.name.length > MAX_REVIEW_SUBMISSION_NAME_LENGTH))
  ) {
    return null;
  }
  const entries: ReviewSubmissionRequestEntry[] = [];
  const seen = new Set<string>();
  for (const raw of record.entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const entryRecord = raw as Record<string, unknown>;
    const ref = parseEntryRef(entryRecord);
    const anchor = parseReviewCommentAnchor(entryRecord.anchor);
    const capture = parseCapture(entryRecord.capture);
    const relocation = parseSubmissionRelocation(entryRecord.relocation);
    if (
      !ref ||
      !anchor ||
      !capture ||
      !relocation ||
      typeof entryRecord.text !== "string" ||
      entryRecord.text.length > MAX_REVIEW_COMMENT_TEXT_LENGTH
    ) {
      return null;
    }
    const key = `${ref.siteId}\0${ref.entryId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    entries.push({
      ...ref,
      text: entryRecord.text,
      anchor,
      capture,
      relocation,
    });
  }
  return {
    version: REVIEW_SUBMISSION_REQUEST_VERSION,
    submissionId: record.submissionId,
    submittedAt: record.submittedAt,
    requestedTarget: record.requestedTarget,
    entries,
    ...(typeof record.name === "string" ? { name: record.name } : {}),
  };
}

/** Parse an agent-authored response shape; completeness is checked by ingestion. */
export function parseReviewSubmissionResponse(
  value: unknown,
): ReviewSubmissionResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== REVIEW_SUBMISSION_RESPONSE_VERSION ||
    !isReviewSubmissionId(record.submissionId) ||
    !Array.isArray(record.outcomes) ||
    record.outcomes.length > MAX_REVIEW_COMMENTS ||
    (record.suggestedTitle !== undefined &&
      (typeof record.suggestedTitle !== "string" ||
        record.suggestedTitle.length > MAX_REVIEW_SUBMISSION_NAME_LENGTH))
  ) {
    return null;
  }
  const outcomes: ReviewSubmissionResponseOutcome[] = [];
  const seen = new Set<string>();
  for (const raw of record.outcomes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const outcomeRecord = raw as Record<string, unknown>;
    const ref = parseEntryRef(outcomeRecord);
    if (
      !ref ||
      (outcomeRecord.disposition !== "done" &&
        outcomeRecord.disposition !== "wont_fix" &&
        outcomeRecord.disposition !== "question") ||
      typeof outcomeRecord.text !== "string" ||
      outcomeRecord.text.length > MAX_REVIEW_COMMENT_TEXT_LENGTH
    ) {
      return null;
    }
    const key = `${ref.siteId}\0${ref.entryId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    outcomes.push({
      ...ref,
      disposition: outcomeRecord.disposition,
      text: outcomeRecord.text,
    });
  }
  return {
    version: REVIEW_SUBMISSION_RESPONSE_VERSION,
    submissionId: record.submissionId,
    outcomes,
    ...(typeof record.suggestedTitle === "string"
      ? { suggestedTitle: record.suggestedTitle }
      : {}),
  };
}

function parseReviewerEntry(value: unknown): ReviewReviewerEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (
    typeof record.text !== "string" ||
    record.text.length > MAX_REVIEW_COMMENT_TEXT_LENGTH
  ) {
    return null;
  }
  const anchor = parseReviewCommentAnchor(record.anchor);
  const capture = parseCapture(record.capture);
  if (!anchor || !capture || !isIsoLikeString(record.createdAt)) return null;
  const entry: ReviewReviewerEntry = {
    id: record.id,
    text: record.text,
    anchor,
    capture,
    createdAt: record.createdAt,
  };
  if (record.submittedAt !== undefined) {
    if (!isIsoLikeString(record.submittedAt)) return null;
    entry.submittedAt = record.submittedAt;
  }
  if (record.submissionId !== undefined) {
    if (typeof record.submissionId !== "string") return null;
    entry.submissionId = record.submissionId;
  }
  return entry;
}

function parseOutcome(value: unknown): ReviewOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.submissionId !== "string" ||
    typeof record.entryId !== "string" ||
    (record.disposition !== "done" &&
      record.disposition !== "wont_fix" &&
      record.disposition !== "question") ||
    typeof record.text !== "string" ||
    record.text.length > MAX_REVIEW_COMMENT_TEXT_LENGTH ||
    !isIsoLikeString(record.observedAt) ||
    typeof record.responseHash !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(record.responseHash)
  ) {
    return null;
  }
  return {
    submissionId: record.submissionId,
    entryId: record.entryId,
    disposition: record.disposition,
    text: record.text,
    observedAt: record.observedAt,
    responseHash: record.responseHash,
    ...(typeof record.sessionId === "string"
      ? { sessionId: record.sessionId }
      : {}),
  };
}

function parseSite(value: unknown): ReviewSite | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.path !== "string" ||
    record.path.length === 0 ||
    record.path.length > MAX_REVIEW_PATH_LENGTH ||
    !isIsoLikeString(record.createdAt) ||
    !Array.isArray(record.entries) ||
    !Array.isArray(record.outcomes)
  ) {
    return null;
  }
  const entries: ReviewReviewerEntry[] = [];
  const seenEntries = new Set<string>();
  for (const raw of record.entries) {
    const entry = parseReviewerEntry(raw);
    if (entry && !seenEntries.has(entry.id)) {
      seenEntries.add(entry.id);
      entries.push(entry);
    }
  }
  const outcomes = record.outcomes.flatMap((raw) => {
    const outcome = parseOutcome(raw);
    return outcome ? [outcome] : [];
  });
  const site: ReviewSite = {
    id: record.id,
    path: record.path,
    createdAt: record.createdAt,
    entries,
    outcomes,
  };
  if (record.resolvedAt !== undefined) {
    if (!isIsoLikeString(record.resolvedAt)) return null;
    site.resolvedAt = record.resolvedAt;
  }
  return site;
}

function parseSubmission(value: unknown): ReviewSubmissionSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    !isIsoLikeString(record.submittedAt) ||
    typeof record.requestedTarget !== "string" ||
    record.requestedTarget.length === 0 ||
    (record.status !== "legacy" &&
      record.status !== "prepared" &&
      record.status !== "accepted") ||
    ((record.status === "prepared" || record.status === "accepted") &&
      !isReviewSubmissionId(record.id)) ||
    !Array.isArray(record.entryRefs) ||
    typeof record.responseRevision !== "number" ||
    !Number.isInteger(record.responseRevision) ||
    record.responseRevision < 0 ||
    typeof record.acknowledgedRevision !== "number" ||
    !Number.isInteger(record.acknowledgedRevision) ||
    record.acknowledgedRevision < 0
  ) {
    return null;
  }
  const entryRefs = record.entryRefs.flatMap((raw) => {
    const ref = parseEntryRef(raw);
    return ref ? [ref] : [];
  });
  const responseTurnsObserved =
    record.responseTurnsObserved === undefined
      ? undefined
      : typeof record.responseTurnsObserved === "number" &&
          Number.isInteger(record.responseTurnsObserved) &&
          record.responseTurnsObserved >= 0
        ? record.responseTurnsObserved
        : null;
  const responseTurnLimit =
    record.responseTurnLimit === undefined
      ? undefined
      : typeof record.responseTurnLimit === "number" &&
          Number.isInteger(record.responseTurnLimit) &&
          record.responseTurnLimit >= 1 &&
          record.responseTurnLimit <= 32
        ? record.responseTurnLimit
        : null;
  if (responseTurnsObserved === null || responseTurnLimit === null) return null;
  if (
    record.lastResponseHash !== undefined &&
    (typeof record.lastResponseHash !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(record.lastResponseHash))
  ) {
    return null;
  }
  return {
    id: record.id,
    submittedAt: record.submittedAt,
    requestedTarget: record.requestedTarget,
    entryRefs,
    status: record.status,
    responseRevision: record.responseRevision,
    acknowledgedRevision: Math.min(
      record.acknowledgedRevision,
      record.responseRevision,
    ),
    ...(typeof record.name === "string" && record.name.length > 0
      ? { name: record.name }
      : {}),
    ...(typeof record.targetSessionId === "string"
      ? { targetSessionId: record.targetSessionId }
      : {}),
    ...(record.deliveryStatus === "queued" ||
    record.deliveryStatus === "delivered"
      ? { deliveryStatus: record.deliveryStatus }
      : {}),
    ...(responseTurnsObserved !== undefined ? { responseTurnsObserved } : {}),
    ...(responseTurnLimit !== undefined ? { responseTurnLimit } : {}),
    ...(typeof record.lastResponseHash === "string"
      ? { lastResponseHash: record.lastResponseHash }
      : {}),
  };
}

/**
 * Convert every valid version-1 comment and batch into canonical entities.
 * No capture is invented: the old format did not record the rendered source.
 */
export function migrateLegacyReviewCommentsFile(
  legacy: ReviewCommentsFile,
): ReviewStoreFile {
  const batchesById = new Map(legacy.batches.map((batch) => [batch.id, batch]));
  const refsByComment = new Map<string, ReviewEntryRef>();
  const sites = legacy.comments.map((comment) => {
    const siteId = `legacy-site-${comment.id}`;
    const batch = comment.batchId
      ? batchesById.get(comment.batchId)
      : undefined;
    const entry: ReviewReviewerEntry = {
      id: comment.id,
      text: comment.text,
      anchor: comment.anchor,
      capture: { status: "legacy-missing" },
      createdAt: comment.createdAt,
      ...(comment.status === "archived"
        ? {
            submittedAt:
              comment.archivedAt ?? batch?.submittedAt ?? comment.createdAt,
            ...(comment.batchId ? { submissionId: comment.batchId } : {}),
          }
        : {}),
    };
    refsByComment.set(comment.id, { siteId, entryId: comment.id });
    return {
      id: siteId,
      path: comment.anchor.path,
      createdAt: comment.createdAt,
      entries: [entry],
      outcomes: [],
    } satisfies ReviewSite;
  });
  const drafts = legacy.comments.flatMap((comment) => {
    const ref = refsByComment.get(comment.id);
    return comment.status === "pending" && ref ? [ref] : [];
  });
  const submissions = legacy.batches.map((batch) => ({
    id: batch.id,
    submittedAt: batch.submittedAt,
    requestedTarget: batch.targetSessionId,
    targetSessionId: batch.targetSessionId,
    entryRefs: batch.commentIds.flatMap((id) => {
      const ref = refsByComment.get(id);
      return ref ? [ref] : [];
    }),
    status: "legacy" as const,
    responseRevision: 0,
    acknowledgedRevision: 0,
  }));
  return {
    version: REVIEW_STORE_FILE_VERSION,
    sites,
    drafts,
    submissions,
  };
}

/** Parse the canonical store, migrating version 1 before any later writes. */
export function parseReviewStoreFile(value: unknown): ReviewStoreFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyReviewStoreFile();
  }
  const record = value as Record<string, unknown>;
  if (record.version === REVIEW_COMMENTS_FILE_VERSION) {
    return migrateLegacyReviewCommentsFile(parseReviewCommentsFile(record));
  }
  if (
    record.version !== REVIEW_STORE_FILE_VERSION ||
    !Array.isArray(record.sites) ||
    !Array.isArray(record.drafts) ||
    !Array.isArray(record.submissions)
  ) {
    return emptyReviewStoreFile();
  }

  const sites: ReviewSite[] = [];
  const seenSites = new Set<string>();
  for (const raw of record.sites) {
    const site = parseSite(raw);
    if (site && !seenSites.has(site.id)) {
      seenSites.add(site.id);
      sites.push(site);
    }
  }
  const validRefs = new Set(
    sites.flatMap((site) =>
      site.entries.map((entry) => `${site.id}\0${entry.id}`),
    ),
  );
  const activeRefs = new Set(
    sites.flatMap((site) =>
      site.entries.flatMap((entry) =>
        entry.submittedAt === undefined && entry.submissionId === undefined
          ? [`${site.id}\0${entry.id}`]
          : [],
      ),
    ),
  );
  const drafts: ReviewDraft[] = [];
  const seenDrafts = new Set<string>();
  for (const raw of record.drafts) {
    const ref = parseEntryRef(raw);
    if (!ref) continue;
    const key = `${ref.siteId}\0${ref.entryId}`;
    if (activeRefs.has(key) && !seenDrafts.has(key)) {
      seenDrafts.add(key);
      drafts.push(ref);
    }
  }
  const submissions: ReviewSubmissionSummary[] = [];
  const seenSubmissions = new Set<string>();
  for (const raw of record.submissions) {
    const submission = parseSubmission(raw);
    if (submission && !seenSubmissions.has(submission.id)) {
      seenSubmissions.add(submission.id);
      submission.entryRefs = submission.entryRefs.filter((ref) =>
        validRefs.has(`${ref.siteId}\0${ref.entryId}`),
      );
      submissions.push(submission);
    }
  }
  return { version: REVIEW_STORE_FILE_VERSION, sites, drafts, submissions };
}

/** Project canonical state back to the stable version-1 comments response. */
export function projectLegacyReviewComments(
  store: ReviewStoreFile,
): ReviewCommentsFile {
  const draftKeys = new Set(
    store.drafts.map((ref) => `${ref.siteId}\0${ref.entryId}`),
  );
  const submissions = new Map(store.submissions.map((item) => [item.id, item]));
  const comments = store.sites.flatMap((site) =>
    site.entries.map((entry): ReviewComment => {
      const pending = draftKeys.has(`${site.id}\0${entry.id}`);
      const submission = entry.submissionId
        ? submissions.get(entry.submissionId)
        : undefined;
      return {
        id: entry.id,
        anchor: entry.anchor,
        text: entry.text,
        status: pending ? "pending" : "archived",
        createdAt: entry.createdAt,
        ...(!pending
          ? {
              archivedAt: entry.submittedAt,
              batchId: entry.submissionId,
              targetSessionId:
                submission?.targetSessionId ??
                (submission?.requestedTarget !== "new"
                  ? submission?.requestedTarget
                  : undefined),
            }
          : {}),
      };
    }),
  );
  const batches = store.submissions.map(
    (submission): ReviewBatch => ({
      id: submission.id,
      submittedAt: submission.submittedAt,
      targetSessionId:
        submission.targetSessionId ??
        (submission.requestedTarget === "new"
          ? ""
          : submission.requestedTarget),
      commentIds: submission.entryRefs.map((ref) => ref.entryId),
    }),
  );
  return { version: REVIEW_COMMENTS_FILE_VERSION, comments, batches };
}

/** The line-geometry an anchor derives from a clicked diff line. */
export interface PatchLineLocation {
  side: ReviewCommentSide;
  oldLine: number | null;
  newLine: number | null;
  snippet: string;
  /** 0-based index of the clicked line within `snippet`'s lines. */
  snippetAnchorOffset: number;
}

/**
 * Total real diff lines across all hunks — the domain of the flat line index.
 * Hunk headers are not counted (they carry no `data-diff-line`).
 */
export function patchLineCount(hunks: PatchHunk[]): number {
  let total = 0;
  for (const hunk of hunks) total += hunk.lines.length;
  return total;
}

/**
 * Invert the flat line index (the P1↔P2 addressing contract in
 * topics/source-review-to-session.md) into a diff-line anchor, using only
 * `structuredPatch` data — the Shiki
 * HTML stays presentation-only, so anchoring is testable without a browser and
 * cannot drift from what is displayed.
 *
 * The flat index enumerates every hunk's `lines` in order, skipping hunk
 * headers. `contextSide` decides the side for a context line (both sides
 * exist); removed/added lines ignore it.
 */
export function anchorFromPatch(
  hunks: PatchHunk[],
  flatIndex: number,
  contextRadius = DEFAULT_SNIPPET_CONTEXT_RADIUS,
  contextSide: ReviewCommentSide = "new",
): PatchLineLocation | null {
  if (!Number.isInteger(flatIndex) || flatIndex < 0) return null;

  let acc = 0;
  for (const hunk of hunks) {
    if (flatIndex < acc + hunk.lines.length) {
      return locateInHunk(hunk, flatIndex - acc, contextRadius, contextSide);
    }
    acc += hunk.lines.length;
  }
  return null;
}

function locateInHunk(
  hunk: PatchHunk,
  within: number,
  contextRadius: number,
  contextSide: ReviewCommentSide,
): PatchLineLocation {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (let i = 0; i < within; i++) {
    const prefix = hunk.lines[i]?.[0];
    if (prefix === "-") oldLine++;
    else if (prefix === "+") newLine++;
    else {
      oldLine++;
      newLine++;
    }
  }

  const prefix = hunk.lines[within]?.[0];
  let side: ReviewCommentSide;
  let resolvedOld: number | null;
  let resolvedNew: number | null;
  if (prefix === "-") {
    side = "old";
    resolvedOld = oldLine;
    resolvedNew = null;
  } else if (prefix === "+") {
    side = "new";
    resolvedOld = null;
    resolvedNew = newLine;
  } else {
    // Context line: present on both sides; the clicked column decides.
    side = contextSide;
    resolvedOld = oldLine;
    resolvedNew = newLine;
  }

  const start = Math.max(0, within - contextRadius);
  return {
    side,
    oldLine: resolvedOld,
    newLine: resolvedNew,
    snippet: buildSnippet(hunk.lines, within, contextRadius),
    // Offset of the clicked line within the snippet window.
    snippetAnchorOffset: within - start,
  };
}

/** Clicked line ± radius, prefixes stripped, newline-joined, bounded. */
function buildSnippet(
  lines: string[],
  within: number,
  contextRadius: number,
): string {
  const start = Math.max(0, within - contextRadius);
  const end = Math.min(lines.length, within + contextRadius + 1);
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    // Strip the leading ' '/'-'/'+' diff prefix.
    out.push((lines[i] ?? "").slice(1));
  }
  return out.join("\n").slice(0, MAX_REVIEW_SNIPPET_LENGTH);
}
