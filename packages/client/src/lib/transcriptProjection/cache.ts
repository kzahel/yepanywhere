import type { Message } from "../../types";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import type { TranscriptProjectionAugments } from "@yep-anywhere/shared/transcript/types";

export type TranscriptProjectionCompiler = (
  messages: Message[],
  augments?: TranscriptProjectionAugments,
) => RenderItem[];

const AUGMENT_CACHE_KEY_FIELDS = {
  activeToolApproval: true,
  markdown: true,
  workflowTags: true,
  workflowSchemaFiles: true,
} as const satisfies Record<keyof TranscriptProjectionAugments, true>;

const augmentCacheKeys = Object.keys(AUGMENT_CACHE_KEY_FIELDS) as Array<
  keyof TranscriptProjectionAugments
>;

interface TranscriptProjectionCacheEntry {
  workflowSchemaFiles: TranscriptProjectionAugments["workflowSchemaFiles"];
  workflowTags: boolean | undefined;
  activeToolApproval: boolean | undefined;
  compiler: TranscriptProjectionCompiler;
  items: RenderItem[];
  markdown: TranscriptProjectionAugments["markdown"];
}

const resultCache = new WeakMap<Message[], TranscriptProjectionCacheEntry[]>();
const CACHE_VARIANTS_PER_MESSAGE_ARRAY = 3;

/**
 * Cache semantic compilation by the identities of the message array and its
 * augment inputs. The compiler remains an explicit dependency so this module
 * does not import the legacy compatibility façade.
 */
export function getCachedTranscriptProjection(
  messages: Message[],
  augments: TranscriptProjectionAugments | undefined,
  compiler: TranscriptProjectionCompiler,
): RenderItem[] {
  const markdown = augments?.markdown;
  const activeToolApproval = augments?.activeToolApproval;
  const cachedVariants = resultCache.get(messages);
  const cached = cachedVariants?.find(
    (entry) =>
      entry.compiler === compiler &&
      augmentCacheKeys.every((key) => entry[key] === augments?.[key]),
  );
  if (cached) {
    return cached.items;
  }

  const items = compiler(messages, augments);
  const variants = cachedVariants ?? [];
  variants.push({
    workflowSchemaFiles: augments?.workflowSchemaFiles,
    workflowTags: augments?.workflowTags,
    activeToolApproval,
    compiler,
    items,
    markdown,
  });
  if (variants.length > CACHE_VARIANTS_PER_MESSAGE_ARRAY) {
    variants.shift();
  }
  resultCache.set(messages, variants);
  return items;
}
