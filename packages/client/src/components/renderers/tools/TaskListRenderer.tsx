import todoStyles from "./TodoWriteRenderer.module.css";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";

type TaskListSnapshot = NonNullable<
  import("zod").z.output<
    typeof toolDisplayContracts.TaskCreate.input
  >["_taskSnapshot"]
>;
type TaskListStatus = TaskListSnapshot["tasks"][number]["status"];
type TaskListSnapshotItem = TaskListSnapshot["tasks"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(input: unknown, field: string): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const value = input[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type TaskListInput = import("zod").z.output<
  typeof toolDisplayContracts.TaskCreate.input
>;
type TaskListResult = import("zod").z.output<
  typeof toolDisplayContracts.TaskCreate.result
>;
function extractSnapshot(
  value: TaskListInput | TaskListResult | undefined,
): TaskListSnapshot | undefined {
  return typeof value === "object" && value !== null
    ? value._taskSnapshot
    : undefined;
}

function taskId(input: unknown): string | undefined {
  return (
    stringField(input, "taskId") ??
    stringField(input, "task_id") ??
    stringField(input, "id")
  );
}

function normalizeStatus(status: unknown): TaskListStatus {
  if (typeof status !== "string") {
    return "unknown";
  }
  const normalized = status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "completed" || normalized === "complete") {
    return "completed";
  }
  if (normalized === "in_progress" || normalized === "running") {
    return "in_progress";
  }
  if (normalized === "pending" || normalized === "todo") {
    return "pending";
  }
  if (normalized === "failed" || normalized === "error") {
    return "failed";
  }
  if (normalized === "cancelled" || normalized === "canceled") {
    return "cancelled";
  }
  return "unknown";
}

function statusIcon(status: TaskListStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    case "failed":
      return "!";
    case "cancelled":
      return "×";
    default:
      return "○";
  }
}

function statusClassName(status: TaskListStatus): string {
  return status === "in_progress"
    ? (todoStyles.todoStatusInProgress ?? "")
    : ((
        {
          pending: todoStyles.todoStatusPending,
          completed: todoStyles.todoStatusCompleted,
        } as Record<string, string>
      )[status] ?? "");
}

function taskLabel(task: TaskListSnapshotItem): string {
  if (task.subject?.trim()) {
    return task.subject.trim();
  }
  return task.id ? `Task #${task.id}` : "Task";
}

function completedCount(tasks: TaskListSnapshotItem[]): number {
  return tasks.filter((task) => normalizeStatus(task.status) === "completed")
    .length;
}

function TaskSnapshotView({ snapshot }: { snapshot: TaskListSnapshot }) {
  const tasks = snapshot.tasks;
  const done = completedCount(tasks);

  return (
    <div className={todoStyles.todoResult} data-todo-result>
      <div className={todoStyles.todoSummary} data-todo-summary>
        {done} out of {tasks.length} tasks completed
      </div>
      <div className={todoStyles.todoList} data-todo-list>
        {tasks.map((task) => {
          const status = normalizeStatus(task.status);
          const isCompleted = status === "completed";
          const display = taskLabel(task);
          return (
            <div
              key={task.id || display}
              className={`${todoStyles.todoItem} ${statusClassName(status)}`}
              data-todo-item
              data-todo-status={
                status === "in_progress" ? "in-progress" : status
              }
            >
              <span className={todoStyles.todoCheckbox} data-todo-checkbox>
                {statusIcon(status)}
              </span>
              <span
                className={`${todoStyles.todoContent} ${isCompleted ? todoStyles.todoCompleted : ""}`}
                data-todo-content
                data-todo-completed={isCompleted || undefined}
              >
                {display}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function eventMessage(toolName: "TaskCreate" | "TaskUpdate", input: unknown) {
  if (toolName === "TaskCreate") {
    return stringField(input, "subject") ?? "Task created";
  }

  const id = taskId(input);
  const status = normalizeStatus(stringField(input, "status"));
  const statusText =
    status === "unknown" ? "updated" : status.replace("_", " ");
  return id ? `Task #${id} ${statusText}` : `Task ${statusText}`;
}

function resultMessage(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result.trim() || undefined;
  }
  if (!isRecord(result)) {
    return undefined;
  }
  const content = result.content;
  return typeof content === "string" && content.trim()
    ? content.trim()
    : undefined;
}

function renderTaskEvent(
  toolName: "TaskCreate" | "TaskUpdate",
  input: TaskListInput | undefined,
  result: TaskListResult | undefined,
  isError: boolean,
) {
  const snapshot = extractSnapshot(result) ?? extractSnapshot(input);
  if (!isError && snapshot && snapshot.tasks.length > 0) {
    return <TaskSnapshotView snapshot={snapshot} />;
  }

  if (isError) {
    return (
      <div className={todoStyles.todoError} data-todo-error>
        {resultMessage(result) ?? "Task update failed"}
      </div>
    );
  }

  return (
    <div className={todoStyles.todoSummary} data-todo-summary>
      {eventMessage(toolName, input)}
    </div>
  );
}

function taskSummary(
  toolName: "TaskCreate" | "TaskUpdate",
  input: TaskListInput | undefined,
  result?: TaskListResult,
): string {
  const snapshot = extractSnapshot(result) ?? extractSnapshot(input);
  if (snapshot?.tasks.length) {
    return `${completedCount(snapshot.tasks)}/${snapshot.tasks.length} complete`;
  }
  return eventMessage(toolName, input);
}

export const taskCreateRenderer = defineTool(toolDisplayContracts.TaskCreate, {
  tool: "TaskCreate",
  displayName: "Create task",

  renderToolUse(input) {
    return (
      <div className={todoStyles.todoSummary} data-todo-summary>
        {eventMessage("TaskCreate", input)}
      </div>
    );
  },

  renderToolResult(result, isError, _context, input) {
    return renderTaskEvent("TaskCreate", input, result, isError);
  },

  renderInline(input, result, isError) {
    return renderTaskEvent("TaskCreate", input, result, isError);
  },

  getUseSummary(input) {
    return taskSummary("TaskCreate", input);
  },

  getResultSummary(result, isError, input) {
    return isError ? "Error" : taskSummary("TaskCreate", input, result);
  },
});

export const taskUpdateRenderer = defineTool(toolDisplayContracts.TaskUpdate, {
  tool: "TaskUpdate",
  displayName: "Update task",

  renderToolUse(input) {
    return (
      <div className={todoStyles.todoSummary} data-todo-summary>
        {eventMessage("TaskUpdate", input)}
      </div>
    );
  },

  renderToolResult(result, isError, _context, input) {
    return renderTaskEvent("TaskUpdate", input, result, isError);
  },

  renderInline(input, result, isError) {
    return renderTaskEvent("TaskUpdate", input, result, isError);
  },

  getUseSummary(input) {
    return taskSummary("TaskUpdate", input);
  },

  getResultSummary(result, isError, input) {
    return isError ? "Error" : taskSummary("TaskUpdate", input, result);
  },
});
