#!/usr/bin/env npx tsx

/**
 * Validates tool_use_result fields in SDK raw logs against our Zod schemas.
 *
 * The Claude SDK provides structured `tool_use_result` objects alongside tool results,
 * but these are not part of the official schema. This script validates them against
 * our ToolResultSchemas to ensure schema compatibility.
 *
 * Usage:
 *   npx tsx scripts/validate-tool-results.ts                    # Validate sdk-raw.jsonl
 *   npx tsx scripts/validate-tool-results.ts [path]             # Validate specific file
 *   npx tsx scripts/validate-tool-results.ts --summary          # Show summary only
 *   npx tsx scripts/validate-tool-results.ts --tool=Bash        # Filter by tool name
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { ZodType } from "zod";
import {
  AskUserQuestionResultSchema,
  BashOutputResultSchema,
  BashResultSchema,
  EditResultSchema,
  EnterPlanModeResultSchema,
  ExitPlanModeResultSchema,
  GlobResultSchema,
  GrepResultSchema,
  KillShellResultSchema,
  ReadResultSchema,
  TaskOutputResultSchema,
  TaskResultSchema,
  TodoWriteResultSchema,
  WebFetchResultSchema,
  WebSearchResultSchema,
  WriteResultSchema,
} from "../packages/shared/src/claude-sdk-schema/tool/ToolResultSchemas.js";

// Registry of tool result schemas
const toolSchemas: Record<string, ZodType> = {
  Task: TaskResultSchema,
  Bash: BashResultSchema,
  Read: ReadResultSchema,
  Edit: EditResultSchema,
  Write: WriteResultSchema,
  Glob: GlobResultSchema,
  Grep: GrepResultSchema,
  TodoWrite: TodoWriteResultSchema,
  WebSearch: WebSearchResultSchema,
  WebFetch: WebFetchResultSchema,
  AskUserQuestion: AskUserQuestionResultSchema,
  BashOutput: BashOutputResultSchema,
  TaskOutput: TaskOutputResultSchema,
  KillShell: KillShellResultSchema,
  EnterPlanMode: EnterPlanModeResultSchema,
  ExitPlanMode: ExitPlanModeResultSchema,
};

interface ToolResultEntry {
  lineNumber: number;
  toolName: string;
  toolUseId: string;
  result: unknown;
  sessionId?: string;
}

interface ValidationError {
  lineNumber: number;
  toolName: string;
  toolUseId: string;
  errors: string[];
  result: unknown;
}

interface ValidationStats {
  totalLines: number;
  toolResultLines: number;
  validResults: number;
  invalidResults: number;
  unknownTools: number;
  byTool: Record<string, { valid: number; invalid: number; unknown: number }>;
}

function extractToolName(entry: Record<string, unknown>): string | null {
  // Check message content for tool_result blocks to find associated tool_use
  const message = entry.message as { content?: unknown[] } | undefined;
  if (!message?.content || !Array.isArray(message.content)) return null;

  for (const block of message.content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "tool_result"
    ) {
      const toolUseId = (block as Record<string, unknown>).tool_use_id;
      // Try to get tool name from the entry itself
      const toolName = entry.tool_name as string | undefined;
      if (toolName) return toolName;
    }
  }

  return null;
}

function inferToolFromResult(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;

  // Infer tool from result shape
  if ("stdout" in r || "stderr" in r) {
    if ("shellId" in r || "command" in r) return "BashOutput";
    return "Bash";
  }
  if ("filenames" in r && "durationMs" in r) return "Glob";
  if ("mode" in r && ("filenames" in r || "content" in r)) return "Grep";
  // Read/Write results have type: "text" or "image" with a file object
  if ("type" in r && (r.type === "text" || r.type === "image") && "file" in r) {
    const file = r.file as Record<string, unknown>;
    if (file && typeof file === "object") {
      // Could be Read or Write - check for distinguishing fields
      if ("originalFile" in r || "structuredPatch" in r) return "Edit";
      return "Read";
    }
  }
  if ("structuredPatch" in r || "originalFile" in r) return "Edit";
  if ("oldTodos" in r || "newTodos" in r) return "TodoWrite";
  if ("query" in r && "results" in r) return "WebSearch";
  if ("bytes" in r && "code" in r) return "WebFetch";
  if ("questions" in r || "answers" in r) return "AskUserQuestion";
  if ("status" in r && "agentId" in r) return "Task";
  if ("retrieval_status" in r && "task" in r) return "TaskOutput";
  if ("shell_id" in r && "message" in r) return "KillShell";
  // ExitPlanMode has a plan field with the plan content
  if ("plan" in r) return "ExitPlanMode";
  // EnterPlanMode has just a message field about entering plan mode
  if ("message" in r && Object.keys(r).length === 1) {
    const msg = r.message as string;
    if (msg?.includes("plan mode")) return "EnterPlanMode";
  }

  return null;
}

async function* readJsonlLines(
  filePath: string,
): AsyncGenerator<{ lineNumber: number; data: Record<string, unknown> }> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      yield { lineNumber, data };
    } catch {
      // Skip invalid JSON lines
    }
  }
}

async function validateFile(
  filePath: string,
  options: { toolFilter?: string; summaryOnly?: boolean },
): Promise<{ stats: ValidationStats; errors: ValidationError[] }> {
  const stats: ValidationStats = {
    totalLines: 0,
    toolResultLines: 0,
    validResults: 0,
    invalidResults: 0,
    unknownTools: 0,
    byTool: {},
  };
  const errors: ValidationError[] = [];

  for await (const { lineNumber, data } of readJsonlLines(filePath)) {
    stats.totalLines++;

    // Look for tool_use_result field
    const toolUseResult = data.tool_use_result;
    if (toolUseResult === undefined) continue;

    stats.toolResultLines++;

    // Try to determine tool name
    let toolName = extractToolName(data) || inferToolFromResult(toolUseResult);

    // Apply filter if specified
    if (options.toolFilter && toolName !== options.toolFilter) continue;

    // Initialize tool stats
    if (toolName && !stats.byTool[toolName]) {
      stats.byTool[toolName] = { valid: 0, invalid: 0, unknown: 0 };
    }

    if (!toolName) {
      // String results are typically error messages or simple responses
      // These are valid SDK output, just not structured
      if (typeof toolUseResult === "string") {
        stats.validResults++;
        if (!stats.byTool["<string>"]) {
          stats.byTool["<string>"] = { valid: 0, invalid: 0, unknown: 0 };
        }
        stats.byTool["<string>"].valid++;
        continue;
      }

      stats.unknownTools++;
      if (!stats.byTool["<unknown>"]) {
        stats.byTool["<unknown>"] = { valid: 0, invalid: 0, unknown: 0 };
      }
      stats.byTool["<unknown>"].unknown++;

      if (!options.summaryOnly) {
        errors.push({
          lineNumber,
          toolName: "<unknown>",
          toolUseId: (data.tool_use_id as string) || "unknown",
          errors: ["Could not determine tool name from result shape"],
          result: toolUseResult,
        });
      }
      continue;
    }

    const schema = toolSchemas[toolName];
    if (!schema) {
      stats.unknownTools++;
      stats.byTool[toolName].unknown++;

      if (!options.summaryOnly) {
        errors.push({
          lineNumber,
          toolName,
          toolUseId: (data.tool_use_id as string) || "unknown",
          errors: [`No schema defined for tool: ${toolName}`],
          result: toolUseResult,
        });
      }
      continue;
    }

    const parsed = schema.safeParse(toolUseResult);
    if (parsed.success) {
      stats.validResults++;
      stats.byTool[toolName].valid++;
    } else {
      stats.invalidResults++;
      stats.byTool[toolName].invalid++;

      if (!options.summaryOnly) {
        const errorMessages = parsed.error.issues.map(
          (e) => `${e.path.join(".")}: ${e.message}`,
        );
        errors.push({
          lineNumber,
          toolName,
          toolUseId: (data.tool_use_id as string) || "unknown",
          errors: errorMessages,
          result: toolUseResult,
        });
      }
    }
  }

  return { stats, errors };
}

function printStats(stats: ValidationStats) {
  console.log("\nValidation Summary:");
  console.log(`  Total lines scanned: ${stats.totalLines}`);
  console.log(`  Lines with tool_use_result: ${stats.toolResultLines}`);
  console.log(`  Valid results: ${stats.validResults}`);
  console.log(`  Invalid results: ${stats.invalidResults}`);
  console.log(`  Unknown tools: ${stats.unknownTools}`);

  if (Object.keys(stats.byTool).length > 0) {
    console.log("\nBy Tool:");
    const sortedTools = Object.entries(stats.byTool).sort(
      (a, b) => b[1].valid + b[1].invalid - (a[1].valid + a[1].invalid),
    );
    for (const [tool, counts] of sortedTools) {
      const total = counts.valid + counts.invalid + counts.unknown;
      const status = counts.invalid > 0 ? "✗" : counts.unknown > 0 ? "?" : "✓";
      console.log(
        `  ${status} ${tool}: ${counts.valid}/${total} valid` +
          (counts.invalid > 0 ? ` (${counts.invalid} invalid)` : "") +
          (counts.unknown > 0 ? ` (${counts.unknown} unknown)` : ""),
      );
    }
  }
}

function printErrors(errors: ValidationError[], limit = 20) {
  if (errors.length === 0) return;

  console.log(
    `\nValidation Errors (showing first ${Math.min(limit, errors.length)} of ${errors.length}):\n`,
  );

  // Group by error pattern
  const errorPatterns = new Map<string, ValidationError[]>();
  for (const error of errors) {
    const key = `${error.toolName}: ${error.errors.join("; ")}`;
    if (!errorPatterns.has(key)) {
      errorPatterns.set(key, []);
    }
    errorPatterns.get(key)?.push(error);
  }

  const sortedPatterns = [...errorPatterns.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, limit);

  for (const [errorMsg, instances] of sortedPatterns) {
    console.log(`[${instances.length}x] ${errorMsg}`);
    const example = instances[0];
    console.log(`     Line ${example.lineNumber}`);
    // Show a snippet of the result
    const resultStr = JSON.stringify(example.result);
    console.log(
      `     Result: ${resultStr.length > 100 ? resultStr.slice(0, 100) + "..." : resultStr}`,
    );
    console.log("");
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Parse options
  const summaryOnly = args.includes("--summary");
  const toolFilterArg = args.find((a) => a.startsWith("--tool="));
  const toolFilter = toolFilterArg?.split("=")[1];
  const filteredArgs = args.filter((a) => !a.startsWith("--"));

  // Determine file path
  let filePath: string;
  if (filteredArgs.length > 0) {
    filePath = filteredArgs[0];
  } else {
    // Default to sdk-raw.jsonl in data directory
    const dataDir =
      process.env.YEP_ANYWHERE_DATA_DIR ||
      path.join(os.homedir(), ".yep-anywhere");
    filePath = path.join(dataDir, "logs", "sdk-raw.jsonl");
  }

  console.log("Tool Result Validator");
  console.log(`File: ${filePath}`);
  if (toolFilter) console.log(`Filter: ${toolFilter}`);
  console.log("");

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    console.log("\nMake sure LOG_SDK_MESSAGES is enabled (default: true)");
    process.exit(1);
  }

  const { stats, errors } = await validateFile(filePath, {
    toolFilter,
    summaryOnly,
  });

  printStats(stats);

  if (!summaryOnly) {
    printErrors(errors);
  }

  if (stats.invalidResults > 0) {
    process.exit(1);
  }

  console.log("\nAll tool results validated successfully!");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
