import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import { Badge } from "../../ui/Badge";
import styles from "./AskUserQuestionRenderer.module.css";
import type {
  AskUserQuestionInput,
  AskUserQuestionResult,
  Question,
} from "./types";

/**
 * Single question display
 */
function QuestionDisplay({
  question,
  selectedAnswer,
}: {
  question: Omit<Question, "multiSelect"> & { multiSelect?: boolean };
  selectedAnswer?: string | string[];
}) {
  const selectedAnswers = Array.isArray(selectedAnswer)
    ? selectedAnswer
    : selectedAnswer
      ? [selectedAnswer]
      : [];
  const optionLabels = new Set(question.options.map((opt) => opt.label));
  const customAnswers = selectedAnswers.filter(
    (answer) => !optionLabels.has(answer),
  );

  return (
    <div className={styles.item}>
      <div className={styles.header}>
        <Badge size="small">{question.header}</Badge>
        <span className={styles.text}>{question.question}</span>
      </div>
      <ul className={styles.options}>
        {question.options.map((option) => {
          const isSelected = selectedAnswers.includes(option.label);
          return (
            <li
              key={option.label}
              className={`${styles.option} ${isSelected ? styles.optionSelected : ""}`}
            >
              <span className={styles.optionIndicator}>
                {question.multiSelect
                  ? isSelected
                    ? "☑"
                    : "☐"
                  : isSelected
                    ? "●"
                    : "○"}
              </span>
              <div className={styles.optionContent}>
                <span className={styles.optionLabel}>{option.label}</span>
                {option.description && (
                  <span className={styles.optionDesc}>
                    {option.description}
                  </span>
                )}
              </div>
            </li>
          );
        })}
        {customAnswers.map((answer) => (
          <li
            key={`other-${answer}`}
            className={`${styles.option} ${styles.optionSelected}`}
          >
            <span className={styles.optionIndicator}>
              {question.multiSelect ? "☑" : "●"}
            </span>
            <div className={styles.optionContent}>
              <span className={styles.optionLabel}>Other</span>
              <span className={styles.optionDesc}>{answer}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * AskUserQuestion tool use - shows questions to be asked
 */
function AskUserQuestionToolUse({ input }: { input: AskUserQuestionInput }) {
  return (
    <div className={styles.toolUse}>
      {input.questions.map((q, i) => (
        <QuestionDisplay key={`${q.header}-${i}`} question={q} />
      ))}
    </div>
  );
}

/**
 * AskUserQuestion tool result - shows questions with selected answers
 */
function AskUserQuestionToolResult({
  result,
}: {
  result: AskUserQuestionResult;
}) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("AskUserQuestion", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("AskUserQuestion", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("AskUserQuestion");

  if (!result?.questions) {
    return (
      <div className={styles.empty}>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="AskUserQuestion" errors={validationErrors} />
        )}
        No questions
      </div>
    );
  }

  return (
    <div className={styles.result}>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="AskUserQuestion" errors={validationErrors} />
      )}
      {result.questions.map((q, i) => {
        // Find the answer by matching the question text
        const answer = result.answers?.[q.question];
        return (
          <QuestionDisplay
            key={`${q.header}-${i}`}
            question={q}
            selectedAnswer={answer}
          />
        );
      })}
    </div>
  );
}

export const askUserQuestionRenderer = defineTool(
  toolDisplayContracts.AskUserQuestion,
  {
    tool: "AskUserQuestion",
    displayName: "Asked",
    pendingDisplayName: "Asking",

    renderToolUse(input, _context) {
      return <AskUserQuestionToolUse input={input} />;
    },

    renderToolResult(result, _isError, _context) {
      return <AskUserQuestionToolResult result={result} />;
    },

    renderFailure(failure) {
      return (
        <div className={styles.error}>
          {failure.content || "Question failed"}
        </div>
      );
    },

    getFailureSummary() {
      return "Error";
    },

    getUseSummary(input) {
      const questions = input.questions;
      return `${questions?.length || 0} question${questions?.length === 1 ? "" : "s"}`;
    },

    getResultSummary(result): string {
      const answered = Object.keys(result?.answers || {}).length;
      const questionCount = result?.questions?.length || 0;
      // If no answers yet but we have questions, show question count instead
      if (answered === 0 && questionCount > 0) {
        return `${questionCount} question${questionCount === 1 ? "" : "s"}`;
      }
      return `${answered} answered`;
    },
  },
);
