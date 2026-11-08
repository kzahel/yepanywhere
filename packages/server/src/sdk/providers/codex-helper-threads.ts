import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./codex-log.js";
import type {
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ToolRequestUserInputResponse,
  TurnStartParams,
  TurnStartResponse,
} from "./codex-protocol/index.js";
import {
  asCodexErrorNotification,
  asCodexTurnCompletedNotification,
} from "./codex-notification-guards.js";
import {
  asToolRequestUserInputParams,
  createDeclinedPermissionResponse,
} from "./codex-approvals.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import type { CodexProviderHost } from "./codex-provider-host.js";
import {
  captureCodexSummaryTextFromNotification,
  captureCodexSummaryTextFromTurnItems,
  cleanCodexRecapText,
  cleanCodexSummaryText,
  CODEX_RECAP_TIMEOUT_MS,
  CODEX_SUMMARY_TIMEOUT_MS,
  createCodexForkSummaryPrompt,
  createCodexForkSummaryThreadResumeParams,
  createCodexRecapPrompt,
  joinCodexSummaryText,
  resolveCodexRecapHelperModel,
} from "./codex-summary-helpers.js";
import {
  assertProviderForkSource,
  type SummaryGenerationRequest,
  type SummaryGenerationResult,
} from "./types.js";
import { normalizeThreadItem } from "./codex-item-conversion.js";
import type { JsonRpcServerRequest } from "./codex-json-rpc.js";

export async function generateSideSessionRecap(
  host: CodexProviderHost,
  recentAssistantText: string[],
  requestedModel?: string,
): Promise<string> {
  const userPrompt = createCodexRecapPrompt(recentAssistantText);
  const model = await resolveCodexRecapHelperModel(requestedModel, () =>
    host.getAvailableModels(),
  );
  const codexCommand = await host.resolveCodexCommand();
  const abortController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, CODEX_RECAP_TIMEOUT_MS);
  timeout.unref?.();

  const appServer = new CodexAppServerClient(
    codexCommand,
    homedir(),
    host.getCodexEnv(),
  );
  appServer.setServerRequestHandler(async (request) =>
    handleRecapServerRequest(request),
  );

  try {
    await appServer.connect();
    await host.initializeAppServer(appServer);
    appServer.notify("initialized");

    const threadResult = await appServer.request<ThreadStartResponse>(
      "thread/start",
      {
        model,
        cwd: homedir(),
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        ephemeral: true,
        experimentalRawEvents: false,
        developerInstructions:
          "You are a recap helper. Reply with the recap text only, no preamble. Do not call tools.",
      } satisfies ThreadStartParams,
    );

    const turnResult = await appServer.request<TurnStartResponse>(
      "turn/start",
      {
        threadId: threadResult.thread.id,
        model,
        input: [{ type: "text", text: userPrompt, text_elements: [] }],
        effort: "low",
        summary: "auto",
      } satisfies TurnStartParams,
    );

    const textByItemId = new Map<string, string>();
    captureCodexSummaryTextFromTurnItems(
      turnResult.turn.items,
      textByItemId,
      normalizeThreadItem,
    );

    if (turnResult.turn.status === "failed") {
      throw new Error(
        turnResult.turn.error?.message ?? "Codex recap generation failed",
      );
    }

    let turnComplete = turnResult.turn.status !== "inProgress";
    while (!turnComplete && !abortController.signal.aborted) {
      const notification = await appServer.nextNotification(
        abortController.signal,
      );
      captureCodexSummaryTextFromNotification(
        notification,
        textByItemId,
        normalizeThreadItem,
      );

      if (notification.method !== "turn/completed") {
        continue;
      }
      const completed = asCodexTurnCompletedNotification(notification.params);
      if (completed?.turn.status === "failed") {
        throw new Error(
          completed.turn.error?.message ?? "Codex recap generation failed",
        );
      }
      turnComplete = true;
    }
    if (abortController.signal.aborted) {
      throw new Error("Timed out generating Codex recap");
    }

    const cleaned = cleanCodexRecapText(joinCodexSummaryText(textByItemId));
    if (!cleaned) {
      throw new Error("Recap generation returned empty text");
    }
    return cleaned;
  } catch (error) {
    if (timedOut) {
      throw new Error("Timed out generating Codex recap");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    abortController.abort();
    await appServer.close();
  }
}

export async function generateForkBackedSummary(
  host: CodexProviderHost,
  request: Extract<SummaryGenerationRequest, { strategy: "fork" }>,
): Promise<SummaryGenerationResult> {
  assertProviderForkSource(
    {
      nativeSessionId: request.generatorSessionId,
      nativeSource: request.nativeSource,
    },
    host.name,
  );
  const summaryEnv = host.getCodexEnv();
  if (request.nativeSource) {
    const launchRoot =
      request.sessionSandbox?.transcriptDir ??
      join(summaryEnv.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
    if (
      (await realpath(launchRoot).catch(() => undefined)) !==
      request.nativeSource.native.storageScope
    )
      throw new Error(
        "Codex summary source is outside the launch transcript store; scoped resume is not qualified",
      );
  }
  if (request.signal?.aborted)
    throw new DOMException("Summary generation cancelled", "AbortError");
  const userPrompt = createCodexForkSummaryPrompt(request);
  const codexCommand = await host.resolveCodexCommand();
  const appServer = new CodexAppServerClient(
    codexCommand,
    request.cwd,
    summaryEnv,
    undefined,
    request.sessionSandbox,
  );
  const abortController = new AbortController();
  let timedOut = false;
  const abortFromRequest = () => {
    abortController.abort();
    void appServer.close();
  };
  if (request.signal?.aborted) {
    abortController.abort();
  } else {
    request.signal?.addEventListener("abort", abortFromRequest, {
      once: true,
    });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
    void appServer.close();
  }, CODEX_SUMMARY_TIMEOUT_MS);
  timeout.unref?.();

  appServer.setServerRequestHandler((serverRequest) =>
    handleNonTurnServerRequest(serverRequest, "summary helper"),
  );

  try {
    if (abortController.signal.aborted) {
      throw new DOMException("Summary generation cancelled", "AbortError");
    }
    await appServer.connect();
    const experimentalApiEnabled = await host.initializeAppServer(appServer);
    appServer.notify("initialized");

    if (request.nativeSource && !experimentalApiEnabled)
      throw new Error(
        "Codex summary source requires native rollout path support",
      );
    const threadResult = await appServer.request<ThreadResumeResponse>(
      "thread/resume",
      createCodexForkSummaryThreadResumeParams(request, experimentalApiEnabled),
    );
    if (
      request.nativeSource &&
      threadResult.thread.id !== request.generatorSessionId
    )
      throw new Error("Codex summary resumed a different native thread");
    const threadId = threadResult.thread.id || request.generatorSessionId;
    const turnResult = await appServer.request<TurnStartResponse>(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: userPrompt, text_elements: [] }],
        effort: "low",
        summary: "auto",
        approvalPolicy: "untrusted",
      } satisfies TurnStartParams,
    );

    const textByItemId = new Map<string, string>();
    captureCodexSummaryTextFromTurnItems(
      turnResult.turn.items,
      textByItemId,
      normalizeThreadItem,
    );

    if (turnResult.turn.status === "failed") {
      throw new Error(
        turnResult.turn.error?.message ?? "Codex summary generation failed",
      );
    }

    const turnId = turnResult.turn.id;
    let turnComplete = turnResult.turn.status !== "inProgress";
    while (!turnComplete && !abortController.signal.aborted) {
      const notification = await appServer.nextNotification(
        abortController.signal,
      );
      captureCodexSummaryTextFromNotification(
        notification,
        textByItemId,
        normalizeThreadItem,
      );

      if (notification.method === "turn/completed") {
        const completed = asCodexTurnCompletedNotification(notification.params);
        if (completed?.turn.id !== turnId) {
          continue;
        }
        captureCodexSummaryTextFromTurnItems(
          completed.turn.items,
          textByItemId,
          normalizeThreadItem,
        );
        if (completed.turn.status === "failed") {
          throw new Error(
            completed.turn.error?.message ?? "Codex summary generation failed",
          );
        }
        turnComplete = true;
        continue;
      }

      if (notification.method === "error") {
        const error = asCodexErrorNotification(notification.params);
        if (error?.turnId === turnId && !error.willRetry) {
          throw new Error(
            error.error.message ?? "Codex summary generation failed",
          );
        }
      }
    }
    if (abortController.signal.aborted) {
      if (request.signal?.aborted) {
        throw new DOMException("Summary generation cancelled", "AbortError");
      }
      throw new Error("Timed out generating Codex summary");
    }

    const cleaned = cleanCodexSummaryText(joinCodexSummaryText(textByItemId));
    if (!cleaned) {
      throw new Error("Summary generation returned empty text");
    }
    return { text: cleaned };
  } catch (error) {
    if (request.signal?.aborted) {
      throw new DOMException("Summary generation cancelled", "AbortError");
    }
    if (timedOut) {
      throw new Error("Timed out generating Codex summary");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abortFromRequest);
    abortController.abort();
    await appServer.close();
  }
}

function handleRecapServerRequest(
  request: JsonRpcServerRequest,
): Promise<unknown> {
  return handleNonTurnServerRequest(request, "recap helper");
}

export function handleForkServerRequest(
  request: JsonRpcServerRequest,
): Promise<unknown> {
  return handleNonTurnServerRequest(request, "fork");
}

function handleNonTurnServerRequest(
  request: JsonRpcServerRequest,
  purpose: string,
): Promise<unknown> {
  log.warn(
    { method: request.method, requestId: request.id, purpose },
    "Declining Codex non-turn server request",
  );

  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return Promise.resolve({ decision: "decline" });
    case "item/permissions/requestApproval":
      return Promise.resolve(createDeclinedPermissionResponse());
    case "item/tool/requestUserInput": {
      const requestInput = asToolRequestUserInputParams(request.params);
      const answers: ToolRequestUserInputResponse["answers"] = {};
      for (const question of requestInput?.questions ?? []) {
        answers[question.id] = { answers: [] };
      }
      return Promise.resolve({
        answers,
      } satisfies ToolRequestUserInputResponse);
    }
    default:
      return Promise.resolve({});
  }
}
