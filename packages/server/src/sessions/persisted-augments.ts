import { citationOptionsForMessages } from "../augments/citation-sources.js";
import {
  augmentEditToolUsesInMessage,
  augmentExitPlanModeAndReadResultsInMessage,
  augmentFinalizedMessage,
  augmentWriteToolUsesInMessage,
} from "../augments/finalized-message-augmenter.js";
import {
  type MarkdownAugmentCacheResult,
  observeMarkdownAugmentCache,
} from "../augments/markdown-augments.js";
import type { SafeMarkdownRenderOptions } from "../augments/safe-markdown.js";
import type { Message } from "../supervisor/types.js";

export interface PersistedAugmentDiagnostics {
  cacheHits: number;
  cacheJoins: number;
  cacheMisses: number;
  changedMessages: number;
  inputMessages: number;
}

export interface PersistedAugmentOptions {
  /** Test-only delay used to validate the session-detail augmentation clock. */
  delayMs?: number;
}

const AUGMENT_OUTPUT_FIELDS = new Set([
  "_diffHtml",
  "_highlightedContentHtml",
  "_highlightedLanguage",
  "_highlightedTruncated",
  "_html",
  "_projectPathLinks",
  "_rawPatch",
  "_renderedHtml",
  "_renderedMarkdownHtml",
  "_structuredPatch",
]);

function countAugmentOutputFields(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    return value.reduce(
      (count, item) => count + countAugmentOutputFields(item),
      0,
    );
  }

  let count = 0;
  for (const [key, nested] of Object.entries(value)) {
    if (AUGMENT_OUTPUT_FIELDS.has(key)) count += 1;
    count += countAugmentOutputFields(nested);
  }
  return count;
}

function waitForDelay(delayMs: number | undefined): Promise<void> | undefined {
  if (delayMs === undefined || delayMs <= 0) return undefined;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function asAugmentableMessage(message: Message): Record<string, unknown> {
  return message as unknown as Record<string, unknown>;
}

/**
 * Embed Edit augment data directly into tool_use inputs.
 * Adds _structuredPatch and _diffHtml to Edit tool_use input blocks.
 */
export async function augmentEditToolUses(messages: Message[]): Promise<void> {
  await Promise.all(
    messages.map((message) =>
      augmentEditToolUsesInMessage(asAugmentableMessage(message)),
    ),
  );
}

/**
 * Embed Write augment data directly into tool_use inputs.
 * Adds syntax-highlighted fields to Write tool_use input blocks.
 */
export async function augmentWriteToolUses(messages: Message[]): Promise<void> {
  await Promise.all(
    messages.map((message) =>
      augmentWriteToolUsesInMessage(asAugmentableMessage(message)),
    ),
  );
}

/**
 * Render ExitPlanMode plan HTML and augment structured Read tool results.
 */
export async function augmentExitPlanModeAndReadResults(
  messages: Message[],
): Promise<void> {
  await Promise.all(
    messages.map((message) =>
      augmentExitPlanModeAndReadResultsInMessage(asAugmentableMessage(message)),
    ),
  );
}

/**
 * Build the cache observer in its own scope. Every closure in one function
 * shares that function's V8 context, so an observer created inside
 * `augmentPersistedSessionMessages` would retain `messages` for as long as any
 * async resource that captured the observer's AsyncLocalStorage store lives.
 */
function countCacheResults(
  diagnostics: PersistedAugmentDiagnostics,
): (result: MarkdownAugmentCacheResult) => void {
  return (result) => {
    if (result === "hit") diagnostics.cacheHits += 1;
    else if (result === "joined") diagnostics.cacheJoins += 1;
    else diagnostics.cacheMisses += 1;
  };
}

/**
 * Apply the same persisted-message augmentation pipeline used by session GET.
 */
export async function augmentPersistedSessionMessages(
  messages: Message[],
  safeMarkdownOptions?: SafeMarkdownRenderOptions,
  options: PersistedAugmentOptions = {},
): Promise<PersistedAugmentDiagnostics> {
  safeMarkdownOptions = {
    ...safeMarkdownOptions,
    ...citationOptionsForMessages(messages, safeMarkdownOptions),
  };
  const diagnostics: PersistedAugmentDiagnostics = {
    cacheHits: 0,
    cacheJoins: 0,
    cacheMisses: 0,
    changedMessages: 0,
    inputMessages: messages.length,
  };
  await observeMarkdownAugmentCache(
    countCacheResults(diagnostics),
    async () => {
      await waitForDelay(options.delayMs);
      await Promise.all(
        messages.map(async (message) => {
          const augmentableMessage = asAugmentableMessage(message);
          const fieldsBefore = countAugmentOutputFields(augmentableMessage);
          await augmentFinalizedMessage(augmentableMessage, {
            safeMarkdownOptions,
          });
          if (countAugmentOutputFields(augmentableMessage) !== fieldsBefore) {
            diagnostics.changedMessages += 1;
          }
        }),
      );
    },
  );

  return diagnostics;
}
