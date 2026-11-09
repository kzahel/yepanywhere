/**
 * The Codex provider commands: `/goal`, `/status`, `/usage` and `/compact`,
 * run against a live session.
 */

import type { ProviderCommandResult } from "../types.js";
import {
  formatCodexStatusCommand,
  formatCodexUsageCommand,
  isCodexChatGptAccount,
  parseCodexUsageView,
} from "./codex-account-commands.js";
import type { CodexAppServerClient } from "./codex-app-server-client.js";
import { log } from "./codex-log.js";
import type {
  ThreadCompactStartParams,
  ThreadCompactStartResponse,
  ThreadGoalClearParams,
  ThreadGoalClearResponse,
  ThreadGoalGetParams,
  ThreadGoalGetResponse,
  ThreadGoalSetParams,
  ThreadGoalSetResponse,
} from "./codex-protocol/index.js";
import {
  ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
  type CodexTurnRuntimeState,
  withCodexTimeout,
} from "./codex-session-state.js";
import type { StartSessionOptions } from "./types.js";

/** The parts of a Codex session that the provider commands read. */
export interface CodexCommandSession {
  readonly options: StartSessionOptions;
  readonly runtimeState: CodexTurnRuntimeState;
  /** The client for requests: null until the thread is ready. */
  readonly activeClient: CodexAppServerClient | null;
  /** The client once the thread is ready, or null if the session ends first. */
  readonly initialActiveClient: Promise<CodexAppServerClient | null>;
}

function formatCodexGoalStatus(
  status: ThreadGoalSetResponse["goal"]["status"],
): string {
  switch (status) {
    case "usageLimited":
      return "Goal usage limited";
    case "budgetLimited":
      return "Goal budget limited";
    default:
      return `Goal ${status}`;
  }
}

/**
 * `/goal`, `/goal clear|pause|resume|edit` and `/goal <objective>`. The
 * session runs these one at a time.
 */
export async function runCodexGoalCommand(
  session: CodexCommandSession,
  argument: string | undefined,
): Promise<ProviderCommandResult> {
  const client = session.activeClient ?? (await session.initialActiveClient);
  const threadId = session.runtimeState.threadId;
  if (!client || !threadId) {
    return {
      handled: true,
      error: "Codex session is not ready for goal commands yet",
    };
  }

  const goalArgument = argument?.trim() ?? "";
  const goalControl = goalArgument.toLowerCase();
  try {
    if (!goalArgument) {
      const response = await client.request<ThreadGoalGetResponse>(
        "thread/goal/get",
        { threadId } satisfies ThreadGoalGetParams,
      );
      return {
        handled: true,
        output: response.goal
          ? {
              summary: "/goal",
              details: [
                response.goal.objective,
                formatCodexGoalStatus(response.goal.status),
                `${response.goal.tokensUsed.toLocaleString()} tokens used`,
              ],
            }
          : { summary: "/goal", details: ["No goal set"] },
      };
    }

    // Every mutation below is a user-typed /goal. Codex 0.161+
    // records only `origin: "user"` edits in model history as user
    // instructions; older app-servers ignore the field.
    if (goalControl === "clear") {
      const response = await client.request<ThreadGoalClearResponse>(
        "thread/goal/clear",
        {
          threadId,
          origin: "user",
        } satisfies ThreadGoalClearParams,
      );
      return {
        handled: true,
        output: {
          summary: "/goal",
          details: [response.cleared ? "Goal cleared" : "No goal to clear"],
        },
      };
    }

    if (goalControl === "pause" || goalControl === "resume") {
      const requestedStatus = goalControl === "pause" ? "paused" : "active";
      const response = await client.request<ThreadGoalSetResponse>(
        "thread/goal/set",
        {
          threadId,
          status: requestedStatus,
          origin: "user",
        } satisfies ThreadGoalSetParams,
      );
      return {
        handled: true,
        output: {
          summary: "/goal",
          details: [
            response.goal.objective,
            response.goal.status === requestedStatus
              ? goalControl === "pause"
                ? "Goal paused"
                : "Goal resumed"
              : formatCodexGoalStatus(response.goal.status),
          ],
        },
      };
    }

    if (goalControl === "edit") {
      return {
        handled: true,
        error:
          "Interactive /goal edit is unavailable in YA. Set the revised objective with /goal <objective>.",
      };
    }

    const current = await client.request<ThreadGoalGetResponse>(
      "thread/goal/get",
      { threadId } satisfies ThreadGoalGetParams,
    );
    if (current.goal?.objective === goalArgument) {
      return {
        handled: true,
        output: {
          summary: "/goal",
          details: [
            current.goal.objective,
            formatCodexGoalStatus(current.goal.status),
          ],
        },
      };
    }
    if (current.goal) {
      await client.request<ThreadGoalClearResponse>("thread/goal/clear", {
        threadId,
        origin: "user",
      } satisfies ThreadGoalClearParams);
    }
    const response = await client.request<ThreadGoalSetResponse>(
      "thread/goal/set",
      {
        threadId,
        objective: goalArgument,
        status: "active",
        origin: "user",
      } satisfies ThreadGoalSetParams,
    );
    return {
      handled: true,
      output: {
        summary: "/goal",
        details: [response.goal.objective, "Goal set"],
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      { threadId, argument: goalArgument, error: message },
      "Codex goal command failed",
    );
    return { handled: true, error: message };
  }
}

export async function runCodexAccountCommand(
  session: CodexCommandSession,
  name: "status" | "usage",
  argument: string | undefined,
): Promise<ProviderCommandResult> {
  if (session.options.routerLaunch)
    return {
      handled: true,
      output: {
        summary: "Account usage is available in the router account controls.",
      },
    };
  const client = session.activeClient ?? (await session.initialActiveClient);
  if (!client) {
    return {
      handled: true,
      output: {
        summary: `/${name}`,
        details: ["Codex session is not ready yet"],
      },
    };
  }

  if (name === "status") {
    const [accountResult, rateLimitsResult] = await Promise.allSettled([
      withCodexTimeout(
        client.request<unknown>("account/read", {
          refreshToken: false,
        }),
        ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
        "Codex account status",
      ),
      withCodexTimeout(
        client.request<unknown>("account/rateLimits/read"),
        ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
        "Codex account rate limits",
      ),
    ]);
    return {
      handled: true,
      output: formatCodexStatusCommand({
        model: session.runtimeState.resolvedModel,
        cwd: session.options.cwd,
        permissionMode: session.runtimeState.activePermissionMode,
        threadId: session.runtimeState.threadId,
        tokenUsage: session.runtimeState.latestTokenUsage,
        accountResponse:
          accountResult.status === "fulfilled"
            ? accountResult.value
            : undefined,
        rateLimitsResponse:
          rateLimitsResult.status === "fulfilled"
            ? rateLimitsResult.value
            : undefined,
      }),
    };
  }

  const view = parseCodexUsageView(argument);
  if (!view) {
    return {
      handled: true,
      output: {
        summary: "Usage: /usage [daily|weekly|cumulative]",
      },
    };
  }
  try {
    const account = await withCodexTimeout(
      client.request<unknown>("account/read", {
        refreshToken: false,
      }),
      ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
      "Codex account status",
    );
    if (!isCodexChatGptAccount(account)) {
      return {
        handled: true,
        output: {
          summary: "Sign in with ChatGPT to use /usage.",
        },
      };
    }
    const usage = await withCodexTimeout(
      client.request<unknown>("account/usage/read"),
      ACCOUNT_RATE_LIMITS_TIMEOUT_MS,
      "Codex account token usage",
    );
    return {
      handled: true,
      output: formatCodexUsageCommand(usage, view),
    };
  } catch (error) {
    log.debug(
      { error, threadId: session.runtimeState.threadId },
      "Codex account token usage is unavailable",
    );
    return {
      handled: true,
      output: { summary: "Token activity unavailable" },
    };
  }
}

export async function startCodexCompaction(
  session: CodexCommandSession,
): Promise<ProviderCommandResult> {
  if (!session.activeClient || !session.runtimeState.threadId) {
    return {
      handled: true,
      error: "Codex session is not ready for compaction yet",
    };
  }
  // A compact runs as its own (non-steerable) turn; refuse mid-turn so we
  // do not collide with active work or send `/compact` as plain text.
  if (
    session.runtimeState.activeTurnId ||
    session.runtimeState.pendingTurnStart ||
    session.runtimeState.pendingCompaction ||
    session.runtimeState.overloadRetryController
  ) {
    return {
      handled: true,
      error: "Cannot compact while a turn is in progress",
    };
  }
  const request = session.activeClient.request<ThreadCompactStartResponse>(
    "thread/compact/start",
    {
      threadId: session.runtimeState.threadId,
    } satisfies ThreadCompactStartParams,
  );
  session.runtimeState.pendingCompaction = {
    retryAttempt: 0,
    // The command reports RPC failures; queued input only needs to know
    // whether a compaction turn will follow the request.
    requestAccepted: request.then(
      () => true,
      () => false,
    ),
  };
  try {
    await request;
    return {
      handled: true,
      output: { summary: "Compaction requested" },
    };
  } catch (error) {
    session.runtimeState.pendingCompaction = undefined;
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      { threadId: session.runtimeState.threadId, error: message },
      "Codex thread/compact/start failed",
    );
    // The pinned compact RPC has no effects on a JSON-RPC refusal.
    // A broken transport can lose an accepted reply; never call that a refusal.
    const definitive =
      typeof (error as { jsonRpcCode?: unknown })?.jsonRpcCode === "number";
    return {
      handled: true,
      error: message,
      ...(!definitive ? { uncertain: true as const } : {}),
    };
  }
}
