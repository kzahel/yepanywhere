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
   * Whether the provider supports cloning sessions.
   */
  supportsCloning: boolean;

  /**
   * Whether the provider supports permission mode switching.
   */
  supportsPermissionMode: boolean;

  /**
   * Whether the provider supports the thinking toggle.
   */
  supportsThinkingToggle: boolean;

  /**
   * Whether the provider exposes slash commands.
   */
  supportsSlashCommands: boolean;
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
