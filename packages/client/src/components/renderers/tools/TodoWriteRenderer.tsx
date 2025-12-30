import type {
  Todo,
  TodoWriteInput,
  TodoWriteResult,
  ToolRenderer,
} from "./types";

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
  const statusClass = `todo-status-${todo.status}`;
  const isCompleted = todo.status === "completed";

  return (
    <div className={`todo-item ${statusClass}`}>
      <span className="todo-checkbox">{getStatusIcon(todo.status)}</span>
      <span className={`todo-content ${isCompleted ? "todo-completed" : ""}`}>
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
    return <div className="todo-empty">No todos specified</div>;
  }

  const inProgress = input.todos.filter((t) => t.status === "in_progress");
  const pending = input.todos.filter((t) => t.status === "pending");
  const completed = input.todos.filter((t) => t.status === "completed");

  return (
    <div className="todo-tool-use">
      <span className="todo-summary">
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
function TodoWriteToolResult({
  result,
  isError,
}: {
  result: TodoWriteResult;
  isError: boolean;
}) {
  if (isError) {
    const errorResult = result as unknown as { content?: unknown } | undefined;
    return (
      <div className="todo-error">
        {typeof result === "object" && errorResult?.content
          ? String(errorResult.content)
          : "Failed to update todos"}
      </div>
    );
  }

  if (!result?.newTodos || result.newTodos.length === 0) {
    return <div className="todo-empty">No todos</div>;
  }

  return (
    <div className="todo-result">
      <div className="todo-list">
        {result.newTodos.map((todo, index) => (
          <TodoItem key={`${todo.content}-${index}`} todo={todo} />
        ))}
      </div>
    </div>
  );
}

export const todoWriteRenderer: ToolRenderer<TodoWriteInput, TodoWriteResult> =
  {
    tool: "TodoWrite",
    displayName: "Update Todos",

    renderToolUse(input, _context) {
      return <TodoWriteToolUse input={input as TodoWriteInput} />;
    },

    renderToolResult(result, isError, _context) {
      return (
        <TodoWriteToolResult
          result={result as TodoWriteResult}
          isError={isError}
        />
      );
    },

    getUseSummary(input) {
      const todos = (input as TodoWriteInput).todos;
      return todos ? `${todos.length} items` : "Todos";
    },

    getResultSummary(result, isError) {
      if (isError) return "Error";
      const r = result as TodoWriteResult;
      return r?.newTodos ? `${r.newTodos.length} items` : "Todos";
    },
  };
