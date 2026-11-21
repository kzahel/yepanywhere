/**
 * Capability flags for providers.
 * Extend this interface as we discover more provider-specific behaviors.
 */
export interface ProviderCapabilities {
  /**
   * Whether the provider supports DAG-based message history.
   * If true, client will reorder messages based on parentUuid.
   * If false, client will respect server-sent order (linear).
   */
  supportsDag: boolean;

  /**
   * Whether ordered durable batches can use shared message IDs to place rows
   * relative to the live stream.
   */
  usesDurableOrderAnchors?: boolean;

  /**
   * Whether replay coverage should use durable IDs. Providers that replay
   * legacy echoes without matching IDs can still use a timestamp watermark.
   */
  usesDurableReplayIdentity?: boolean;

  /**
   * Whether the provider supports cloning sessions.
   */
  supportsCloning: boolean;

  /**
   * Whether the provider's live-stream message ids can diverge from its durable
   * (JSONL/DB) ids, so a backfill merge can append duplicates. When true, the
   * client reconciles stream-vs-durable copies by content+timestamp as a
   * backstop. Providers whose ids match deterministically leave this false.
   */
  needsApproxMessageDedup: boolean;

  /**
   * Whether to exclude tool_use/tool_result messages from the approx-dedup
   * backstop (only meaningful when needsApproxMessageDedup is true). Set when
   * the provider's tool messages dedup deterministically by id, so the
   * content+timestamp backstop is redundant for them and should not risk
   * merging legitimately-recurring identical tool calls. Defaults to false
   * (backstop covers tools too). See topics/stream-durable-id-dedup.md.
   */
  approxDedupExcludesTools?: boolean;

  /**
   * Whether the provider persists busy-path sends (steer/queued delivery) as
   * queue-operation rows with no uuid, so YA's optimistic user echo can never
   * dedup by id against the durable copy. When true, the client pairs
   * `deferredSource: "queue-operation"` rows one-to-one against sdk-source
   * user echoes by identical text and nearest timestamp. Claude-family only;
   * defaults to false. See topics/stream-durable-id-dedup.md.
   */
  dedupQueueOperationEchoes?: boolean;

  /**
   * Whether the provider mints its own durable user-turn id with no hook for
   * YA to supply or predict one, so an optimistic self-send echo can never
   * dedup by id against its durable copy. When true, the client pairs each
   * durable user row with the in-order run of unconfirmed self-send echoes
   * whose text it exactly reproduces. Grok only; defaults to false. See
   * topics/stream-durable-id-dedup.md.
   */
  dedupSelfSendUserEchoes?: boolean;
}

/**
 * Metadata for settings display.
 */
export interface ProviderMetadata {
  /** Short description of the provider */
  description: string;

  /** Limitations or caveats for mobile supervision */
  limitations: string[];

  /** Official website URL */
  website: string;

  /** CLI name for auto-detection */
  cliName: string;
}

/**
 * Client-side abstraction for an AI provider.
 * Encapsulates capabilities and metadata to avoid scattered "if/else" checks.
 */
export interface Provider {
  /** Internal ID (e.g. 'claude', 'gemini') */
  readonly id: string;

  /** Human-readable name */
  readonly displayName: string;

  /** Capability flags */
  readonly capabilities: ProviderCapabilities;

  /** Settings display metadata */
  readonly metadata: ProviderMetadata;
}
