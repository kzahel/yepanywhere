import todoStyles from "./TodoWriteRenderer.module.css";
import { useI18n } from "../../../i18n";
import { CodeModeOutput } from "./CodeModeOutput";
import styles from "./UpdatePlanRenderer.module.css";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import type { UpdatePlanStep } from "./types";

type NormalizedPlanStatus = "pending" | "in_progress" | "completed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePlanStatus(status: unknown): NormalizedPlanStatus {
  if (typeof status !== "string") {
    return "pending";
  }

  const normalized = status.trim().toLowerCase();
  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "done"
  ) {
    return "completed";
  }
  if (
    normalized === "in_progress" ||
    normalized === "in-progress" ||
    normalized === "active" ||
    normalized === "running"
  ) {
    return "in_progress";
  }
  return "pending";
}

function getStatusIcon(status: NormalizedPlanStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    default:
      return "○";
  }
}

function statusClassName(status: NormalizedPlanStatus): string {
  return status === "in_progress"
    ? (todoStyles.todoStatusInProgress ?? "")
    : ((
        {
          pending: todoStyles.todoStatusPending,
          completed: todoStyles.todoStatusCompleted,
        } as Record<string, string>
      )[status] ?? "");
}

function extractPlanSteps(input: unknown): Array<{
  step: string;
  status: NormalizedPlanStatus;
}> {
  if (!isRecord(input) || !Array.isArray(input.plan)) {
    return [];
  }

  return input.plan
    .filter(
      (item): item is UpdatePlanStep =>
        isRecord(item) && typeof item.step === "string",
    )
    .map((item) => ({
      step: item.step,
      status: normalizePlanStatus(item.status),
    }));
}

function extractExplanation(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.explanation !== "string") {
    return undefined;
  }
  const explanation = input.explanation.trim();
  return explanation.length > 0 ? explanation : undefined;
}

function extractResultMessage(result: unknown): string | undefined {
  if (typeof result === "string") {
    const message = result.trim();
    return message.length > 0 ? message : undefined;
  }

  if (isRecord(result) && typeof result.message === "string") {
    const message = result.message.trim();
    return message.length > 0 ? message : undefined;
  }

  return undefined;
}

/** Code-mode acknowledgements may include unrelated sibling output. Keep it
 * available without expanding it over the input-side plan. */
function PlanOutput({
  result,
  isError,
}: {
  result: unknown;
  isError: boolean;
}) {
  const { t } = useI18n();
  return (
    <details className={styles.output}>
      <summary>{t("toolDisplay.output")}</summary>
      <CodeModeOutput result={result} isError={isError} />
    </details>
  );
}

export const updatePlanRenderer = defineTool(toolDisplayContracts.UpdatePlan, {
  tool: "UpdatePlan",
  displayName: "Update plan",

  renderToolUse() {
    return null;
  },

  renderToolResult(result, isError) {
    return (
      <div
        className={isError ? todoStyles.todoError : todoStyles.todoSummary}
        data-todo-error={isError || undefined}
        data-todo-summary={!isError || undefined}
      >
        {extractResultMessage(result)}
        {Array.isArray(result) && (
          <PlanOutput result={result} isError={isError} />
        )}
      </div>
    );
  },

  renderInline(input, result, isError, status) {
    const steps = extractPlanSteps(input);
    const explanation = extractExplanation(input);
    const resultMessage = extractResultMessage(result);

    if (isError) {
      return (
        <div className={todoStyles.todoError} data-todo-error>
          {resultMessage || "Failed to update plan"}
          {Array.isArray(result) && (
            <PlanOutput result={result} isError={isError} />
          )}
        </div>
      );
    }

    if (steps.length === 0) {
      if (status === "pending") {
        return (
          <div className={todoStyles.todoSummary} data-todo-summary>
            Updating plan...
          </div>
        );
      }
      return (
        <div className={todoStyles.todoSummary} data-todo-summary>
          {resultMessage || "Plan updated"}
          {Array.isArray(result) && (
            <PlanOutput result={result} isError={isError} />
          )}
        </div>
      );
    }

    const completed = steps.filter(
      (step) => step.status === "completed",
    ).length;

    return (
      <div className={todoStyles.todoResult} data-todo-result>
        <div className={todoStyles.todoSummary} data-todo-summary>
          {completed} out of {steps.length} tasks completed
        </div>
        {explanation && (
          <div className={todoStyles.todoSummary} data-todo-summary>
            {explanation}
          </div>
        )}
        <div className={todoStyles.todoList} data-todo-list>
          {steps.map((step, index) => (
            <div
              key={`${step.step}-${index}`}
              className={`${todoStyles.todoItem} ${statusClassName(step.status)}`}
              data-todo-item
              data-todo-status={
                step.status === "in_progress" ? "in-progress" : step.status
              }
            >
              <span className={todoStyles.todoCheckbox} data-todo-checkbox>
                {getStatusIcon(step.status)}
              </span>
              <span
                className={`${todoStyles.todoContent} ${step.status === "completed" ? todoStyles.todoCompleted : ""}`}
                data-todo-content
                data-todo-completed={step.status === "completed" || undefined}
              >
                {index + 1}. {step.step}
              </span>
            </div>
          ))}
        </div>
        {Array.isArray(result) && (
          <PlanOutput result={result} isError={isError} />
        )}
        {status !== "pending" &&
          resultMessage &&
          resultMessage.toLowerCase() !== "plan updated" && (
            <div className={todoStyles.todoSummary} data-todo-summary>
              {resultMessage}
            </div>
          )}
      </div>
    );
  },

  getUseSummary(input) {
    const steps = extractPlanSteps(input);
    if (steps.length === 0) {
      return "Update plan";
    }
    const completed = steps.filter(
      (step) => step.status === "completed",
    ).length;
    return `${completed}/${steps.length} complete`;
  },

  getResultSummary(result, isError) {
    if (isError) {
      return "Error";
    }
    return extractResultMessage(result) || "Plan updated";
  },
});
