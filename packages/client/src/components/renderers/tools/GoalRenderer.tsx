import { useI18n } from "../../../i18n";
import type { RenderContext } from "../types";
import { Badge, type BadgeTone } from "../../ui/Badge";
import styles from "./GoalRenderer.module.css";
import { defineTool } from "./defineTool";
import { toolDisplayContracts } from "./toolDisplayContracts";

type GoalOperation = "create" | "get" | "update";

type KnownGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

interface GoalSnapshot {
  objective: string;
  status: KnownGoalStatus | string;
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

interface ParsedGoalResponse {
  goal?: GoalSnapshot | null;
  remainingTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readString(
  record: Record<string, unknown>,
  ...fields: string[]
): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(
  record: Record<string, unknown>,
  ...fields: string[]
): number | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeGoalStatus(value: string | undefined): string {
  if (!value) {
    return "active";
  }
  switch (
    value
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "")
  ) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "usagelimited":
      return "usageLimited";
    case "budgetlimited":
      return "budgetLimited";
    case "complete":
    case "completed":
      return "complete";
    default:
      return value;
  }
}

function parseGoalSnapshot(value: unknown): GoalSnapshot | undefined {
  const parsed = parseJsonValue(value);
  if (!isRecord(parsed)) {
    return undefined;
  }
  const objective = readString(parsed, "objective");
  if (!objective) {
    return undefined;
  }
  return {
    objective,
    status: normalizeGoalStatus(readString(parsed, "status")),
    tokenBudget: readNumber(parsed, "tokenBudget", "token_budget"),
    tokensUsed: readNumber(parsed, "tokensUsed", "tokens_used"),
    timeUsedSeconds: readNumber(parsed, "timeUsedSeconds", "time_used_seconds"),
  };
}

function parseGoalResponse(value: unknown): ParsedGoalResponse {
  const parsed = parseJsonValue(value);
  if (!isRecord(parsed)) {
    return {};
  }

  const hasGoalEnvelope = Object.hasOwn(parsed, "goal");
  const rawGoal = hasGoalEnvelope ? parsed.goal : parsed;
  return {
    goal: rawGoal === null ? null : parseGoalSnapshot(rawGoal),
    remainingTokens: readNumber(parsed, "remainingTokens", "remaining_tokens"),
  };
}

function goalFromCreateInput(input: unknown): GoalSnapshot | undefined {
  const parsed = parseJsonValue(input);
  if (!isRecord(parsed)) {
    return undefined;
  }
  const objective = readString(parsed, "objective");
  if (!objective) {
    return undefined;
  }
  return {
    objective,
    status: "active",
    tokenBudget: readNumber(parsed, "tokenBudget", "token_budget"),
    tokensUsed: 0,
    timeUsedSeconds: 0,
  };
}

function requestedUpdateStatus(input: unknown): KnownGoalStatus | undefined {
  const parsed = parseJsonValue(input);
  if (!isRecord(parsed)) {
    return undefined;
  }
  const status = normalizeGoalStatus(readString(parsed, "status"));
  return status === "complete" || status === "blocked" ? status : undefined;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function goalSummary(
  operation: GoalOperation,
  input: unknown,
  result?: unknown,
): string {
  const response = parseGoalResponse(result);
  if (response.goal?.objective) {
    return singleLine(response.goal.objective);
  }
  if (response.goal === null) {
    return "No goal set";
  }
  if (operation === "create") {
    const pendingGoal = goalFromCreateInput(input);
    if (pendingGoal) {
      return singleLine(pendingGoal.objective);
    }
  }
  if (operation === "update") {
    return requestedUpdateStatus(input) ?? "current goal";
  }
  return "current goal";
}

function displayNameForCall(
  operation: GoalOperation,
  input: unknown,
  callStatus: "pending" | "complete" | "error" | "aborted" | "incomplete",
): string {
  if (operation === "create") {
    if (callStatus === "pending") return "Creating goal";
    if (callStatus === "complete") return "Created goal";
    return "Create goal";
  }
  if (operation === "get") {
    if (callStatus === "pending") return "Checking goal";
    if (callStatus === "complete") return "Checked goal";
    return "Check goal";
  }

  const requestedStatus = requestedUpdateStatus(input);
  if (callStatus !== "pending" && callStatus !== "complete") {
    if (requestedStatus === "complete") return "Complete goal";
    if (requestedStatus === "blocked") return "Block goal";
    return "Update goal";
  }
  if (requestedStatus === "complete") {
    if (callStatus === "pending") return "Completing goal";
    if (callStatus === "complete") return "Goal complete";
  }
  if (requestedStatus === "blocked") {
    if (callStatus === "pending") return "Blocking goal";
    if (callStatus === "complete") return "Goal blocked";
  }
  return callStatus === "pending" ? "Updating goal" : "Updated goal";
}

function errorMessage(result: unknown): string | undefined {
  const parsed = parseJsonValue(result);
  if (typeof parsed === "string") {
    return parsed.trim() || undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const direct = readString(parsed, "message", "error", "content");
  if (direct) {
    return direct;
  }
  return isRecord(parsed.error)
    ? readString(parsed.error, "message", "detail")
    : undefined;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function statusClassName(status: string): string {
  switch (status) {
    case "active":
      return styles.statusActive ?? "";
    case "paused":
      return styles.statusPaused ?? "";
    case "blocked":
      return styles.statusBlocked ?? "";
    case "usageLimited":
    case "budgetLimited":
      return styles.statusLimited ?? "";
    case "complete":
      return styles.statusComplete ?? "";
    default:
      return styles.statusUnknown ?? "";
  }
}

function statusTone(status: string): BadgeTone {
  switch (status) {
    case "active":
      return "info";
    case "paused":
    case "usageLimited":
    case "budgetLimited":
      return "warning";
    case "blocked":
      return "danger";
    case "complete":
      return "success";
    default:
      return "neutral";
  }
}

function GoalPreview({
  operation,
  input,
  result,
  isError,
  context,
}: {
  operation: GoalOperation;
  input: unknown;
  result?: unknown;
  isError: boolean;
  context: RenderContext;
}) {
  const { locale, t } = useI18n();
  const parsed = parseGoalResponse(result);
  const goal =
    parsed.goal ??
    (operation === "create" ? goalFromCreateInput(input) : undefined);
  const numberFormat = new Intl.NumberFormat(locale);

  const statusLabel = (status: string): string => {
    switch (status) {
      case "active":
        return t("goalRendererStatusActive");
      case "paused":
        return t("goalRendererStatusPaused");
      case "blocked":
        return t("goalRendererStatusBlocked");
      case "usageLimited":
        return t("goalRendererStatusUsageLimited");
      case "budgetLimited":
        return t("goalRendererStatusBudgetLimited");
      case "complete":
        return t("goalRendererStatusComplete");
      default:
        return status.replace(/([a-z])([A-Z])/g, "$1 $2");
    }
  };

  if (isError) {
    return (
      <div className={`${styles.card} ${styles.error}`} data-goal-card="error">
        <strong>{t("goalRendererFailed")}</strong>
        <span className={styles.errorMessage}>
          {errorMessage(result) ?? t("goalRendererFailedFallback")}
        </span>
      </div>
    );
  }

  if (!goal) {
    const pendingStatus = requestedUpdateStatus(input);
    const message = context.isStreaming
      ? operation === "get"
        ? t("goalRendererChecking")
        : pendingStatus === "complete"
          ? t("goalRendererCompleting")
          : pendingStatus === "blocked"
            ? t("goalRendererBlocking")
            : t("goalRendererUpdating")
      : parsed.goal === null
        ? t("goalRendererNone")
        : t("goalRendererDetailsUnavailable");
    return (
      <div className={styles.empty} data-goal-card="empty">
        {message}
      </div>
    );
  }

  const tokensUsed = goal.tokensUsed;
  const tokenBudget = goal.tokenBudget;
  const remainingTokens =
    parsed.remainingTokens ??
    (tokenBudget !== undefined && tokensUsed !== undefined
      ? Math.max(0, tokenBudget - tokensUsed)
      : undefined);
  const hasBudget = tokenBudget !== undefined && tokenBudget > 0;
  const progressValue = hasBudget
    ? Math.min(tokenBudget, Math.max(0, tokensUsed ?? 0))
    : undefined;

  return (
    <section
      className={`${styles.card} ${statusClassName(goal.status)}`}
      aria-label={t("goalRendererCardLabel")}
      data-goal-card="goal"
      data-goal-status={goal.status}
    >
      <div className={styles.topline}>
        <span className={styles.objectiveLabel}>
          {t("goalRendererObjectiveLabel")}
        </span>
        <Badge
          tone={statusTone(goal.status)}
          size="small"
          className={styles.statusBadge}
        >
          {statusLabel(goal.status)}
        </Badge>
      </div>
      <p className={styles.objective}>{goal.objective}</p>

      {(tokensUsed !== undefined || (goal.timeUsedSeconds ?? 0) > 0) && (
        <div className={styles.metrics}>
          {tokensUsed !== undefined && (
            <span className={styles.metric}>
              {hasBudget
                ? t("goalRendererTokenBudget", {
                    used: numberFormat.format(tokensUsed),
                    budget: numberFormat.format(tokenBudget),
                  })
                : t("goalRendererTokensUsed", {
                    count: numberFormat.format(tokensUsed),
                  })}
            </span>
          )}
          {remainingTokens !== undefined && (
            <span className={styles.metricSecondary}>
              {t("goalRendererTokensRemaining", {
                count: numberFormat.format(remainingTokens),
              })}
            </span>
          )}
          {(goal.timeUsedSeconds ?? 0) > 0 && (
            <span className={styles.metricSecondary}>
              {t("goalRendererElapsed", {
                duration: formatDuration(goal.timeUsedSeconds ?? 0),
              })}
            </span>
          )}
        </div>
      )}

      {hasBudget && progressValue !== undefined && (
        <progress
          className={styles.progress}
          value={progressValue}
          max={tokenBudget}
          aria-label={t("goalRendererTokenProgressLabel", {
            used: numberFormat.format(tokensUsed ?? 0),
            budget: numberFormat.format(tokenBudget),
          })}
        />
      )}
    </section>
  );
}

function createGoalRenderer<
  const T extends "create_goal" | "get_goal" | "update_goal",
>(tool: T, operation: GoalOperation) {
  return defineTool(toolDisplayContracts[tool], {
    tool,
    displayName: "Goal",
    displayNameForCall(input, status) {
      return displayNameForCall(operation, input, status);
    },
    renderToolUse(input, context) {
      return (
        <GoalPreview
          operation={operation}
          input={input}
          isError={false}
          context={context}
        />
      );
    },
    renderToolResult(result, isError, context, input) {
      return (
        <GoalPreview
          operation={operation}
          input={input}
          result={result}
          isError={isError}
          context={context}
        />
      );
    },
    renderCollapsedPreview(input, result, isError, context) {
      return (
        <GoalPreview
          operation={operation}
          input={input}
          result={result}
          isError={isError}
          context={context}
        />
      );
    },
    getUseSummary(input) {
      return goalSummary(operation, input);
    },
    getResultSummary(result, isError, input) {
      return isError ? "failed" : goalSummary(operation, input, result);
    },
  });
}

export const createGoalToolRenderer = createGoalRenderer(
  "create_goal",
  "create",
);
export const getGoalToolRenderer = createGoalRenderer("get_goal", "get");
export const updateGoalToolRenderer = createGoalRenderer(
  "update_goal",
  "update",
);
