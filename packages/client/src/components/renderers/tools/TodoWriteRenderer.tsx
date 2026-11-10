import styles from "./TodoWriteRenderer.module.css";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { useEffect, useState } from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { validateToolResult } from "../../../lib/validateToolResult";
import { SchemaWarning } from "../../SchemaWarning";
import type { Todo, TodoWriteInput, TodoWriteResult } from "./types";

/**
 * Get status icon for a todo item
 */
function getStatusIcon(status: Todo["status"]): string {
  switch (status) {
    case "pending":
      return "□";
    case "in_progress":
      return "❋";
    case "completed":
      return "✓";
    default:
      return "□";
  }
}

/**
 * Single todo item
 */
function TodoItem({ todo }: { todo: Todo }) {
  const statusClass =
    (
      {
        pending: styles.todoStatusPending,
        completed: styles.todoStatusCompleted,
      } as Record<string, string | undefined>
    )[todo.status] ?? "";
  const isCompleted = todo.status === "completed";

  return (
    <div
      className={`${styles.todoItem} ${statusClass}`}
      data-todo-item
      data-todo-status={todo.status}
    >
      <span className={styles.todoCheckbox} data-todo-checkbox>
        {getStatusIcon(todo.status)}
      </span>
      <span
        className={`${styles.todoContent} ${isCompleted ? styles.todoCompleted : ""}`}
        data-todo-content
        data-todo-completed={isCompleted || undefined}
      >
        {todo.content}
      </span>
    </div>
  );
}

/**
 * TodoWrite tool use - shows intended todo changes
 */
function TodoWriteToolUse({ input }: { input: TodoWriteInput }) {
  if (!input?.todos || input.todos.length === 0) {
    return (
      <div className={styles.todoEmpty} data-todo-empty>
        No todos specified
      </div>
    );
  }

  const inProgress = input.todos.filter((t) => t.status === "in_progress");
  const pending = input.todos.filter((t) => t.status === "pending");
  const completed = input.todos.filter((t) => t.status === "completed");

  return (
    <div className={styles.todoToolUse} data-todo-tool-use>
      <span className={styles.todoSummary} data-todo-summary>
        {inProgress.length > 0 && `${inProgress.length} in progress`}
        {inProgress.length > 0 &&
          (pending.length > 0 || completed.length > 0) &&
          ", "}
        {pending.length > 0 && `${pending.length} pending`}
        {pending.length > 0 && completed.length > 0 && ", "}
        {completed.length > 0 && `${completed.length} completed`}
      </span>
    </div>
  );
}

/**
 * TodoWrite tool result - shows the updated todo list
 */
function TodoWriteToolResult({ result }: { result: TodoWriteResult }) {
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("TodoWrite", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("TodoWrite", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("TodoWrite");

  if (!result?.newTodos || result.newTodos.length === 0) {
    return (
      <div className={styles.todoEmpty} data-todo-empty>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="TodoWrite" errors={validationErrors} />
        )}
        No todos
      </div>
    );
  }

  return (
    <div className={styles.todoResult} data-todo-result>
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="TodoWrite" errors={validationErrors} />
      )}
      <div className={styles.todoList} data-todo-list>
        {result.newTodos.map((todo, index) => (
          <TodoItem key={`${todo.content}-${index}`} todo={todo} />
        ))}
      </div>
    </div>
  );
}

export const todoWriteRenderer = defineTool(toolDisplayContracts.TodoWrite, {
  tool: "TodoWrite",
  displayName: "Update Todos",

  renderToolUse(input, _context) {
    return <TodoWriteToolUse input={input} />;
  },

  renderToolResult(result, _isError, _context) {
    return <TodoWriteToolResult result={result} />;
  },

  renderFailure(failure) {
    return (
      <div className={styles.todoError} data-todo-error>
        {failure.content || "Failed to update todos"}
      </div>
    );
  },

  getFailureSummary() {
    return "Error";
  },

  getUseSummary(input) {
    const todos = input.todos;
    return todos ? `${todos.length} items` : "Todos";
  },

  getResultSummary(result) {
    const r = result;
    return r?.newTodos ? `${r.newTodos.length} items` : "Todos";
  },
});
