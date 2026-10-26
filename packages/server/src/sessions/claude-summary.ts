import type { Stats } from "node:fs";
import { open } from "node:fs/promises";
import {
  DEFAULT_PROVIDER,
  type ProviderName,
  type UrlProjectId,
  type ClaudeSessionEntry,
  getLogicalParentUuid,
  getModelContextWindow,
  isCompactBoundary,
  isIdeMetadata,
  isSyntheticNoResponseTurn,
  sanitizeSessionTitle,
  stripIdeMetadata,
  truncateSessionTitle,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { ContextUsage, SessionSummary } from "../supervisor/types.js";
import { iterateJsonlLines } from "../utils/jsonl.js";
import {
  assistantContentParts,
  formatAgentExcerpt,
  systemAwaySummaryExcerpt,
} from "./agent-excerpt.js";

type UsageFields = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export interface CompactClaudeSummaryNode {
  uuid: string;
  parentUuid: string | null;
  logicalParentUuid?: string;
  lineIndex: number;
  type: string;
  timestamp: string;
  model?: string;
  usage?: UsageFields;
  compactionPreTokens?: number;
  awaySummaryExcerpt?: string;
  assistantExcerpt?: string;
  assistantToolName?: string;
  /** A user entry carrying prose: someone wrote into the session here. */
  humanTurn?: boolean;
}

interface ParseMetrics {
  lineCount: number;
  parsedEntries: number;
  malformedLines: number;
  nodeCount: number;
  maxLineLength: number;
}

export interface ClaudeSummaryStreamMetrics extends ParseMetrics {
  fileSize: number;
  parseMs: number;
  rssBefore: number;
  rssAfter: number;
  heapUsedBefore: number;
  heapUsedAfter: number;
}

export interface ClaudeSessionSummaryRead {
  summary: SessionSummary | null;
  metrics: ClaudeSummaryStreamMetrics;
}

export interface ClaudeSummaryParseState {
  nodeMap: Map<string, CompactClaudeSummaryNode>;
  childrenMap: Map<string | null, string[]>;
  progressUuids: Set<string>;
  firstTimestamp?: string;
  firstUserTitleContent?: string;
  firstUserTitleCaptured: boolean;
  metrics: ParseMetrics;
}

export interface ReadClaudeSessionSummaryOptions {
  filePath: string;
  stats: Stats;
  sessionId: string;
  projectId: UrlProjectId;
  resolveContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number;
  includeCompactionSafetyMargin?: boolean;
}

const LOG_CLAUDE_SUMMARY_PARSE = process.env.CLAUDE_READER_LOG_PARSE === "true";

const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_MESSAGE_RE = /<command-message>[\s\S]*?<\/command-message>/g;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_NAME_TAG_RE = /<command-name>[\s\S]*?<\/command-name>/g;
const COMMAND_ARGS_TAG_RE = /<command-args>[\s\S]*?<\/command-args>/g;
const LOCAL_COMMAND_CAVEAT_RE =
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g;
const CONVERSATION_TYPES = new Set(["user", "assistant"]);

function getTotalInputTokens(usage: UsageFields): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function formatClaudeCommandTurn(text: string): string | null {
  const command = text.match(COMMAND_NAME_RE)?.[1]?.trim();
  if (!command) return null;

  const unparsed = text
    .replace(LOCAL_COMMAND_CAVEAT_RE, "")
    .replace(COMMAND_NAME_TAG_RE, "")
    .replace(COMMAND_MESSAGE_RE, "")
    .replace(COMMAND_ARGS_TAG_RE, "")
    .trim();
  if (unparsed) return null;

  const args = text.match(COMMAND_ARGS_RE)?.[1]?.trim() ?? "";
  return args ? `${command} ${args}` : command;
}

function normalizeTitleText(text: string): string {
  const withoutIdeMetadata = stripIdeMetadata(text);
  return formatClaudeCommandTurn(withoutIdeMetadata) ?? withoutIdeMetadata;
}

function extractTitleContent(
  content: string | Array<{ type?: unknown; text?: unknown }>,
): string {
  if (typeof content === "string") {
    return normalizeTitleText(content);
  }
  const titleText = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block?.type === "text" &&
        typeof block.text === "string" &&
        !isIdeMetadata(block.text),
    )
    .map((block) => block.text)
    .join("\n");
  return normalizeTitleText(titleText);
}

function getStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function getUuid(entry: ClaudeSessionEntry): string | undefined {
  return getStringField(entry, "uuid");
}

function getParentUuid(entry: ClaudeSessionEntry): string | null {
  return getStringField(entry, "parentUuid") ?? null;
}

function getTimestamp(entry: ClaudeSessionEntry): string {
  return getStringField(entry, "timestamp") ?? "";
}

function getFirstUserTitleCandidate(
  entry: ClaudeSessionEntry,
): string | undefined {
  if (entry.type !== "user" || entry.isMeta === true) return undefined;
  const content = (entry as { message?: { content?: unknown } }).message
    ?.content;
  if (!content) return undefined;
  if (typeof content === "string") return extractTitleContent(content);
  if (!Array.isArray(content)) return undefined;
  const objectBlocks = content.filter(
    (block): block is { type?: unknown; text?: unknown } =>
      typeof block === "object" && block !== null,
  );
  return extractTitleContent(objectBlocks);
}

function validTimestamp(entry: ClaudeSessionEntry): string | undefined {
  const timestampMs = Date.parse(getTimestamp(entry));
  return Number.isFinite(timestampMs)
    ? new Date(timestampMs).toISOString()
    : undefined;
}

export interface ClaudeCatalogHead {
  /** Whole: search matches the session's own words; surfaces truncate. */
  title?: string;
  /** The first timestamped entry, as the summary's `createdAt` takes it. */
  createdAt?: string;
}

/** Collection discovery never parses past this prefix for a title or the
 * session's creation time. */
export async function readClaudeCatalogHead(
  filePath: string,
): Promise<ClaudeCatalogHead> {
  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    if (bytesRead === buffer.length) lines.pop();
    let createdAt: string | undefined;
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: ClaudeSessionEntry;
      try {
        entry = JSON.parse(line) as ClaudeSessionEntry;
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      createdAt ??= validTimestamp(entry);
      const title = getFirstUserTitleCandidate(entry);
      if (title !== undefined) {
        const sanitized = sanitizeSessionTitle(title) || undefined;
        return {
          ...(sanitized !== undefined ? { title: sanitized } : {}),
          ...(createdAt ? { createdAt } : {}),
        };
      }
    }
    return createdAt ? { createdAt } : {};
  } finally {
    await file.close();
  }
}

export interface ClaudeCatalogTail {
  /** The latest conversation timestamp. */
  updatedAt?: string;
  /** The latest human turn, by the summary's own per-entry test. */
  lastHumanTurnAt?: string;
}

/**
 * The tail counterpart of `readClaudeCatalogHead`: the latest conversation
 * and human-turn timestamps a collection row can claim without a full parse.
 *
 * Catalog rows are built for sessions the summary index cannot answer for —
 * every session is dirty for a beat after any append — so their only other
 * freshness source is file mtime. Claude writes non-conversation rows at
 * shutdown (an idle reap's `last-prompt`), and an mtime taken from one of
 * those makes a read session unread and falsely recent. See
 * `docs/project/2026-07-06-claude-idle-reap-mtime-unread.md`.
 *
 * Like `getLastAgentExcerpt`, this scans raw lines from the end rather than
 * building the DAG, so it approximates the active branch: a dead post-rewind
 * branch at the tail could win. That is acceptable for a bounded projection
 * the exact indexed summary replaces as soon as it is warm, and it is strictly
 * closer than storage time either way. A field is omitted when no row inside
 * the window carries it, leaving the caller's fallback in place: storage time
 * for `updatedAt`, and the creation time for a human turn further back.
 */
export async function readClaudeCatalogTail(
  filePath: string,
): Promise<ClaudeCatalogTail> {
  const file = await open(filePath, "r");
  try {
    const { size } = await file.stat();
    const windowBytes = Math.min(size, 256 * 1024);
    const position = size - windowBytes;
    const buffer = Buffer.alloc(windowBytes);
    const { bytesRead } = await file.read(buffer, 0, windowBytes, position);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // A window that starts mid-file opens mid-line; that fragment is not JSON.
    if (position > 0) lines.shift();
    let updatedAt: string | undefined;
    let lastHumanTurnAt: string | undefined;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (updatedAt && lastHumanTurnAt) break;
      const line = lines[i]?.trim();
      if (!line) continue;
      let entry: ClaudeSessionEntry;
      try {
        entry = JSON.parse(line) as ClaudeSessionEntry;
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      if (!CONVERSATION_TYPES.has(entry.type)) continue;
      const timestamp = validTimestamp(entry);
      if (!timestamp) continue;
      updatedAt ??= timestamp;
      if (!lastHumanTurnAt && getFirstUserTitleCandidate(entry))
        lastHumanTurnAt = timestamp;
    }
    return {
      ...(updatedAt ? { updatedAt } : {}),
      ...(lastHumanTurnAt ? { lastHumanTurnAt } : {}),
    };
  } finally {
    await file.close();
  }
}

function getAssistantUsage(entry: ClaudeSessionEntry): UsageFields | undefined {
  if (entry.type !== "assistant") return undefined;
  const usage = (entry as { message?: { usage?: UsageFields } }).message?.usage;
  return usage && typeof usage === "object" ? usage : undefined;
}

function getAssistantModel(entry: ClaudeSessionEntry): string | undefined {
  if (entry.type !== "assistant") return undefined;
  return getStringField(
    (entry as { message?: { model?: unknown } }).message,
    "model",
  );
}

function getCompactionPreTokens(entry: ClaudeSessionEntry): number | undefined {
  if (!isCompactBoundary(entry)) return undefined;
  const compactMetadata = (entry as { compactMetadata?: unknown })
    .compactMetadata;
  if (!compactMetadata || typeof compactMetadata !== "object") {
    return undefined;
  }
  const preTokens = (compactMetadata as { preTokens?: unknown }).preTokens;
  return typeof preTokens === "number" && preTokens > 0 ? preTokens : undefined;
}

export function createParseState(): ClaudeSummaryParseState {
  return {
    nodeMap: new Map(),
    childrenMap: new Map(),
    progressUuids: new Set(),
    firstUserTitleCaptured: false,
    metrics: {
      lineCount: 0,
      parsedEntries: 0,
      malformedLines: 0,
      nodeCount: 0,
      maxLineLength: 0,
    },
  };
}

function rememberChild(
  childrenMap: Map<string | null, string[]>,
  parentUuid: string | null,
  uuid: string,
): void {
  const children = childrenMap.get(parentUuid);
  if (children) {
    children.push(uuid);
  } else {
    childrenMap.set(parentUuid, [uuid]);
  }
}

export function addEntryToState(
  state: ClaudeSummaryParseState,
  entry: ClaudeSessionEntry,
  lineIndex: number,
): void {
  state.metrics.parsedEntries += 1;

  if (!state.firstTimestamp) {
    const timestamp = getTimestamp(entry);
    if (timestamp) state.firstTimestamp = timestamp;
  }

  if (!state.firstUserTitleCaptured) {
    const candidate = getFirstUserTitleCandidate(entry);
    if (candidate !== undefined) {
      state.firstUserTitleContent = candidate;
      state.firstUserTitleCaptured = true;
    }
  }

  const uuid = getUuid(entry);
  if (!uuid) return;

  if (entry.type === "progress") {
    state.progressUuids.add(uuid);
    return;
  }

  const parentUuid = getParentUuid(entry);
  const logicalParentUuid = getLogicalParentUuid(entry);
  const model = getAssistantModel(entry);
  const usage = getAssistantUsage(entry);
  const compactionPreTokens = getCompactionPreTokens(entry);
  const awaySummaryExcerpt = systemAwaySummaryExcerpt(entry);
  // A synthetic no-response placeholder is assistant-shaped but no model
  // produced it, so it must not become the session's "last agent turn" excerpt.
  const assistantParts =
    entry.type === "assistant" && !isSyntheticNoResponseTurn(entry)
      ? assistantContentParts(
          (entry as { message?: { content?: unknown } }).message?.content,
        )
      : undefined;
  const assistantExcerpt = assistantParts
    ? formatAgentExcerpt(assistantParts.text)
    : undefined;
  const node: CompactClaudeSummaryNode = {
    uuid,
    parentUuid,
    lineIndex,
    type: entry.type,
    timestamp: getTimestamp(entry),
    ...(logicalParentUuid ? { logicalParentUuid } : {}),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(compactionPreTokens ? { compactionPreTokens } : {}),
    ...(awaySummaryExcerpt ? { awaySummaryExcerpt } : {}),
    ...(assistantExcerpt ? { assistantExcerpt } : {}),
    ...(assistantParts?.toolName
      ? { assistantToolName: assistantParts.toolName }
      : {}),
    // The same text test that picks a session's title, reused so one rule
    // decides what counts as someone writing into the session.
    ...(getFirstUserTitleCandidate(entry) ? { humanTurn: true } : {}),
  };

  state.nodeMap.set(uuid, node);
  rememberChild(state.childrenMap, parentUuid, uuid);
  state.metrics.nodeCount = state.nodeMap.size;
}

function findFallbackParentByLineIndex(
  beforeLineIndex: number,
  nodeMap: Map<string, CompactClaudeSummaryNode>,
  excludeUuids: Set<string>,
): CompactClaudeSummaryNode | null {
  let best: CompactClaudeSummaryNode | null = null;
  for (const node of nodeMap.values()) {
    if (node.lineIndex >= beforeLineIndex) continue;
    if (excludeUuids.has(node.uuid)) continue;
    if (!best || node.lineIndex > best.lineIndex) {
      best = node;
    }
  }
  return best;
}

function walkBranchLength(
  tipUuid: string,
  nodeMap: Map<string, CompactClaudeSummaryNode>,
  progressUuids: Set<string>,
): number {
  let conversationCount = 0;
  let currentUuid: string | null = tipUuid;
  const visited = new Set<string>();

  while (currentUuid && !visited.has(currentUuid)) {
    visited.add(currentUuid);
    const node = nodeMap.get(currentUuid);
    if (!node) break;

    if (CONVERSATION_TYPES.has(node.type)) {
      conversationCount += 1;
    }

    let nextUuid = node.parentUuid;
    if (!nextUuid && node.logicalParentUuid) {
      nextUuid = node.logicalParentUuid;
    }

    if (
      nextUuid &&
      !nodeMap.has(nextUuid) &&
      (node.logicalParentUuid || progressUuids.has(nextUuid))
    ) {
      const fallback = findFallbackParentByLineIndex(
        node.lineIndex,
        nodeMap,
        visited,
      );
      currentUuid = fallback?.uuid ?? null;
    } else {
      currentUuid = nextUuid;
    }
  }

  return conversationCount;
}

function selectActiveTip(
  state: ClaudeSummaryParseState,
): CompactClaudeSummaryNode | null {
  const tips: CompactClaudeSummaryNode[] = [];
  for (const node of state.nodeMap.values()) {
    const children = state.childrenMap.get(node.uuid);
    if (!children || children.length === 0) {
      tips.push(node);
    }
  }
  if (tips.length === 0) return null;

  // Branch length only breaks timestamp ties, so walk branches solely for
  // the tips tied on the newest timestamp: walking every tip is quadratic on
  // large sessions (each walk is O(depth) with O(n) fallback scans).
  let maxTimestamp = "";
  for (const node of tips) {
    if (node.timestamp > maxTimestamp) maxTimestamp = node.timestamp;
  }
  const candidates = tips.filter((node) => node.timestamp === maxTimestamp);
  if (candidates.length === 1) return candidates[0] ?? null;

  return candidates
    .map((node) => ({
      node,
      length: walkBranchLength(node.uuid, state.nodeMap, state.progressUuids),
    }))
    .reduce((best, current) => {
      if (current.length > best.length) return current;
      if (
        current.length === best.length &&
        current.node.lineIndex > best.node.lineIndex
      ) {
        return current;
      }
      return best;
    }).node;
}

function buildActiveBranch(
  state: ClaudeSummaryParseState,
): CompactClaudeSummaryNode[] {
  const tip = selectActiveTip(state);
  const activeBranch: CompactClaudeSummaryNode[] = [];
  const visited = new Set<string>();

  let current: CompactClaudeSummaryNode | null = tip;
  while (current && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    activeBranch.unshift(current);

    let nextUuid = current.parentUuid;
    if (!nextUuid && current.logicalParentUuid) {
      nextUuid = current.logicalParentUuid;
    }

    let nextNode = nextUuid ? (state.nodeMap.get(nextUuid) ?? null) : null;
    if (
      !nextNode &&
      nextUuid &&
      ((current.logicalParentUuid &&
        !state.nodeMap.has(current.logicalParentUuid)) ||
        state.progressUuids.has(nextUuid))
    ) {
      nextNode = findFallbackParentByLineIndex(
        current.lineIndex,
        state.nodeMap,
        visited,
      );
    }

    current = nextNode;
  }

  return activeBranch;
}

function extractModel(
  activeBranch: CompactClaudeSummaryNode[],
): string | undefined {
  for (let i = activeBranch.length - 1; i >= 0; i -= 1) {
    const node = activeBranch[i];
    if (node?.type !== "assistant") continue;
    if (node.model && node.model !== "<synthetic>") return node.model;
  }
  return undefined;
}

function computeCompactCompactionOverhead(
  activeBranch: CompactClaudeSummaryNode[],
): number {
  let lastCompactIdx = -1;
  let preTokens = 0;

  for (let i = activeBranch.length - 1; i >= 0; i -= 1) {
    const node = activeBranch[i];
    if (node?.compactionPreTokens) {
      lastCompactIdx = i;
      preTokens = node.compactionPreTokens;
      break;
    }
  }

  if (lastCompactIdx === -1) return 0;

  for (let i = lastCompactIdx - 1; i >= 0; i -= 1) {
    const node = activeBranch[i];
    if (node?.type !== "assistant" || !node.usage) continue;
    const lastPreCompactionTokens = getTotalInputTokens(node.usage);
    if (lastPreCompactionTokens > 0) {
      const overhead = preTokens - lastPreCompactionTokens;
      return overhead > 0 ? overhead : 0;
    }
  }

  return 0;
}

function extractContextUsage(
  activeBranch: CompactClaudeSummaryNode[],
  model: string | undefined,
  provider: ProviderName,
  resolveContextWindow: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number,
  includeCompactionSafetyMargin: boolean,
): ContextUsage | undefined {
  const contextWindowSize = resolveContextWindow(model, provider);
  const overhead = includeCompactionSafetyMargin
    ? computeCompactCompactionOverhead(activeBranch)
    : 0;

  for (let i = activeBranch.length - 1; i >= 0; i -= 1) {
    const node = activeBranch[i];
    if (node?.type !== "assistant" || !node.usage) continue;

    const rawInputTokens = getTotalInputTokens(node.usage);
    if (rawInputTokens === 0) continue;

    const inputTokens = rawInputTokens + overhead;
    const result: ContextUsage = {
      inputTokens,
      percentage: Math.round((inputTokens / contextWindowSize) * 100),
      contextWindow: contextWindowSize,
    };

    if (
      node.usage.output_tokens !== undefined &&
      node.usage.output_tokens > 0
    ) {
      result.outputTokens = node.usage.output_tokens;
    }
    if (
      node.usage.cache_read_input_tokens !== undefined &&
      node.usage.cache_read_input_tokens > 0
    ) {
      result.cacheReadTokens = node.usage.cache_read_input_tokens;
    }
    if (
      node.usage.cache_creation_input_tokens !== undefined &&
      node.usage.cache_creation_input_tokens > 0
    ) {
      result.cacheCreationTokens = node.usage.cache_creation_input_tokens;
    }

    return result;
  }

  return undefined;
}

/** Active-branch agent excerpt for a parse state (hover-card refresh path). */
export function lastAgentExcerptFromState(
  state: ClaudeSummaryParseState,
): string | undefined {
  return findLastAgentExcerpt(buildActiveBranch(state));
}

function findLastAgentExcerpt(
  activeBranch: CompactClaudeSummaryNode[],
): string | undefined {
  let trailingTool: string | undefined;
  for (let i = activeBranch.length - 1; i >= 0; i -= 1) {
    const node = activeBranch[i];
    if (!node) continue;
    if (node.awaySummaryExcerpt) return node.awaySummaryExcerpt;
    if (node.type !== "assistant") continue;
    if (node.assistantExcerpt) return node.assistantExcerpt;
    if (!trailingTool && node.assistantToolName) {
      trailingTool = node.assistantToolName;
    }
  }
  return trailingTool ? `⚙ ${trailingTool}` : undefined;
}

/**
 * When someone last wrote into this session, as opposed to when the agent last
 * produced something. Sidebar chronology is stated in the reader's own turns,
 * so it needs a time that agent work never advances.
 *
 * A message another session delivered here reads exactly like a typed one and
 * counts as one; separating them would need provenance the transcript does not
 * carry. Tool results do not count: they arrive as user entries, but carry
 * blocks rather than prose, so the same text test that picks a session's title
 * rejects them.
 */
function findLastHumanTurnAt(
  activeBranch: CompactClaudeSummaryNode[],
): string | undefined {
  for (let i = activeBranch.length - 1; i >= 0; i -= 1) {
    const node = activeBranch[i];
    if (!node?.humanTurn) continue;
    const timestampMs = Date.parse(node.timestamp);
    if (Number.isFinite(timestampMs))
      return new Date(timestampMs).toISOString();
  }
  return undefined;
}

function findContentUpdatedAt(
  activeBranch: CompactClaudeSummaryNode[],
  fallback: Date,
): string {
  for (let i = activeBranch.length - 1; i >= 0; i -= 1) {
    const node = activeBranch[i];
    if (!node || !CONVERSATION_TYPES.has(node.type)) continue;
    const timestampMs = Date.parse(node.timestamp);
    if (Number.isFinite(timestampMs)) {
      return new Date(timestampMs).toISOString();
    }
  }
  return fallback.toISOString();
}

/**
 * Shallow-clone a parse state so a provisional (unterminated) trailing entry
 * can be folded in for summary building without polluting the incremental
 * state retained by the transcript cache.
 */
export function cloneParseState(
  state: ClaudeSummaryParseState,
): ClaudeSummaryParseState {
  return {
    nodeMap: new Map(state.nodeMap),
    childrenMap: new Map(
      [...state.childrenMap].map(([parent, children]) => [
        parent,
        [...children],
      ]),
    ),
    progressUuids: new Set(state.progressUuids),
    firstTimestamp: state.firstTimestamp,
    firstUserTitleContent: state.firstUserTitleContent,
    firstUserTitleCaptured: state.firstUserTitleCaptured,
    metrics: { ...state.metrics },
  };
}

export function buildSummaryFromState(
  state: ClaudeSummaryParseState,
  options: ReadClaudeSessionSummaryOptions,
): SessionSummary | null {
  const activeBranch = buildActiveBranch(state);
  const messageCount = activeBranch.filter((node) =>
    CONVERSATION_TYPES.has(node.type),
  ).length;

  const firstUserMessage = state.firstUserTitleContent;
  const fullTitle = firstUserMessage?.trim() || null;
  const title = firstUserMessage
    ? truncateSessionTitle(firstUserMessage) || null
    : null;
  const model = extractModel(activeBranch);
  const provider: ProviderName =
    model && !model.startsWith("claude-") ? "claude-ollama" : DEFAULT_PROVIDER;
  const resolveContextWindow =
    options.resolveContextWindow ?? getModelContextWindow;

  const createdAt =
    state.firstTimestamp ??
    (options.stats.birthtimeMs > 0
      ? options.stats.birthtime.toISOString()
      : options.stats.mtime.toISOString());
  const lastHumanTurnAt = findLastHumanTurnAt(activeBranch);

  return {
    id: options.sessionId,
    projectId: options.projectId,
    title,
    fullTitle,
    createdAt,
    updatedAt: findContentUpdatedAt(activeBranch, options.stats.mtime),
    messageCount,
    ownership: { owner: "none" },
    contextUsage: extractContextUsage(
      activeBranch,
      model,
      provider,
      resolveContextWindow,
      options.includeCompactionSafetyMargin === true,
    ),
    provider,
    model,
    lastAgentText: findLastAgentExcerpt(activeBranch),
    ...(lastHumanTurnAt ? { lastHumanTurnAt } : {}),
  };
}

function createStreamMetrics(args: {
  options: ReadClaudeSessionSummaryOptions;
  metrics: ParseMetrics;
  parseMs: number;
  memoryBefore: NodeJS.MemoryUsage;
  memoryAfter: NodeJS.MemoryUsage;
}): ClaudeSummaryStreamMetrics {
  return {
    fileSize: args.options.stats.size,
    lineCount: args.metrics.lineCount,
    parsedEntries: args.metrics.parsedEntries,
    malformedLines: args.metrics.malformedLines,
    nodeCount: args.metrics.nodeCount,
    maxLineLength: args.metrics.maxLineLength,
    parseMs: args.parseMs,
    rssBefore: args.memoryBefore.rss,
    rssAfter: args.memoryAfter.rss,
    heapUsedBefore: args.memoryBefore.heapUsed,
    heapUsedAfter: args.memoryAfter.heapUsed,
  };
}

function logParseMetrics(args: {
  options: ReadClaudeSessionSummaryOptions;
  metrics: ClaudeSummaryStreamMetrics;
}): void {
  if (!LOG_CLAUDE_SUMMARY_PARSE && args.metrics.parseMs < 250) return;
  getLogger().info(
    {
      event: "claude_summary_stream",
      sessionId: args.options.sessionId,
      filePath: args.options.filePath,
      fileSize: args.metrics.fileSize,
      lineCount: args.metrics.lineCount,
      parsedEntries: args.metrics.parsedEntries,
      malformedLines: args.metrics.malformedLines,
      nodeCount: args.metrics.nodeCount,
      maxLineLength: args.metrics.maxLineLength,
      parseMs: args.metrics.parseMs,
      rssBefore: args.metrics.rssBefore,
      rssAfter: args.metrics.rssAfter,
      heapUsedBefore: args.metrics.heapUsedBefore,
      heapUsedAfter: args.metrics.heapUsedAfter,
    },
    "CLAUDE_READER: summary stream",
  );
}

/** Replica selection stops at the first entry accepted by the summary parser. */
export async function hasClaudeTranscriptEntries(
  filePath: string,
): Promise<boolean> {
  const state = createParseState();
  for await (const line of iterateJsonlLines(filePath)) {
    if (!line.trim()) continue;
    try {
      addEntryToState(state, JSON.parse(line) as ClaudeSessionEntry, 0);
    } catch {
      continue;
    }
    if (state.metrics.parsedEntries > 0) return true;
  }
  return false;
}

export async function readClaudeSessionSummaryWithMetrics(
  options: ReadClaudeSessionSummaryOptions,
): Promise<ClaudeSessionSummaryRead> {
  const state = createParseState();
  const startedAt = Date.now();
  const memoryBefore = process.memoryUsage();

  for await (const rawLine of iterateJsonlLines(options.filePath)) {
    state.metrics.lineCount += 1;
    state.metrics.maxLineLength = Math.max(
      state.metrics.maxLineLength,
      rawLine.length,
    );
    const line = rawLine.trim();
    if (!line) continue;

    try {
      const parsedLineIndex = state.metrics.parsedEntries;
      addEntryToState(
        state,
        JSON.parse(line) as ClaudeSessionEntry,
        parsedLineIndex,
      );
    } catch {
      state.metrics.malformedLines += 1;
    }
  }

  const parseMs = Date.now() - startedAt;
  const memoryAfter = process.memoryUsage();
  const metrics = createStreamMetrics({
    options,
    metrics: state.metrics,
    parseMs,
    memoryBefore,
    memoryAfter,
  });
  logParseMetrics({
    options,
    metrics,
  });

  const summary =
    state.metrics.parsedEntries === 0
      ? null
      : buildSummaryFromState(state, options);
  return { summary, metrics };
}

export async function readClaudeSessionSummary(
  options: ReadClaudeSessionSummaryOptions,
): Promise<SessionSummary | null> {
  return (await readClaudeSessionSummaryWithMetrics(options)).summary;
}
