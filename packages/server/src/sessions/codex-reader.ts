import { readCodexIncrementalSnapshot } from "./codex-incremental-snapshot.js";
import type {
  ProviderChildSource,
  ProviderChildObservation,
} from "./ProviderChildRelationshipService.js";
import {
  readIssueTextBatch,
  type IssueReadOptions,
} from "./issue-text-reader.js";
/**
 * CodexSessionReader - Reads Codex sessions from disk.
 *
 * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * with a different format than Claude:
 * - session_meta: Session initialization (id, cwd, timestamp)
 * - response_item: Messages, reasoning, function calls
 * - event_msg: User/agent messages, token counts
 * - turn_context: Per-turn configuration
 *
 * Unlike Claude's DAG structure, Codex sessions are linear.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  type CodexSessionEntry,
  type NativeSessionRef,
  type CodexSessionMetaEntry,
  type CodexTurnContextEntry,
  type EffortLevel,
  type PermissionMode,
  type ProviderChildSessionSummary,
  type ThinkingConfig,
  type UrlProjectId,
  getModelContextWindow,
  parseCodexSessionEntry,
  nativeSessionRef,
  parseNativeSessionId,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import type { SessionDiscoveryIndex } from "../indexes/SessionDiscoveryIndex.js";
import { getForkedSessionFile } from "./fork-discovery.js";
import {
  codexRootFileIndex,
  type CodexRootFileIndex,
  type CodexRootRead,
} from "./codex-root-file-index.js";
import {
  openCodexSpawnIndex,
  type CodexSpawnIndexLease,
} from "./codex-spawn-index.js";
import { resolveNativeSessionRef } from "./SessionIdentityStore.js";
import { getLogger } from "../logging/logger.js";
import {
  canonicalizeProjectPath,
  getProjectIdentityKey,
} from "../projects/paths.js";
import type {
  ContextUsage,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import {
  codexRolloutRepresentation,
  findCodexRolloutRepresentation,
  getCodexRolloutActivityTimeMs,
  isCompressedCodexRolloutPath,
  isCodexRolloutFileName,
  plainCodexRolloutPath,
  preferPlainCodexRollouts,
} from "../utils/codexRolloutFiles.js";
import {
  iterateJsonlLines,
  iterateJsonlLineRecords,
  readJsonlLines,
} from "../utils/jsonl.js";
import {
  getCodexRolloutTreeEpoch,
  isCodexRolloutTreeEnumerationTrusted,
  reconcileCodexRootObservation,
} from "./codex-rollout-tree-observation.js";
import {
  type CodexScanOptions,
  type CodexSessionFile,
  type CodexSharedScanCacheEntry,
  CodexSessionMap,
  codexSessionsInProject,
  codexSharedScanCache,
  isNewerCodexSessionFile,
  visibleCodexSessions,
} from "./codex-shared-scan-cache.js";
import {
  parseCodexSpawnAgentOutput,
  parseCodexStartedChild,
  codexOutputMayMatch,
} from "./codex-child-launch-metadata.js";
import {
  type CodexRolloutDiscoveryStats,
  createCodexSessionDiscoveryIndex,
  createCodexRolloutDiscoveryStats,
  readCodexRolloutMetadata,
} from "./codex-discovery.js";
import {
  type CodexUserResponseEntry,
  buildCodexUserTurnProvenance,
  codexUserMessageEventText,
  codexUserResponseText,
  countCodexUserTurns,
  findFirstCodexUserTurn,
  isCodexContextualUserResponse,
  isCodexUserMessageEventEntry,
  isCodexUserResponseEntry,
} from "./codex-user-turn-provenance.js";
import {
  getCodexAsyncAgentMessageItem,
  normalizeSession,
  tagCodexEntriesNormalizationSource,
} from "./normalization.js";
import {
  type CodexLineageReadMetrics,
  type CodexRolloutLineage,
  iterateCodexRolloutLineageEntries,
  readCodexRolloutLineageEntries,
  readCodexSessionMeta,
  resolveCodexRolloutLineage,
} from "./codex-rollout-lineage.js";
import {
  type CodexCompactPageSnapshot,
  type CodexCompactTailSnapshot,
  type CodexCompactWindowSnapshot,
  type CodexParsedEntrySnapshot,
  CodexRolloutWindowReader,
} from "./codex-rollout-window.js";
import { SummaryParserClient } from "./summary-parser-worker-client.js";
import {
  type CodexEntryCacheBudget,
  codexEntryCacheBudget,
} from "./codex-entry-cache-budget.js";
import { readCodexAsyncQuestions } from "./codex-async-questions.js";
import type {
  SummaryParserWorkerMode,
  SummaryParserWorkerRequest,
} from "./summary-parser-worker-protocol.js";
import {
  type GetSessionSummaryOptions,
  type GetSessionOptions,
  type ISessionReader,
  type LoadedSession,
  type RecoveredSessionLaunchSettings,
  type SessionListSummary,
  type SessionSummaryReadMode,
  sortProviderChildSessions,
  toSessionListSummary,
} from "./types.js";

export interface CodexSessionReaderOptions {
  /**
   * Base directory for Codex sessions (~/.codex/sessions).
   * Sessions are stored in YYYY/MM/DD/rollout-*.jsonl structure.
   */
  sessionsDir: string;
  /**
   * The project path (cwd) to filter sessions by.
   * Only sessions with this cwd will be listed.
   */
  projectPath?: string;
  dataDir?: string;
  discoveryIndex?: SessionDiscoveryIndex;
  slowLogThresholdMs?: number;
  summaryParserWorkerMode?: SummaryParserWorkerMode;
  summaryParserClient?: SummaryParserClient;
  /** Retention budget for parsed transcripts; process-wide by default. */
  entryCacheBudget?: CodexEntryCacheBudget;
}

const CODEX_SCAN_CACHE_TTL_MS = 5000;
const DEFAULT_SLOW_LOG_THRESHOLD_MS = 250;
const CODEX_HEAD_SUMMARY_MAX_LINES = 200;
const CODEX_HEAD_SUMMARY_MAX_BYTES = 1024 * 1024;
const CODEX_FULL_SUMMARY_CACHE_MAX_ENTRIES = 256;
const LOG_ENTRY_READS = process.env.CODEX_READER_LOG_PARSE === "true";

interface CodexFullSummaryCacheEntry {
  promise: Promise<SessionSummary | null>;
  lastAccessedAt: number;
}

const codexFullSummaryCache = new Map<string, CodexFullSummaryCacheEntry>();

function getCodexFullSummaryCacheKey(
  filePath: string,
  stats: Awaited<ReturnType<typeof stat>>,
): string {
  return `${filePath}\0${Number(stats.mtimeMs)}\0${Number(stats.size)}`;
}

function cloneSessionSummary(
  summary: SessionSummary | null,
): SessionSummary | null {
  if (!summary) return null;
  return {
    ...summary,
    ownership: { ...summary.ownership },
    ...(summary.contextUsage
      ? { contextUsage: { ...summary.contextUsage } }
      : {}),
  };
}

function trimCodexFullSummaryCache(): void {
  if (codexFullSummaryCache.size <= CODEX_FULL_SUMMARY_CACHE_MAX_ENTRIES) {
    return;
  }

  const entriesToDelete = Array.from(codexFullSummaryCache.entries())
    .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)
    .slice(
      0,
      codexFullSummaryCache.size - CODEX_FULL_SUMMARY_CACHE_MAX_ENTRIES,
    );
  for (const [cacheKey] of entriesToDelete) {
    codexFullSummaryCache.delete(cacheKey);
  }
}

export type CodexSessionReaderScanCacheStatus = "hit" | "in-flight" | "miss";

export interface CodexSessionReaderScanMetrics {
  sessionsDir: string;
  projectPath?: string;
  activeAfterMs?: number;
  cacheKey: string;
  sharedCacheStatus: CodexSessionReaderScanCacheStatus;
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
  subagentSessionsSkipped: number;
  sessionsReturned: number;
  discovery: CodexRolloutDiscoveryStats;
}

interface CodexEntryCache {
  filePath: string;
  startByte: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  entries: CodexSessionEntry[];
  /**
   * Decoded JSONL bytes behind `entries`, charged to the retention budget.
   * Not `size`: a zstd rollout's file size understates its parsed heap
   * several-fold, and lineage entries come from other rollout files.
   */
  sourceBytes: number;
  partialLine: Buffer;
  nextLeafOrdinal?: number;
  normalizationSource: object;
  /**
   * True once the retention budget declined or evicted this entry. Its
   * contents remain a valid snapshot for the read that produced it.
   */
  uncached?: boolean;
}

interface CodexReadEntrySnapshot extends CodexParsedEntrySnapshot {
  nextLeafOrdinal?: number;
}

interface CodexEntrySnapshot {
  entries: CodexSessionEntry[];
  transcriptSnapshotUpdatedAt: string;
}

function validateContiguousCodexOrdinals(
  entries: readonly CodexSessionEntry[],
  filePath: string,
  expectedOrdinal?: number,
): number | undefined {
  let nextOrdinal = expectedOrdinal;
  for (const entry of entries) {
    const ordinal = (entry as { ordinal?: unknown }).ordinal;
    if (!Number.isSafeInteger(ordinal) || Number(ordinal) < 0) {
      throw new Error(`Codex rollout has an unsafe leaf ordinal: ${filePath}`);
    }
    const numericOrdinal = Number(ordinal);
    if (nextOrdinal !== undefined && numericOrdinal !== nextOrdinal) {
      throw new Error(
        `Codex rollout has a non-contiguous leaf ordinal: ${filePath}`,
      );
    }
    nextOrdinal = numericOrdinal + 1;
  }
  return nextOrdinal;
}

interface CodexEntryReadOwner {
  promise: Promise<CodexEntryCache | null>;
  joinedCallers: number;
}

interface CodexAgentMapping {
  toolUseId: string;
  agentId: string;
}

interface CodexAgentMappingCache {
  filePath: string;
  fileIdentity: string;
  ctimeMs: number;
  /** A stable file version was verified after extracting these historical ids. */
  verified: boolean;
  /** Partial windows may add known anchors but cannot certify their absence. */
  complete: boolean;
  digest: string;
  mtimeMs: number;
  size: number;
  mappings: CodexAgentMapping[];
}

function codexMappingAnchors(
  cache?: CodexAgentMappingCache,
): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const m of cache?.mappings ?? []) {
    if (m.toolUseId.length > 1024) continue;
    const previous = result.get(m.agentId);
    result.set(
      m.agentId,
      previous === undefined || previous === m.toolUseId ? m.toolUseId : null,
    );
  }
  return result;
}

type CodexEntryReadPurpose =
  | "summary"
  | "detail"
  | "agent-mapping"
  | "subagent";

interface CodexReadEntriesOptions {
  purpose: CodexEntryReadPurpose;
  cache?: boolean;
  startByte?: number;
}

export interface CodexEntryCacheStats {
  sessions: number;
  entries: number;
  sourceBytes: number;
  partialLineBytes: number;
}

export interface CodexAgentMappingCacheStats {
  sessions: number;
  mappings: number;
}

interface CodexEntryReadMetrics {
  event: "codex_entry_read";
  sessionsDir: string;
  projectPath?: string;
  sessionId: string;
  filePath: string;
  purpose: CodexEntryReadPurpose;
  cacheMode: "read-write" | "read-only";
  cacheStatus: "hit" | "append" | "miss";
  fileSize: number;
  fileMtimeMs: number;
  durationMs: number;
  readLinesMs?: number;
  parseMs?: number;
  dedupeMs?: number;
  cacheStoreMs?: number;
  lineCount?: number;
  parsedEntries?: number;
  dedupedEntries?: number;
  maxLineLength?: number;
  heapUsedBefore: number;
  heapUsedAfter: number;
  rssBefore: number;
  rssAfter: number;
  heapUsedDelta: number;
  rssDelta: number;
  entryCache: CodexEntryCacheStats;
}

export interface CodexSummaryStreamMetrics {
  event: "codex_summary_stream";
  readMode: SessionSummaryReadMode;
  sessionsDir: string;
  projectPath?: string;
  sessionId: string;
  filePath: string;
  fileSize: number;
  fileMtimeMs: number;
  compressed: boolean;
  durationMs: number;
  parseMs: number;
  lineCount: number;
  parsedEntries: number;
  dedupedEntries: number;
  skippedDuplicateEntries: number;
  maxLineLength: number;
  stoppedEarly: boolean;
  stopReason: "eof" | "head_complete" | "line_budget" | "byte_budget";
  heapUsedBefore: number;
  heapUsedAfter: number;
  rssBefore: number;
  rssAfter: number;
  heapUsedDelta: number;
  rssDelta: number;
  entryCache: CodexEntryCacheStats;
}

interface CodexSummaryTitleCandidate {
  title: string | null;
  fullTitle: string | null;
}

interface CodexSummaryContextCandidate {
  inputTokens: number;
  contextWindow?: number;
}

interface CodexSummaryState {
  metaEntry?: CodexSessionMetaEntry;
  firstTurnContext?: CodexTurnContextEntry;
  latestTurnContext?: CodexTurnContextEntry;
  firstEventUserTitle?: CodexSummaryTitleCandidate;
  firstLegacyResponseUserTitle?: CodexSummaryTitleCandidate;
  pendingResponseUser?: CodexUserResponseEntry;
  eventUserMessageCount: number;
  legacyResponseUserCount: number;
  assistantMessageCount: number;
  model?: string;
  contextCandidate?: CodexSummaryContextCandidate;
}

const RECOVERABLE_CODEX_EFFORTS = new Set<EffortLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isRecoverableCodexEffort(value: string): value is EffortLevel {
  return RECOVERABLE_CODEX_EFFORTS.has(value as EffortLevel);
}

function recoverCodexPermissionMode(
  turnContext: CodexTurnContextEntry,
): PermissionMode {
  const approvalPolicy = turnContext.payload.approval_policy;
  const sandboxType = turnContext.payload.sandbox_policy?.type;
  if (approvalPolicy === "never" && sandboxType === "danger-full-access") {
    return "bypassPermissions";
  }
  if (approvalPolicy === "on-request" && sandboxType === "read-only") {
    return "plan";
  }
  return "default";
}

function recoverCodexLaunchSettings(
  turnContext: CodexTurnContextEntry | undefined,
): RecoveredSessionLaunchSettings | null {
  if (!turnContext) return null;

  const model = turnContext.payload.model?.trim();
  const effort = turnContext.payload.effort;
  let thinking: ThinkingConfig | undefined;
  let recoveredEffort: EffortLevel | undefined;
  if (effort === "none") {
    thinking = { type: "disabled" };
  } else if (effort && isRecoverableCodexEffort(effort)) {
    thinking = { type: "adaptive", display: "summarized" };
    recoveredEffort = effort;
  }

  return {
    permissionMode: recoverCodexPermissionMode(turnContext),
    ...(model ? { requestedModel: model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(recoveredEffort ? { effort: recoveredEffort } : {}),
  };
}

interface CodexSummaryStreamRead {
  state: CodexSummaryState;
  lineCount: number;
  parsedEntries: number;
  dedupedEntries: number;
  skippedDuplicateEntries: number;
  maxLineLength: number;
  parseMs: number;
  readMode: SessionSummaryReadMode;
  stoppedEarly: boolean;
  stopReason: CodexSummaryStreamMetrics["stopReason"];
}

class CodexAgentMappingCollector {
  private readonly spawnAgentCallIds = new Set<string>();
  private readonly seenToolUseIds = new Set<string>();
  private readonly mappings: CodexAgentMapping[] = [];

  acceptsLine(line: string): boolean {
    if (line.includes('"spawn_agent"')) return true;
    return (
      this.spawnAgentCallIds.size > 0 &&
      ((line.includes('"function_call_output"') &&
        codexOutputMayMatch(line, this.spawnAgentCallIds)) ||
        line.includes('"SubAgentActivity"') ||
        line.includes('"sub_agent_activity"'))
    );
  }

  add(entry: CodexSessionEntry): void {
    const started = parseCodexStartedChild(entry);
    if (
      started &&
      this.spawnAgentCallIds.has(started.toolUseId) &&
      !this.seenToolUseIds.has(started.toolUseId)
    ) {
      this.mappings.push({ toolUseId: started.toolUseId, agentId: started.id });
      this.seenToolUseIds.add(started.toolUseId);
    }
    if (entry.type !== "response_item") {
      return;
    }

    const payload = entry.payload;
    if (payload.type === "function_call" && payload.name === "spawn_agent") {
      this.spawnAgentCallIds.add(payload.call_id);
      return;
    }

    if (
      payload.type !== "function_call_output" ||
      !payload.call_id ||
      !this.spawnAgentCallIds.has(payload.call_id) ||
      this.seenToolUseIds.has(payload.call_id)
    ) {
      return;
    }

    const agentId = parseCodexSpawnAgentOutput(payload.output);
    if (!agentId) {
      return;
    }

    this.mappings.push({ toolUseId: payload.call_id, agentId });
    this.seenToolUseIds.add(payload.call_id);
  }

  result(): CodexAgentMapping[] {
    return this.mappings.map((mapping) => ({ ...mapping }));
  }
}

function agentMappingDigest(mappings: readonly CodexAgentMapping[]): string {
  return createHash("sha256")
    .update(
      mappings
        .map((m) => JSON.stringify([m.toolUseId, m.agentId]))
        .sort()
        .join("\n"),
    )
    .digest("hex");
}

function collectCodexAgentMappings(
  entries: readonly CodexSessionEntry[],
): CodexAgentMapping[] {
  const collector = new CodexAgentMappingCollector();
  for (const entry of entries) {
    collector.add(entry);
  }
  return collector.result();
}

/**
 * Codex-specific session reader for Codex CLI JSONL files.
 *
 * Handles Codex's linear conversation structure with session_meta,
 * response_item, event_msg, and turn_context entries.
 */
export class CodexSessionReader implements ISessionReader {
  private sessionsDir: string;
  private projectPath?: string;
  private projectIdentityKey?: string;
  private dataDir?: string;
  private discoveryIndex?: SessionDiscoveryIndex;
  private slowLogThresholdMs: number;
  private summaryParserWorkerMode: SummaryParserWorkerMode;
  private summaryParserClient?: SummaryParserClient;
  private lastScanMetrics: CodexSessionReaderScanMetrics | null = null;
  private lastSummaryStreamMetrics: CodexSummaryStreamMetrics | null = null;

  private entryCache: Map<string, CodexEntryCache> = new Map();
  private entryReadOwners: Map<string, CodexEntryReadOwner> = new Map();
  private entryCacheRevision = 0;
  private retired = false;
  private readonly childIndexLeases = new Set<CodexSpawnIndexLease>();
  private readonly retirementListeners = new Set<() => void>();
  private readonly entryCacheBudget: CodexEntryCacheBudget;
  private agentMappingCache: Map<string, CodexAgentMappingCache> = new Map();
  private readonly mappingListeners = new Set<(parentId: string) => void>();
  private readonly rolloutWindowReader: CodexRolloutWindowReader;

  constructor(options: CodexSessionReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
    this.projectIdentityKey = this.projectPath
      ? getProjectIdentityKey(this.projectPath)
      : undefined;
    this.dataDir = options.dataDir;
    this.discoveryIndex =
      options.discoveryIndex ??
      createCodexSessionDiscoveryIndex(options.dataDir, this.sessionsDir);
    this.slowLogThresholdMs = Math.max(
      0,
      options.slowLogThresholdMs ?? DEFAULT_SLOW_LOG_THRESHOLD_MS,
    );
    this.summaryParserWorkerMode = options.summaryParserWorkerMode ?? "off";
    this.summaryParserClient = options.summaryParserClient;
    this.entryCacheBudget = options.entryCacheBudget ?? codexEntryCacheBudget;
    this.rolloutWindowReader = new CodexRolloutWindowReader(
      (filePath, start, length) => this.readFileRange(filePath, start, length),
    );
  }

  async close(): Promise<void> {
    this.retired = true;
    for (const lease of this.childIndexLeases) lease.close();
    this.childIndexLeases.clear();
    for (const listener of [...this.retirementListeners]) listener();
    this.retirementListeners.clear();
    this.mappingListeners.clear();
    this.entryCacheRevision += 1;
    for (const cached of this.entryCache.values()) {
      this.entryCacheBudget.release(cached);
    }
    this.entryCache.clear();
    // Existing leases may finish reads from retained native metadata after
    // retirement. Background relationship sources release this reader above.
    this.agentMappingCache.clear();
    const client = this.summaryParserClient;
    this.summaryParserClient = undefined;
    await client?.close();
  }

  invalidateCache(): void {
    this.entryCacheRevision += 1;
    for (const cached of this.entryCache.values()) {
      this.entryCacheBudget.release(cached);
    }
    this.entryCache.clear();
    this.agentMappingCache.clear();
    codexSharedScanCache.delete(this.sessionsDir);
  }

  getLastScanMetrics(): CodexSessionReaderScanMetrics | null {
    return this.lastScanMetrics
      ? cloneCodexSessionReaderScanMetrics(this.lastScanMetrics)
      : null;
  }

  getEntryCacheStats(): CodexEntryCacheStats {
    let entries = 0;
    let sourceBytes = 0;
    let partialLineBytes = 0;

    for (const cached of this.entryCache.values()) {
      entries += cached.entries.length;
      sourceBytes += cached.sourceBytes;
      partialLineBytes += cached.partialLine.length;
    }

    return {
      sessions: this.entryCache.size,
      entries,
      sourceBytes,
      partialLineBytes,
    };
  }

  getAgentMappingCacheStats(): CodexAgentMappingCacheStats {
    let mappings = 0;
    for (const cached of this.agentMappingCache.values()) {
      mappings += cached.mappings.length;
    }
    return { sessions: this.agentMappingCache.size, mappings };
  }

  getLastSummaryStreamMetrics(): CodexSummaryStreamMetrics | null {
    return this.lastSummaryStreamMetrics
      ? { ...this.lastSummaryStreamMetrics }
      : null;
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const sessions = codexSessionsInProject(
      await this.scanSessions(),
      this.projectIdentityKey,
    );
    for (const session of sessions) {
      const summary = await this.getSessionSummary(session.id, projectId);
      if (summary) {
        summaries.push(summary);
      }
    }

    // Sort by updatedAt descending
    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
    options?: GetSessionSummaryOptions,
  ): Promise<SessionSummary | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const inProcessParser = () =>
        this.buildSessionSummaryFromStream(
          sessionId,
          projectId,
          sessionFile.filePath,
          options,
        );

      if (
        options?.readMode === "head" ||
        this.summaryParserWorkerMode === "off"
      ) {
        if (options?.readMode === "head") {
          return await inProcessParser();
        }

        const stats = await stat(sessionFile.filePath);
        return await this.getCoalescedFullSessionSummary(
          sessionFile.filePath,
          stats,
          () =>
            this.buildSessionSummaryFromKnownStats(
              sessionId,
              projectId,
              sessionFile.filePath,
              stats,
              options,
            ),
        );
      }

      const stats = await stat(sessionFile.filePath);
      return await this.getCoalescedFullSessionSummary(
        sessionFile.filePath,
        stats,
        async () => {
          const request: SummaryParserWorkerRequest = {
            type: "parse",
            requestId: randomUUID(),
            provider: "codex",
            filePath: sessionFile.filePath,
            sessionId,
            projectId,
            stats: {
              size: Number(stats.size),
              mtimeMs: Number(stats.mtimeMs),
              mtimeIso: stats.mtime.toISOString(),
            },
            sourceHints: {
              codex: {
                sessionsDir: this.sessionsDir,
                ...(this.projectPath ? { projectPath: this.projectPath } : {}),
                ...(this.dataDir ? { dataDir: this.dataDir } : {}),
              },
            },
          };
          const result = await this.getSummaryParserClient().parse(
            request,
            inProcessParser,
          );
          return result.summary;
        },
      );
    } catch {
      return null;
    }
  }

  async getSessionListSummary(
    sessionId: string,
    projectId: UrlProjectId,
    summaryHint?: SessionListSummary,
    options?: { deferAsyncQuestions?: boolean },
  ): Promise<SessionListSummary | null> {
    if (summaryHint && options?.deferAsyncQuestions) {
      return toSessionListSummary(summaryHint);
    }
    if (summaryHint) {
      const sessionFile = await this.findSessionFile(sessionId);
      if (!sessionFile) return null;
      try {
        return {
          ...toSessionListSummary(summaryHint),
          asyncQuestions: await readCodexAsyncQuestions(sessionFile.filePath),
        };
      } catch {
        // Match summary reads when the provider source becomes unreadable.
        return null;
      }
    }
    const summary = await this.getSessionSummary(sessionId, projectId, {
      readMode: "head",
      deferAsyncQuestions: options?.deferAsyncQuestions,
    });
    return summary ? toSessionListSummary(summary) : null;
  }

  async getRecoveredLaunchSettings(
    sessionId: string,
  ): Promise<RecoveredSessionLaunchSettings | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const stats = await stat(sessionFile.filePath);
      const read = await this.readSummaryStream(
        sessionId,
        sessionFile.filePath,
        stats,
        "full",
      );
      return recoverCodexLaunchSettings(read.state.latestTurnContext);
    } catch {
      return null;
    }
  }

  async readIssueTextBatch(sessionId: string, options: IssueReadOptions) {
    options.signal.throwIfAborted();
    const file = await this.findSessionFile(sessionId);
    if (!file) throw new Error("Session source unavailable");
    if (file.filePath.endsWith(".gz"))
      throw new Error("Compressed issue indexing is unavailable");
    const lineage = await resolveCodexRolloutLineage({
      requestedSessionId: sessionId,
      leafFilePath: file.filePath,
      resolveRolloutPath: (id) => this.findRolloutPathById(id),
      maxSegments: 32,
      signal: options.signal,
    });
    const segments = lineage.referenceBacked
      ? lineage.segments.map((segment) => ({
          path: segment.filePath,
          end: segment.end?.end_byte_offset,
          ordinal: true,
        }))
      : [{ path: file.filePath }];
    return readIssueTextBatch("codex", segments, options);
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const requestedTailCompactions = options?.tailCompactions;
      const beforeMessageId = options?.beforeMessageId;
      const summaryHint = options?.summaryHint;
      let compactWindow: CodexCompactWindowSnapshot | null = null;
      let referenceBackedHistory = false;
      if (
        Number.isInteger(requestedTailCompactions) &&
        requestedTailCompactions !== undefined &&
        requestedTailCompactions > 0 &&
        (summaryHint?.provider === "codex" ||
          summaryHint?.provider === "codex-oss")
      ) {
        referenceBackedHistory = Boolean(
          (await readCodexSessionMeta(sessionFile.filePath)).payload
            .history_base,
        );
        const stats = await stat(sessionFile.filePath);
        const snapshotUpdatedAt = new Date(
          getCodexRolloutActivityTimeMs(sessionFile.filePath, stats),
        ).toISOString();
        // The hint's relationship to the file was validated where it was
        // fetched, and it only supplies head-derived fields: the window itself
        // is read from the live file. Reject only a hint claiming to be newer
        // than the file, which means the rollout was replaced or rewound
        // rather than appended to.
        if (
          !referenceBackedHistory &&
          summaryHint.updatedAt <= snapshotUpdatedAt
        ) {
          compactWindow = afterMessageId
            ? await this.readIncrementalSnapshot(
                sessionId,
                sessionFile.filePath,
                stats,
                requestedTailCompactions,
                afterMessageId,
                summaryHint,
              )
            : beforeMessageId
              ? await this.readCompactPageSnapshot(
                  sessionFile.filePath,
                  stats,
                  requestedTailCompactions,
                  beforeMessageId,
                )
              : await this.readCompactTailSnapshot(
                  sessionFile.filePath,
                  stats,
                  requestedTailCompactions,
                );
          if (compactWindow)
            this.cacheAgentMappingsFromEntries({
              sessionId,
              filePath: sessionFile.filePath,
              startByte: compactWindow.startByte,
              completeFile: false,
              stats,
              entries: compactWindow.entries,
            });
        }
      }

      const transcriptSnapshot =
        compactWindow ??
        (await this.readEntries(sessionId, sessionFile.filePath, {
          purpose: "detail",
          cache: true,
        }));
      const { entries, transcriptSnapshotUpdatedAt } = transcriptSnapshot;
      const summary = compactWindow
        ? this.refreshTailDerivedSummary(
            cloneSessionSummary(summaryHint ?? null),
            compactWindow,
          )
        : await this.buildSessionSummaryFromEntries(
            sessionId,
            projectId,
            entries,
            transcriptSnapshotUpdatedAt,
          );
      if (!summary) return null;

      const provider = compactWindow
        ? summary.provider === "codex-oss"
          ? "codex-oss"
          : "codex"
        : this.determineProviderFromEntries(entries);
      return {
        summary,
        transcriptSnapshotUpdatedAt,
        ...(compactWindow
          ? {
              readWindow:
                compactWindow.kind === "compact-tail"
                  ? {
                      kind: compactWindow.kind,
                      omittedPrefix: compactWindow.omittedPrefix,
                      startByte: compactWindow.startByte,
                      compactBoundaries: compactWindow.compactBoundaries,
                    }
                  : {
                      kind: compactWindow.kind,
                      omittedPrefix: compactWindow.omittedPrefix,
                      startByte: compactWindow.startByte,
                      endByte: compactWindow.endByte,
                      compactBoundaries: compactWindow.compactBoundaries,
                    },
            }
          : {}),
        data: {
          provider,
          session: {
            entries,
          },
        },
      };
    } catch (error) {
      getLogger().error(
        {
          event: "codex_session_detail_read_failed",
          sessionId,
          filePath: sessionFile.filePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "CODEX_READER: detail read failed",
      );
      throw error;
    }
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const stats = await stat(sessionFile.filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // If mtime and size match cached values, return null (no change)
      if (mtime === cachedMtime && size === cachedSize) {
        return null;
      }

      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null;
    }
  }

  /** Caches the agent mappings a complete read of the session file describes. */
  private cacheAgentMappingsFromEntries(options: {
    sessionId: string;
    filePath: string;
    /** Byte the read began at; a windowed read describes only its own tail. */
    startByte: number;
    /** An oldest page starts at zero but still omits the file's newer tail. */
    completeFile?: boolean;
    stats: Awaited<ReturnType<typeof stat>>;
    entries: readonly CodexSessionEntry[];
  }): void {
    const { sessionId, filePath, startByte, stats, entries } = options;
    const mtimeMs = Number(stats.mtimeMs),
      size = Number(stats.size),
      ctimeMs = Number(stats.ctimeMs);
    const fileIdentity = `${Number(stats.dev)}\0${Number(stats.ino)}`;
    const complete = options.completeFile ?? startByte === 0;
    if (this.retired) return;

    const cached = this.agentMappingCache.get(sessionId);
    if (
      cached?.filePath === filePath &&
      cached.mtimeMs === mtimeMs &&
      cached.ctimeMs === ctimeMs &&
      cached.fileIdentity === fileIdentity &&
      cached.complete &&
      cached.size === size
    ) {
      return;
    }

    const observed = collectCodexAgentMappings(entries);
    // Windowed reads know only their own positive anchors. An empty tail must
    // neither erase historical mappings nor claim complete-file coverage.
    if (!complete && !observed.length) return;
    const mappings =
      !complete &&
      cached?.fileIdentity === fileIdentity &&
      cached.filePath === filePath
        ? [
            ...new Map(
              [...cached.mappings, ...observed].map((m) => [m.toolUseId, m]),
            ).values(),
          ]
        : observed;
    const digest = agentMappingDigest(mappings);
    this.agentMappingCache.set(sessionId, {
      filePath,
      fileIdentity,
      ctimeMs,
      verified: false,
      complete,
      digest,
      mtimeMs,
      size,
      mappings,
    });
    if (cached?.fileIdentity !== fileIdentity || cached.digest !== digest)
      for (const listener of this.mappingListeners) listener(sessionId);
  }

  private async readAgentMappings(
    session: CodexSessionFile,
  ): Promise<CodexAgentMapping[]> {
    const startedAt = Date.now();
    const memoryBefore = process.memoryUsage();
    const stats = await stat(session.filePath);
    const cached = this.agentMappingCache.get(session.id);
    if (
      cached?.filePath === session.filePath &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.ctimeMs === stats.ctimeMs &&
      cached.fileIdentity === `${Number(stats.dev)}\0${Number(stats.ino)}` &&
      cached.complete &&
      cached.size === stats.size
    ) {
      this.recordEntryReadMetrics({
        startedAt,
        memoryBefore,
        sessionId: session.id,
        filePath: session.filePath,
        purpose: "agent-mapping",
        cacheMode: "read-only",
        cacheStatus: "hit",
        stats,
        parsedEntries: cached.mappings.length,
        dedupedEntries: cached.mappings.length,
      });
      return cached.mappings.map((mapping) => ({ ...mapping }));
    }

    const collector = new CodexAgentMappingCollector();
    const readStartedAt = Date.now();
    let lineCount = 0;
    let maxLineLength = 0;
    let parsedEntries = 0;
    let parseMs = 0;
    for await (const { line, terminated } of iterateJsonlLineRecords(
      session.filePath,
    )) {
      if (!terminated) break;
      lineCount += 1;
      maxLineLength = Math.max(maxLineLength, line.length);
      if (!collector.acceptsLine(line)) {
        continue;
      }

      const parseStartedAt = Date.now();
      const entry = parseCodexSessionEntry(line);
      parseMs += Date.now() - parseStartedAt;
      if (!entry) {
        continue;
      }
      parsedEntries += 1;
      collector.add(entry);
    }
    const readLinesMs = Date.now() - readStartedAt;
    const mappings = collector.result();
    const after = await stat(session.filePath);
    if (
      after.dev !== stats.dev ||
      after.ino !== stats.ino ||
      after.size < stats.size
    )
      throw new Error("Codex launch mapping source replaced during read");
    if (this.retired) return [];
    const cacheStoreStartedAt = Date.now();
    // Appending while this request streams is normal. Return the terminated
    // prefix it observed, without certifying whole-file coverage or caching
    // proof against a version that did not surround the read.
    if (
      after.size === stats.size &&
      after.mtimeMs === stats.mtimeMs &&
      after.ctimeMs === stats.ctimeMs
    ) {
      const digest = agentMappingDigest(mappings);
      const fileIdentity = `${Number(stats.dev)}\0${Number(stats.ino)}`;
      this.agentMappingCache.set(session.id, {
        filePath: session.filePath,
        fileIdentity,
        ctimeMs: stats.ctimeMs,
        verified: true,
        complete: true,
        digest,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        mappings,
      });
      if (cached?.fileIdentity !== fileIdentity || cached.digest !== digest)
        for (const listener of this.mappingListeners) listener(session.id);
    }
    const cacheStoreMs = Date.now() - cacheStoreStartedAt;
    this.recordEntryReadMetrics({
      startedAt,
      memoryBefore,
      sessionId: session.id,
      filePath: session.filePath,
      purpose: "agent-mapping",
      cacheMode: "read-only",
      cacheStatus: "miss",
      stats,
      readLinesMs,
      parseMs,
      cacheStoreMs,
      lineCount,
      parsedEntries,
      dedupedEntries: mappings.length,
      maxLineLength,
    });
    return mappings.map((mapping) => ({ ...mapping }));
  }

  private async verifyMappingCache(
    candidate: CodexAgentMappingCache,
  ): Promise<boolean> {
    const file = await open(
      candidate.filePath,
      constants.O_RDONLY |
        (process.platform === "win32"
          ? 0
          : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    );
    try {
      const matches = (s: Awaited<ReturnType<typeof stat>>) =>
        s.isFile() &&
        candidate.fileIdentity === `${Number(s.dev)}\0${Number(s.ino)}` &&
        candidate.size === Number(s.size) &&
        candidate.mtimeMs === Number(s.mtimeMs) &&
        candidate.ctimeMs === Number(s.ctimeMs);
      if (!matches(await file.stat())) return false;
      // The display reader accepts a valid JSON EOF before its newline. New
      // plain-file durable anchors wait for record termination. A compressed
      // archive is instead fenced by its complete decompression/file version.
      if (!isCompressedCodexRolloutPath(candidate.filePath)) {
        if (!candidate.size) return false;
        const end = Buffer.alloc(1);
        const { bytesRead } = await file.read(end, 0, 1, candidate.size - 1);
        if (bytesRead !== 1 || end[0] !== 0x0a) return false;
      }
      return matches(await file.stat());
    } finally {
      await file.close();
    }
  }

  async getAgentMappings(
    parentSessionId?: string,
  ): Promise<{ toolUseId: string; agentId: string }[]> {
    if (this.retired) return [];
    const parentSession = parentSessionId
      ? await this.findSessionFile(parentSessionId)
      : null;
    const sessions = parentSessionId
      ? parentSession
        ? [parentSession]
        : []
      : await this.scanSessions();
    const mappings: { toolUseId: string; agentId: string }[] = [];
    const seenToolUseIds = new Set<string>();

    for (const session of sessions) {
      if (
        this.projectIdentityKey &&
        getProjectIdentityKey(session.cwd) !== this.projectIdentityKey
      ) {
        continue;
      }

      for (const mapping of await this.readAgentMappings(session)) {
        if (seenToolUseIds.has(mapping.toolUseId)) continue;
        mappings.push(mapping);
        seenToolUseIds.add(mapping.toolUseId);
      }
    }

    return mappings;
  }

  async getAgentSession(
    agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    const sessionFile = await this.findSessionFile(agentId);
    if (!sessionFile) return null;

    const { entries, transcriptSnapshotUpdatedAt } = await this.readEntries(
      agentId,
      sessionFile.filePath,
      {
        purpose: "subagent",
        cache: true,
      },
    );
    if (entries.length === 0) return null;

    const metaEntry = entries.find((e) => e.type === "session_meta") as
      | CodexSessionMetaEntry
      | undefined;
    if (!metaEntry) return null;

    const { title, fullTitle } = this.extractTitle(entries);
    const provider = this.determineProviderFromEntries(entries);
    const summary: SessionSummary = {
      id: agentId,
      projectId: "codex-subagent" as UrlProjectId,
      title,
      fullTitle,
      createdAt: metaEntry.payload.timestamp,
      updatedAt: sessionFile.timestamp,
      messageCount: this.countMessages(entries),
      ownership: { owner: "none" },
      provider,
    };
    const loaded: LoadedSession = {
      summary,
      transcriptSnapshotUpdatedAt,
      data: {
        provider,
        session: { entries },
      },
    };
    const session = normalizeSession(loaded);

    return {
      messages: session.messages.map((message) => ({
        ...message,
        isSubagent: true,
      })),
      status: inferCodexAgentStatus(entries),
    };
  }

  getProviderChildSource(
    parent: NativeSessionRef,
  ): ProviderChildSource | undefined {
    if (parent.family !== "codex") return undefined;
    let lastVersion: string | undefined;
    let lastEntry: CodexSharedScanCacheEntry | undefined;
    let lastEpoch: number | null = null;
    let lastCacheEntry: CodexAgentMappingCache | undefined;
    let lastAnchors: CodexAgentMappingCache | undefined;
    const historicalAnchors = new Map<string, string | undefined>();
    let emittedAnchors = new Map<string, string | undefined>();
    let anchors = new Map<string, string | null>();
    const readAnchors = () => codexMappingAnchors(lastAnchors);
    const snapshot = (entry: CodexSharedScanCacheEntry) => {
      const children = this.materializeNativeChildren(
        parent.id,
        entry,
        anchors,
        historicalAnchors,
      ).map((summary) => ({
        native: nativeSessionRef(
          "codex",
          parent.storageScope,
          parseNativeSessionId(summary.id),
        ),
        summary,
        metadataAvailable: !!summary.toolUseId,
        version: "",
      }));
      for (const child of children) {
        const { updatedAt: _activity, ...summary } = child.summary;
        child.version = createHash("sha256")
          .update(JSON.stringify({ native: child.native, summary }))
          .digest("hex");
      }
      children.sort((a, b) => a.native.id.localeCompare(b.native.id));
      const state = entry.incomplete
        ? ("partial" as const)
        : ("complete" as const);
      return {
        state,
        children,
        version: createHash("sha256")
          .update(
            JSON.stringify({
              state,
              children: children.map(
                ({
                  native,
                  summary: { updatedAt: _activity, ...summary },
                }) => ({ native, summary }),
              ),
            }),
          )
          .digest("hex"),
      };
    };
    let indexLease: CodexSpawnIndexLease | undefined;
    let pointCurrent: (() => Promise<boolean>) | undefined;
    const releaseIndex = () => {
      if (indexLease) {
        indexLease.close();
        this.childIndexLeases.delete(indexLease);
        indexLease = undefined;
      }
      pointCurrent = undefined;
    };
    const finishObservation = async (
      entry: CodexSharedScanCacheEntry,
      previousMetadata: Parameters<ProviderChildSource["observe"]>[1],
    ): Promise<ProviderChildObservation> => {
      const candidate = this.agentMappingCache.get(parent.id);
      lastCacheEntry = candidate;
      const historical = lastAnchors;
      lastAnchors = undefined;
      if (
        candidate &&
        candidate.filePath === entry.sessions.get(parent.id)?.filePath
      ) {
        const current = await stat(candidate.filePath).catch(() => undefined);
        if (current) {
          const identity = `${Number(current.dev)}\0${Number(current.ino)}`;
          if (
            Number(current.size) >= candidate.size &&
            candidate.fileIdentity === identity &&
            (candidate.verified ||
              (await this.verifyMappingCache(candidate).catch(() => false)))
          ) {
            candidate.verified = true;
            lastAnchors = candidate;
          } else if (
            historical?.verified &&
            historical.filePath === candidate.filePath &&
            Number(current.size) >= historical.size &&
            historical.fileIdentity === identity
          )
            lastAnchors = historical;
        }
      }
      // Structure comes from each child's native parent proof. A long parent
      // transcript is irrelevant to enumerating its children (including none).
      // Use the current catalog, not the reader's historical best-file cache:
      // that cache intentionally retains deleted/backdated native records.
      anchors = readAnchors();
      const present = new Set<string>();
      for (const child of entry.sessions.values()) {
        if (child.parentThreadId !== parent.id) continue;
        present.add(child.id);
        // Query SQL once for a newly seen child, or when transient native
        // metadata disappeared after emitting an anchor SQL may now retain.
        // isCurrent reuses this acquisition's snapshot, never repeating SQL.
        if (
          !anchors.get(child.id) &&
          (!historicalAnchors.has(child.id) ||
            historicalAnchors.get(child.id) !== emittedAnchors.get(child.id))
        ) {
          const native = nativeSessionRef(
            "codex",
            parent.storageScope,
            parseNativeSessionId(child.id),
          );
          historicalAnchors.set(
            child.id,
            previousMetadata?.(native)?.toolUseId,
          );
        } else if (!historicalAnchors.has(child.id))
          historicalAnchors.set(child.id, undefined);
      }
      for (const id of historicalAnchors.keys())
        if (!present.has(id)) historicalAnchors.delete(id);
      const observation = snapshot(entry);
      emittedAnchors = new Map(
        observation.children.map((c) => [c.native.id, c.summary.toolUseId]),
      );
      lastEntry = entry;
      lastEpoch = getCodexRolloutTreeEpoch(this.sessionsDir);
      lastVersion = observation.version;
      return observation;
    };
    const readPoint = async (path: string, id: string) => {
      parseNativeSessionId(id);
      const physical = await realpath(path);
      const suffix = relative(parent.storageScope, physical);
      if (
        !suffix ||
        suffix === ".." ||
        suffix.startsWith(`..${sep}`) ||
        isAbsolute(suffix)
      )
        throw new Error("Codex child locator escaped native scope");
      const lexical = join(this.sessionsDir, suffix);
      if ((await realpath(lexical)) !== physical)
        throw new Error("Codex child source root changed");
      const before = await stat(physical);
      if (isCompressedCodexRolloutPath(physical))
        throw new Error("Codex native spawn locator requires a plain rollout");
      const handle = await open(physical, "r");
      let terminated = false;
      try {
        const bytes = Buffer.alloc(4096);
        for (let offset = 0; offset < 1024 * 1024; offset += bytes.length) {
          const { bytesRead } = await handle.read(
            bytes,
            0,
            bytes.length,
            offset,
          );
          if (bytes.subarray(0, bytesRead).includes(10)) {
            terminated = true;
            break;
          }
          if (bytesRead < bytes.length) break;
        }
      } finally {
        await handle.close();
      }
      if (!terminated) throw new Error("Codex native metadata is incomplete");
      const session = await this.readSessionMeta(
        lexical,
        undefined,
        undefined,
        true,
      );
      const after = await stat(physical);
      if (
        !session ||
        session.id !== id ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        (this.projectIdentityKey &&
          getProjectIdentityKey(session.cwd) !== this.projectIdentityKey)
      )
        throw new Error("Codex child locator metadata mismatch");
      return {
        session,
        proof: JSON.stringify([
          physical,
          before.dev,
          before.ino,
          session.id,
          session.cwd,
          session.parentThreadId,
          session.isSubagent,
          session.agentNickname,
          session.agentRole,
          session.spawnDepth,
        ]),
      };
    };
    return {
      isRetired: () => this.retired,
      owner: this,
      ownsNativeScope: async () =>
        (await realpath(this.sessionsDir).catch(() => undefined)) ===
        parent.storageScope,
      onRetire: (listener) => {
        this.retirementListeners.add(listener);
        return () => this.retirementListeners.delete(listener);
      },
      onMetadataAvailable: (listener) => {
        const changed = (id: string) => {
          if (id === parent.id) listener();
        };
        this.mappingListeners.add(changed);
        return () => this.mappingListeners.delete(changed);
      },
      ownsFileChange: (event) =>
        [this.sessionsDir, parent.storageScope].some((root) => {
          const suffix = relative(root, event.path);
          return (
            suffix !== ".." &&
            !suffix.startsWith(`..${sep}`) &&
            !isAbsolute(suffix)
          );
        }),
      parentsForChanges: async (ids, signal) => {
        if (signal.aborted || this.retired)
          throw new Error("Codex child observation retired");
        await this.scanSessions();
        // A cold/in-flight walk can finish with watcher reports still pending.
        // Fold those through the shared cache before addressing new children.
        if (
          codexSharedScanCache
            .get(this.sessionsDir)
            ?.get(this.getSharedScanCacheKey())?.changedPaths.size
        )
          await this.scanSessions();
        if (signal.aborted || this.retired)
          throw new Error("Codex child observation retired");
        const catalog = codexSharedScanCache
          .get(this.sessionsDir)
          ?.get(this.getSharedScanCacheKey());
        return ids.flatMap((id) => {
          const parentId = catalog?.sessions.get(id)?.parentThreadId;
          return parentId ? [parentId] : [];
        });
      },
      overlayActivity: (children) => {
        const catalog = this.retired
          ? undefined
          : codexSharedScanCache
              .get(this.sessionsDir)
              ?.get(this.getSharedScanCacheKey());
        return children
          .map((child) => {
            const native = catalog?.sessions.get(child.id);
            return native?.parentThreadId === parent.id
              ? { ...child, updatedAt: new Date(native.mtime).toISOString() }
              : child;
          })
          .sort(
            (a, b) =>
              b.updatedAt.localeCompare(a.updatedAt) ||
              a.id.localeCompare(b.id),
          );
      },
      observe: async (signal, previousMetadata) => {
        releaseIndex();
        if (signal.aborted || this.retired)
          throw new Error("Codex child observation retired");
        if ((await realpath(this.sessionsDir)) !== parent.storageScope)
          throw new Error("Codex child observation scope mismatch");
        await reconcileCodexRootObservation(this.sessionsDir);
        await this.scanSessions();
        let entry = codexSharedScanCache
          .get(this.sessionsDir)
          ?.get(this.getSharedScanCacheKey());
        if (
          entry &&
          entry.epoch !== getCodexRolloutTreeEpoch(this.sessionsDir)
        ) {
          // Enumeration from before watcher start/recovery cannot certify the
          // new epoch. Rebuild once, rather than laundering its old empty set.
          codexSharedScanCache
            .get(this.sessionsDir)
            ?.delete(this.getSharedScanCacheKey());
          await this.scanSessions();
          entry = codexSharedScanCache
            .get(this.sessionsDir)
            ?.get(this.getSharedScanCacheKey());
        } else if (entry?.inFlight) {
          await this.scanSessions();
          entry = codexSharedScanCache
            .get(this.sessionsDir)
            ?.get(this.getSharedScanCacheKey());
        }
        // The caller supplies the authorized native binding. Its original
        // YA project need not equal a fork/worktree's native working directory.
        if (signal.aborted || this.retired || !entry?.sessions.has(parent.id))
          throw new Error("Codex parent metadata unavailable");
        return finishObservation(entry, previousMetadata);
      },
      releaseObservation: releaseIndex,
      refreshMetadata: async (signal, previousMetadata) => {
        releaseIndex();
        if (signal.aborted || this.retired)
          throw new Error("Codex child observation retired");
        const pointIndex = codexRootFileIndex(this.sessionsDir);
        const pointRead = pointIndex.readVersion();
        if ((await realpath(this.sessionsDir)) !== parent.storageScope)
          throw new Error("Codex child observation scope mismatch");
        const lease = await openCodexSpawnIndex(this.sessionsDir);
        if (!lease) return undefined;
        if (signal.aborted || this.retired) {
          lease.close();
          return undefined;
        }
        indexLease = lease;
        this.childIndexLeases.add(lease);
        try {
          const rows = lease.read(parent.id);
          if (!rows.length) {
            releaseIndex();
            return undefined;
          }
          const rowVersion = JSON.stringify(rows);
          const points = new Map<string, { path: string; proof: string }>();
          const sessions = new CodexSessionMap();
          const p = await readPoint(rows[0]!.parentPath, parent.id);
          sessions.set(parent.id, p.session);
          points.set(parent.id, { path: rows[0]!.parentPath, proof: p.proof });
          for (const row of rows) {
            if (signal.aborted || this.retired)
              throw new Error("Codex child observation retired");
            if (!row.childId || !row.childPath || row.childId === parent.id)
              continue;
            try {
              const point = await readPoint(row.childPath, row.childId);
              // Native ownership can change after attachment. Creation parentage
              // still requires this child's own qualified thread-spawn header.
              if (point.session.parentThreadId !== parent.id) continue;
              sessions.set(row.childId, point.session);
              points.set(row.childId, {
                path: row.childPath,
                proof: point.proof,
              });
            } catch {
              /* Unavailable locators cannot erase accepted history. */
            }
          }
          const entry: CodexSharedScanCacheEntry = {
            sessions,
            changedPaths: new Set(),
            incomplete: true,
          };
          pointCurrent = async () => {
            if (
              this.retired ||
              signal.aborted ||
              !pointIndex.accepts(pointRead) ||
              !(await lease.isCurrent()) ||
              (await realpath(this.sessionsDir).catch(() => undefined)) !==
                parent.storageScope ||
              JSON.stringify(lease.read(parent.id)) !== rowVersion
            )
              return false;
            for (const [id, point] of points)
              if ((await readPoint(point.path, id)).proof !== point.proof)
                return false;
            if (this.retired || signal.aborted) return false;
            return pointIndex.observePoints([...sessions.values()], pointRead);
          };
          const observation = await finishObservation(entry, previousMetadata);
          const observedAnchors = new Map<string, string | undefined>(
            observation.children.map((c) => [c.native.id, c.summary.toolUseId]),
          );
          return {
            ...observation,
            needsFullMetadata:
              lastAnchors?.mappings.some(
                (m) => observedAnchors.get(m.agentId) !== m.toolUseId,
              ) ?? false,
          };
        } catch (error) {
          releaseIndex();
          if (signal.aborted || this.retired) throw error;
          // The native index is optional locator evidence. Busy recovery,
          // archived paths and old rows must leave the full handoff available.
          return undefined;
        }
      },
      isCurrent: async (version) => {
        const current = codexSharedScanCache
          .get(this.sessionsDir)
          ?.get(this.getSharedScanCacheKey());
        const anchorIdentityCurrent =
          !lastAnchors ||
          (await stat(lastAnchors.filePath).then(
            (s) =>
              Number(s.size) >= lastAnchors!.size &&
              lastAnchors!.fileIdentity ===
                `${Number(s.dev)}\0${Number(s.ino)}`,
            () => false,
          ));
        const point = pointCurrent
          ? await pointCurrent().catch(() => false)
          : undefined;
        return (
          !this.retired &&
          anchorIdentityCurrent &&
          (!this.agentMappingCache.get(parent.id) ||
            this.agentMappingCache.get(parent.id)?.digest ===
              lastCacheEntry?.digest) &&
          (point !== undefined
            ? point &&
              version === lastVersion &&
              !!lastEntry &&
              snapshot(lastEntry).version === version
            : !!current &&
              current === lastEntry &&
              version === lastVersion &&
              getCodexRolloutTreeEpoch(this.sessionsDir) === lastEpoch &&
              (current.epoch ?? null) === lastEpoch &&
              current.sessions.has(parent.id) &&
              !current.needsEnumeration &&
              !current.inFlight &&
              !current.applyingChanges &&
              !current.changedPaths.size &&
              snapshot(current).version === version)
        );
      },
    };
  }

  /** Explicit fresh native metadata, never a parent-body replay. */
  async listProviderChildSessions(
    parentSessionId: string,
  ): Promise<ProviderChildSessionSummary[]> {
    if (this.retired) return [];
    const native = await this.getNativeSessionRef(
      parseNativeSessionId(parentSessionId),
    );
    if (!native) return [];
    await this.scanSessions();
    const parent = codexSharedScanCache
      .get(this.sessionsDir)
      ?.get(this.getSharedScanCacheKey())
      ?.sessions.get(parentSessionId);
    if (
      !parent ||
      (this.projectIdentityKey &&
        getProjectIdentityKey(parent.cwd) !== this.projectIdentityKey)
    )
      return [];
    const source = this.getProviderChildSource(native)!;
    let lastObservation: ProviderChildObservation | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const observation = await source.observe(new AbortController().signal);
        lastObservation = observation;
        if (await source.isCurrent(observation.version))
          return sortProviderChildSessions(
            observation.children.map((c) => c.summary),
          );
      } catch {
        if (this.retired) return [];
        // Raw adapters tolerate disappearing native storage. SQL publication
        // retains its stricter validation; this is only a historical view.
      } finally {
        source.releaseObservation?.();
      }
    }
    return (
      this.listAcceptedProviderChildSessions(parentSessionId) ??
      sortProviderChildSessions(
        lastObservation?.children.map((c) => c.summary) ?? [],
      )
    );
  }

  /** Pure accepted header metadata. Cold callers must explicitly request freshness. */
  listAcceptedProviderChildSessions(
    parentSessionId: string,
  ): ProviderChildSessionSummary[] | undefined {
    if (this.retired) return undefined;
    const entry = codexSharedScanCache
      .get(this.sessionsDir)
      ?.get(this.getSharedScanCacheKey());
    const parent = entry?.sessions.get(parentSessionId);
    if (
      !entry ||
      !parent ||
      entry.inFlight ||
      entry.applyingChanges ||
      entry.changedPaths.size ||
      entry.needsEnumeration ||
      (this.projectIdentityKey &&
        getProjectIdentityKey(parent.cwd) !== this.projectIdentityKey) ||
      (entry.epoch ?? null) !== getCodexRolloutTreeEpoch(this.sessionsDir) ||
      (!isCodexRolloutTreeEnumerationTrusted(this.sessionsDir, entry.epoch) &&
        (entry.timestamp === undefined ||
          Date.now() - entry.timestamp >= CODEX_SCAN_CACHE_TTL_MS))
    )
      return undefined;
    const cache = this.agentMappingCache.get(parentSessionId);
    const children = this.materializeNativeChildren(
      parentSessionId,
      entry,
      cache?.verified &&
        cache.filePath === parent.filePath &&
        cache.size <= parent.size &&
        cache.mtimeMs <= parent.mtime
        ? codexMappingAnchors(cache)
        : undefined,
    );
    return children.length || !entry.incomplete
      ? sortProviderChildSessions(children)
      : undefined;
  }

  private materializeNativeChildren(
    parentId: string,
    entry: CodexSharedScanCacheEntry,
    anchors?: ReadonlyMap<string, string | null>,
    historical?: ReadonlyMap<string, string | undefined>,
  ): ProviderChildSessionSummary[] {
    const children: ProviderChildSessionSummary[] = [];
    for (const child of entry.sessions.values()) {
      if (child.parentThreadId !== parentId) continue;
      const toolUseId = anchors?.get(child.id) ?? historical?.get(child.id);
      children.push({
        id: child.id,
        parentSessionId: parentId,
        ...(toolUseId ? { toolUseId } : {}),
        ...(child.agentNickname
          ? { title: truncateSessionTitle(child.agentNickname) }
          : {}),
        ...(child.agentRole
          ? { agentType: child.agentRole.slice(0, 256) }
          : {}),
        ...(child.spawnDepth !== undefined
          ? { spawnDepth: child.spawnDepth }
          : {}),
        updatedAt: new Date(child.mtime).toISOString(),
      });
    }
    return children;
  }

  /**
   * Scan the sessions directory and find all session files.
   */
  private async scanSessions(
    options?: CodexScanOptions,
  ): Promise<readonly CodexSessionFile[]> {
    const cacheKey = this.getSharedScanCacheKey(options);
    let rootCache = codexSharedScanCache.get(this.sessionsDir);
    if (!rootCache) {
      rootCache = new Map();
      codexSharedScanCache.set(this.sessionsDir, rootCache);
    }
    const fileIndex = codexRootFileIndex(this.sessionsDir);
    const lookupRead = fileIndex.readVersion();
    const cached = rootCache.get(cacheKey);
    const now = Date.now();

    if (
      cached &&
      (cached.inFlight ||
        (cached.timestamp !== undefined &&
          (isCodexRolloutTreeEnumerationTrusted(
            this.sessionsDir,
            cached.epoch,
          ) ||
            now - cached.timestamp < CODEX_SCAN_CACHE_TTL_MS)))
    ) {
      const metrics = createCodexSessionReaderScanMetrics({
        sessionsDir: this.sessionsDir,
        projectPath: this.projectPath,
        activeAfterMs: options?.activeAfterMs,
        cacheKey,
        sharedCacheStatus: cached.inFlight ? "in-flight" : "hit",
      });
      const startedAt = Date.now();
      if (cached.inFlight) {
        await cached.inFlight;
        if (!fileIndex.isCurrent() || rootCache.get(cacheKey) !== cached)
          return this.scanSessions(options);
        fileIndex.observe(cached.sessions, lookupRead);
        const visibleSessions = this.filterVisibleSessionsForScanMetrics(
          cached.sessions,
          metrics,
        );
        metrics.durationMs = Date.now() - startedAt;
        this.recordScanMetrics(metrics);
        return visibleSessions;
      }
      if (
        !(await this.applyObservedRolloutChanges(
          cached,
          metrics,
          fileIndex,
          lookupRead,
        ))
      ) {
        // A reported deletion may have hidden another file for the same
        // session; only a fresh enumeration can say which one remains.
        if (rootCache.get(cacheKey) === cached) rootCache.delete(cacheKey);
        return this.scanSessions(options);
      }
      if (!fileIndex.isCurrent() || rootCache.get(cacheKey) !== cached)
        return this.scanSessions(options);
      fileIndex.observe(cached.sessions, lookupRead);
      const visibleSessions = this.filterVisibleSessionsForScanMetrics(
        cached.sessions,
        metrics,
      );
      metrics.durationMs = Date.now() - startedAt;
      this.recordScanMetrics(metrics);
      return visibleSessions;
    }

    const metrics = createCodexSessionReaderScanMetrics({
      sessionsDir: this.sessionsDir,
      projectPath: this.projectPath,
      activeAfterMs: options?.activeAfterMs,
      cacheKey,
      sharedCacheStatus: "miss",
    });
    const startedAt = Date.now();
    const entry: CodexSharedScanCacheEntry = {
      timestamp: now,
      // Read before walking: the walk proves only what the watcher could
      // have reported from its start.
      epoch: getCodexRolloutTreeEpoch(this.sessionsDir),
      sessions: new CodexSessionMap(),
      activeAfterMs: options?.activeAfterMs,
      changedPaths: new Set(),
      failedPaths: new Set(),
    };
    const inFlight = this.scanSessionsUncached(
      fileIndex,
      lookupRead,
      options,
      metrics,
      entry.failedPaths,
    ).then((sessions) => {
      entry.directoryReadErrors = metrics.directoryReadErrors > 0;
      entry.incomplete =
        metrics.failedFiles > 0 || metrics.directoryReadErrors > 0;
      for (const session of sessions) {
        const current = entry.sessions.get(session.id);
        if (!current || isNewerCodexSessionFile(session, current))
          entry.sessions.set(session.id, session);
      }
      return [...entry.sessions.values()];
    });
    entry.inFlight = inFlight;
    rootCache.set(cacheKey, entry);

    try {
      await inFlight;
      if (!fileIndex.isCurrent() || rootCache.get(cacheKey) !== entry)
        return this.scanSessions(options);
      // Keep the same map: an exact observation arriving during the scan must
      // survive its older result. Observations never extend scan freshness.
      entry.timestamp = Date.now();
      entry.inFlight = undefined;
      if (options?.activeAfterMs !== undefined)
        this.retainLatestCutoff(cacheKey);
      if (options?.activeAfterMs === undefined && !entry.incomplete)
        fileIndex.completeEnumeration(entry.sessions, lookupRead);
      else fileIndex.observe(entry.sessions, lookupRead, true);
      const visibleSessions = this.filterVisibleSessionsForScanMetrics(
        entry.sessions,
        metrics,
      );
      metrics.durationMs = Date.now() - startedAt;
      this.recordScanMetrics(metrics);
      return visibleSessions;
    } catch (error) {
      metrics.durationMs = Date.now() - startedAt;
      this.recordScanMetrics(metrics);
      const entry = rootCache.get(cacheKey);
      if (entry?.inFlight === inFlight) {
        rootCache.delete(cacheKey);
      }
      throw error;
    }
  }

  /**
   * The active-after cutoff advances over time, and each cutoff would
   * otherwise keep its own copy of the directory's session list forever.
   * Keep only `cacheKey` among this directory's settled cutoff scans.
   */
  private retainLatestCutoff(cacheKey: string): void {
    const unfiltered = this.getSharedScanCacheKey();
    const rootCache = codexSharedScanCache.get(this.sessionsDir);
    for (const [key, entry] of rootCache ?? []) {
      if (key !== cacheKey && key !== unfiltered && !entry.inFlight) {
        rootCache?.delete(key);
      }
    }
  }

  /**
   * Fold watcher-reported rollout changes into a settled enumeration by
   * re-reading only those files. False when a reported deletion removed a
   * session, which leaves the enumeration unable to stand in for a walk.
   */
  private async applyObservedRolloutChanges(
    entry: CodexSharedScanCacheEntry,
    metrics: CodexSessionReaderScanMetrics,
    fileIndex: CodexRootFileIndex,
    lookupRead: CodexRootRead,
  ): Promise<boolean> {
    while (entry.changedPaths.size > 0 || entry.applyingChanges) {
      if (entry.applyingChanges) {
        await entry.applyingChanges;
        continue;
      }
      const changed = [...entry.changedPaths];
      entry.changedPaths.clear();
      const apply = (async () => {
        for (const plainPath of changed) {
          let removed = false;
          for (const [id, session] of entry.sessions) {
            if (plainCodexRolloutPath(session.filePath) !== plainPath) continue;
            entry.sessions.delete(id);
            removed = true;
          }
          const filePath = await findCodexRolloutRepresentation(plainPath);
          if (!filePath) {
            entry.failedPaths?.delete(plainPath);
            entry.incomplete =
              !!entry.failedPaths?.size || !!entry.directoryReadErrors;
            if (removed) entry.needsEnumeration = true;
            continue;
          }
          metrics.rolloutFilesFound += 1;
          fileIndex.rememberPaths([filePath], lookupRead);
          const session = await this.readSessionMeta(
            filePath,
            entry.activeAfterMs === undefined
              ? undefined
              : { activeAfterMs: entry.activeAfterMs },
            metrics,
          );
          if (!session) {
            metrics.failedFiles++;
            entry.failedPaths ??= new Set();
            entry.failedPaths.add(plainPath);
            entry.incomplete = true;
            continue;
          }
          entry.failedPaths?.delete(plainPath);
          fileIndex.observePoints([session], lookupRead);
          entry.incomplete =
            !!entry.failedPaths?.size || !!entry.directoryReadErrors;
          const current = entry.sessions.get(session.id);
          if (!current || isNewerCodexSessionFile(session, current))
            entry.sessions.set(session.id, session);
        }
        await this.discoveryIndex?.flush();
      })();
      entry.applyingChanges = apply;
      try {
        await apply;
      } catch (error) {
        for (const plainPath of changed) entry.changedPaths.add(plainPath);
        throw error;
      } finally {
        if (entry.applyingChanges === apply) entry.applyingChanges = undefined;
      }
    }
    return !entry.needsEnumeration;
  }

  private getSharedScanCacheKey(options?: CodexScanOptions): string {
    return `${this.sessionsDir}::activeAfter=${options?.activeAfterMs ?? "all"}`;
  }

  async observeNativeSessionFile(
    native: NativeSessionRef,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (
      this.retired ||
      signal?.aborted ||
      native.family !== "codex" ||
      native.storageScope !== this.sessionsDir
    )
      return false;
    const fileIndex = codexRootFileIndex(this.sessionsDir);
    const lookupRead = fileIndex.readVersion();
    const actual = await realpath(filePath).catch(() => null);
    if (!actual || this.retired || signal?.aborted || !fileIndex.isCurrent())
      return false;
    const suffix = relative(this.sessionsDir, actual);
    if (
      !suffix ||
      suffix === ".." ||
      suffix.startsWith(`..${sep}`) ||
      isAbsolute(suffix)
    )
      return false;
    const session = await this.readSessionMeta(actual);
    if (
      this.retired ||
      signal?.aborted ||
      !fileIndex.accepts(lookupRead) ||
      !session ||
      session.id !== native.id ||
      session.isSubagent ||
      (this.projectIdentityKey &&
        getProjectIdentityKey(session.cwd) !== this.projectIdentityKey)
    )
      return false;
    let rootCache = codexSharedScanCache.get(this.sessionsDir);
    if (!rootCache) {
      rootCache = new Map();
      codexSharedScanCache.set(this.sessionsDir, rootCache);
    }
    const unfiltered = this.getSharedScanCacheKey();
    if (!rootCache.has(unfiltered)) {
      // Exact native point evidence is shared without certifying enumeration.
      rootCache.set(unfiltered, {
        sessions: new CodexSessionMap(),
        changedPaths: new Set(),
      });
    }
    fileIndex.observePoints([session], lookupRead);
    return fileIndex.getSession(native.id)?.filePath === actual;
  }

  private async findRolloutPathById(rolloutId: string): Promise<string | null> {
    const index = codexRootFileIndex(this.sessionsDir);
    const lookupRead = index.readVersion();
    const path = await index.findRolloutPath(rolloutId, (directory) =>
      this.findJsonlFiles(directory),
    );
    return index.accepts(lookupRead)
      ? path
      : this.findRolloutPathById(rolloutId);
  }

  private resolveRolloutLineage(
    sessionId: string,
    filePath: string,
  ): Promise<CodexRolloutLineage> {
    return resolveCodexRolloutLineage({
      requestedSessionId: sessionId,
      leafFilePath: filePath,
      resolveRolloutPath: (rolloutId) => this.findRolloutPathById(rolloutId),
    });
  }

  private filterVisibleSessionsForScanMetrics(
    sessions: readonly CodexSessionFile[] | CodexSessionMap,
    metrics: CodexSessionReaderScanMetrics,
  ): readonly CodexSessionFile[] {
    const visible = visibleCodexSessions(sessions);
    metrics.subagentSessionsSkipped += visible.subagents;
    metrics.sessionsReturned = visible.sessions.length;
    return visible.sessions;
  }

  private recordScanMetrics(metrics: CodexSessionReaderScanMetrics): void {
    this.lastScanMetrics = cloneCodexSessionReaderScanMetrics(metrics);
    const payload = {
      event: "codex_reader_scan",
      ...metrics,
    };
    if (metrics.durationMs >= this.slowLogThresholdMs) {
      getLogger().warn(payload, "CODEX_READER: slow scan");
    } else if (metrics.sharedCacheStatus === "miss") {
      getLogger().debug(payload, "CODEX_READER: scan complete");
    }
  }

  private async scanSessionsUncached(
    fileIndex: CodexRootFileIndex,
    lookupRead: CodexRootRead,
    options?: CodexScanOptions,
    metrics?: CodexSessionReaderScanMetrics,
    failedPaths?: Set<string>,
  ): Promise<CodexSessionFile[]> {
    const sessionsById = new Map<string, CodexSessionFile>();
    try {
      await stat(this.sessionsDir);
      if (metrics) metrics.sessionsDirExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (metrics) metrics.directoryReadErrors += 1;
      throw error;
    }

    const files = await this.findJsonlFiles(this.sessionsDir, metrics);
    fileIndex.rememberPaths(files, lookupRead);

    for (const filePath of files) {
      const activeWindowSkipsBefore = metrics?.discovery.activeWindowSkips ?? 0;
      const session = await this.readSessionMeta(filePath, options, metrics);
      if (session) {
        const current = sessionsById.get(session.id);
        if (!current || isNewerCodexSessionFile(session, current)) {
          sessionsById.set(session.id, session);
        }
      } else if (
        metrics &&
        metrics.discovery.activeWindowSkips === activeWindowSkipsBefore
      ) {
        metrics.failedFiles += 1;
        failedPaths?.add(plainCodexRolloutPath(filePath));
      }
    }
    await this.discoveryIndex?.flush();
    if (metrics) {
      metrics.sessionsParsed = sessionsById.size;
    }

    return [...sessionsById.values()];
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    return sessionFile?.filePath ?? null;
  }

  async getNativeSessionRef(
    sessionId: import("@yep-anywhere/shared").NativeSessionId,
  ) {
    const file = await this.findSessionFile(sessionId);
    return file
      ? resolveNativeSessionRef("codex", this.sessionsDir, sessionId)
      : null;
  }

  async getSessionProjectPath(sessionId: string): Promise<string | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    return sessionFile ? canonicalizeProjectPath(sessionFile.cwd) : null;
  }

  async getNativeSessionRefs(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, NativeSessionRef>> {
    const files = codexSessionsInProject(
      await this.scanSessions(),
      this.projectIdentityKey,
    );
    const scope = await realpath(this.sessionsDir).catch(() => null);
    const requested = new Set(ids),
      refs = new Map<string, NativeSessionRef>();
    if (!scope || this.retired) return refs;
    for (const file of files)
      if (requested.has(file.id)) {
        refs.set(
          file.id,
          nativeSessionRef("codex", scope, parseNativeSessionId(file.id)),
        );
      }
    return refs;
  }

  getIndexScopeKey(sessionDir: string): string {
    return `codex::${sessionDir}::${this.projectIdentityKey ?? "*"}`;
  }

  async listSessionFiles(
    _sessionDir: string,
    options?: CodexScanOptions,
  ): Promise<{ sessionId: string; filePath: string }[]> {
    const sessions = codexSessionsInProject(
      await this.scanSessions(options),
      this.projectIdentityKey,
    );
    return sessions
      .filter(
        (session) =>
          !options?.activeAfterMs || session.mtime >= options.activeAfterMs,
      )
      .map((session) => ({
        sessionId: session.id,
        filePath: session.filePath,
      }));
  }

  /**
   * Find a session file by ID.
   */
  private async findSessionFile(
    sessionId: string,
  ): Promise<CodexSessionFile | null> {
    // Check cache first
    const fileIndex = codexRootFileIndex(this.sessionsDir);
    const lookupRead = fileIndex.readVersion();
    const cached = fileIndex.getSession(sessionId);
    if (cached) return cached;

    // Fork completion supplies an exact path before the scan cache catches up.
    // Read only that file; an older in-flight scan cannot erase this hint.
    const forkPath = await getForkedSessionFile(
      "codex",
      sessionId,
      this.sessionsDir,
    );
    if (forkPath) {
      const session = await this.readSessionMeta(forkPath);
      if (
        session?.id === sessionId &&
        !session.isSubagent &&
        (!this.projectIdentityKey ||
          getProjectIdentityKey(session.cwd) === this.projectIdentityKey)
      ) {
        if (!fileIndex.accepts(lookupRead))
          return this.findSessionFile(sessionId);
        fileIndex.observePoints([session], lookupRead);
        return fileIndex.getSession(sessionId) ?? null;
      }
      if (session) return null;
    }

    // Scan if cache miss
    await this.scanSessions();
    return codexRootFileIndex(this.sessionsDir).getSession(sessionId) ?? null;
  }

  private async readEntries(
    sessionId: string,
    filePath: string,
    options?: CodexReadEntriesOptions,
  ): Promise<CodexEntrySnapshot> {
    const purpose = options?.purpose ?? "detail";
    const startByte = options?.startByte ?? 0;
    const startedAt = Date.now();
    const memoryBefore = process.memoryUsage();

    for (;;) {
      const shouldWriteCache = !this.retired && (options?.cache ?? true);
      const stats = await stat(filePath);
      const cached = this.entryCache.get(sessionId);

      if (
        cached &&
        cached.filePath === filePath &&
        cached.startByte === startByte &&
        cached.size === stats.size &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.ctimeMs === stats.ctimeMs
      ) {
        this.entryCacheBudget.touch(cached);
        this.cacheAgentMappingsFromEntries({
          sessionId,
          filePath,
          startByte,
          stats,
          entries: cached.entries,
        });
        this.recordEntryReadMetrics({
          startedAt,
          memoryBefore,
          sessionId,
          filePath,
          purpose,
          cacheMode: shouldWriteCache ? "read-write" : "read-only",
          cacheStatus: "hit",
          stats,
          parsedEntries: cached.entries.length,
          dedupedEntries: cached.entries.length,
        });
        return this.copyEntrySnapshot(cached);
      }

      if (!shouldWriteCache) {
        return this.readEntriesWithoutCache({
          startedAt,
          memoryBefore,
          sessionId,
          filePath,
          purpose,
          stats,
        });
      }

      const existingOwner = this.entryReadOwners.get(sessionId);
      if (existingOwner) {
        existingOwner.joinedCallers += 1;
        const joined = await existingOwner.promise;
        if (
          joined?.uncached &&
          joined.filePath === filePath &&
          joined.startByte === startByte
        ) {
          return this.copyEntrySnapshot(joined);
        }
        continue;
      }

      const revision = this.entryCacheRevision;
      let owner: CodexEntryReadOwner;
      const promise = this.refreshEntryCache({
        startedAt,
        memoryBefore,
        sessionId,
        filePath,
        purpose,
        revision,
        startByte,
      }).finally(() => {
        if (this.entryReadOwners.get(sessionId) === owner) {
          this.entryReadOwners.delete(sessionId);
        }
      });
      owner = { promise, joinedCallers: 0 };
      this.entryReadOwners.set(sessionId, owner);

      const refreshed = await promise;
      if (
        refreshed &&
        (refreshed.uncached || this.entryCache.get(sessionId) === refreshed)
      ) {
        return this.copyEntrySnapshot(refreshed);
      }
    }
  }

  /**
   * Account a cached entry against the shared retention budget. An entry that
   * alone exceeds the budget is dropped and served uncached; budget pressure
   * from other entries evicts this one later through the release callback.
   */
  private retainEntry(sessionId: string, cached: CodexEntryCache): void {
    const release = () => {
      if (this.entryCache.get(sessionId) === cached) {
        this.entryCache.delete(sessionId);
      }
      cached.uncached = true;
    };
    if (
      this.retired ||
      !this.entryCacheBudget.admit(cached, cached.sourceBytes, release)
    ) {
      release();
    }
  }

  private copyEntrySnapshot(cached: CodexEntryCache): CodexEntrySnapshot {
    return {
      entries: tagCodexEntriesNormalizationSource(
        cached.entries.slice(),
        cached.normalizationSource,
        cached.entries,
      ),
      transcriptSnapshotUpdatedAt: new Date(
        getCodexRolloutActivityTimeMs(cached.filePath, cached),
      ).toISOString(),
    };
  }

  private async refreshEntryCache(options: {
    startedAt: number;
    memoryBefore: NodeJS.MemoryUsage;
    sessionId: string;
    filePath: string;
    purpose: CodexEntryReadPurpose;
    revision: number;
    startByte: number;
  }): Promise<CodexEntryCache | null> {
    const {
      startedAt,
      memoryBefore,
      sessionId,
      filePath,
      purpose,
      revision,
      startByte,
    } = options;
    const stats = await stat(filePath);
    const cached = this.entryCache.get(sessionId);

    if (
      cached &&
      cached.filePath === filePath &&
      cached.startByte === startByte &&
      cached.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.ctimeMs === stats.ctimeMs
    ) {
      this.entryCacheBudget.touch(cached);
      return cached;
    }

    if (
      cached &&
      cached.filePath === filePath &&
      cached.startByte === startByte &&
      !isCompressedCodexRolloutPath(filePath) &&
      cached.size < stats.size
    ) {
      const parsed = await this.rolloutWindowReader.readEntryRange(
        filePath,
        cached.size,
        stats.size - cached.size,
        Date.now(),
        cached.partialLine,
      );
      const nextLeafOrdinal =
        cached.nextLeafOrdinal === undefined
          ? undefined
          : validateContiguousCodexOrdinals(
              parsed.entries,
              filePath,
              cached.nextLeafOrdinal,
            );

      if (
        revision !== this.entryCacheRevision ||
        this.entryCache.get(sessionId) !== cached
      ) {
        return null;
      }

      cached.entries.push(...parsed.entries);
      cached.sourceBytes += parsed.sourceBytes;
      cached.partialLine = parsed.partialLine;
      cached.nextLeafOrdinal = nextLeafOrdinal;
      cached.size = stats.size;
      cached.mtimeMs = stats.mtimeMs;
      cached.ctimeMs = stats.ctimeMs;
      this.retainEntry(sessionId, cached);
      this.cacheAgentMappingsFromEntries({
        sessionId,
        filePath,
        startByte,
        stats,
        entries: cached.entries,
      });
      this.recordEntryReadMetrics({
        startedAt,
        memoryBefore,
        sessionId,
        filePath,
        purpose,
        cacheMode: "read-write",
        cacheStatus: "append",
        stats,
        readLinesMs: parsed.readLinesMs,
        parseMs: parsed.parseMs,
        lineCount: parsed.lineCount,
        parsedEntries: parsed.entries.length,
        dedupedEntries: cached.entries.length,
        maxLineLength: parsed.maxLineLength,
      });
      return cached;
    }

    const parsed: CodexReadEntrySnapshot =
      startByte === 0
        ? await this.readEntrySnapshot(sessionId, filePath, stats)
        : await this.rolloutWindowReader.readEntryRange(
            filePath,
            startByte,
            stats.size - startByte,
          );
    // A stale entry the budget evicted during the parse was being replaced
    // anyway; only invalidation or a concurrent replacement voids this parse.
    if (
      revision !== this.entryCacheRevision ||
      this.entryCache.get(sessionId) !== (cached?.uncached ? undefined : cached)
    ) {
      return null;
    }

    const cacheStoreStartedAt = Date.now();
    const refreshed: CodexEntryCache = {
      filePath,
      startByte,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      size: stats.size,
      entries: parsed.entries,
      sourceBytes: parsed.sourceBytes,
      partialLine: parsed.partialLine,
      nextLeafOrdinal: parsed.nextLeafOrdinal,
      normalizationSource: {},
    };
    if (cached) {
      this.entryCacheBudget.release(cached);
    }
    this.entryCache.set(sessionId, refreshed);
    this.retainEntry(sessionId, refreshed);
    const cacheStoreMs = Date.now() - cacheStoreStartedAt;
    this.cacheAgentMappingsFromEntries({
      sessionId,
      filePath,
      startByte,
      stats,
      entries: parsed.entries,
    });
    this.recordEntryReadMetrics({
      startedAt,
      memoryBefore,
      sessionId,
      filePath,
      purpose,
      cacheMode: "read-write",
      cacheStatus: "miss",
      stats,
      readLinesMs: parsed.readLinesMs,
      parseMs: parsed.parseMs,
      cacheStoreMs,
      lineCount: parsed.lineCount,
      parsedEntries: parsed.entries.length,
      dedupedEntries: parsed.entries.length,
      maxLineLength: parsed.maxLineLength,
    });
    return refreshed;
  }

  private async readEntriesWithoutCache(options: {
    startedAt: number;
    memoryBefore: NodeJS.MemoryUsage;
    sessionId: string;
    filePath: string;
    purpose: CodexEntryReadPurpose;
    stats: Awaited<ReturnType<typeof stat>>;
  }): Promise<CodexEntrySnapshot> {
    const { startedAt, memoryBefore, sessionId, filePath, purpose, stats } =
      options;
    const parsed = await this.readEntrySnapshot(sessionId, filePath, stats);
    this.cacheAgentMappingsFromEntries({
      sessionId,
      filePath,
      startByte: 0,
      stats,
      entries: parsed.entries,
    });
    this.recordEntryReadMetrics({
      startedAt,
      memoryBefore,
      sessionId,
      filePath,
      purpose,
      cacheMode: "read-only",
      cacheStatus: "miss",
      stats,
      readLinesMs: parsed.readLinesMs,
      parseMs: parsed.parseMs,
      lineCount: parsed.lineCount,
      parsedEntries: parsed.entries.length,
      dedupedEntries: parsed.entries.length,
      maxLineLength: parsed.maxLineLength,
    });
    return {
      entries: parsed.entries.slice(),
      transcriptSnapshotUpdatedAt: new Date(
        getCodexRolloutActivityTimeMs(filePath, stats),
      ).toISOString(),
    };
  }

  private async readEntrySnapshot(
    sessionId: string,
    filePath: string,
    stats: Awaited<ReturnType<typeof stat>>,
  ): Promise<CodexReadEntrySnapshot> {
    const readStartedAt = Date.now();
    const lineage = await this.resolveRolloutLineage(sessionId, filePath);
    if (lineage.referenceBacked) {
      if (!isCompressedCodexRolloutPath(filePath)) {
        const leafSegment = lineage.segments.at(-1);
        if (
          !leafSegment ||
          leafSegment.filePath !== filePath ||
          leafSegment.end
        ) {
          throw new Error(`Invalid Codex leaf segment for ${sessionId}`);
        }
        const inherited = await readCodexRolloutLineageEntries({
          ...lineage,
          segments: lineage.segments.slice(0, -1),
        });
        const leaf = await this.rolloutWindowReader.readEntryRange(
          filePath,
          0,
          Number(stats.size),
          readStartedAt,
        );
        const leafMeta = leaf.entries[0];
        if (
          leafMeta?.type !== "session_meta" ||
          leafMeta.payload.id !== sessionId
        ) {
          throw new Error(
            `Codex rollout has no matching leaf metadata: ${filePath}`,
          );
        }
        const nextLeafOrdinal = validateContiguousCodexOrdinals(
          leaf.entries,
          filePath,
        );
        const localEntries: CodexSessionEntry[] = [];
        for (const entry of leaf.entries) {
          const numericOrdinal = Number(
            (entry as { ordinal?: unknown }).ordinal,
          );
          if (
            entry.type !== "session_meta" &&
            numericOrdinal >= leafSegment.startOrdinal
          ) {
            localEntries.push(entry);
          }
        }
        const parseMs = inherited.parseMs + leaf.parseMs;
        return {
          entries: [...inherited.entries, ...localEntries],
          partialLine: leaf.partialLine,
          nextLeafOrdinal,
          readLinesMs: Math.max(0, Date.now() - readStartedAt - parseMs),
          parseMs,
          lineCount: inherited.lineCount + leaf.lineCount,
          maxLineLength: Math.max(inherited.maxLineLength, leaf.maxLineLength),
          sourceBytes: inherited.bytesRead + leaf.sourceBytes,
        };
      }
      const parsed = await readCodexRolloutLineageEntries(lineage);
      return {
        entries: parsed.entries,
        partialLine: Buffer.alloc(0),
        readLinesMs: Math.max(0, Date.now() - readStartedAt - parsed.parseMs),
        parseMs: parsed.parseMs,
        lineCount: parsed.lineCount,
        maxLineLength: parsed.maxLineLength,
        sourceBytes: parsed.bytesRead,
      };
    }
    if (isCompressedCodexRolloutPath(filePath)) {
      const lines = await readJsonlLines(filePath);
      const readLinesMs = Date.now() - readStartedAt;
      const entries: CodexSessionEntry[] = [];
      let maxLineLength = 0;
      let sourceBytes = 0;
      const parseStartedAt = Date.now();
      for (const line of lines) {
        maxLineLength = Math.max(maxLineLength, line.length);
        sourceBytes += Buffer.byteLength(line) + 1;
        const entry = parseCodexSessionEntry(line);
        if (entry) {
          entries.push(entry);
        }
      }
      return {
        entries,
        partialLine: Buffer.alloc(0),
        readLinesMs,
        parseMs: Date.now() - parseStartedAt,
        lineCount: lines.length,
        maxLineLength,
        sourceBytes,
      };
    }

    return this.rolloutWindowReader.readEntryRange(
      filePath,
      0,
      Number(stats.size),
      readStartedAt,
    );
  }

  /**
   * A compact-tail response pairs an indexed summary with entries read from
   * the live file, so the index may predate recent appends. Re-derive the
   * fields the tail window itself carries; head-derived fields (title,
   * creation, originator, provider) cannot change under append. An older page
   * is not the session's current state, so it refreshes nothing.
   *
   * `messageCount` still reflects only what was indexed and therefore lags a
   * session that is still being written. It feeds session-list ordering and
   * the empty-session check, neither of which depends on an exact count.
   */
  private refreshTailDerivedSummary(
    summary: SessionSummary | null,
    window: CodexCompactWindowSnapshot,
  ): SessionSummary | null {
    if (!summary || window.kind !== "compact-tail") return summary;

    const provider = summary.provider === "codex-oss" ? "codex-oss" : "codex";
    const model = this.extractModel(window.entries) ?? summary.model;
    const contextUsage =
      this.extractContextUsage(window.entries, model, provider) ??
      summary.contextUsage;
    return {
      ...summary,
      updatedAt: window.transcriptSnapshotUpdatedAt,
      ...(model !== undefined ? { model } : {}),
      ...(contextUsage ? { contextUsage } : {}),
    };
  }

  private async readIncrementalSnapshot(
    sessionId: string,
    filePath: string,
    stats: Awaited<ReturnType<typeof stat>>,
    compactBoundaries: number,
    afterMessageId: string,
    summary: SessionSummary,
  ): Promise<CodexCompactTailSnapshot | null> {
    return readCodexIncrementalSnapshot(
      {
        cached: this.entryCache.get(sessionId),
        readEntries: (...args) => this.readEntries(...args),
        windowReader: this.rolloutWindowReader,
      },
      sessionId,
      filePath,
      stats,
      compactBoundaries,
      afterMessageId,
      summary,
    );
  }

  private async readCompactTailSnapshot(
    filePath: string,
    stats: Awaited<ReturnType<typeof stat>>,
    compactBoundaries: number,
  ): Promise<CodexCompactTailSnapshot | null> {
    return this.rolloutWindowReader.readCompactTailSnapshot(
      filePath,
      stats,
      compactBoundaries,
    );
  }

  private async readCompactPageSnapshot(
    filePath: string,
    stats: Awaited<ReturnType<typeof stat>>,
    compactBoundaries: number,
    beforeMessageId: string,
  ): Promise<CodexCompactPageSnapshot | null> {
    return this.rolloutWindowReader.readCompactPageSnapshot(
      filePath,
      stats,
      compactBoundaries,
      beforeMessageId,
    );
  }

  async getSessionSummaryFromFile(
    sessionId: string,
    projectId: UrlProjectId,
    filePath: string,
    options?: GetSessionSummaryOptions,
  ): Promise<SessionSummary | null> {
    return this.buildSessionSummaryFromStream(
      sessionId,
      projectId,
      filePath,
      options,
    );
  }

  private async buildSessionSummaryFromStream(
    sessionId: string,
    projectId: UrlProjectId,
    filePath: string,
    options?: GetSessionSummaryOptions,
  ): Promise<SessionSummary | null> {
    const stats = await stat(filePath);
    return this.buildSessionSummaryFromKnownStats(
      sessionId,
      projectId,
      filePath,
      stats,
      options,
    );
  }

  private async buildSessionSummaryFromKnownStats(
    sessionId: string,
    projectId: UrlProjectId,
    filePath: string,
    stats: Awaited<ReturnType<typeof stat>>,
    options?: GetSessionSummaryOptions,
  ): Promise<SessionSummary | null> {
    const read = await this.readSummaryStream(
      sessionId,
      filePath,
      stats,
      options?.readMode ?? "full",
    );
    const summary = this.buildSessionSummaryFromState(
      sessionId,
      projectId,
      filePath,
      stats,
      read.state,
    );
    if (summary && !options?.deferAsyncQuestions)
      summary.asyncQuestions = await readCodexAsyncQuestions(filePath);
    return summary;
  }

  private async getCoalescedFullSessionSummary(
    filePath: string,
    stats: Awaited<ReturnType<typeof stat>>,
    parse: () => Promise<SessionSummary | null>,
  ): Promise<SessionSummary | null> {
    const cacheKey = getCodexFullSummaryCacheKey(filePath, stats);
    const cached = codexFullSummaryCache.get(cacheKey);
    if (cached) {
      cached.lastAccessedAt = Date.now();
      return cloneSessionSummary(await cached.promise);
    }

    const promise = parse();
    codexFullSummaryCache.set(cacheKey, {
      promise,
      lastAccessedAt: Date.now(),
    });
    trimCodexFullSummaryCache();

    try {
      return cloneSessionSummary(await promise);
    } catch (error) {
      if (codexFullSummaryCache.get(cacheKey)?.promise === promise) {
        codexFullSummaryCache.delete(cacheKey);
      }
      throw error;
    }
  }

  private getSummaryParserClient(): SummaryParserClient {
    this.summaryParserClient ??= new SummaryParserClient({
      mode: this.summaryParserWorkerMode,
    });
    return this.summaryParserClient;
  }

  private async readSummaryStream(
    sessionId: string,
    filePath: string,
    stats: Awaited<ReturnType<typeof stat>>,
    readMode: SessionSummaryReadMode,
  ): Promise<CodexSummaryStreamRead> {
    const startedAt = Date.now();
    const memoryBefore = process.memoryUsage();
    const state: CodexSummaryState = {
      eventUserMessageCount: 0,
      legacyResponseUserCount: 0,
      assistantMessageCount: 0,
    };
    let lineCount = 0;
    let parsedEntries = 0;
    let dedupedEntries = 0;
    const skippedDuplicateEntries = 0;
    let maxLineLength = 0;
    let bytesRead = 0;
    let stoppedEarly = false;
    let stopReason: CodexSummaryStreamMetrics["stopReason"] = "eof";

    const parseStartedAt = Date.now();
    const headBudgetStopReason = (): Exclude<
      CodexSummaryStreamMetrics["stopReason"],
      "eof"
    > | null => {
      if (readMode !== "head") return null;
      if (lineCount >= CODEX_HEAD_SUMMARY_MAX_LINES) {
        return "line_budget";
      }
      if (bytesRead >= CODEX_HEAD_SUMMARY_MAX_BYTES) {
        return "byte_budget";
      }
      return null;
    };
    const stopEarly = (
      reason: Exclude<CodexSummaryStreamMetrics["stopReason"], "eof">,
    ) => {
      stoppedEarly = true;
      stopReason = reason;
    };

    const applyParsedEntry = (entry: CodexSessionEntry): boolean => {
      parsedEntries += 1;
      dedupedEntries += 1;
      this.applySummaryEntry(state, entry);
      if (readMode === "head" && this.hasHeadSummary(state)) {
        stopEarly("head_complete");
        return true;
      }
      const budgetReason = headBudgetStopReason();
      if (budgetReason) {
        stopEarly(budgetReason);
        return true;
      }
      return false;
    };

    const lineage = await this.resolveRolloutLineage(sessionId, filePath);
    if (lineage.referenceBacked) {
      const lineageMetrics: CodexLineageReadMetrics = {
        lineCount: 0,
        parsedEntries: 0,
        maxLineLength: 0,
        parseMs: 0,
        bytesRead: 0,
      };
      for await (const entry of iterateCodexRolloutLineageEntries(
        lineage,
        lineageMetrics,
      )) {
        lineCount = lineageMetrics.lineCount;
        maxLineLength = lineageMetrics.maxLineLength;
        bytesRead = lineageMetrics.bytesRead;
        if (applyParsedEntry(entry)) break;
      }
      lineCount = lineageMetrics.lineCount;
      maxLineLength = lineageMetrics.maxLineLength;
      bytesRead = lineageMetrics.bytesRead;
    } else {
      for await (const line of iterateJsonlLines(filePath)) {
        lineCount += 1;
        maxLineLength = Math.max(maxLineLength, line.length);
        bytesRead += Buffer.byteLength(line) + 1;
        const trimmed = line.trim();
        if (!trimmed) {
          const budgetReason = headBudgetStopReason();
          if (budgetReason) {
            stopEarly(budgetReason);
            break;
          }
          continue;
        }

        const entry = parseCodexSessionEntry(trimmed);
        if (!entry) {
          const budgetReason = headBudgetStopReason();
          if (budgetReason) {
            stopEarly(budgetReason);
            break;
          }
          continue;
        }

        if (applyParsedEntry(entry)) break;
      }
    }
    const parseMs = Date.now() - parseStartedAt;

    const read = {
      state,
      lineCount,
      parsedEntries,
      dedupedEntries,
      skippedDuplicateEntries,
      maxLineLength,
      parseMs,
      readMode,
      stoppedEarly,
      stopReason,
    };
    this.recordSummaryStreamMetrics({
      startedAt,
      memoryBefore,
      sessionId,
      filePath,
      stats,
      read,
    });
    return read;
  }

  private hasHeadSummary(state: CodexSummaryState): boolean {
    return !!state.metaEntry && state.eventUserMessageCount > 0;
  }

  private applySummaryEntry(
    state: CodexSummaryState,
    entry: CodexSessionEntry,
  ): void {
    const precedingResponseUser = state.pendingResponseUser;
    state.pendingResponseUser = undefined;

    if (entry.type === "session_meta") {
      state.metaEntry ??= entry;
      return;
    }

    if (entry.type === "turn_context") {
      state.firstTurnContext ??= entry;
      state.latestTurnContext = entry;
      if (entry.payload.model) {
        state.model = entry.payload.model;
      }
      return;
    }

    if (entry.type === "event_msg") {
      if (isCodexUserMessageEventEntry(entry)) {
        state.eventUserMessageCount += 1;
        if (!state.firstEventUserTitle) {
          const fullTitle =
            codexUserMessageEventText(entry) ||
            (precedingResponseUser
              ? codexUserResponseText(precedingResponseUser.payload)
              : "");
          if (fullTitle) {
            state.firstEventUserTitle = {
              title: truncateSessionTitle(fullTitle) || null,
              fullTitle,
            };
          }
        }
        return;
      }

      if (getCodexAsyncAgentMessageItem(entry)) {
        state.assistantMessageCount += 1;
        return;
      }

      if (entry.payload.type === "token_count") {
        const info = entry.payload.info;
        const usage = info?.last_token_usage ?? info?.total_token_usage;
        const inputTokens = usage?.input_tokens ?? 0;
        if (inputTokens > 0) {
          state.contextCandidate = {
            inputTokens,
            ...(info?.model_context_window && info.model_context_window > 0
              ? { contextWindow: info.model_context_window }
              : {}),
          };
        }
      }
      return;
    }

    if (entry.type !== "response_item") {
      return;
    }

    const payload = entry.payload;
    if (payload.type !== "message") {
      return;
    }

    if (payload.role === "assistant") {
      state.assistantMessageCount += 1;
      return;
    }

    if (!isCodexUserResponseEntry(entry)) {
      return;
    }

    state.pendingResponseUser = entry;
    if (isCodexContextualUserResponse(payload)) {
      return;
    }

    state.legacyResponseUserCount += 1;
    if (state.firstLegacyResponseUserTitle) {
      return;
    }
    const fullTitle = codexUserResponseText(payload);
    if (fullTitle) {
      state.firstLegacyResponseUserTitle = {
        title: truncateSessionTitle(fullTitle) || null,
        fullTitle,
      };
    }
  }

  private buildSessionSummaryFromState(
    sessionId: string,
    projectId: UrlProjectId,
    filePath: string,
    stats: Awaited<ReturnType<typeof stat>>,
    state: CodexSummaryState,
  ): SessionSummary | null {
    const metaEntry = state.metaEntry;
    if (!metaEntry) return null;

    const userMessageCount =
      state.eventUserMessageCount > 0
        ? state.eventUserMessageCount
        : state.legacyResponseUserCount;
    const messageCount = state.assistantMessageCount + userMessageCount;
    if (messageCount === 0) return null;

    const model = state.model;
    const provider = this.determineProvider(metaEntry, model);
    const contextUsage = this.contextUsageFromSummaryCandidate(
      state.contextCandidate,
      model,
      provider,
    );
    const title = (state.eventUserMessageCount > 0
      ? state.firstEventUserTitle
      : state.firstLegacyResponseUserTitle) ?? {
      title: null,
      fullTitle: null,
    };
    const forkedFromSessionId =
      typeof metaEntry.payload.forked_from_id === "string"
        ? metaEntry.payload.forked_from_id
        : undefined;

    return {
      id: sessionId,
      projectId,
      title: title.title,
      fullTitle: title.fullTitle,
      createdAt: metaEntry.payload.timestamp,
      updatedAt: new Date(
        getCodexRolloutActivityTimeMs(filePath, stats),
      ).toISOString(),
      messageCount,
      ownership: { owner: "none" },
      contextUsage,
      provider,
      model,
      forkedFromSessionId,
      originator: metaEntry.payload.originator,
      cliVersion: metaEntry.payload.cli_version,
      source: codexSessionSourceLabel(metaEntry.payload.source),
      approvalPolicy: state.firstTurnContext?.payload.approval_policy,
      sandboxPolicy: state.firstTurnContext?.payload.sandbox_policy
        ? {
            type: state.firstTurnContext.payload.sandbox_policy.type,
            networkAccess:
              state.firstTurnContext.payload.sandbox_policy.network_access,
            excludeTmpdirEnvVar:
              state.firstTurnContext.payload.sandbox_policy
                .exclude_tmpdir_env_var,
            excludeSlashTmp:
              state.firstTurnContext.payload.sandbox_policy.exclude_slash_tmp,
          }
        : undefined,
    };
  }

  private contextUsageFromSummaryCandidate(
    candidate: CodexSummaryContextCandidate | undefined,
    model: string | undefined,
    provider: "codex" | "codex-oss",
  ): ContextUsage | undefined {
    if (!candidate) {
      return undefined;
    }

    const contextWindow =
      candidate.contextWindow ?? getModelContextWindow(model, provider);
    const percentage = Math.min(
      100,
      Math.round((candidate.inputTokens / contextWindow) * 100),
    );
    return {
      inputTokens: candidate.inputTokens,
      percentage,
      contextWindow,
    };
  }

  private async buildSessionSummaryFromEntries(
    sessionId: string,
    projectId: UrlProjectId,
    entries: CodexSessionEntry[],
    transcriptSnapshotUpdatedAt: string,
  ): Promise<SessionSummary | null> {
    if (entries.length === 0) return null;

    const metaEntry = entries.find((e) => e.type === "session_meta") as
      | CodexSessionMetaEntry
      | undefined;
    if (!metaEntry) return null;

    const { title, fullTitle } = this.extractTitle(entries);
    const messageCount = this.countMessages(entries);
    const model = this.extractModel(entries);
    const provider = this.determineProvider(metaEntry, model);
    const turnContext = this.extractTurnContext(entries);
    const contextUsage = this.extractContextUsage(entries, model, provider);
    const forkedFromSessionId =
      typeof metaEntry.payload.forked_from_id === "string"
        ? metaEntry.payload.forked_from_id
        : undefined;

    if (messageCount === 0) return null;

    return {
      id: sessionId,
      projectId,
      title,
      fullTitle,
      createdAt: metaEntry.payload.timestamp,
      updatedAt: transcriptSnapshotUpdatedAt,
      messageCount,
      ownership: { owner: "none" },
      contextUsage,
      provider,
      model,
      forkedFromSessionId,
      originator: metaEntry.payload.originator,
      cliVersion: metaEntry.payload.cli_version,
      source: codexSessionSourceLabel(metaEntry.payload.source),
      approvalPolicy: turnContext?.payload.approval_policy,
      sandboxPolicy: turnContext?.payload.sandbox_policy
        ? {
            type: turnContext.payload.sandbox_policy.type,
            networkAccess: turnContext.payload.sandbox_policy.network_access,
            excludeTmpdirEnvVar:
              turnContext.payload.sandbox_policy.exclude_tmpdir_env_var,
            excludeSlashTmp:
              turnContext.payload.sandbox_policy.exclude_slash_tmp,
          }
        : undefined,
    };
  }

  private recordEntryReadMetrics(options: {
    startedAt: number;
    memoryBefore: NodeJS.MemoryUsage;
    sessionId: string;
    filePath: string;
    purpose: CodexEntryReadPurpose;
    cacheMode: CodexEntryReadMetrics["cacheMode"];
    cacheStatus: CodexEntryReadMetrics["cacheStatus"];
    stats: Awaited<ReturnType<typeof stat>>;
    readLinesMs?: number;
    parseMs?: number;
    dedupeMs?: number;
    cacheStoreMs?: number;
    lineCount?: number;
    parsedEntries?: number;
    dedupedEntries?: number;
    maxLineLength?: number;
  }): void {
    const durationMs = Date.now() - options.startedAt;
    if (!LOG_ENTRY_READS && durationMs < this.slowLogThresholdMs) {
      return;
    }

    const memoryAfter = process.memoryUsage();
    const payload: CodexEntryReadMetrics = {
      event: "codex_entry_read",
      sessionsDir: this.sessionsDir,
      ...(this.projectPath ? { projectPath: this.projectPath } : {}),
      sessionId: options.sessionId,
      filePath: options.filePath,
      purpose: options.purpose,
      cacheMode: options.cacheMode,
      cacheStatus: options.cacheStatus,
      fileSize: Number(options.stats.size),
      fileMtimeMs: Number(options.stats.mtimeMs),
      durationMs,
      ...(options.readLinesMs !== undefined
        ? { readLinesMs: options.readLinesMs }
        : {}),
      ...(options.parseMs !== undefined ? { parseMs: options.parseMs } : {}),
      ...(options.dedupeMs !== undefined ? { dedupeMs: options.dedupeMs } : {}),
      ...(options.cacheStoreMs !== undefined
        ? { cacheStoreMs: options.cacheStoreMs }
        : {}),
      ...(options.lineCount !== undefined
        ? { lineCount: options.lineCount }
        : {}),
      ...(options.parsedEntries !== undefined
        ? { parsedEntries: options.parsedEntries }
        : {}),
      ...(options.dedupedEntries !== undefined
        ? { dedupedEntries: options.dedupedEntries }
        : {}),
      ...(options.maxLineLength !== undefined
        ? { maxLineLength: options.maxLineLength }
        : {}),
      heapUsedBefore: options.memoryBefore.heapUsed,
      heapUsedAfter: memoryAfter.heapUsed,
      rssBefore: options.memoryBefore.rss,
      rssAfter: memoryAfter.rss,
      heapUsedDelta: memoryAfter.heapUsed - options.memoryBefore.heapUsed,
      rssDelta: memoryAfter.rss - options.memoryBefore.rss,
      entryCache: this.getEntryCacheStats(),
    };

    if (durationMs >= this.slowLogThresholdMs) {
      getLogger().warn(payload, "CODEX_READER: slow entry read");
      return;
    }
    getLogger().debug(payload, "CODEX_READER: entry read");
  }

  private recordSummaryStreamMetrics(options: {
    startedAt: number;
    memoryBefore: NodeJS.MemoryUsage;
    sessionId: string;
    filePath: string;
    stats: Awaited<ReturnType<typeof stat>>;
    read: Omit<CodexSummaryStreamRead, "state">;
  }): void {
    const durationMs = Date.now() - options.startedAt;
    const memoryAfter = process.memoryUsage();
    const payload: CodexSummaryStreamMetrics = {
      event: "codex_summary_stream",
      sessionsDir: this.sessionsDir,
      ...(this.projectPath ? { projectPath: this.projectPath } : {}),
      sessionId: options.sessionId,
      filePath: options.filePath,
      fileSize: Number(options.stats.size),
      fileMtimeMs: Number(options.stats.mtimeMs),
      compressed: isCompressedCodexRolloutPath(options.filePath),
      durationMs,
      parseMs: options.read.parseMs,
      lineCount: options.read.lineCount,
      parsedEntries: options.read.parsedEntries,
      dedupedEntries: options.read.dedupedEntries,
      skippedDuplicateEntries: options.read.skippedDuplicateEntries,
      maxLineLength: options.read.maxLineLength,
      readMode: options.read.readMode,
      stoppedEarly: options.read.stoppedEarly,
      stopReason: options.read.stopReason,
      heapUsedBefore: options.memoryBefore.heapUsed,
      heapUsedAfter: memoryAfter.heapUsed,
      rssBefore: options.memoryBefore.rss,
      rssAfter: memoryAfter.rss,
      heapUsedDelta: memoryAfter.heapUsed - options.memoryBefore.heapUsed,
      rssDelta: memoryAfter.rss - options.memoryBefore.rss,
      entryCache: this.getEntryCacheStats(),
    };

    this.lastSummaryStreamMetrics = payload;

    if (!LOG_ENTRY_READS && durationMs < this.slowLogThresholdMs) {
      return;
    }

    if (durationMs >= this.slowLogThresholdMs) {
      getLogger().warn(payload, "CODEX_READER: slow summary stream");
      return;
    }
    getLogger().debug(payload, "CODEX_READER: summary stream");
  }

  private async readFileRange(
    filePath: string,
    start: number,
    length: number,
  ): Promise<Buffer> {
    if (length <= 0) {
      return Buffer.alloc(0);
    }

    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      let totalBytesRead = 0;
      while (totalBytesRead < length) {
        const { bytesRead } = await handle.read(
          buffer,
          totalBytesRead,
          length - totalBytesRead,
          start + totalBytesRead,
        );
        if (bytesRead === 0) break;
        totalBytesRead += bytesRead;
      }
      if (totalBytesRead !== length) {
        throw new Error(
          `Codex transcript changed during bounded read: expected ${length} bytes, read ${totalBytesRead}`,
        );
      }
      return buffer;
    } finally {
      await handle.close();
    }
  }

  /**
   * Recursively find all Codex rollout files in a directory.
   */
  private async findJsonlFiles(
    dir: string,
    metrics?: CodexSessionReaderScanMetrics,
  ): Promise<string[]> {
    const files: string[] = [];
    await this.collectJsonlFiles(dir, files, metrics);
    const preferredFiles = preferPlainCodexRollouts(files);
    if (metrics) {
      metrics.rolloutFilesAfterPrecedence = preferredFiles.length;
      metrics.precedenceSkippedCompressed =
        files.length - preferredFiles.length;
    }
    return preferredFiles;
  }

  private async collectJsonlFiles(
    dir: string,
    files: string[],
    metrics?: CodexSessionReaderScanMetrics,
  ): Promise<void> {
    try {
      if (metrics) metrics.directoriesVisited += 1;
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.collectJsonlFiles(fullPath, files, metrics);
        } else if (entry.isFile() && isCodexRolloutFileName(entry.name)) {
          files.push(fullPath);
          if (metrics) {
            metrics.rolloutFilesFound += 1;
            if (codexRolloutRepresentation(fullPath) === "zstd") {
              metrics.compressedRolloutFiles += 1;
            } else {
              metrics.plainRolloutFiles += 1;
            }
          }
        }
      }
    } catch {
      if (metrics) metrics.directoryReadErrors += 1;
      // Ignore errors (permission denied, etc.)
    }
  }

  /**
   * Read session metadata from the first line of a file.
   */
  private async readSessionMeta(
    filePath: string,
    options?: CodexScanOptions,
    metrics?: CodexSessionReaderScanMetrics,
    freshHeader = false,
  ): Promise<CodexSessionFile | null> {
    try {
      const session = await readCodexRolloutMetadata({
        sessionsDir: this.sessionsDir,
        filePath,
        ...(!freshHeader && this.discoveryIndex
          ? { discoveryIndex: this.discoveryIndex }
          : {}),
        ...(options?.activeAfterMs !== undefined
          ? { activeAfterMs: options.activeAfterMs }
          : {}),
        ...(metrics ? { metrics: metrics.discovery } : {}),
      });
      if (!session) return null;
      return {
        id: session.id,
        filePath,
        cwd: session.cwd,
        timestamp: session.timestamp,
        mtime: session.mtime,
        size: session.size,
        isSubagent: session.isSubagent,
        parentThreadId: session.parentThreadId ?? null,
        agentNickname: session.agentNickname,
        agentRole: session.agentRole,
        spawnDepth: session.spawnDepth,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract title from entries (first user message).
   */
  private extractTitle(entries: CodexSessionEntry[]): {
    title: string | null;
    fullTitle: string | null;
  } {
    const firstTurn = findFirstCodexUserTurn(entries);
    if (!firstTurn) {
      return { title: null, fullTitle: null };
    }
    return {
      title: truncateSessionTitle(firstTurn.text) || null,
      fullTitle: firstTurn.text,
    };
  }

  /**
   * Count user/assistant messages in entries.
   *
   * Matches the logic in convertEntriesToMessages - we count user_message
   * events and response_item messages. Async completed agent items are
   * standalone rows; ordinary agent events are streaming duplicates.
   */
  private countMessages(entries: CodexSessionEntry[]): number {
    const provenance = buildCodexUserTurnProvenance(entries);
    const assistantCount = entries.reduce(
      (count, entry) =>
        (entry.type === "response_item" &&
          entry.payload.type === "message" &&
          entry.payload.role === "assistant") ||
        getCodexAsyncAgentMessageItem(entry) !== null
          ? count + 1
          : count,
      0,
    );
    return assistantCount + countCodexUserTurns(entries, provenance);
  }

  /**
   * Extract context usage from token_count events.
   *
   * @param entries - Codex session entries
   * @param model - Model ID for determining context window size (fallback)
   * @param provider - Provider for model-less context-window fallback
   */
  private extractContextUsage(
    entries: CodexSessionEntry[],
    model: string | undefined,
    provider: "codex" | "codex-oss",
  ): ContextUsage | undefined {
    // Find last token_count event
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry &&
        entry.type === "event_msg" &&
        entry.payload.type === "token_count"
      ) {
        const info = entry.payload.info;
        if (info?.last_token_usage || info?.total_token_usage) {
          // Codex context meter is based on the latest turn's input_tokens,
          // not cumulative totals and not cached-input totals.
          const usage = info.last_token_usage ?? info.total_token_usage;
          if (!usage) continue;
          const inputTokens = usage.input_tokens;

          if (inputTokens === 0) continue;

          // Prefer model_context_window from Codex if available, fall back to model-based lookup
          const contextWindow =
            info.model_context_window && info.model_context_window > 0
              ? info.model_context_window
              : getModelContextWindow(model, provider);
          const percentage = Math.min(
            100,
            Math.round((inputTokens / contextWindow) * 100),
          );

          return { inputTokens, percentage, contextWindow };
        }
      }
    }

    return undefined;
  }

  /**
   * Extract the model from turn_context entries.
   */
  private extractModel(entries: CodexSessionEntry[]): string | undefined {
    // Last turn_context with a model: per-turn context tracks the model the
    // session is currently using, which can change mid-transcript.
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type === "turn_context" && entry.payload.model) {
        return entry.payload.model;
      }
    }
    return undefined;
  }

  /**
   * Extract the first turn_context entry, which captures session launch policy.
   */
  private extractTurnContext(
    entries: CodexSessionEntry[],
  ): CodexTurnContextEntry | undefined {
    for (const entry of entries) {
      if (entry.type === "turn_context") {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Determine provider based on session metadata or model.
   */
  private determineProvider(
    metaEntry: CodexSessionMetaEntry,
    model?: string,
  ): "codex" | "codex-oss" {
    // Check explicit provider field if available
    if (metaEntry.payload.model_provider) {
      const provider = metaEntry.payload.model_provider.toLowerCase();
      if (
        provider === "ollama" ||
        provider === "lmstudio" ||
        provider === "local"
      ) {
        return "codex-oss";
      }
      if (provider === "openai" || provider === "azure") {
        return "codex";
      }
    }

    // fallback: check model name for known local models if provider not set
    if (model) {
      const lowerModel = model.toLowerCase();
      // Heuristic: models starting with "gpt-" or "o1-" are usually OpenAI
      if (lowerModel.startsWith("gpt-") || lowerModel.startsWith("o1-")) {
        return "codex";
      }
      // Heuristic: other models often implying local usage (llama, mistral, qwen, etc)
      // or if we just default to everything else being oss?
      // For safety, let's just stick to specific local keywords for now to avoid false positives.
      if (
        lowerModel.includes("llama") ||
        lowerModel.includes("mistral") ||
        lowerModel.includes("qwen") ||
        lowerModel.includes("gemma") ||
        lowerModel.includes("deepseek") ||
        lowerModel.includes("phi")
      ) {
        return "codex-oss";
      }
    }

    // Default to codex if we can't be sure
    return "codex";
  }

  /**
   * Helper to determine provider from a list of entries.
   */
  private determineProviderFromEntries(
    entries: CodexSessionEntry[],
  ): "codex" | "codex-oss" {
    const metaEntry = entries.find((e) => e.type === "session_meta") as
      | CodexSessionMetaEntry
      | undefined;

    if (!metaEntry) return "codex";

    const model = this.extractModel(entries);
    return this.determineProvider(metaEntry, model);
  }
}

function createCodexSessionReaderScanMetrics(options: {
  sessionsDir: string;
  projectPath?: string;
  activeAfterMs?: number;
  cacheKey: string;
  sharedCacheStatus: CodexSessionReaderScanCacheStatus;
}): CodexSessionReaderScanMetrics {
  return {
    sessionsDir: options.sessionsDir,
    ...(options.projectPath ? { projectPath: options.projectPath } : {}),
    ...(options.activeAfterMs !== undefined
      ? { activeAfterMs: options.activeAfterMs }
      : {}),
    cacheKey: options.cacheKey,
    sharedCacheStatus: options.sharedCacheStatus,
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
    subagentSessionsSkipped: 0,
    sessionsReturned: 0,
    discovery: createCodexRolloutDiscoveryStats(),
  };
}

function codexSessionSourceLabel(source: unknown): string | undefined {
  if (typeof source === "string") {
    const trimmed = source.trim();
    return trimmed || undefined;
  }

  if (isRecord(source) && isRecord(source.subagent)) {
    return "subagent";
  }

  return undefined;
}

function inferCodexAgentStatus(
  entries: CodexSessionEntry[],
): "pending" | "running" | "completed" | "failed" {
  let sawTaskStarted = false;
  let sawTaskComplete = false;
  let sawTurnAborted = false;
  let sawAssistantMessage = false;

  for (const entry of entries) {
    if (entry.type === "event_msg") {
      if (entry.payload.type === "task_started") {
        sawTaskStarted = true;
        sawTaskComplete = false;
      } else if (entry.payload.type === "task_complete") {
        sawTaskComplete = true;
      } else if (entry.payload.type === "turn_aborted") {
        sawTurnAborted = true;
      }
      continue;
    }

    if (
      entry.type === "response_item" &&
      entry.payload.type === "message" &&
      entry.payload.role === "assistant"
    ) {
      sawAssistantMessage = true;
    }
  }

  if (sawTurnAborted) {
    return "failed";
  }
  if (sawTaskStarted && !sawTaskComplete) {
    return "running";
  }
  if (sawTaskComplete || sawAssistantMessage) {
    return "completed";
  }
  return "pending";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneCodexSessionReaderScanMetrics(
  metrics: CodexSessionReaderScanMetrics,
): CodexSessionReaderScanMetrics {
  return {
    ...metrics,
    discovery: { ...metrics.discovery },
  };
}
