import type { ContentBlock, Message } from "./message.js";
import type { ToolResultData } from "./items.js";

export interface ToolResultProjection {
  data: ToolResultData;
  background: boolean;
  interrupted: boolean;
}

export interface ToolOutputFacts {
  sessionId?: string;
  cellId?: string;
  launchId?: string;
  launchIsSession?: boolean;
  exited?: boolean;
}

/**
 * Intrinsic facts only: pairing, approval, ordering and folding remain derived
 * from the complete current window. Keys are immutable input objects, never IDs.
 * Weak keys release facts with their source messages/results; no history is held.
 */
export interface TranscriptProjectionMemo {
  results: WeakMap<
    Message,
    WeakMap<
      ContentBlock,
      { toolName: string; projection: ToolResultProjection }
    >
  >;
  outputs: WeakMap<ToolResultData, ToolOutputFacts>;
}

export function createTranscriptProjectionMemo(): TranscriptProjectionMemo {
  return { results: new WeakMap(), outputs: new WeakMap() };
}

export function projectToolResultOnce(
  memo: TranscriptProjectionMemo | undefined,
  message: Message,
  block: ContentBlock,
  toolName: string,
  build: () => ToolResultProjection,
): ToolResultProjection {
  const blocks = memo?.results.get(message);
  const cached = blocks?.get(block);
  if (cached?.toolName === toolName) return cached.projection;
  const projection = build();
  if (memo) {
    const entries = blocks ?? new WeakMap();
    // One variant per block: changed call names replace, rather than accumulate.
    entries.set(block, { toolName, projection });
    memo.results.set(message, entries);
  }
  return projection;
}
