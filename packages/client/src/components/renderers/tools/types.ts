import type { ReactNode } from "react";
import type { ContentBlock, RenderContext } from "../types";

/**
 * Bash tool types
 */
export interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage: boolean;
  backgroundTaskId?: string;
}

/**
 * Read tool types
 */
export interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export interface ReadResult {
  type: "text" | "image";
  file: TextFile | ImageFile;
}

export interface TextFile {
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
}

export interface ImageFile {
  base64: string;
  type: string; // MIME type
  originalSize: number;
  dimensions: {
    originalWidth: number;
    originalHeight: number;
    displayWidth: number;
    displayHeight: number;
  };
}

/**
 * Edit tool types
 */
export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface EditResult {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;
  replaceAll: boolean;
  userModified: boolean;
  structuredPatch: PatchHunk[];
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // Prefixed with ' ', '-', or '+'
}

/**
 * Write tool types
 */
export interface WriteInput {
  file_path: string;
  content: string;
}

export interface WriteResult {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
}

/**
 * TodoWrite tool types
 */
export interface TodoWriteInput {
  todos: Todo[];
}

export interface TodoWriteResult {
  oldTodos: Todo[];
  newTodos: Todo[];
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

/**
 * Glob tool types
 */
export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GlobResult {
  filenames: string[];
  durationMs: number;
  numFiles: number;
  truncated: boolean;
}

/**
 * Grep tool types
 */
export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "files_with_matches" | "content" | "count";
}

export interface GrepResult {
  mode: "files_with_matches" | "content" | "count";
  filenames: string[];
  numFiles: number;
  content?: string;
  numLines?: number;
  appliedLimit?: number;
}

/**
 * Task tool types
 */
export interface TaskInput {
  description: string;
  prompt: string;
  subagent_type: string;
  model?: string;
}

export interface TaskResult {
  status: "completed" | "failed" | "timeout";
  prompt: string;
  agentId: string;
  content: ContentBlock[];
  totalDurationMs: number;
  totalTokens: number;
  totalToolUseCount: number;
}

/**
 * WebSearch tool types
 */
export interface WebSearchInput {
  query: string;
}

export interface WebSearchResult {
  query: string;
  results: Array<{ content: Array<{ title: string; url: string }> }>;
  durationSeconds: number;
}

/**
 * WebFetch tool types
 */
export interface WebFetchInput {
  url: string;
  prompt: string;
}

export interface WebFetchResult {
  bytes: number;
  code: number;
  codeText: string;
  result: string;
  durationMs: number;
  url: string;
}

/**
 * AskUserQuestion tool types
 */
export interface AskUserQuestionInput {
  questions: Question[];
}

export interface Question {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export interface AskUserQuestionResult {
  questions: Question[];
  answers: Record<string, string>;
}

/**
 * ExitPlanMode tool types
 */
export interface ExitPlanModeInput {
  plan?: string;
}

export interface ExitPlanModeResult {
  plan: string;
  isAgent: boolean;
  filePath: string;
}

/**
 * BashOutput tool types
 */
export interface BashOutputInput {
  bash_id: string;
  block?: boolean;
  wait_up_to?: number;
}

export interface BashOutputResult {
  shellId: string;
  command: string;
  status: "running" | "completed" | "failed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutLines: number;
  stderrLines: number;
  timestamp: string;
}

/**
 * TaskOutput tool types
 */
export interface TaskOutputInput {
  task_id: string;
  block?: boolean;
  timeout?: number;
}

export interface TaskOutputResult {
  retrieval_status: "completed" | "timeout" | "running";
  task: {
    task_id: string;
    task_type: "local_bash" | "agent";
    status: "running" | "completed" | "failed";
    description: string;
    output: string;
    exitCode: number | null;
  };
}

/**
 * KillShell tool types
 */
export interface KillShellInput {
  shell_id: string;
}

export interface KillShellResult {
  message: string;
  shell_id: string;
}

/**
 * Tool renderer interface
 */
export interface ToolRenderer<TInput = unknown, TResult = unknown> {
  /** Tool name (e.g., "Bash", "Edit", "Read") */
  tool: string;
  /** Display name shown in UI (defaults to tool name) */
  displayName?: string;
  /** Render the tool_use block (what Claude wants to do) */
  renderToolUse(input: TInput, context: RenderContext): ReactNode;
  /** Render the tool_result block (what happened) */
  renderToolResult(
    result: TResult,
    isError: boolean,
    context: RenderContext,
    input?: TInput,
  ): ReactNode;
  /** Summary for collapsed tool_use view */
  getUseSummary?(input: TInput): string;
  /** Summary for collapsed tool_result view */
  getResultSummary?(result: TResult, isError: boolean, input?: TInput): string;
  /**
   * Render an interactive summary that replaces the expand/collapse behavior.
   * When provided, the row won't expand - instead clicking invokes this component.
   */
  renderInteractiveSummary?(
    input: TInput,
    result: TResult | undefined,
    isError: boolean,
    context: RenderContext,
  ): ReactNode;
  /**
   * Render a preview shown in the collapsed state (below the header).
   * Used to show a condensed view of input/output without expanding.
   */
  renderCollapsedPreview?(
    input: TInput,
    result: TResult | undefined,
    isError: boolean,
    context: RenderContext,
  ): ReactNode;
}
