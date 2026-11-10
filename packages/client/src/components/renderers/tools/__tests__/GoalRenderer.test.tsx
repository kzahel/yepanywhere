// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SchemaValidationProvider } from "../../../../contexts/SchemaValidationContext";
import { ToastProvider } from "../../../../contexts/ToastContext";
import { I18nProvider } from "../../../../i18n";
import { ToolCallRow } from "../../../blocks/ToolCallRow";

function renderGoalRow(
  props: Omit<React.ComponentProps<typeof ToolCallRow>, "id">,
) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <SchemaValidationProvider>
          <ToolCallRow id="goal-call" sessionProvider="codex" {...props} />
        </SchemaValidationProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

afterEach(() => cleanup());

describe("GoalRenderer", () => {
  it("renders a created goal as readable objective and budget progress", () => {
    const { container } = renderGoalRow({
      toolName: "create_goal",
      toolInput: {
        objective:
          "Ship the goal renderer, then verify every lifecycle state on desktop and mobile.",
        token_budget: 5000,
      },
      toolResult: {
        content: "ignored compact JSON",
        isError: false,
        structured: {
          goal: {
            threadId: "thread-secret-noise",
            objective:
              "Ship the goal renderer, then verify every lifecycle state on desktop and mobile.",
            status: "active",
            tokenBudget: 5000,
            tokensUsed: 1250,
            timeUsedSeconds: 95,
            createdAt: 1,
            updatedAt: 2,
          },
          remainingTokens: 3750,
          completionBudgetReport: "model-only instruction",
        },
      },
      status: "complete",
    });

    expect(screen.getByText("Created goal")).toBeTruthy();
    expect(screen.getByText("Objective")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("1,250 / 5,000 tokens")).toBeTruthy();
    expect(screen.getByText("3,750 remaining")).toBeTruthy();
    expect(screen.getByText("1m 35s elapsed")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", {
        name: "Token budget usage: 1,250 of 5,000",
      }),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("thread-secret-noise");
    expect(container.textContent).not.toContain("model-only instruction");
    expect(container.querySelector("[data-tool-fallback]")).toBeNull();
  });

  it("renders get_goal with no current goal as an explicit empty state", () => {
    renderGoalRow({
      toolName: "get_goal",
      toolInput: {},
      toolResult: {
        content: '{"goal":null}',
        structured: { goal: null, remainingTokens: null },
        isError: false,
      },
      status: "complete",
    });

    expect(screen.getByText("Checked goal")).toBeTruthy();
    expect(screen.getByText("No goal is set for this thread.")).toBeTruthy();
  });

  it("renders snake-case update_goal results and blocked lifecycle state", () => {
    renderGoalRow({
      toolName: "update_goal",
      toolInput: { status: "blocked" },
      toolResult: {
        content: "",
        structured: {
          goal: {
            objective: "Wait for the unavailable external dependency.",
            status: "blocked",
            token_budget: 2000,
            tokens_used: 850,
            time_used_seconds: 3600,
          },
          remaining_tokens: 1150,
        },
        isError: false,
      },
      status: "complete",
    });

    expect(screen.getByText("Goal blocked")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("850 / 2,000 tokens")).toBeTruthy();
    expect(screen.getByText("1h 0m elapsed")).toBeTruthy();
  });

  it("states the pending update operation without raw input JSON", () => {
    const { container } = renderGoalRow({
      toolName: "update_goal",
      toolInput: { status: "complete" },
      status: "pending",
    });

    expect(screen.getByText("Completing goal")).toBeTruthy();
    expect(
      screen.getByText("Marking the current goal complete..."),
    ).toBeTruthy();
    expect(container.querySelector("[data-tool-fallback]")).toBeNull();
  });

  it("shows provider failures as wrapped error text", () => {
    renderGoalRow({
      toolName: "create_goal",
      toolInput: { objective: "A second unfinished goal" },
      toolResult: {
        content:
          "cannot create a new goal because this thread has an unfinished goal",
        isError: true,
      },
      status: "error",
    });

    expect(screen.getByText("Goal operation failed")).toBeTruthy();
    expect(
      screen.getByText(
        "cannot create a new goal because this thread has an unfinished goal",
      ),
    ).toBeTruthy();
  });

  it("does not label a failed update as successfully completed", () => {
    renderGoalRow({
      toolName: "update_goal",
      toolInput: { status: "complete" },
      toolResult: {
        content: "the goal is no longer active",
        isError: true,
      },
      status: "error",
    });

    expect(screen.getByText("Complete goal")).toBeTruthy();
    expect(screen.queryByText("Updated goal")).toBeNull();
    expect(screen.getByText("Goal operation failed")).toBeTruthy();
  });
});
