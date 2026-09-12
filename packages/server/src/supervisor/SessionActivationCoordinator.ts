import {
  DEFAULT_RECAP_AFTER_SECONDS,
  HELPER_SIDE_MODEL_CHEAPEST,
  type EffortLevel,
  type PermissionRules,
  type PromptSuggestionMode,
  type ProviderName,
  type RecapMode,
  type SessionSandboxLevel,
  type ThinkingConfig,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type {
  EffectiveSessionLaunchSettingsValue,
  SessionMetadataService,
} from "../metadata/index.js";
import { getSessionSandboxSettingsError } from "../session-sandbox.js";
import type { RecoveredSessionLaunchSettings } from "../sessions/types.js";
import type { PermissionMode } from "../sdk/types.js";
import type { Process } from "./Process.js";
import { persistedSandboxFromProcess } from "./sessionSandboxMetadata.js";

/** Launch and live configuration settings for a session. */
export interface ModelSettings {
  /** Explicit launch opt-in, never inherited by forks or automatic resumes. */
  computerControl?: boolean;
  /** Model to use (e.g., "sonnet", "opus", "haiku"). undefined = use CLI default */
  model?: string;
  /** Exact YA request token, including "default", used for durable restore. */
  requestedModel?: string;
  /** Provider-visible service tier. undefined means provider/default behavior. */
  serviceTier?: string;
  /** Thinking configuration. undefined = thinking disabled for new sessions. */
  thinking?: ThinkingConfig;
  /** Effort level for response quality. undefined = SDK default */
  effort?: EffortLevel;
  /** Optional provider-visible client identity. */
  clientName?: string;
  /** Provider to use for this session. undefined = use default (Claude) */
  providerName?: ProviderName;
  /** SSH host for remote execution (undefined = local) */
  executor?: string;
  /** Environment variables to set on remote. */
  remoteEnv?: Record<string, string>;
  /** Global instructions to append to system prompt. */
  globalInstructions?: string;
  /** Permission rules for tool filtering (deny/allow patterns). */
  permissions?: PermissionRules;
  /** How this session should answer away-recap requests. */
  recapMode?: RecapMode;
  /** Browser-away duration before YA asks this process for a recap. */
  recapAfterSeconds?: number;
  /** How this session should request native prompt suggestions. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** Resume strategy. undefined and "full" preserve existing behavior. */
  resumeMode?: "full" | "compact-first";
  /** Resume only through this transcript message UUID. */
  resumeSessionAt?: string;
  /** Per-model preemptive compaction threshold percentage. */
  compactAtContextPercent?: number;
  /** Effective context window used by the compaction threshold. */
  compactAtContextWindow?: number;
  /** Ignore a provider-native threshold and retain YA orchestration. */
  forceYaOrchestratedCompaction?: boolean;
  /** Claude Code's launch-time auto-compaction percentage override. */
  claudeAutoCompactPercentOverride?: number;
  /** Settled YA host filesystem confinement for this session. */
  sandboxLevel?: SessionSandboxLevel;
  /** Public-only egress boundary; absent means on for project-write. */
  sandboxNetworkFirewall?: boolean;
  /** Opaque project-private provider-state key restored from metadata. */
  sandboxStateKey?: string;
}

export interface SessionReactivationOverrides {
  permissionMode?: PermissionMode;
  modelSettings?: ModelSettings;
}

export interface SessionReactivationOptions {
  preempt?: boolean;
  requestedOverrides?: SessionReactivationOverrides;
}

export class SessionConfigurationConflictError extends Error {
  readonly status = 409;
  readonly changes: readonly string[];

  constructor(changes: readonly string[]) {
    super(
      `Cannot apply launch-scoped configuration while the session is active: ${changes.join(", ")}`,
    );
    this.name = "SessionConfigurationConflictError";
    this.changes = changes;
  }
}

interface ProcessModelConfiguration {
  nextModel: string | undefined;
  nextRequestedModel: string | null;
  nextServiceTier: string | undefined;
  nextThinking: ThinkingConfig | undefined;
  nextEffort: EffortLevel | undefined;
  modelChanged: boolean;
  serviceTierChanged: boolean;
  thinkingChanged: boolean;
  effortChanged: boolean;
  dynamicChange: "model" | "thinking" | "effort" | null;
}

interface PendingProcessLaunchSettings {
  processId: string;
  value: EffectiveSessionLaunchSettingsValue;
}

interface SessionCoordinationState {
  activation: Promise<Process> | null;
  configurationTail: Promise<void> | null;
  pendingLaunchSettings: PendingProcessLaunchSettings | null;
}

export interface SessionActivationCoordinatorOptions {
  defaultPermissionMode: PermissionMode;
  sessionMetadataService?: SessionMetadataService;
  recoverSessionLaunchSettings?: (
    sessionId: string,
    projectId: UrlProjectId,
    provider: ProviderName | undefined,
  ) => Promise<RecoveredSessionLaunchSettings | null | undefined>;
  getProcess(processId: string): Process | undefined;
  getProcessForSession(sessionId: string): Process | undefined;
  unregisterProcess(process: Process): void;
  assertProviderOwnershipSettled(process: Process, action: string): void;
  assertSessionSandboxSettings(settings: ModelSettings | undefined): void;
  restartProcess(
    process: Process,
    projectPath: string,
    permissionMode: PermissionMode,
    settings: ModelSettings,
  ): Promise<Process | null>;
  onSuccessfulProviderSession?: (
    sessionId: string,
    provider: ProviderName,
  ) => Promise<void>;
}

export interface ReactivateSessionRequest {
  projectPath: string;
  projectId: UrlProjectId;
  sessionId: string;
  permissionMode?: PermissionMode;
  modelSettings?: ModelSettings;
  requestedOverrides: SessionReactivationOverrides;
  prepareColdActivation(): Promise<void>;
  launchCold(settings: {
    permissionMode: PermissionMode;
    modelSettings: ModelSettings;
  }): Promise<Process>;
}

export function thinkingConfigsEqual(
  current?: ThinkingConfig,
  next?: ThinkingConfig,
): boolean {
  if (current?.type !== next?.type) return false;
  if (!current || !next) return true;
  if (current.type === "adaptive" && next.type === "adaptive") {
    return current.display === next.display;
  }
  if (current.type === "enabled" && next.type === "enabled") {
    return (
      current.budgetTokens === next.budgetTokens &&
      current.display === next.display
    );
  }
  return true;
}

function permissionRulesEqual(
  current: PermissionRules | undefined,
  next: PermissionRules | undefined,
): boolean {
  return JSON.stringify(current) === JSON.stringify(next);
}

function isDynamicThinkingModeConfig(thinking?: ThinkingConfig): boolean {
  return (
    !thinking ||
    thinking.type === "disabled" ||
    (thinking.type === "adaptive" && thinking.display === undefined)
  );
}

export function canApplyThinkingConfigDynamically(
  current?: ThinkingConfig,
  next?: ThinkingConfig,
): boolean {
  if (!isDynamicThinkingModeConfig(current)) return false;
  if (!isDynamicThinkingModeConfig(next)) return false;
  return current?.type !== next?.type;
}

/**
 * Owns the per-session activation and configuration state machine.
 *
 * Every transition is serialized by session id. The caller supplies provider
 * launch/restart operations, while the coordinator returns the single settled
 * Process that owns the session after the transition.
 */
export class SessionActivationCoordinator {
  private readonly sessions = new Map<string, SessionCoordinationState>();

  constructor(private readonly options: SessionActivationCoordinatorOptions) {}

  private stateFor(sessionId: string): SessionCoordinationState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionCoordinationState = {
      activation: null,
      configurationTail: null,
      pendingLaunchSettings: null,
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private releaseEmptyState(
    sessionId: string,
    state: SessionCoordinationState,
  ): void {
    if (
      state.activation === null &&
      state.configurationTail === null &&
      state.pendingLaunchSettings === null &&
      this.sessions.get(sessionId) === state
    ) {
      this.sessions.delete(sessionId);
    }
  }

  async waitForActivation(sessionId: string): Promise<boolean> {
    const activation = this.sessions.get(sessionId)?.activation;
    if (!activation) return false;
    try {
      await activation;
    } catch {
      // The caller retries its ordinary path, which surfaces a fresh failure
      // or recovers after a transient activation failure.
    }
    return true;
  }

  async startActivation<T extends Process>(
    sessionId: string,
    activate: () => Promise<T> | T,
  ): Promise<T> {
    const state = this.stateFor(sessionId);
    const activation = Promise.resolve().then(activate);
    state.activation = activation;
    try {
      return (await activation) as T;
    } finally {
      if (state.activation === activation) {
        state.activation = null;
        this.releaseEmptyState(sessionId, state);
      }
    }
  }

  enqueueConfiguration<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const state = this.stateFor(sessionId);
    const result = (state.configurationTail ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    state.configurationTail = tail;
    void tail.finally(() => {
      if (state.configurationTail === tail) {
        state.configurationTail = null;
        this.releaseEmptyState(sessionId, state);
      }
    });
    return result;
  }

  async resolveColdLaunchSettings(
    projectId: UrlProjectId,
    sessionId: string,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
  ): Promise<{ permissionMode: PermissionMode; modelSettings: ModelSettings }> {
    const metadata = this.options.sessionMetadataService;
    const durable = metadata?.getEffectiveLaunchSettings(sessionId);
    const explicitRequestedModel =
      modelSettings?.requestedModel ?? modelSettings?.model;
    const legacyRequestedModel = durable
      ? undefined
      : metadata?.getRequestedModel(sessionId);
    const needsRecovery =
      !durable &&
      (permissionMode === undefined ||
        (explicitRequestedModel === undefined &&
          legacyRequestedModel === undefined) ||
        modelSettings?.thinking === undefined);
    let recovered: RecoveredSessionLaunchSettings | undefined;
    if (needsRecovery && this.options.recoverSessionLaunchSettings) {
      const provider =
        modelSettings?.providerName ?? metadata?.getProvider?.(sessionId);
      try {
        recovered =
          (await this.options.recoverSessionLaunchSettings(
            sessionId,
            projectId,
            provider,
          )) ?? undefined;
      } catch (error) {
        getLogger().debug(
          {
            event: "session_launch_settings_recovery_failed",
            sessionId,
            projectId,
            provider,
            error: error instanceof Error ? error.message : String(error),
          },
          "Falling back after session launch settings recovery failed",
        );
      }
    }

    const inheritedRequestedModel = durable
      ? (durable.requestedModel ?? undefined)
      : (legacyRequestedModel ?? recovered?.requestedModel);
    const requestedModel = explicitRequestedModel ?? inheritedRequestedModel;
    const inheritedServiceTier = durable
      ? (durable.serviceTier ?? undefined)
      : recovered?.serviceTier;
    const inheritedThinking = durable
      ? (durable.thinking ?? undefined)
      : recovered?.thinking;
    const inheritedEffort = durable
      ? (durable.effort ?? undefined)
      : recovered?.effort;
    const thinkingWasRequested = modelSettings?.thinking !== undefined;

    return {
      permissionMode:
        permissionMode ??
        (durable ? durable.permissionMode : recovered?.permissionMode) ??
        this.options.defaultPermissionMode,
      modelSettings: {
        ...modelSettings,
        requestedModel: requestedModel ?? undefined,
        model:
          requestedModel && requestedModel !== "default"
            ? requestedModel
            : undefined,
        serviceTier: modelSettings?.serviceTier ?? inheritedServiceTier,
        thinking: modelSettings?.thinking ?? inheritedThinking,
        effort: thinkingWasRequested
          ? modelSettings?.effort
          : (modelSettings?.effort ?? inheritedEffort),
      },
    };
  }

  private processLaunchSettings(
    process: Process,
  ): EffectiveSessionLaunchSettingsValue {
    return {
      permissionMode: process.permissionMode,
      requestedModel: process.requestedModel ?? null,
      serviceTier: process.serviceTier ?? null,
      thinking: process.thinking ?? null,
      effort: process.appliedEffort ?? null,
    };
  }

  private async persistProcessLaunchSettings(process: Process): Promise<void> {
    const state = this.stateFor(process.sessionId);
    const pending: PendingProcessLaunchSettings = {
      processId: process.id,
      value: this.processLaunchSettings(process),
    };
    state.pendingLaunchSettings = pending;
    await this.options.sessionMetadataService?.recordEffectiveLaunchSettings(
      process.sessionId,
      pending.value,
    );
    if (state.pendingLaunchSettings === pending) {
      state.pendingLaunchSettings = null;
      this.releaseEmptyState(process.sessionId, state);
    }
  }

  /** Persist standing policy before its replaceable controller releases ownership. */
  async prepareForServerReload(process: Process): Promise<void> {
    await this.enqueueConfiguration(process.sessionId, async () => {
      await this.persistProcessLaunchSettings(process);
      await this.options.sessionMetadataService?.flushPendingWrites();
    });
  }

  private async flushPendingProcessLaunchSettings(
    process: Process,
  ): Promise<void> {
    const pending = this.sessions.get(process.sessionId)?.pendingLaunchSettings;
    if (pending?.processId === process.id) {
      await this.persistProcessLaunchSettings(process);
    }
  }

  private async persistReactivationOverrides(
    process: Process,
    requestedOverrides: SessionReactivationOverrides,
  ): Promise<void> {
    const service = this.options.sessionMetadataService;
    const updates = requestedOverrides.modelSettings;
    if (!service || !updates) return;

    let wroteMetadata = false;
    if (Object.hasOwn(updates, "providerName")) {
      await service.setProvider(process.sessionId, process.provider);
      wroteMetadata = true;
    }
    if (Object.hasOwn(updates, "executor")) {
      await service.setExecutor(process.sessionId, process.executor);
      wroteMetadata = true;
    }
    if (
      Object.hasOwn(updates, "recapMode") ||
      Object.hasOwn(updates, "recapAfterSeconds") ||
      Object.hasOwn(updates, "promptSuggestionMode")
    ) {
      await service.updateMetadata(process.sessionId, {
        ...(Object.hasOwn(updates, "recapMode")
          ? { recapMode: process.recapMode }
          : {}),
        ...(Object.hasOwn(updates, "recapAfterSeconds")
          ? { recapAfterSeconds: process.recapAfterSeconds }
          : {}),
        ...(Object.hasOwn(updates, "promptSuggestionMode")
          ? { promptSuggestionMode: process.promptSuggestionMode }
          : {}),
      });
      wroteMetadata = true;
    }
    if (Object.hasOwn(updates, "sandboxLevel")) {
      await service.setSessionSandbox(process.sessionId, {
        ...persistedSandboxFromProcess(process),
      });
      wroteMetadata = true;
    }
    if (wroteMetadata) {
      await service.flushPendingWrites();
    }
  }

  scheduleLaunchSettingsPersistence(process: Process, setting: string): void {
    if (
      process.isTerminated ||
      this.options.getProcessForSession(process.sessionId) !== process
    ) {
      return;
    }
    const state = this.stateFor(process.sessionId);
    const pending: PendingProcessLaunchSettings = {
      processId: process.id,
      value: this.processLaunchSettings(process),
    };
    state.pendingLaunchSettings = pending;
    void this.enqueueConfiguration(process.sessionId, async () => {
      if (
        state.pendingLaunchSettings !== pending ||
        process.isTerminated ||
        this.options.getProcessForSession(process.sessionId) !== process
      ) {
        return;
      }
      await this.persistProcessLaunchSettings(process);
    }).catch((error) => {
      getLogger().warn(
        {
          event: "session_launch_settings_save_failed",
          sessionId: process.sessionId,
          processId: process.id,
          setting,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to save applied session launch settings",
      );
    });
  }

  discardProcess(process: Process): void {
    const state = this.sessions.get(process.sessionId);
    if (state?.pendingLaunchSettings?.processId === process.id) {
      state.pendingLaunchSettings = null;
      this.releaseEmptyState(process.sessionId, state);
    }
  }

  async persistSuccessfulSessionBoundaryOrAbort(
    process: Process,
  ): Promise<void> {
    try {
      await this.persistProcessLaunchSettings(process);
      await this.options.sessionMetadataService?.setProvider?.(
        process.sessionId,
        process.provider,
      );
      await this.options.onSuccessfulProviderSession?.(
        process.sessionId,
        process.provider,
      );
    } catch (error) {
      await process.abort();
      throw new Error(
        `Failed to persist successful ${process.provider} session boundary: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  reactivate(request: ReactivateSessionRequest): Promise<Process> {
    return this.enqueueConfiguration(request.sessionId, async () => {
      const existing = this.options.getProcessForSession(request.sessionId);
      if (existing) {
        if (!existing.isTerminated) {
          const reconciled = await this.reconcileProcess(
            existing,
            request.projectPath,
            request.modelSettings,
            request.requestedOverrides,
          );
          await this.persistReactivationOverrides(
            reconciled,
            request.requestedOverrides,
          );
          return reconciled;
        }
        this.options.unregisterProcess(existing);
      }

      const activeActivation = this.sessions.get(request.sessionId)?.activation;
      if (activeActivation) {
        const activated = await activeActivation;
        const reconciled = await this.reconcileProcess(
          activated,
          request.projectPath,
          request.modelSettings,
          request.requestedOverrides,
        );
        await this.persistReactivationOverrides(
          reconciled,
          request.requestedOverrides,
        );
        return reconciled;
      }

      const activated = await this.startActivation(
        request.sessionId,
        async () => {
          const raced = this.options.getProcessForSession(request.sessionId);
          if (raced) {
            if (!raced.isTerminated) {
              return this.reconcileProcess(
                raced,
                request.projectPath,
                request.modelSettings,
                request.requestedOverrides,
              );
            }
            this.options.unregisterProcess(raced);
          }
          await request.prepareColdActivation();
          const resolved = await this.resolveColdLaunchSettings(
            request.projectId,
            request.sessionId,
            request.permissionMode,
            request.modelSettings,
          );
          return request.launchCold(resolved);
        },
      );
      await this.persistReactivationOverrides(
        activated,
        request.requestedOverrides,
      );
      return activated;
    });
  }

  async reconfigureProcess(
    processId: string,
    updates: ModelSettings,
  ): Promise<Process | null> {
    const process = this.options.getProcess(processId);
    if (
      !process ||
      process.isTerminated ||
      process.hasUnverifiedProviderOwnership
    ) {
      return null;
    }

    return this.enqueueConfiguration(process.sessionId, async () => {
      const current = this.options.getProcess(processId);
      if (
        !current ||
        current.isTerminated ||
        current.hasUnverifiedProviderOwnership
      ) {
        return null;
      }
      const configuration = this.resolveProcessModelConfiguration(
        current,
        updates,
      );
      const changes = this.modelConfigurationChanges(configuration);
      if (changes.length === 0) {
        await this.flushPendingProcessLaunchSettings(current);
        return current;
      }

      if (configuration.dynamicChange !== null) {
        const changed = await this.applyDynamicModelConfiguration(
          current,
          configuration,
        );
        if (!changed) return null;
        await this.persistProcessLaunchSettings(current);
        return current;
      }

      if (current.state.type !== "idle") {
        throw new SessionConfigurationConflictError(changes);
      }
      return this.options.restartProcess(
        current,
        current.projectPath,
        current.permissionMode,
        this.restartSettingsForProcess(current, configuration, updates),
      );
    });
  }

  private resolveProcessModelConfiguration(
    process: Process,
    updates: ModelSettings,
  ): ProcessModelConfiguration {
    const hasModelUpdate = Object.hasOwn(updates, "model");
    const hasRequestedModelUpdate = Object.hasOwn(updates, "requestedModel");
    const hasServiceTierUpdate = Object.hasOwn(updates, "serviceTier");
    const hasThinkingUpdate = Object.hasOwn(updates, "thinking");
    const hasEffortUpdate = Object.hasOwn(updates, "effort");

    const currentRequestedModel = process.requestedModel ?? null;
    const nextRequestedModel = hasRequestedModelUpdate
      ? (updates.requestedModel ?? null)
      : hasModelUpdate
        ? (updates.model ?? null)
        : currentRequestedModel;
    const nextModel = hasModelUpdate
      ? updates.model
      : nextRequestedModel && nextRequestedModel !== "default"
        ? nextRequestedModel
        : undefined;
    const nextServiceTier = hasServiceTierUpdate
      ? updates.serviceTier
      : process.serviceTier;
    const nextThinking = hasThinkingUpdate
      ? updates.thinking
      : process.thinking;
    const nextEffort = hasEffortUpdate ? updates.effort : process.effort;

    const modelChanged =
      (hasModelUpdate || hasRequestedModelUpdate) &&
      nextRequestedModel !== currentRequestedModel;
    const serviceTierChanged =
      hasServiceTierUpdate && nextServiceTier !== process.serviceTier;
    const thinkingChanged =
      hasThinkingUpdate &&
      !thinkingConfigsEqual(process.thinking, nextThinking);
    const effortChanged =
      hasEffortUpdate && nextEffort !== process.appliedEffort;

    let dynamicChange: ProcessModelConfiguration["dynamicChange"] = null;
    if (
      modelChanged &&
      !serviceTierChanged &&
      !thinkingChanged &&
      !effortChanged &&
      process.supportsSetModel &&
      (process.getProviderRuntimeStatus()?.kind !== "retrying" ||
        process.supportsInterrupt)
    ) {
      dynamicChange = "model";
    } else if (
      !modelChanged &&
      !serviceTierChanged &&
      thinkingChanged &&
      !effortChanged &&
      canApplyThinkingConfigDynamically(process.thinking, nextThinking) &&
      process.supportsThinkingModeChange
    ) {
      dynamicChange = "thinking";
    } else if (
      !modelChanged &&
      !serviceTierChanged &&
      !thinkingChanged &&
      effortChanged &&
      process.supportsEffortChange
    ) {
      dynamicChange = "effort";
    }

    return {
      nextModel,
      nextRequestedModel,
      nextServiceTier,
      nextThinking,
      nextEffort,
      modelChanged,
      serviceTierChanged,
      thinkingChanged,
      effortChanged,
      dynamicChange,
    };
  }

  private modelConfigurationChanges(
    configuration: ProcessModelConfiguration,
  ): string[] {
    return [
      configuration.modelChanged ? "model" : undefined,
      configuration.serviceTierChanged ? "service tier" : undefined,
      configuration.thinkingChanged ? "thinking" : undefined,
      configuration.effortChanged ? "effort" : undefined,
    ].filter((change): change is string => change !== undefined);
  }

  private async applyDynamicModelConfiguration(
    process: Process,
    configuration: ProcessModelConfiguration,
  ): Promise<boolean> {
    switch (configuration.dynamicChange) {
      case "model":
        return process.setModel(
          configuration.nextModel,
          configuration.nextRequestedModel,
        );
      case "thinking": {
        const tokens =
          configuration.nextThinking?.type === "disabled" ? undefined : 1;
        const changed = await process.setMaxThinkingTokens(tokens);
        if (changed) {
          process.updateThinkingConfig(
            configuration.nextThinking,
            configuration.nextEffort,
          );
        }
        return changed;
      }
      case "effort":
        return process.setEffort(configuration.nextEffort);
      case null:
        return false;
    }
  }

  private restartSettingsForProcess(
    process: Process,
    configuration: ProcessModelConfiguration,
    updates: ModelSettings,
  ): ModelSettings {
    return {
      ...updates,
      model: configuration.nextModel,
      requestedModel: configuration.nextRequestedModel ?? undefined,
      serviceTier: configuration.nextServiceTier,
      thinking: configuration.nextThinking,
      effort: configuration.nextEffort,
      compactAtContextPercent:
        updates.compactAtContextPercent ?? process.compactAtContextPercent,
      compactAtContextWindow:
        updates.compactAtContextWindow ?? process.compactAtContextWindow,
      forceYaOrchestratedCompaction:
        updates.forceYaOrchestratedCompaction ??
        process.forceYaOrchestratedCompaction,
      claudeAutoCompactPercentOverride:
        updates.claudeAutoCompactPercentOverride ??
        process.launchCompactPercentOverride,
      providerName: updates.providerName ?? process.provider,
      executor: Object.hasOwn(updates, "executor")
        ? updates.executor
        : process.executor,
      permissions: Object.hasOwn(updates, "permissions")
        ? updates.permissions
        : process.permissions,
      recapMode: updates.recapMode ?? process.recapMode,
      recapAfterSeconds: updates.recapAfterSeconds ?? process.recapAfterSeconds,
      promptSuggestionMode:
        updates.promptSuggestionMode ?? process.promptSuggestionMode,
      helperSideModel: updates.helperSideModel ?? process.helperSideModel,
      sandboxLevel:
        updates.sandboxLevel ?? process.sandboxEnforcement?.effective,
      sandboxNetworkFirewall:
        updates.sandboxNetworkFirewall ??
        process.sandboxEnforcement?.networkFirewall,
      sandboxStateKey: updates.sandboxStateKey ?? process.sandboxStateKey,
    };
  }

  private async reconcileProcess(
    process: Process,
    projectPath: string,
    coldSettings: ModelSettings | undefined,
    requestedOverrides: SessionReactivationOverrides,
  ): Promise<Process> {
    this.options.assertProviderOwnershipSettled(process, "reactivate");
    const updates = requestedOverrides.modelSettings ?? {};
    const configuration = this.resolveProcessModelConfiguration(
      process,
      updates,
    );
    const desiredPermissionMode =
      requestedOverrides.permissionMode ?? process.permissionMode;
    const desiredProvider = Object.hasOwn(updates, "providerName")
      ? (updates.providerName ?? process.provider)
      : process.provider;
    const desiredExecutor = Object.hasOwn(updates, "executor")
      ? updates.executor
      : process.executor;
    const desiredPermissions = Object.hasOwn(updates, "permissions")
      ? updates.permissions
      : process.permissions;
    const desiredSandboxLevel = Object.hasOwn(updates, "sandboxLevel")
      ? (updates.sandboxLevel ?? "none")
      : (process.sandboxEnforcement?.effective ?? "none");
    const desiredSandboxStateKey = Object.hasOwn(updates, "sandboxStateKey")
      ? updates.sandboxStateKey
      : process.sandboxStateKey;
    const desiredSandboxNetworkFirewall =
      desiredSandboxLevel === "project-write" &&
      (Object.hasOwn(updates, "sandboxNetworkFirewall")
        ? updates.sandboxNetworkFirewall !== false
        : process.sandboxEnforcement?.networkFirewall !== false);
    const desiredPromptSuggestionMode = Object.hasOwn(
      updates,
      "promptSuggestionMode",
    )
      ? (updates.promptSuggestionMode ?? "off")
      : process.promptSuggestionMode;
    const desiredRecapMode = Object.hasOwn(updates, "recapMode")
      ? (updates.recapMode ?? "off")
      : process.recapMode;
    const desiredRecapAfterSeconds = Object.hasOwn(updates, "recapAfterSeconds")
      ? (updates.recapAfterSeconds ?? DEFAULT_RECAP_AFTER_SECONDS)
      : process.recapAfterSeconds;
    const desiredHelperSideModel = Object.hasOwn(updates, "helperSideModel")
      ? updates.helperSideModel || HELPER_SIDE_MODEL_CHEAPEST
      : process.helperSideModel;

    const sandboxError = getSessionSandboxSettingsError(
      desiredSandboxLevel,
      desiredRecapMode,
    );
    if (sandboxError) throw new Error(sandboxError);

    const restartChanges = [
      desiredProvider !== process.provider ? "provider" : undefined,
      desiredExecutor !== process.executor ? "executor" : undefined,
      !permissionRulesEqual(desiredPermissions, process.permissions)
        ? "permission rules"
        : undefined,
      desiredSandboxLevel !==
        (process.sandboxEnforcement?.effective ?? "none") ||
      (desiredSandboxLevel === "project-write" &&
        desiredSandboxStateKey !== undefined &&
        desiredSandboxStateKey !== process.sandboxStateKey) ||
      (desiredSandboxLevel === "project-write" &&
        desiredSandboxNetworkFirewall !==
          (process.sandboxEnforcement?.networkFirewall !== false))
        ? "sandbox"
        : undefined,
      desiredPromptSuggestionMode !== process.promptSuggestionMode
        ? "prompt suggestions"
        : undefined,
      configuration.dynamicChange === null
        ? this.modelConfigurationChanges(configuration)
        : [],
    ]
      .flat()
      .filter((change): change is string => change !== undefined);

    if (restartChanges.length > 0) {
      if (process.state.type !== "idle") {
        throw new SessionConfigurationConflictError(restartChanges);
      }
      const restartSettings = this.restartSettingsForProcess(
        process,
        configuration,
        {
          ...coldSettings,
          ...updates,
          providerName: desiredProvider,
          executor: desiredExecutor,
          permissions: desiredPermissions,
          promptSuggestionMode: desiredPromptSuggestionMode,
          recapMode: desiredRecapMode,
          recapAfterSeconds: desiredRecapAfterSeconds,
          helperSideModel: desiredHelperSideModel,
          sandboxLevel: desiredSandboxLevel,
          sandboxNetworkFirewall: desiredSandboxNetworkFirewall,
          sandboxStateKey: desiredSandboxStateKey,
        },
      );
      const replacement = await this.options.restartProcess(
        process,
        projectPath,
        desiredPermissionMode,
        restartSettings,
      );
      if (!replacement) {
        throw new Error(
          "Provider does not support the requested configuration",
        );
      }
      return replacement;
    }

    const modelChanges = this.modelConfigurationChanges(configuration);
    if (modelChanges.length > 0) {
      const changed = await this.applyDynamicModelConfiguration(
        process,
        configuration,
      );
      if (!changed) {
        throw new Error("Provider did not apply the requested configuration");
      }
    }

    const permissionChanged = desiredPermissionMode !== process.permissionMode;
    if (permissionChanged) {
      process.setPermissionMode(desiredPermissionMode);
    }
    const recapChanged =
      desiredRecapMode !== process.recapMode ||
      desiredRecapAfterSeconds !== process.recapAfterSeconds ||
      desiredHelperSideModel !== process.helperSideModel;
    if (recapChanged) {
      process.setRecapConfig({
        recapMode: desiredRecapMode,
        recapAfterSeconds: desiredRecapAfterSeconds,
        helperSideModel: desiredHelperSideModel,
      });
    }

    const pending = this.sessions.get(process.sessionId)?.pendingLaunchSettings;
    if (
      modelChanges.length > 0 ||
      permissionChanged ||
      pending?.processId === process.id
    ) {
      await this.persistProcessLaunchSettings(process);
    }
    return process;
  }
}
