/**
 * Pure utility functions for speech recognition processing.
 * Extracted for testability - the main hook uses these internally.
 */

export interface SpeechResult {
  isFinal: boolean;
  transcript: string;
}

export interface ProcessedSpeechResults {
  /** The latest (highest index) final transcript */
  latestFinal: string;
  /** Combined interim text from all non-final results */
  interimText: string;
}

/**
 * Process an array of speech recognition results.
 * On mobile, each result is a complete cumulative transcript.
 * On desktop, results are separate utterances.
 * We take the LAST final result since on mobile that's the most complete.
 */
export function processSpeechResults(
  results: SpeechResult[],
): ProcessedSpeechResults {
  let latestFinal = "";
  let interimText = "";

  for (const result of results) {
    if (result.isFinal) {
      latestFinal = result.transcript;
    } else {
      interimText += result.transcript;
    }
  }

  return { latestFinal, interimText };
}

/**
 * Compute the delta (new text) between the latest final transcript
 * and the previous one.
 *
 * On mobile Chrome, each "final" result is cumulative (e.g., "hello" -> "hello world").
 * We extract just the new part (" world") to avoid duplicating text.
 *
 * On desktop, separate utterances are independent, so we return the whole thing.
 */
export function computeSpeechDelta(
  latestFinal: string,
  previousFinal: string,
): string {
  if (!latestFinal || latestFinal === previousFinal) {
    return "";
  }

  // If latest starts with previous, extract just the new part (mobile behavior)
  if (latestFinal.startsWith(previousFinal)) {
    return latestFinal.slice(previousFinal.length);
  }

  // New utterance - return the whole thing (desktop behavior after pause)
  return latestFinal;
}

const NO_SPACE_BEFORE_TRANSCRIPT = /^[,.;:!?%)]/;
const INITIAL_TITLE_CASE_WORD = /^(\s*[(["'`]*)([A-Z])(?=[a-z])/;
const INITIAL_TITLE_CASE_TOKEN = /^(\s*[(["'`]*)([A-Z][a-z]+)(?=$|[^A-Za-z])/;
const LOWERCASE_CONTEXT_WORD = /^[^A-Za-z]*[a-z]/;
const SENTENCE_INITIAL_CONTEXT = /(?:^|[.!?][)"'\]]*)$/;
const COMMON_CONTINUATION_WORDS = new Set([
  "after",
  "although",
  "and",
  "anyway",
  "are",
  "as",
  "at",
  "basically",
  "because",
  "before",
  "but",
  "can",
  "could",
  "did",
  "do",
  "does",
  "even",
  "finally",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "however",
  "how",
  "if",
  "in",
  "is",
  "it",
  "its",
  "just",
  "like",
  "meanwhile",
  "maybe",
  "my",
  "not",
  "now",
  "of",
  "okay",
  "on",
  "or",
  "our",
  "really",
  "she",
  "so",
  "still",
  "that",
  "the",
  "their",
  "then",
  "there",
  "they",
  "this",
  "those",
  "though",
  "to",
  "ultimately",
  "was",
  "we",
  "well",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "with",
  "would",
  "yeah",
  "you",
  "your",
]);
export const SPEECH_SELECTION_FINAL_GRACE_MS = 300;

export function getSpeechTranscriptSeparator(
  base: string,
  transcript: string,
): "" | " " {
  if (!base.trimEnd() || !transcript.trim()) return "";
  return NO_SPACE_BEFORE_TRANSCRIPT.test(transcript.trim()) ? "" : " ";
}

export interface SpeechTranscriptInsertion {
  text: string;
  cursor: number;
}

export interface SpeechTranscriptReplacement extends SpeechTranscriptInsertion {
  replacementStart: number;
  replacementEnd: number;
  insertedLength: number;
}

export interface SpeechOwnedChunk {
  start: number;
  end: number;
}

export interface SpeechInsertionRange {
  start: number;
  end: number;
  replaceEnd?: number;
  replaceSelectedAtMs?: number;
  chunks: SpeechOwnedChunk[];
}

/**
 * Composed text preceding the speech insertion cursor, snapshotted for one
 * capture. A recording already holding an insertion range keeps its own
 * transaction point; otherwise the native caret decides, and a composer with
 * no focused textarea takes the whole draft.
 */
export function textBeforeSpeechCursor(
  draft: string,
  insertionRange: SpeechInsertionRange | null,
  textarea: HTMLTextAreaElement | null,
): string {
  return draft.slice(
    0,
    insertionRange?.end ?? textarea?.selectionStart ?? draft.length,
  );
}

export interface SpeechTranscriptInsertionParts {
  before: string;
  separatorBefore: "" | " ";
  transcript: string;
  separatorAfter: "" | " ";
  after: string;
  text: string;
  cursor: number;
}

export function getSpeechTranscriptInsertionParts(
  base: string,
  transcript: string,
  index: number,
): SpeechTranscriptInsertionParts {
  const trimmedTranscript = transcript.trim();
  const clampedIndex = Math.max(0, Math.min(index, base.length));
  const before = base.slice(0, clampedIndex).trimEnd();
  const after = base.slice(clampedIndex).trimStart();
  if (!trimmedTranscript) {
    return {
      before,
      separatorBefore: "",
      transcript: "",
      separatorAfter: "",
      after,
      text: base,
      cursor: clampedIndex,
    };
  }

  const separatorBefore = getSpeechTranscriptSeparator(
    before,
    trimmedTranscript,
  );
  const separatorAfter = getSpeechTranscriptSeparator(trimmedTranscript, after);
  const insertedText = `${separatorBefore}${trimmedTranscript}`;

  return {
    before,
    separatorBefore,
    transcript: trimmedTranscript,
    separatorAfter,
    after,
    text: `${before}${insertedText}${separatorAfter}${after}`,
    cursor: before.length + insertedText.length,
  };
}

function lowercaseInitialTitleCaseWord(transcript: string): string {
  return transcript.replace(
    INITIAL_TITLE_CASE_WORD,
    (_match, prefix: string, letter: string) =>
      `${prefix}${letter.toLowerCase()}`,
  );
}

function isSentenceInitialReplacementContext(
  base: string,
  replacementStart: number,
): boolean {
  const context = base.slice(0, replacementStart);
  return (
    /\n\s*$/.test(context) || SENTENCE_INITIAL_CONTEXT.test(context.trimEnd())
  );
}

/**
 * Smooth a recognizer-created chunk boundary without broadly guessing at
 * proper nouns. Speech services often title-case each phrase after a pause;
 * this only lowercases a conservative set of ordinary continuation words when
 * the insertion context is still mid-sentence. Acronyms, single letters, and
 * unlisted title-case words (Android, Google, Jay) remain provider-verbatim.
 */
export function smoothPausedSpeechCapitalization(
  base: string,
  transcript: string,
  insertionIndex: number,
): string {
  const trimmedTranscript = transcript.trim();
  if (
    !trimmedTranscript ||
    isSentenceInitialReplacementContext(base, insertionIndex)
  ) {
    return trimmedTranscript;
  }
  const token = INITIAL_TITLE_CASE_TOKEN.exec(trimmedTranscript)?.[2];
  if (!token || !COMMON_CONTINUATION_WORDS.has(token.toLowerCase())) {
    return trimmedTranscript;
  }
  return lowercaseInitialTitleCaseWord(trimmedTranscript);
}

/**
 * Apply the same pause-boundary treatment to provisional text that a normal
 * finalized chunk at this speech range will receive. This keeps the mirror
 * from visibly changing capitalization when the chunk commits.
 */
export function getSpeechInterimDisplayTranscript(
  base: string,
  transcript: string,
  range: SpeechInsertionRange | null,
): string {
  const trimmedTranscript = transcript.trim();
  const replacingExplicitRange =
    range !== null && (range.replaceEnd ?? range.end) > range.end;
  if (
    !range ||
    range.chunks.length === 0 ||
    replacingExplicitRange ||
    !trimmedTranscript
  ) {
    return trimmedTranscript;
  }
  return smoothPausedSpeechCapitalization(base, trimmedTranscript, range.end);
}

/**
 * Snapshot the exact text projected by the composer mirror. Provisional speech
 * remains absent from the editable textarea, but an explicit delivery action
 * can use this value without waiting for a later recognizer revision.
 */
export function getSpeechVisibleDraftText(
  base: string,
  interimTranscript: string,
  range: SpeechInsertionRange | null,
): string {
  const displayTranscript = getSpeechInterimDisplayTranscript(
    base,
    interimTranscript,
    range,
  );
  if (!displayTranscript) return base;
  return range
    ? getSpeechTranscriptReplacementParts(
        base,
        displayTranscript,
        range.end,
        range.replaceEnd ?? range.end,
      ).text
    : getSpeechTranscriptInsertionParts(base, displayTranscript, base.length)
        .text;
}

function normalizeSpeechTranscriptForReplacementContext(
  base: string,
  transcript: string,
  replacementStart: number,
  replacementEnd: number,
): string {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript || replacementEnd <= replacementStart) {
    return trimmedTranscript;
  }
  const selectedText = base.slice(replacementStart, replacementEnd);
  if (!LOWERCASE_CONTEXT_WORD.test(selectedText)) return trimmedTranscript;
  if (isSentenceInitialReplacementContext(base, replacementStart)) {
    return trimmedTranscript;
  }
  return lowercaseInitialTitleCaseWord(trimmedTranscript);
}

export function getSpeechTranscriptReplacementParts(
  base: string,
  transcript: string,
  replacementStart: number,
  replacementEnd: number,
): SpeechTranscriptInsertionParts {
  const clampedReplacementStart = Math.max(
    0,
    Math.min(replacementStart, base.length),
  );
  const clampedReplacementEnd = Math.max(
    clampedReplacementStart,
    Math.min(replacementEnd, base.length),
  );
  const normalizedTranscript = normalizeSpeechTranscriptForReplacementContext(
    base,
    transcript,
    clampedReplacementStart,
    clampedReplacementEnd,
  );
  const baseWithoutReplacement = `${base.slice(0, clampedReplacementStart)}${base.slice(clampedReplacementEnd)}`;
  return getSpeechTranscriptInsertionParts(
    baseWithoutReplacement,
    normalizedTranscript,
    clampedReplacementStart,
  );
}

export function insertSpeechTranscriptAt(
  base: string,
  transcript: string,
  index: number,
): SpeechTranscriptInsertion {
  const insertion = getSpeechTranscriptInsertionParts(base, transcript, index);
  return {
    text: insertion.text,
    cursor: insertion.cursor,
  };
}

export function replaceSpeechTranscriptBefore(
  base: string,
  transcript: string,
  index: number,
  previousChars: number,
): SpeechTranscriptReplacement {
  const replacementEnd = Math.max(0, Math.min(index, base.length));
  const replacementStart = Math.max(
    0,
    replacementEnd - Math.max(0, previousChars),
  );
  const baseWithoutReplacement = `${base.slice(0, replacementStart)}${base.slice(replacementEnd)}`;
  const insertion = getSpeechTranscriptInsertionParts(
    baseWithoutReplacement,
    transcript,
    replacementStart,
  );
  return {
    ...insertion,
    replacementStart,
    replacementEnd,
    insertedLength:
      insertion.text.length -
      (base.length - (replacementEnd - replacementStart)),
  };
}

export interface SpeechRangeReplacement extends SpeechTranscriptReplacement {
  range: SpeechInsertionRange;
}

export function createSpeechInsertionRange(
  selectionStart: number,
  selectionEnd: number,
): SpeechInsertionRange {
  return {
    start: selectionStart,
    end: selectionStart,
    replaceEnd: selectionEnd > selectionStart ? selectionEnd : undefined,
    chunks: [],
  };
}

export function retargetSpeechInsertionRange(
  range: SpeechInsertionRange,
  selectionStart: number,
  selectionEnd: number,
  selectedAtMs = Date.now(),
): SpeechInsertionRange {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd));
  const end = Math.max(start, Math.max(selectionStart, selectionEnd));
  if (
    range.end === start &&
    range.replaceEnd === (end > start ? end : undefined) &&
    (end <= start || range.replaceSelectedAtMs !== undefined)
  ) {
    return range;
  }
  return {
    ...range,
    end: start,
    replaceEnd: end > start ? end : undefined,
    replaceSelectedAtMs: end > start ? selectedAtMs : undefined,
  };
}

export function clearSpeechInsertionRangeReplacement(
  range: SpeechInsertionRange,
): SpeechInsertionRange {
  if (range.replaceEnd === undefined && range.replaceSelectedAtMs === undefined)
    return range;
  return {
    ...range,
    replaceEnd: undefined,
    replaceSelectedAtMs: undefined,
  };
}

export function getSpeechSelectionFinalDelayMs(
  range: SpeechInsertionRange | null,
  nowMs = Date.now(),
): number {
  if (
    !range ||
    range.replaceEnd === undefined ||
    range.replaceEnd <= range.end ||
    range.replaceSelectedAtMs === undefined
  ) {
    return 0;
  }

  const elapsedMs = nowMs - range.replaceSelectedAtMs;
  if (elapsedMs < 0) return SPEECH_SELECTION_FINAL_GRACE_MS;
  return Math.max(0, SPEECH_SELECTION_FINAL_GRACE_MS - elapsedMs);
}

export function mapSpeechInsertionRangeThroughEdit(
  previousText: string,
  nextText: string,
  range: SpeechInsertionRange,
): SpeechInsertionRange {
  return {
    start: mapTextIndexThroughEdit(previousText, nextText, range.start),
    end: mapTextIndexThroughEdit(previousText, nextText, range.end),
    replaceEnd:
      range.replaceEnd === undefined
        ? undefined
        : mapTextIndexThroughEdit(previousText, nextText, range.replaceEnd),
    replaceSelectedAtMs: range.replaceSelectedAtMs,
    chunks: range.chunks.map((chunk) => ({
      start: mapTextIndexThroughEdit(previousText, nextText, chunk.start),
      end: mapTextIndexThroughEdit(previousText, nextText, chunk.end),
    })),
  };
}

function mapTextIndexThroughReplacement(
  index: number,
  replacementStart: number,
  replacementEnd: number,
  insertedLength: number,
): number {
  const start = Math.max(0, replacementStart);
  const end = Math.max(start, replacementEnd);
  const delta = insertedLength - (end - start);
  if (index < start) return index;
  if (start === end) return index + insertedLength;
  if (index > end) return index + delta;
  return start + insertedLength;
}

function speechReplacementIntersectsRangeReplacement(
  range: SpeechInsertionRange,
  replacementStart: number,
  replacementEnd: number,
): boolean {
  if (range.replaceEnd === undefined || range.replaceEnd <= range.end) {
    return false;
  }
  return replacementStart < range.replaceEnd && replacementEnd > range.end;
}

export function mapSpeechInsertionRangeThroughReplacement(
  range: SpeechInsertionRange,
  replacementStart: number,
  replacementEnd: number,
  insertedLength: number,
): SpeechInsertionRange {
  const mapIndex = (index: number): number =>
    mapTextIndexThroughReplacement(
      index,
      replacementStart,
      replacementEnd,
      insertedLength,
    );
  const mapped = {
    start: mapIndex(range.start),
    end: mapIndex(range.end),
    replaceEnd:
      range.replaceEnd === undefined ? undefined : mapIndex(range.replaceEnd),
    replaceSelectedAtMs: range.replaceSelectedAtMs,
    chunks: range.chunks.map((chunk) => ({
      start: mapIndex(chunk.start),
      end: mapIndex(chunk.end),
    })),
  };
  return speechReplacementIntersectsRangeReplacement(
    range,
    replacementStart,
    replacementEnd,
  )
    ? clearSpeechInsertionRangeReplacement(mapped)
    : mapped;
}

function mapChunkAfterReplacement(
  chunk: SpeechOwnedChunk,
  replacementStart: number,
  replacementEnd: number,
  delta: number,
): SpeechOwnedChunk | null {
  if (chunk.end <= replacementStart) return chunk;
  if (chunk.start >= replacementEnd) {
    return { start: chunk.start + delta, end: chunk.end + delta };
  }
  return null;
}

export function replaceSpeechTranscriptInRange(
  base: string,
  transcript: string,
  range: SpeechInsertionRange,
  previousChars: number,
): SpeechRangeReplacement {
  const replacingExplicitRange =
    range.replaceEnd !== undefined && range.replaceEnd > range.end;
  const latestSpeechEnd = range.chunks.at(-1)?.end;
  const replacementEnd = replacingExplicitRange
    ? (range.replaceEnd ?? range.end)
    : previousChars > 0 && latestSpeechEnd !== undefined
      ? latestSpeechEnd
      : range.end;
  const replacementStart = Math.max(
    0,
    replacingExplicitRange
      ? Math.min(range.end, base.length)
      : Math.min(replacementEnd, base.length) - Math.max(0, previousChars),
  );
  const clampedReplacementEnd = Math.max(
    replacementStart,
    Math.min(replacementEnd, base.length),
  );
  const normalizedTranscript =
    range.chunks.length > 0 && previousChars === 0 && !replacingExplicitRange
      ? smoothPausedSpeechCapitalization(base, transcript, replacementStart)
      : transcript;
  const insertion = replacingExplicitRange
    ? getSpeechTranscriptReplacementParts(
        base,
        normalizedTranscript,
        replacementStart,
        clampedReplacementEnd,
      )
    : getSpeechTranscriptInsertionParts(
        `${base.slice(0, replacementStart)}${base.slice(clampedReplacementEnd)}`,
        normalizedTranscript,
        replacementStart,
      );
  const insertionStart = insertion.before.length;
  const insertedLength = insertion.cursor - replacementStart;
  const delta = insertion.text.length - base.length;
  const nextChunks = range.chunks
    .map((chunk) =>
      mapChunkAfterReplacement(
        chunk,
        replacementStart,
        clampedReplacementEnd,
        delta,
      ),
    )
    .filter((chunk): chunk is SpeechOwnedChunk => chunk !== null);
  if (insertedLength > 0) {
    nextChunks.push({
      start: insertionStart,
      end: insertion.cursor,
    });
  }

  return {
    ...insertion,
    replacementStart,
    replacementEnd: clampedReplacementEnd,
    insertedLength,
    range: {
      start: range.start,
      end: mapTextIndexThroughReplacement(
        range.end,
        replacementStart,
        clampedReplacementEnd,
        insertedLength,
      ),
      chunks: nextChunks,
    },
  };
}

export function removeLatestSpeechChunkFromRange(
  base: string,
  range: SpeechInsertionRange,
): SpeechRangeReplacement | null {
  const latest = range.chunks.at(-1);
  if (!latest) return null;

  const replacement = removeTextRange(base, latest.start, latest.end);
  const nextChunks = range.chunks
    .slice(0, -1)
    .map((chunk) =>
      mapChunkAfterReplacement(
        chunk,
        latest.start,
        latest.end,
        latest.start - latest.end,
      ),
    )
    .filter((chunk): chunk is SpeechOwnedChunk => chunk !== null);
  return {
    text: replacement.text,
    cursor: replacement.cursor,
    replacementStart: latest.start,
    replacementEnd: latest.end,
    insertedLength: 0,
    range: {
      start: range.start,
      end: latest.start,
      replaceEnd: range.replaceEnd,
      replaceSelectedAtMs: range.replaceSelectedAtMs,
      chunks: nextChunks,
    },
  };
}

export function appendSpeechTranscript(
  base: string,
  transcript: string,
): string {
  return insertSpeechTranscriptAt(base, transcript, base.length).text;
}

export function mapTextIndexThroughEdit(
  previousText: string,
  nextText: string,
  index: number,
): number {
  const clampedIndex = Math.max(0, Math.min(index, previousText.length));
  let prefixLength = 0;
  const commonLimit = Math.min(previousText.length, nextText.length);
  while (
    prefixLength < commonLimit &&
    previousText[prefixLength] === nextText[prefixLength]
  ) {
    prefixLength += 1;
  }

  if (clampedIndex <= prefixLength) return clampedIndex;

  let suffixLength = 0;
  while (
    suffixLength < previousText.length - prefixLength &&
    suffixLength < nextText.length - prefixLength &&
    previousText[previousText.length - 1 - suffixLength] ===
      nextText[nextText.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const previousEditEnd = previousText.length - suffixLength;
  const nextEditEnd = nextText.length - suffixLength;
  if (clampedIndex >= previousEditEnd) {
    return clampedIndex + (nextText.length - previousText.length);
  }
  return nextEditEnd;
}

export function removeTextRange(
  text: string,
  start: number,
  end: number,
): SpeechTranscriptInsertion {
  const clampedStart = Math.max(0, Math.min(start, text.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, text.length));
  return {
    text: `${text.slice(0, clampedStart)}${text.slice(clampedEnd)}`,
    cursor: clampedStart,
  };
}

/**
 * The interim mirror a composer draws over its draft: the interim text as the
 * final chunk at `range` would show it, and where it splits the draft. With no
 * range the interim goes at the end of the draft.
 */
export function getSpeechInterimPreview(
  draft: string,
  interimTranscript: string,
  range: SpeechInsertionRange | null,
): {
  interimDisplayTranscript: string;
  interimInsertion: SpeechTranscriptInsertionParts;
} {
  const interimDisplayTranscript = getSpeechInterimDisplayTranscript(
    draft,
    interimTranscript,
    range,
  );
  const interimInsertion = range
    ? getSpeechTranscriptReplacementParts(
        draft,
        interimDisplayTranscript,
        range.end,
        range.replaceEnd ?? range.end,
      )
    : getSpeechTranscriptInsertionParts(
        draft,
        interimDisplayTranscript,
        draft.length,
      );
  return { interimDisplayTranscript, interimInsertion };
}
