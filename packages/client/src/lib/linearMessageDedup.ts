import { getMessageIds } from "@yep-anywhere/shared/transcript/message";
import type { Message } from "../types";
import { isUnconfirmedSelfSend } from "./deliveryState";
import { getMessageContent, mergeMessage } from "./mergeMessages";

// A human does not send two semantically identical turns within this window,
// so it is safe to treat same-fingerprint messages this close in time as the
// same message (a stream copy and its durable copy). Deliberately tight to
// minimize false merges; deterministic id matching (where available) carries
// the real load, this is only the backstop.
const DEFAULT_TIMESTAMP_WINDOW_MS = 2000;
const REPLAY_TIMESTAMP_WINDOW_MS = 2000;
// New-session startup can echo the opening user turn before the provider has
// finished creating/persisting the durable session. Keep the wider tolerance
// scoped to that one first user turn; later identical turns stay on the tight
// 2s backstop.
const FIRST_USER_TURN_TIMESTAMP_WINDOW_MS = 30000;
const MAX_SCAN_MESSAGES = 400;
const UPLOADED_FILES_MARKERS = [
  "\n\nUser uploaded files in .attachments:\n",
  "\n\nUser uploaded files:\n",
] as const;

interface ApproxDedupOptions {
  windowMs?: number;
  replayWindowMs?: number;
  firstUserTurnWindowMs?: number;
  excludeTools?: boolean;
}

const semanticFingerprintCache = new WeakMap<Message, string | null>();
const visibleUserTurnFingerprintCache = new WeakMap<Message, string | null>();

function getMessageRole(message: Message): string {
  const nestedRole = (message.message as { role?: unknown } | undefined)?.role;
  if (nestedRole === "user" || nestedRole === "assistant") {
    return nestedRole;
  }
  if (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "system"
  ) {
    return message.role;
  }
  return "unknown";
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${k}:${stableStringify(v)}`).join(",")}}`;
  }
  return String(value);
}

function normalizeContentBlock(block: unknown): string {
  if (typeof block === "string") {
    return `text:${block}`;
  }

  if (!block || typeof block !== "object") {
    return "";
  }

  const typedBlock = block as Record<string, unknown>;
  const type =
    typeof typedBlock.type === "string" ? typedBlock.type : "unknown";

  switch (type) {
    case "text":
    case "output_text":
      return `text:${typeof typedBlock.text === "string" ? typedBlock.text : ""}`;

    case "thinking":
      return `thinking:${typeof typedBlock.thinking === "string" ? typedBlock.thinking : ""}`;

    case "tool_use":
      return `tool_use:${typeof typedBlock.id === "string" ? typedBlock.id : ""}:${typeof typedBlock.name === "string" ? typedBlock.name : ""}:${stableStringify(typedBlock.input)}`;

    case "tool_result":
      return `tool_result:${typeof typedBlock.tool_use_id === "string" ? typedBlock.tool_use_id : ""}:${typedBlock.is_error === true ? "1" : "0"}:${typeof typedBlock.content === "string" ? typedBlock.content : stableStringify(typedBlock.content)}`;

    default:
      return `${type}:${stableStringify(typedBlock)}`;
  }
}

function isReplayMessage(message: Message): boolean {
  return message.isReplay === true;
}

// A message that carries a tool_use or tool_result block. These dedup by a
// deterministic id (Codex call_id) upstream in mergeMessages, so the
// content+timestamp backstop is redundant for them; callers can opt to exclude
// them so legitimately-recurring identical tool calls are never approx-merged.
function isToolMessage(message: Message): boolean {
  const content = getMessageContent(message);
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = (block as { type?: unknown }).type;
    return type === "tool_use" || type === "tool_result";
  });
}

/**
 * A plain user prompt turn: user type + user role, excluding tool_use /
 * tool_result echoes that also render under the user role. Shared with the
 * composer recall drawer's entry derivation (composerTurnRecall).
 */
export function isPlainUserTurn(message: Message): boolean {
  return (
    message.type === "user" &&
    getMessageRole(message) === "user" &&
    !isToolMessage(message)
  );
}

function hasEarlierPlainUserTurn(
  messages: Message[],
  beforeIndex: number,
): boolean {
  for (let i = 0; i < beforeIndex; i += 1) {
    const message = messages[i];
    if (message && isPlainUserTurn(message)) {
      return true;
    }
  }
  return false;
}

function hasEarlierPlainUserEntry(
  entries: IndexedMessage[],
  beforeIndex: number,
): boolean {
  for (let i = 0; i < beforeIndex; i += 1) {
    const entry = entries[i];
    if (entry && isPlainUserTurn(entry.message)) {
      return true;
    }
  }
  return false;
}

function getAllowedTimestampDeltaMs(
  a: Message,
  b: Message,
  options: Required<Pick<ApproxDedupOptions, "windowMs" | "replayWindowMs">> &
    Pick<ApproxDedupOptions, "firstUserTurnWindowMs">,
  isFirstUserTurnPair: boolean,
): number {
  if (isFirstUserTurnPair) {
    return options.firstUserTurnWindowMs ?? FIRST_USER_TURN_TIMESTAMP_WINDOW_MS;
  }
  return isReplayMessage(a) || isReplayMessage(b)
    ? options.replayWindowMs
    : options.windowMs;
}

function getSemanticFingerprint(message: Message): string | null {
  const cached = semanticFingerprintCache.get(message);
  if (cached !== undefined) {
    return cached;
  }

  const content = getMessageContent(message);

  let normalizedContent: string;
  if (typeof content === "string") {
    normalizedContent = `text:${content}`;
  } else if (Array.isArray(content)) {
    normalizedContent = content.map(normalizeContentBlock).join("|");
  } else {
    semanticFingerprintCache.set(message, null);
    return null;
  }

  if (!normalizedContent.trim()) {
    semanticFingerprintCache.set(message, null);
    return null;
  }

  const type = typeof message.type === "string" ? message.type : "unknown";
  const role = getMessageRole(message);
  const fingerprint = `${type}|${role}|${normalizedContent}`;
  semanticFingerprintCache.set(message, fingerprint);
  return fingerprint;
}

function getTextContent(message: Message): string | null {
  const content = getMessageContent(message);
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const textParts = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typedBlock = block as { type?: unknown; text?: unknown };
      const type = typeof typedBlock.type === "string" ? typedBlock.type : "";
      if (type !== "text" && type !== "output_text" && type !== "input_text") {
        return "";
      }
      return typeof typedBlock.text === "string" ? typedBlock.text : "";
    })
    .filter((text) => text.length > 0);

  return textParts.length > 0 ? textParts.join("\n") : null;
}

function splitUploadedFilesSection(text: string): {
  text: string;
  attachmentPaths: string[];
} {
  const markerIndex = UPLOADED_FILES_MARKERS.map((marker) => ({
    marker,
    index: text.indexOf(marker),
  }))
    .filter(({ index }) => index !== -1)
    .sort((a, b) => a.index - b.index)[0];

  if (!markerIndex) {
    return { text, attachmentPaths: [] };
  }

  const visibleText = text.slice(0, markerIndex.index);
  const uploadSection = text.slice(
    markerIndex.index + markerIndex.marker.length,
  );
  const markdownRegex = /^- \[(?:.+?)\]\((?:<(.+?)>|(.+?))\) \((?:[^)]*)\)$/;
  const legacyRegex = /^- .+? \([^)]+\): (.+)$/;
  const attachmentPaths: string[] = [];

  for (const line of uploadSection.split("\n")) {
    const trimmed = line.trim();
    const markdownMatch = trimmed.match(markdownRegex);
    if (markdownMatch) {
      attachmentPaths.push(markdownMatch[1] ?? markdownMatch[2] ?? "");
      continue;
    }
    const legacyMatch = trimmed.match(legacyRegex);
    if (legacyMatch) {
      attachmentPaths.push(legacyMatch[1] ?? "");
    }
  }

  return {
    text: visibleText,
    attachmentPaths: attachmentPaths.filter((path) => path.trim().length > 0),
  };
}

function extractAttachmentPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((attachment) => {
      if (!attachment || typeof attachment !== "object") {
        return "";
      }
      const path = (attachment as { path?: unknown }).path;
      if (typeof path === "string" && path.trim().length > 0) {
        return path;
      }
      const id = (attachment as { id?: unknown }).id;
      return typeof id === "string" ? id : "";
    })
    .filter((path) => path.trim().length > 0);
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function getVisibleUserTurnFingerprint(message: Message): string | null {
  const cached = visibleUserTurnFingerprintCache.get(message);
  if (cached !== undefined) {
    return cached;
  }

  if (!isPlainUserTurn(message)) {
    visibleUserTurnFingerprintCache.set(message, null);
    return null;
  }

  const text = getTextContent(message);
  if (text === null) {
    visibleUserTurnFingerprintCache.set(message, null);
    return null;
  }

  const split = splitUploadedFilesSection(text);
  const attachmentPaths = new Set<string>([
    ...split.attachmentPaths,
    ...extractAttachmentPaths(
      (message as { attachments?: unknown }).attachments,
    ),
    ...extractAttachmentPaths(
      (message.message as { attachments?: unknown } | undefined)?.attachments,
    ),
  ]);
  const normalizedText = normalizeVisibleText(split.text);
  if (attachmentPaths.size === 0) {
    visibleUserTurnFingerprintCache.set(message, null);
    return null;
  }

  const fingerprint = `visible-user|${normalizedText}|attachments:${Array.from(
    attachmentPaths,
  )
    .sort()
    .join("|")}`;
  visibleUserTurnFingerprintCache.set(message, fingerprint);
  return fingerprint;
}

export function getMessageTimestampMs(message: Message): number | null {
  if (typeof message.timestamp !== "string") {
    return null;
  }
  const ms = Date.parse(message.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

// --- Claude queue-operation echo pairing -----------------------------------
//
// A Claude busy-send (steer or queued delivery) is persisted by the CLI as a
// queue-operation enqueue row — no uuid, no tempId — which the server reader
// normalizes into a user message with a positional `queue-operation-…` id and
// `deferredSource: "queue-operation"`. YA's optimistic live echo carries the
// YA queue uuid, so by-id dedup can never match the pair and the general
// approx backstop is off for Claude. This pairing is the scoped remedy: only
// queue-operation rows participate, only against sdk-source plain user turns,
// matched one-to-one by identical visible text and nearest timestamp. Both
// sides are stamped at enqueue time on the same machine (typically <1s
// apart); the wide window absorbs CLI stdin lag and stays safe because of the
// structural scoping. See topics/stream-durable-id-dedup.md.

const QUEUE_OPERATION_ECHO_WINDOW_MS = 60_000;

function isClaudeQueueOperationRow(message: Message): boolean {
  return (
    (message._source ?? "sdk") === "jsonl" &&
    (message as { deferredSource?: unknown }).deferredSource ===
      "queue-operation" &&
    isPlainUserTurn(message)
  );
}

function isOptimisticUserEcho(message: Message): boolean {
  return (message._source ?? "sdk") === "sdk" && isPlainUserTurn(message);
}

function isUnconfirmedSteerEcho(message: Message): boolean {
  if (!isUnconfirmedSelfSend(message)) {
    return false;
  }
  const metadata = (message as { messageMetadata?: unknown }).messageMetadata;
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    (metadata as { deliveryIntent?: unknown }).deliveryIntent === "steer"
  );
}

function getComparableUserText(message: Message): string | null {
  const text = getTextContent(message);
  return text === null ? null : normalizeVisibleText(text);
}

export function reconcileClaudeQueueOperationEchoes(
  messages: Message[],
): Message[] {
  return reconcileDeliveredUserTurns(
    reconcileQueueOperationRows(messages),
    isUnconfirmedSelfSend,
    QUEUE_OPERATION_ECHO_WINDOW_MS,
  );
}

function reconcileQueueOperationRows(messages: Message[]): Message[] {
  const startIndex = Math.max(0, messages.length - MAX_SCAN_MESSAGES);

  interface Candidate {
    index: number;
    timestampMs: number;
    text: string;
  }

  let rows: Candidate[] | null = null;
  let echoes: Candidate[] | null = null;
  for (let i = startIndex; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    const isRow = isClaudeQueueOperationRow(message);
    if (!isRow && !isOptimisticUserEcho(message)) continue;
    const timestampMs = getMessageTimestampMs(message);
    const text = getComparableUserText(message);
    if (timestampMs === null || !text) continue;
    const candidate: Candidate = { index: i, timestampMs, text };
    if (isRow) {
      rows ??= [];
      rows.push(candidate);
    } else {
      echoes ??= [];
      echoes.push(candidate);
    }
  }
  if (!rows || !echoes) {
    return messages;
  }

  // Pair each queue-operation row with the nearest-in-time unmatched echo of
  // identical text. Nearest wins so an older direct-send echo with the same
  // text cannot steal a steer's row.
  const pairs: Array<{ echoIndex: number; rowIndex: number }> = [];
  const takenEchoes = new Set<number>();
  for (const row of rows) {
    let best: Candidate | null = null;
    for (const echo of echoes) {
      if (takenEchoes.has(echo.index)) continue;
      if (echo.text !== row.text) continue;
      const deltaMs = Math.abs(echo.timestampMs - row.timestampMs);
      if (deltaMs > QUEUE_OPERATION_ECHO_WINDOW_MS) continue;
      if (!best || deltaMs < Math.abs(best.timestampMs - row.timestampMs)) {
        best = echo;
      }
    }
    if (best) {
      takenEchoes.add(best.index);
      pairs.push({ echoIndex: best.index, rowIndex: row.index });
    }
  }
  if (pairs.length === 0) {
    return messages;
  }

  // The earlier array position absorbs the pair so the transcript does not
  // jump. The durable row is authoritative for shared fields and — decisive
  // for future by-id merges — for identity: the result must key on the row's
  // `queue-operation-…` id, or the next durable fetch re-appends the row and
  // the duplicate returns. Echo-only fields (tempId, metadata) are preserved.
  const mergedByIndex = new Map<number, Message>();
  const droppedIndices = new Set<number>();
  for (const { echoIndex, rowIndex } of pairs) {
    const echo = messages[echoIndex];
    const row = messages[rowIndex];
    if (!echo || !row) continue;
    const { uuid: _echoUuid, ...merged } = mergeMessage(echo, row, "jsonl");
    const rowUuid = (row as { uuid?: unknown }).uuid;
    mergedByIndex.set(
      Math.min(echoIndex, rowIndex),
      typeof rowUuid === "string" ? { ...merged, uuid: rowUuid } : merged,
    );
    droppedIndices.add(Math.max(echoIndex, rowIndex));
  }
  if (droppedIndices.size === 0) {
    return messages;
  }

  const result: Message[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (droppedIndices.has(i)) continue;
    const message = mergedByIndex.get(i) ?? messages[i];
    if (message) result.push(message);
  }
  return result;
}

// Claude has a second busy-send delivery shape the pairing above cannot see:
// on interrupt (and some end-of-turn deliveries) it *dequeues* every pending
// queued message — content-less queue-operation dequeue rows the reader never
// surfaces — and writes one real user row (its own uuid, parented on the
// interrupt marker) whose text is the dequeued texts joined by "\n". With no
// queue-operation row to pair against and YA's uuid dropped, the optimistic
// echoes strand as perpetual "sent ✓" copies at their send positions above
// the interrupt while the durable turn renders again below it. Pair each such
// durable row with the in-order echo run whose concatenation reproduces its
// text exactly; the durable position wins, so the turn reads at its delivery
// point (immediately after the interrupt marker) just like remove-path
// deliveries. The exact-concatenation requirement plus the self-send marker
// (tempId/messageMetadata — provider stream copies carry neither) is what
// keeps this safe without a tight timestamp window: enqueue-to-delivery can
// span a long-running tool, so the only time constraint is that no consumed
// echo postdates the delivery by more than clock skew.
//
// Codex has the same identity shape for long-running steers: the optimistic
// echo carries YA's uuid, while the durable user row carries a positional id.
// The general 2s backstop cannot pair them when Codex consumes the steer after
// a long tool. Codex calls the same exact-text reconciler, but only for
// self-sent echoes explicitly marked as steers.

function isDurableDeliveredUserRow(message: Message): boolean {
  return (
    (!message.inputMessageIds || getMessageIds(message).length <= 1) &&
    (message._source ?? "sdk") === "jsonl" &&
    (message as { deferredSource?: unknown }).deferredSource === undefined &&
    isPlainUserTurn(message)
  );
}

interface DequeueCandidate {
  index: number;
  timestampMs: number;
  text: string;
}

/**
 * Find the in-order run of unconsumed echoes whose texts, joined by
 * whitespace, exactly reproduce `rowText`. Backtracks so a shorter echo
 * cannot shadow a longer one that also prefixes the remainder.
 */
function matchEchoRun(
  rowText: string,
  rowTimestampMs: number,
  echoes: DequeueCandidate[],
  consumed: Set<number>,
  futureSkewMs: number,
): DequeueCandidate[] | null {
  const usable = echoes.filter(
    (echo) =>
      !consumed.has(echo.index) &&
      echo.timestampMs <= rowTimestampMs + futureSkewMs,
  );

  const consume = (
    remainder: string,
    startIndex: number,
  ): DequeueCandidate[] | null => {
    if (remainder.length === 0) return [];
    for (let i = startIndex; i < usable.length; i += 1) {
      const echo = usable[i];
      if (!echo || !remainder.startsWith(echo.text)) continue;
      let rest = remainder.slice(echo.text.length);
      if (rest.length > 0) {
        const stripped = rest.replace(/^\s+/, "");
        // No separator at the boundary means this echo only matched a text
        // prefix, not a whole dequeued segment.
        if (stripped.length === rest.length) continue;
        rest = stripped;
      }
      const tail = consume(rest, i + 1);
      if (tail) return [echo, ...tail];
    }
    return null;
  };

  const run = consume(rowText, 0);
  return run && run.length > 0 ? run : null;
}

function reconcileDeliveredUserTurns(
  messages: Message[],
  isEligibleEcho: (message: Message) => boolean,
  futureSkewMs: number,
): Message[] {
  const startIndex = Math.max(0, messages.length - MAX_SCAN_MESSAGES);

  let rows: DequeueCandidate[] | null = null;
  let echoes: DequeueCandidate[] | null = null;
  for (let i = startIndex; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    const isRow = isDurableDeliveredUserRow(message);
    const isEcho =
      !isRow && isOptimisticUserEcho(message) && isEligibleEcho(message);
    if (!isRow && !isEcho) continue;
    const timestampMs = getMessageTimestampMs(message);
    const text = getComparableUserText(message);
    if (timestampMs === null || !text) continue;
    const candidate: DequeueCandidate = { index: i, timestampMs, text };
    if (isRow) {
      rows ??= [];
      rows.push(candidate);
    } else {
      echoes ??= [];
      echoes.push(candidate);
    }
  }
  if (!rows || !echoes) {
    return messages;
  }

  const mergedByIndex = new Map<number, Message>();
  const droppedIndices = new Set<number>();
  for (const row of rows) {
    const run = matchEchoRun(
      row.text,
      row.timestampMs,
      echoes,
      droppedIndices,
      futureSkewMs,
    );
    if (!run) continue;
    const rowMessage = messages[row.index];
    const firstEcho = run[0] && messages[run[0].index];
    if (!rowMessage || !firstEcho) continue;

    // Mirror the queue-operation pairing: durable row is authoritative for
    // identity and shared fields; echo-only fields (tempId, metadata)
    // survive. All consumed echoes' tempIds ride along so chip clearing and
    // per-chunk affordances see the whole batch.
    const { uuid: _echoUuid, ...merged } = mergeMessage(
      firstEcho,
      rowMessage,
      "jsonl",
    );
    const rowUuid = (rowMessage as { uuid?: unknown }).uuid;
    const tempIds = run
      .map((echo) => (messages[echo.index] as { tempId?: unknown }).tempId)
      .filter((tempId): tempId is string => typeof tempId === "string");
    mergedByIndex.set(row.index, {
      ...merged,
      ...(typeof rowUuid === "string" ? { uuid: rowUuid } : {}),
      ...(tempIds.length > 0 ? { tempIds } : {}),
    });
    for (const echo of run) {
      droppedIndices.add(echo.index);
    }
  }
  if (droppedIndices.size === 0) {
    return messages;
  }

  const result: Message[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (droppedIndices.has(i)) continue;
    const message = mergedByIndex.get(i) ?? messages[i];
    if (message) result.push(message);
  }
  return result;
}

export function reconcileCodexSteerEchoes(messages: Message[]): Message[] {
  return reconcileDeliveredUserTurns(
    messages,
    isUnconfirmedSteerEcho,
    REPLAY_TIMESTAMP_WINDOW_MS,
  );
}

// Grok records each user turn under an id of its own with no hook for YA to
// supply or predict one, so neither a direct send nor an interject can dedup
// by id — every mid-turn backfill re-rendered the prompt and left the echo
// permanently "sent". The echo is always stamped before Grok writes its row,
// and Grok's record timestamp has whole-second granularity, so an echo can
// postdate its row only by that truncation.
const SELF_SEND_ECHO_FUTURE_SKEW_MS = 2000;

export function reconcileSelfSendUserEchoes(messages: Message[]): Message[] {
  return reconcileDeliveredUserTurns(
    messages,
    isUnconfirmedSelfSend,
    SELF_SEND_ECHO_FUTURE_SKEW_MS,
  );
}

export function hasEquivalentJsonlMessage(
  existing: Message[],
  incoming: Message,
  options?: ApproxDedupOptions,
): boolean {
  if (options?.excludeTools && isToolMessage(incoming)) {
    return false;
  }
  const incomingFingerprint = getSemanticFingerprint(incoming);
  const incomingTimestampMs = getMessageTimestampMs(incoming);
  if (!incomingFingerprint || incomingTimestampMs === null) {
    return false;
  }

  const windowMs = options?.windowMs ?? DEFAULT_TIMESTAMP_WINDOW_MS;
  const replayWindowMs = options?.replayWindowMs ?? REPLAY_TIMESTAMP_WINDOW_MS;
  const firstUserTurnWindowMs =
    options?.firstUserTurnWindowMs ?? FIRST_USER_TURN_TIMESTAMP_WINDOW_MS;
  const maxScan = MAX_SCAN_MESSAGES;
  const startIndex = Math.max(0, existing.length - maxScan);

  for (let i = existing.length - 1; i >= startIndex; i -= 1) {
    const candidate = existing[i];
    if (candidate?._source !== "jsonl") {
      continue;
    }
    const candidateTimestampMs = getMessageTimestampMs(candidate);
    if (candidateTimestampMs === null) {
      continue;
    }
    const isFirstUserTurnPair =
      isPlainUserTurn(candidate) &&
      isPlainUserTurn(incoming) &&
      !hasEarlierPlainUserTurn(existing, i);
    const semanticMatches =
      getSemanticFingerprint(candidate) === incomingFingerprint;
    const candidateVisibleFingerprint =
      getVisibleUserTurnFingerprint(candidate);
    const visibleUserTurnMatches =
      isFirstUserTurnPair &&
      candidateVisibleFingerprint !== null &&
      candidateVisibleFingerprint === getVisibleUserTurnFingerprint(incoming);
    if (!semanticMatches && !visibleUserTurnMatches) {
      continue;
    }
    const allowedDeltaMs = getAllowedTimestampDeltaMs(
      candidate,
      incoming,
      { windowMs, replayWindowMs, firstUserTurnWindowMs },
      isFirstUserTurnPair,
    );
    if (
      Math.abs(candidateTimestampMs - incomingTimestampMs) <= allowedDeltaMs
    ) {
      return true;
    }
  }

  return false;
}

interface IndexedMessage {
  message: Message;
  originalIndex: number;
  timestampMs: number | null;
  fingerprint: string | null;
  visibleUserTurnFingerprint: string | null;
}

export function reconcileLinearMessages(
  messages: Message[],
  options?: ApproxDedupOptions,
): Message[] {
  const windowMs = options?.windowMs ?? DEFAULT_TIMESTAMP_WINDOW_MS;
  const replayWindowMs = options?.replayWindowMs ?? REPLAY_TIMESTAMP_WINDOW_MS;
  const firstUserTurnWindowMs =
    options?.firstUserTurnWindowMs ?? FIRST_USER_TURN_TIMESTAMP_WINDOW_MS;
  const maxCandidateWindowMs = Math.max(
    windowMs,
    replayWindowMs,
    firstUserTurnWindowMs,
  );
  const excludeTools = options?.excludeTools === true;

  const sorted = messages
    .map(
      (message, originalIndex): IndexedMessage => ({
        message,
        originalIndex,
        timestampMs: getMessageTimestampMs(message),
        fingerprint: getSemanticFingerprint(message),
        visibleUserTurnFingerprint: getVisibleUserTurnFingerprint(message),
      }),
    )
    .sort((a, b) => {
      if (a.timestampMs === null && b.timestampMs === null) {
        return a.originalIndex - b.originalIndex;
      }
      if (a.timestampMs === null) return 1;
      if (b.timestampMs === null) return -1;
      if (a.timestampMs !== b.timestampMs) {
        return a.timestampMs - b.timestampMs;
      }
      return a.originalIndex - b.originalIndex;
    });

  const kept: IndexedMessage[] = [];

  for (const entry of sorted) {
    let merged = false;

    if (
      entry.fingerprint &&
      entry.timestampMs !== null &&
      !(excludeTools && isToolMessage(entry.message))
    ) {
      for (let i = kept.length - 1; i >= 0; i -= 1) {
        const candidate = kept[i];
        if (!candidate) {
          continue;
        }
        if (candidate.timestampMs === null) {
          continue;
        }
        if (entry.timestampMs - candidate.timestampMs > maxCandidateWindowMs) {
          break;
        }
        const isFirstUserTurnPair =
          isPlainUserTurn(candidate.message) &&
          isPlainUserTurn(entry.message) &&
          !hasEarlierPlainUserEntry(kept, i);
        const semanticMatches = candidate.fingerprint === entry.fingerprint;
        const visibleUserTurnMatches =
          isFirstUserTurnPair &&
          candidate.visibleUserTurnFingerprint !== null &&
          candidate.visibleUserTurnFingerprint ===
            entry.visibleUserTurnFingerprint;
        if (!semanticMatches && !visibleUserTurnMatches) continue;
        const candidateSource = candidate.message._source;
        const entrySource = entry.message._source;
        const sameSource = candidateSource === entrySource;
        const canMergeDifferentSources =
          candidateSource !== undefined &&
          entrySource !== undefined &&
          !sameSource;
        const canMergeStartupLiveSources =
          visibleUserTurnMatches && sameSource && candidateSource === "sdk";
        const canMergeSameSource =
          sameSource &&
          candidateSource !== undefined &&
          (candidate.timestampMs === entry.timestampMs ||
            canMergeStartupLiveSources);
        if (!canMergeDifferentSources && !canMergeSameSource) {
          continue;
        }
        const mergeSource = entrySource ?? candidateSource;
        if (!mergeSource) {
          continue;
        }
        const allowedDeltaMs = getAllowedTimestampDeltaMs(
          candidate.message,
          entry.message,
          { windowMs, replayWindowMs, firstUserTurnWindowMs },
          isFirstUserTurnPair,
        );
        if (entry.timestampMs - candidate.timestampMs > allowedDeltaMs) {
          continue;
        }

        candidate.message = mergeMessage(
          candidate.message,
          entry.message,
          mergeSource,
        );
        candidate.timestampMs =
          getMessageTimestampMs(candidate.message) ?? candidate.timestampMs;
        candidate.fingerprint = getSemanticFingerprint(candidate.message);
        candidate.visibleUserTurnFingerprint = getVisibleUserTurnFingerprint(
          candidate.message,
        );
        merged = true;
        break;
      }
    }

    if (!merged) {
      kept.push(entry);
    }
  }

  return kept.map((entry) => entry.message);
}
