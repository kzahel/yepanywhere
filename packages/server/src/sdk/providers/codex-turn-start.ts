/**
 * Starting a Codex turn for one queued user message: prompt assembly,
 * permission and cyber access resolution, the per-message effort, the
 * turn-start window, and the retries that rerun the turn without resending
 * its input.
 */

import {
  type CodexCyberAccessProgram,
  codexCyberAccessProgramWireValue,
  formatMcpAppModelContext,
  hasInvocationCandidate,
  type ModelInfo,
  resolveTurnEffort,
  thinkingOptionToConfig,
  type ThinkingOption,
} from "@yep-anywhere/shared";
import type { QueuedSDKUserMessage } from "../messageQueue.js";
import type { SDKMessage, UserMessage } from "../types.js";
import type { CodexAppServerClient } from "./codex-app-server-client.js";
import {
  logSdkCorrelationDebug,
  withCodexTimestamp,
} from "./codex-item-conversion.js";
import { log } from "./codex-log.js";
import type { AppServerModel } from "./codex-model-catalog.js";
import type { TurnStartResponse } from "./codex-protocol/index.js";
import type { CyberAccessProgram } from "./codex-protocol/generated/v2/CyberAccessProgram.js";
import {
  type CodexConfigSource,
  createTurnStartParams,
  mapEffortToReasoningEffort,
} from "./codex-session-config.js";
import {
  ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
  type CodexSessionSkillInventory,
  type CodexTurnRuntimeState,
  MODEL_LIST_TIMEOUT_MS,
  withCodexTimeout,
} from "./codex-session-state.js";
import { createCodexUserInputs } from "./codex-skill-inputs.js";
import {
  mapPermissionModeToThreadPolicy,
  normalizePermissionMode,
} from "./codex-thread-params.js";
import {
  type CodexTurnContext,
  consumeCodexTurn,
  prepareCodexOverloadRetry,
} from "./codex-turn-consumer.js";
import type { StartSessionOptions } from "./types.js";

/**
 * Provider services a turn start uses. Each is called when needed, so a
 * setting changed between turns takes effect on the next one.
 */
export interface CodexTurnStartHost {
  readonly configSource: CodexConfigSource;
  getAvailableModels(): Promise<ModelInfo[]>;
  refreshCodexSkills(
    appServer: CodexAppServerClient,
    cwd: string,
    inventory: CodexSessionSkillInventory,
    forceReload: boolean,
  ): Promise<void>;
  /** The cyber access program setting, read for every turn. */
  cyberAccessProgram(): CodexCyberAccessProgram;
  /**
   * Account, model and program scopes whose program request was refused.
   * Shared by every session of the provider.
   */
  readonly cyberAccessDenials: Set<string>;
}

/** What a turn start needs beyond what the turn consumer needs. */
export interface CodexTurnStartContext extends CodexTurnContext {
  readonly host: CodexTurnStartHost;
  readonly skillInventory: CodexSessionSkillInventory;
  /** The thread's reasoning effort as Codex reported it at thread start. */
  readonly threadReasoningEffort: string | null | undefined;
}

/** Prompt prefixes that only the first user message of a session carries. */
export interface CodexPromptState {
  isFirstMessage: boolean;
  readonly globalContext: string | undefined;
}

/**
 * Run one queued user message as a turn: yield the user message, start the
 * turn, consume it, and retry a cyber access denial or an overload without
 * resending the input.
 */
export async function* startCodexUserTurn(
  context: CodexTurnStartContext,
  message: QueuedSDKUserMessage,
  prompt: CodexPromptState,
): AsyncGenerator<SDKMessage, void, void> {
  const {
    appServer,
    options,
    signal,
    sessionId,
    runtimeState,
    failureTrace,
    host,
    skillInventory,
    threadReasoningEffort,
  } = context;
  let userPrompt = extractTextFromMessage(message);
  if (!userPrompt) {
    return;
  }

  // Prepend global instructions to the first message of new sessions
  if (prompt.isFirstMessage && prompt.globalContext) {
    userPrompt = `[Global context]\n${prompt.globalContext}\n\n---\n\n${userPrompt}`;
    prompt.isFirstMessage = false;
  } else {
    prompt.isFirstMessage = false;
  }

  if (hasInvocationCandidate(userPrompt)) {
    await host.refreshCodexSkills(appServer, options.cwd, skillInventory, true);
  }
  const preparedInput = createCodexUserInputs(
    userPrompt,
    skillInventory.skills,
    skillInventory.stale ? "stale" : "current",
  );
  userPrompt = preparedInput.text;

  // Emit user message with UUID from queue to enable deduplication.
  const userMessage = withCodexTimestamp({
    type: "user",
    uuid: message.uuid,
    session_id: sessionId,
    message: {
      role: "user",
      content: userPrompt,
    },
  } as SDKMessage);
  logSdkCorrelationDebug(sessionId, userMessage, {
    eventKind: "user_message",
    phase: "submitted",
    sourceEvent: "queued_input",
  });
  failureTrace.lastUserMessage = {
    uuid: message.uuid,
    chars: userPrompt.length,
  };
  yield userMessage;

  const turnPermissionMode = normalizePermissionMode(
    getPermissionModeFromMessage(message) ?? options.permissionMode,
  );
  const turnPolicy = mapPermissionModeToThreadPolicy(turnPermissionMode);
  runtimeState.activePermissionMode = turnPermissionMode;
  const cyberAccess = await resolveTurnCyberAccess(
    host,
    appServer,
    runtimeState,
    sessionId,
    runtimeState.turnModelOverride ?? runtimeState.resolvedModel,
  );
  const turnStartParams = createTurnStartParams(
    host.configSource,
    sessionId,
    preparedInput.input,
    options,
    turnPolicy,
    runtimeState.workspaceWriteSandboxPolicy,
    runtimeState.turnModelOverride,
    runtimeState.turnEffortOverride,
    message.uuid,
    cyberAccess.program,
    runtimeState.serviceTier,
  );
  let restoreThreadEffort: (() => Promise<unknown>) | undefined;
  if (message.turnEffort) {
    const modelId =
      runtimeState.turnModelOverride ?? runtimeState.resolvedModel;
    const model = (
      options.routerLaunch
        ? (options.routerLaunch.models ?? [])
        : await host.getAvailableModels()
    ).find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`No effort catalog for model ${modelId}`);
    const normal: ThinkingOption =
      options.thinking?.type === "disabled"
        ? "off"
        : runtimeState.turnEffortOverride
          ? `on:${runtimeState.turnEffortOverride}`
          : "auto";
    const selected = thinkingOptionToConfig(
      resolveTurnEffort(message.turnEffort, normal, model),
    );
    const baseline =
      turnStartParams.effort ??
      model.defaultReasoningEffort ??
      threadReasoningEffort;
    if (!baseline)
      throw new Error("Cannot restore the model's unknown normal effort");
    turnStartParams.effort = mapEffortToReasoningEffort(
      host.configSource,
      selected.effort,
      selected.thinking,
      modelId,
      options.routerLaunch?.models,
    );
    runtimeState.activeTurnHasEffortOverride = true;
    restoreThreadEffort = () =>
      appServer.request("thread/settings/update", {
        threadId: sessionId,
        effort:
          mapEffortToReasoningEffort(
            host.configSource,
            runtimeState.turnEffortOverride ?? undefined,
            options.thinking,
            modelId,
            options.routerLaunch?.models,
          ) ??
          model.defaultReasoningEffort ??
          threadReasoningEffort ??
          baseline,
      });
  }
  await flushMcpAppModelContext(appServer, runtimeState, sessionId);
  let notificationBarrierSequence = appServer.lastNotificationReceiptSequence;
  let settlePendingTurnStart: (turnId: string | null) => void = () => {};
  const pendingTurnStart = new Promise<string | null>((resolve) => {
    settlePendingTurnStart = resolve;
  });
  runtimeState.pendingTurnStart = pendingTurnStart;
  let turnResult: TurnStartResponse;
  try {
    turnResult = await appServer.request<TurnStartResponse>(
      "turn/start",
      turnStartParams,
    );
    runtimeState.activeTurnId = turnResult.turn.id;
    if (message.uuid) options.onNativeInputConsumed?.(sessionId, message.uuid);
    await restoreThreadEffort?.();
    settlePendingTurnStart(turnResult.turn.id);
  } catch (error) {
    settlePendingTurnStart(null);
    throw error;
  } finally {
    if (runtimeState.pendingTurnStart === pendingTurnStart) {
      runtimeState.pendingTurnStart = null;
    }
  }
  options.onPermissionModeApplied?.(turnPermissionMode);

  log.info(
    {
      sessionId,
      turnId: turnResult.turn.id,
      turnStatus: turnResult.turn.status,
      permissionMode: turnPermissionMode,
      approvalPolicy: turnPolicy.approvalPolicy,
      sandboxPolicy: turnStartParams.sandboxPolicy,
    },
    "Started Codex app-server turn",
  );
  let overloadRetryAttempt = 0;
  let cyberAccessProgram = cyberAccess.program;
  while (!signal.aborted) {
    const { retryableError } = yield* consumeCodexTurn(
      context,
      turnResult.turn,
      notificationBarrierSequence,
      cyberAccessProgram !== null,
    );
    if (!retryableError) break;

    if (retryableError.kind === "cyberAccessDenied") {
      // The refusal happens before any model output, so the turn
      // reruns at once without the program. Later turns for this
      // account and model omit it from the start.
      if (cyberAccess.scope) {
        host.cyberAccessDenials.add(cyberAccess.scope);
      }
      cyberAccessProgram = null;
      yield {
        ...retryableError.message,
        codexWillRetry: true,
        codexCyberAccessRetry: true,
      } as SDKMessage;
      log.info(
        {
          sessionId,
          turnId: retryableError.message.codexTurnId,
          model: runtimeState.turnModelOverride ?? runtimeState.resolvedModel,
          cyberAccessProgram: cyberAccess.program,
        },
        "Codex account is not authorized for the cyber access program; retrying without it",
      );
    } else {
      overloadRetryAttempt += 1;
      const retryReady = yield* prepareCodexOverloadRetry(
        context,
        retryableError.message,
        overloadRetryAttempt,
      );
      if (!retryReady) {
        yield {
          type: "result",
          session_id: sessionId,
        } as SDKMessage;
        break;
      }
    }

    const retryTurnStartParams = createTurnStartParams(
      host.configSource,
      sessionId,
      [],
      options,
      turnPolicy,
      runtimeState.workspaceWriteSandboxPolicy,
      runtimeState.turnModelOverride,
      runtimeState.turnEffortOverride,
      undefined,
      cyberAccessProgram,
      runtimeState.serviceTier,
    );
    if (message.turnEffort)
      retryTurnStartParams.effort = turnStartParams.effort;
    notificationBarrierSequence = appServer.lastNotificationReceiptSequence;
    turnResult = await appServer.request<TurnStartResponse>(
      "turn/start",
      retryTurnStartParams,
    );
    await restoreThreadEffort?.();
    log.info(
      {
        sessionId,
        turnId: turnResult.turn.id,
        turnStatus: turnResult.turn.status,
        model: retryTurnStartParams.model ?? runtimeState.resolvedModel,
        retryAttempt: overloadRetryAttempt,
        approvalPolicy: turnPolicy.approvalPolicy,
        sandboxPolicy: retryTurnStartParams.sandboxPolicy,
      },
      "Retried failed Codex turn without resending user input",
    );
  }
  runtimeState.activeTurnHasEffortOverride = false;
}

/**
 * Deliver each MCP App view's latest model context as hidden history ahead
 * of the user turn it informs. A failed insertion is logged and the context
 * stays held for the next turn.
 */
async function flushMcpAppModelContext(
  appServer: CodexAppServerClient,
  runtimeState: CodexTurnRuntimeState,
  threadId: string,
): Promise<void> {
  if (runtimeState.mcpAppModelContext.size === 0) return;
  const held = [...runtimeState.mcpAppModelContext.values()];
  try {
    await appServer.request("thread/inject_items", {
      threadId,
      items: held.map(({ server, tool, text }) => ({
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: formatMcpAppModelContext(server, tool, text),
          },
        ],
      })),
    });
    runtimeState.mcpAppModelContext.clear();
  } catch (error) {
    log.warn(
      {
        event: "codex_mcp_app_context_inject_failed",
        threadId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Could not deliver MCP App model context before the turn",
    );
  }
}

/**
 * Codex resolves the access program per turn and forgets it afterward, so
 * every user turn carries the current selection. Omitting the field keeps
 * Codex's automatic choice, which is what the default does. YA-internal
 * helper turns such as the recap thread never send it.
 *
 * Enrollment belongs to the ChatGPT account and model, not to YA's
 * server-wide setting, so a selection the backend already refused for this
 * account and model is omitted rather than failing every turn. `scope` is
 * null when no program is configured; it names the denial to record if the
 * backend refuses the requested one.
 */
async function resolveTurnCyberAccess(
  host: CodexTurnStartHost,
  appServer: CodexAppServerClient,
  runtimeState: CodexTurnRuntimeState,
  sessionId: string,
  model: string | null,
): Promise<{ program: CyberAccessProgram | null; scope: string | null }> {
  const program = codexCyberAccessProgramWireValue(host.cyberAccessProgram());
  if (!program) return { program: null, scope: null };
  if (model) {
    let cursor: string | null | undefined;
    do {
      const page = await withCodexTimeout(
        appServer.request<{
          data: AppServerModel[];
          nextCursor?: string | null;
        }>("model/list", { limit: 100, includeHidden: true, cursor }),
        MODEL_LIST_TIMEOUT_MS,
        "Codex model access programs",
      );
      const entry = page.data.find(
        (entry) => (entry.model || entry.id) === model,
      );
      if (entry) {
        const programs = entry.availableAccessPrograms?.cyber;
        if (programs?.length && !programs.includes(program)) {
          return { program: null, scope: null };
        }
        break;
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  runtimeState.cyberAccessAccountKey ??= await readCyberAccessAccountKey(
    appServer,
    sessionId,
  );
  const scope = JSON.stringify([
    runtimeState.cyberAccessAccountKey,
    model,
    program,
  ]);
  return {
    program: host.cyberAccessDenials.has(scope) ? null : program,
    scope,
  };
}

/**
 * Identify the signed-in account for cyber access denials. An account
 * switch replaces the app-server process, so one read per session suffices.
 * When the account cannot be read, a denial stays confined to this session.
 */
async function readCyberAccessAccountKey(
  appServer: CodexAppServerClient,
  sessionId: string,
): Promise<string> {
  try {
    const response = await withCodexTimeout(
      appServer.request<unknown>("account/read", { refreshToken: false }),
      ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
      "Codex account status",
    );
    const account =
      response && typeof response === "object"
        ? (response as { account?: { type?: unknown; email?: unknown } })
            .account
        : undefined;
    if (typeof account?.type === "string") {
      return typeof account.email === "string" && account.email
        ? `${account.type}:${account.email}`
        : account.type;
    }
  } catch (error) {
    log.warn(
      { sessionId, error },
      "Could not read Codex account for cyber access program scoping",
    );
  }
  return `session:${sessionId}`;
}

function getPermissionModeFromMessage(
  message: unknown,
): StartSessionOptions["permissionMode"] | undefined {
  if (!message || typeof message !== "object") return undefined;
  const mode = (message as { mode?: unknown }).mode;
  switch (mode) {
    case "default":
    case "acceptEdits":
    case "plan":
    case "bypassPermissions":
    case "auto":
      return mode;
    default:
      return undefined;
  }
}

/**
 * Extract text content from a user message.
 */
export function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  // Handle UserMessage format
  const userMsg = message as UserMessage;
  if (typeof userMsg.text === "string") {
    return userMsg.text;
  }

  // Handle SDK message format
  const sdkMsg = message as {
    message?: { content?: string | unknown[] };
  };
  const content = sdkMsg.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === "string") return block;
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          (block as { type: string }).type === "text" &&
          "text" in block
        ) {
          return (block as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}
