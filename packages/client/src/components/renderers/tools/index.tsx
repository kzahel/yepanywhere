import type { ReactNode } from "react";
import { canonicalizeToolName } from "../../../lib/toolNames";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";
import type { RenderContext } from "../types";
import type { DisplayRecord, CheckedToolDefinition } from "./defineTool";
import { defineTool } from "./defineTool";
import { z } from "zod";
// Import and register tool renderers
import { askUserQuestionRenderer } from "./AskUserQuestionRenderer";
import { bashOutputRenderer } from "./BashOutputRenderer";
import { bashRenderer } from "./BashRenderer";
import { codeModeExecRenderer } from "./CodeModeExecRenderer";
import { editRenderer } from "./EditRenderer";
import { exitPlanModeRenderer } from "./ExitPlanModeRenderer";
import { globRenderer } from "./GlobRenderer";
import {
  createGoalToolRenderer,
  getGoalToolRenderer,
  updateGoalToolRenderer,
} from "./GoalRenderer";
import { grepRenderer } from "./GrepRenderer";
import { killShellRenderer } from "./KillShellRenderer";
import { readRenderer } from "./ReadRenderer";
import { spawnAgentRenderer } from "./SpawnAgentRenderer";
import { taskOutputRenderer } from "./TaskOutputRenderer";
import { taskCreateRenderer, taskUpdateRenderer } from "./TaskListRenderer";
import { taskRenderer } from "./TaskRenderer";
import { todoWriteRenderer } from "./TodoWriteRenderer";
import { updatePlanRenderer } from "./UpdatePlanRenderer";
import { viewImageRenderer } from "./ViewImageRenderer";
import { webFetchRenderer } from "./WebFetchRenderer";
import { webRenderer } from "./WebRenderer";
import { webSearchRenderer } from "./WebSearchRenderer";
import { writeRenderer } from "./WriteRenderer";
import { writeStdinRenderer } from "./WriteStdinRenderer";

import type { ToolDisplayName } from "./toolDisplayContracts";
const registeredTools = {
  Bash: bashRenderer,
  Read: readRenderer,
  Edit: editRenderer,
  Write: writeRenderer,
  Glob: globRenderer,
  Grep: grepRenderer,
  TodoWrite: todoWriteRenderer,
  TaskCreate: taskCreateRenderer,
  TaskUpdate: taskUpdateRenderer,
  Task: taskRenderer,
  WebSearch: webSearchRenderer,
  WebFetch: webFetchRenderer,
  Web: webRenderer,
  AskUserQuestion: askUserQuestionRenderer,
  ExitPlanMode: exitPlanModeRenderer,
  UpdatePlan: updatePlanRenderer,
  WriteStdin: writeStdinRenderer,
  create_goal: createGoalToolRenderer,
  get_goal: getGoalToolRenderer,
  update_goal: updateGoalToolRenderer,
  ViewImage: viewImageRenderer,
  spawn_agent: spawnAgentRenderer,
  Exec: codeModeExecRenderer,
  BashOutput: bashOutputRenderer,
  TaskOutput: taskOutputRenderer,
  KillShell: killShellRenderer,
} satisfies {
  [K in ToolDisplayName]: CheckedToolDefinition & { readonly tool: K };
};
export const toolDefinitions = Object.values(registeredTools);
export type RegisteredToolName = keyof typeof registeredTools;
const definitions = new Map<string, CheckedToolDefinition>(
  toolDefinitions.map((definition) => [definition.tool, definition]),
);
// Generic tools are data inspection infrastructure, never specialized callbacks.
const fallback = defineTool(
  {
    input: z.never(),
    result: z.never(),
    variants: ["unknown"],
    standaloneResult: false,
  },
  {
    tool: "__fallback__",
    renderToolUse: () => null,
    renderToolResult: () => null,
  },
);
function getDefinition(name: string) {
  return definitions.get(canonicalizeToolName(name));
}
export const toolRegistry = {
  metadata(toolName: string) {
    const definition = getDefinition(toolName);
    return {
      registered: !!definition,
      tool: definition?.tool ?? toolName,
      operations: definition?.operations ?? [],
    };
  },
  prepare(toolName: string, record: DisplayRecord) {
    const definition = getDefinition(toolName);
    const prepared = (definition ?? fallback).prepare({ ...record, toolName });
    return definition
      ? prepared
      : { ...prepared, getDisplayName: () => toolName };
  },
  hasInteractiveSummary(name: string) {
    return (
      getDefinition(name)?.operations.includes("renderInteractiveSummary") ??
      false
    );
  },
  hasCollapsedPreview(name: string) {
    return (
      getDefinition(name)?.operations.includes("renderCollapsedPreview") ??
      false
    );
  },
  hasInlineRenderer(name: string) {
    return getDefinition(name)?.operations.includes("renderInline") ?? false;
  },
  getDisplayName(
    name: string,
    status: ToolCallItem["status"] = "complete",
    input?: unknown,
  ) {
    return (
      getDefinition(name)?.prepare({ input, status }).getDisplayName() ?? name
    );
  },
  renderToolUse(
    name: string,
    input: unknown,
    context: RenderContext,
  ): ReactNode {
    return this.prepare(name, { input, status: "pending" }).renderToolUse(
      context,
    );
  },
  renderToolResult(
    name: string,
    result: unknown,
    isError: boolean,
    context: RenderContext,
    input?: unknown,
  ): ReactNode {
    return this.prepare(name, {
      input,
      result,
      isError,
      status: isError ? "error" : "complete",
    }).renderToolResult(context);
  },
  renderCollapsedPreview(
    name: string,
    input: unknown,
    result: unknown,
    isError: boolean,
    context: RenderContext,
  ): ReactNode {
    return this.prepare(name, {
      input,
      result,
      isError,
      status: isError ? "error" : result === undefined ? "pending" : "complete",
    }).renderCollapsedPreview(context);
  },
  renderInteractiveSummary(
    name: string,
    input: unknown,
    result: unknown,
    isError: boolean,
    context: RenderContext,
  ): ReactNode {
    return this.prepare(name, {
      input,
      result,
      isError,
      status: isError ? "error" : result === undefined ? "pending" : "complete",
    }).renderInteractiveSummary(context);
  },
  renderInline(
    name: string,
    input: unknown,
    result: unknown,
    isError: boolean,
    status: ToolCallItem["status"],
    context: RenderContext,
  ): ReactNode {
    return this.prepare(name, { input, result, isError, status }).renderInline(
      context,
    );
  },
};
