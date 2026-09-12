import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type {
  CodexSessionEntry,
  UnifiedSession,
} from "../packages/shared/src/index.js";
import {
  parseCodexSessionEntry,
  toUrlProjectId,
} from "../packages/shared/src/index.js";
import { ClaudeTranscriptCache } from "../packages/server/src/sessions/claude-transcript-cache.js";
import {
  readCodexRolloutLineageEntries,
  resolveCodexRolloutLineage,
  readCodexSessionMeta,
} from "../packages/server/src/sessions/codex-rollout-lineage.js";
import { iterateJsonlLines } from "../packages/server/src/utils/jsonl.js";
import { normalizeSession } from "../packages/server/src/sessions/normalization.js";
import { augmentTaskListSnapshots } from "../packages/server/src/augments/task-list-augments.js";
import { augmentPersistedSessionMessages } from "../packages/server/src/sessions/persisted-augments.js";
import { compileTranscriptProjection } from "../packages/shared/src/transcript/compiler.js";
import type { Message } from "../packages/client/src/types.js";
import type { ToolCallItem } from "../packages/shared/src/transcript/items.js";
import { canonicalizeToolName } from "../packages/client/src/lib/toolNames.js";
import {
  prepareDisplay,
  type DisplayContract,
} from "../packages/client/src/components/renderers/tools/prepareDisplay.js";
import { toolDisplayContracts } from "../packages/client/src/components/renderers/tools/toolDisplayContracts.js";

export interface AuditFile {
  path: string;
  provider: "codex" | "claude";
  fileId: string;
}
export interface AuditRequest {
  file: AuditFile;
  rolloutPaths: Record<string, string>;
}
export interface AuditGroup {
  provider: string;
  version: string;
  tool: string;
  category:
    | "successful-raw"
    | "error-raw"
    | "unfinished-raw"
    | "projection-loss";
  reason: string;
  inputShape: string;
  resultShape: string;
  issues: string[];
  count: number;
  examples: { fileId: string; callId: string }[];
}
export interface AuditFileResult {
  fileId: string;
  provider: string;
  version: string;
  entries: number;
  malformedLines: number;
  changedDuringRead: boolean;
  referenceBacked: boolean;
  warnings: number;
  counts: Record<string, number>;
  groups: AuditGroup[];
}

export function auditId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

// Only schema vocabulary may leave this process. Arbitrary object keys, values,
// Zod messages, exception messages, tool names and paths can contain user data.
const fields = new Set(
  `type content text input output result file path file_path
filePath name id tool_use_id questions answers options label description header
multiSelect isOther isSecret prompt command cmd cell_id cellId session_id
linked_command linked_file_path linked_tool_name objective status token_budget
tokenBudget tokens_used tokensUsed time_used_seconds timeUsedSeconds goal error
message remainingTokens remaining_tokens stdout stderr exitCode exit_code
durationSeconds wall_time_seconds interrupted isImage backgroundTaskId calls
source image_url detail base64 dimensions originalSize originalWidth
originalHeight displayWidth displayHeight numLines startLine totalLines offset
limit pattern glob mode output_mode filenames numFiles durationMs truncated
matches lineNumber columnNumber ranges start end query results title url bytes
code codeText durationSeconds oldTodos newTodos todos activeForm plan step
explanation old_string new_string oldString newString originalFile replace_all
replaceAll userModified structuredPatch _structuredPatch _diffHtml _rawPatch
rawPatch patch changes oldStart oldLines newStart newLines lines retrieval_status
task task_id taskId task_type agentId agent_id nickname isAsync outputFile
totalDurationMs totalTokens totalToolUseCount thinking signature summary
_renderedHtml _renderedMarkdownHtml _highlightedContentHtml _highlightedLanguage
_highlightedTruncated _taskSnapshot version tasks subject currentTaskId
sourceToolUseId unresolvedTaskIds missingCreate pages ref wordLimit totalLines
contentType published redirectedUrl crawled search_query image_query open click
find ref_id lineno response_length q recency domains shell_id shellId bash_id
timestamp stdoutLines stderrLines`.split(/\s+/),
);
const types = new Set([
  "input_text",
  "input_image",
  "text",
  "image",
  "image_url",
  "tool_use",
  "tool_result",
  "pdf",
  "thinking",
]);

export function safeShape(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  if (depth >= 4) return Array.isArray(value) ? "array" : "object";
  if (Array.isArray(value)) {
    const shapes = [
      ...new Set(value.slice(0, 32).map((item) => safeShape(item, depth + 1))),
    ].sort();
    return `[${shapes.slice(0, 8).join("|")}${value.length > 32 ? "|…" : ""}]`;
  }
  const entries = Object.entries(value);
  const known = entries
    .filter(([key]) => fields.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const shape = known
    .slice(0, 24)
    .map(
      ([key, child]) =>
        `${key}:${key === "type" && typeof child === "string" && types.has(child) ? child : safeShape(child, depth + 1)}`,
    );
  if (known.length < entries.length || known.length > 24)
    shape.push("*:unknown");
  return `{${shape.join(",")}}`;
}

function safeIssues(
  issues: readonly {
    code: string;
    path: readonly PropertyKey[];
    errors?: unknown;
  }[],
): string[] {
  return [
    ...new Set(
      issues.flatMap((issue) => {
        if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
          return issue.errors.flatMap((errors) => safeIssues(errors));
        }
        return [
          `${issue.code}@${issue.path.map((part) => (typeof part === "number" ? "[]" : fields.has(String(part)) ? String(part) : "*")).join(".") || "$"}`,
        ];
      }),
    ),
  ]
    .sort()
    .slice(0, 16);
}

type Contract =
  (typeof toolDisplayContracts)[keyof typeof toolDisplayContracts];
const contracts: Record<
  string,
  DisplayContract<Contract["input"], Contract["result"]>
> = toolDisplayContracts;

export function auditRows(
  rows: readonly ToolCallItem[],
  source: Pick<AuditFileResult, "fileId" | "provider" | "version">,
): Pick<AuditFileResult, "counts" | "groups"> {
  const counts: Record<string, number> = {};
  const groups = new Map<string, AuditGroup>();
  const count = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  for (const row of rows) {
    count("toolRows");
    const tool = canonicalizeToolName(row.toolName);
    const contract = Object.hasOwn(contracts, tool)
      ? contracts[tool]
      : undefined;
    if (!contract) {
      count("unregisteredRows");
      continue;
    }
    count("registeredRows");
    const result = row.toolResult?.structured ?? row.toolResult?.content;
    const prepared = prepareDisplay(contract, {
      input: row.toolInput,
      result,
      status: row.status,
      isError: row.toolResult?.isError,
    });
    const add = (
      category: AuditGroup["category"],
      reason: string,
      issues: string[],
    ) => {
      count(category);
      const group: AuditGroup = {
        provider: source.provider,
        version: source.version,
        tool,
        category,
        reason,
        inputShape: safeShape(row.toolInput),
        resultShape: safeShape(result),
        issues,
        count: 0,
        examples: [],
      };
      const key = JSON.stringify([
        tool,
        category,
        reason,
        group.inputShape,
        group.resultShape,
        issues,
      ]);
      const current = groups.get(key) ?? group;
      current.count++;
      if (current.examples.length < 3)
        current.examples.push({
          fileId: source.fileId,
          callId: auditId(row.id),
        });
      groups.set(key, current);
    };
    if (prepared.kind === "raw") {
      const error =
        prepared.reason === "input" ? prepared.input : prepared.result;
      add(
        prepared.isError
          ? "error-raw"
          : row.status === "complete"
            ? "successful-raw"
            : "unfinished-raw",
        prepared.reason ?? "unknown",
        error && !error.success ? safeIssues(error.error.issues) : [],
      );
    } else count(prepared.kind);
    // Targeted known consumers, not a claim that every stripped field matters.
    if (
      prepared.input.success &&
      row.toolInput &&
      typeof row.toolInput === "object"
    ) {
      const input = row.toolInput as Record<string, unknown>;
      const projection = prepared.input.data as Record<string, unknown>;
      const lost = (key: string) =>
        input[key] !== undefined && projection[key] !== input[key];
      const aliases =
        tool === "WriteStdin"
          ? [
              !input.cell_id && lost("cellId") ? "cellId" : "",
              !input.linked_command &&
              lost(
                typeof input.command === "string" && input.command.trim()
                  ? "command"
                  : "cmd",
              )
                ? "command/cmd"
                : "",
            ]
          : tool === "create_goal" &&
              input.token_budget === undefined &&
              lost("tokenBudget")
            ? ["tokenBudget"]
            : [];
      for (const alias of aliases.filter(Boolean))
        add("projection-loss", alias, []);
    }
  }
  return { counts, groups: [...groups.values()] };
}

export async function auditTranscript({
  file,
  rolloutPaths,
}: AuditRequest): Promise<AuditFileResult> {
  const before = await stat(file.path);
  let data: UnifiedSession;
  let malformedLines = 0;
  let referenceBacked = false;
  let version = "unknown";
  let entryCount = 0;
  let sessionId = file.fileId;
  if (file.provider === "codex") {
    const meta = await readCodexSessionMeta(file.path);
    sessionId = meta.payload.id;
    version = /^\d+\.\d+\.\d+(?:[-+][\w.-]{1,40})?$/.test(
      meta.payload.cli_version ?? "",
    )
      ? (meta.payload.cli_version ?? "unknown")
      : "unknown";
    const lineage = await resolveCodexRolloutLineage({
      requestedSessionId: sessionId,
      leafFilePath: file.path,
      resolveRolloutPath: async (id) => rolloutPaths[id] ?? null,
    });
    referenceBacked = lineage.referenceBacked;
    let entries: CodexSessionEntry[];
    if (referenceBacked)
      entries = (await readCodexRolloutLineageEntries(lineage)).entries;
    else {
      entries = [];
      for await (const line of iterateJsonlLines(file.path)) {
        if (!line.trim()) continue;
        const entry = parseCodexSessionEntry(line);
        if (entry) entries.push(entry);
        else malformedLines++;
      }
    }
    entryCount = entries.length;
    data = { provider: "codex", session: { entries } };
  } else {
    const snapshot = await new ClaudeTranscriptCache({
      maxSourceBytes: 0,
    }).load(file.path);
    if (!snapshot) throw new Error("Unreadable Claude transcript");
    malformedLines = snapshot.malformedLines;
    entryCount = snapshot.entries.length;
    const versions = snapshot.entries
      .map((entry) => ("version" in entry ? entry.version : undefined))
      .filter(
        (value): value is string =>
          typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value),
      );
    version = versions.at(-1) ?? "unknown";
    data = { provider: "claude", session: { messages: snapshot.entries } };
  }
  const normalized = normalizeSession({
    summary: {
      id: sessionId,
      projectId: toUrlProjectId("/audit"),
      title: "Audit",
      fullTitle: "Audit",
      createdAt: before.mtime.toISOString(),
      updatedAt: before.mtime.toISOString(),
      messageCount: 0,
      ownership: { owner: "none" },
      provider: data.provider,
    },
    transcriptSnapshotUpdatedAt: before.mtime.toISOString(),
    data,
  });
  augmentTaskListSnapshots(normalized.messages);
  // Per-message processing avoids unbounded Promise.all work on long sessions.
  for (const message of normalized.messages)
    await augmentPersistedSessionMessages([message]);
  const rows = compileTranscriptProjection(
    normalized.messages as Message[],
  ).filter((row): row is ToolCallItem => row.type === "tool_call");
  const after = await stat(file.path);
  const source = { fileId: file.fileId, provider: data.provider, version };
  return {
    ...source,
    entries: entryCount,
    malformedLines,
    referenceBacked,
    changedDuringRead:
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino,
    warnings: 0,
    ...auditRows(rows, source),
  };
}
