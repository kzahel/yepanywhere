#!/usr/bin/env npx tsx

/**
 * Validates JSONL session files against our Zod schemas.
 *
 * Usage:
 *   npx tsx scripts/validate-jsonl.ts           # Validate both Claude and Codex
 *   npx tsx scripts/validate-jsonl.ts --claude  # Validate only Claude sessions
 *   npx tsx scripts/validate-jsonl.ts --codex   # Validate only Codex sessions
 *   npx tsx scripts/validate-jsonl.ts [path]    # Validate specific path (auto-detects type)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionEntrySchema } from "../packages/shared/src/claude-sdk-schema/index.js";
import { CodexSessionEntrySchema } from "../packages/shared/src/codex-schema/session.js";

type SchemaType = "claude" | "codex";

interface ValidationError {
  file: string;
  lineNumber: number;
  error: string;
  rawLine: string;
}

interface ValidationResult {
  file: string;
  totalLines: number;
  validLines: number;
  errors: ValidationError[];
}

interface ValidationTarget {
  path: string;
  schemaType: SchemaType;
  label: string;
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string) {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch (err) {
      // Skip directories we can't read
    }
  }

  walk(dir);
  return files;
}

function validateFile(
  filePath: string,
  schemaType: SchemaType,
): ValidationResult {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "");

  const result: ValidationResult = {
    file: filePath,
    totalLines: lines.length,
    validLines: 0,
    errors: [],
  };

  const schema =
    schemaType === "codex" ? CodexSessionEntrySchema : SessionEntrySchema;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    try {
      const parsed = JSON.parse(line);
      const validated = schema.safeParse(parsed);

      if (validated.success) {
        result.validLines++;
      } else {
        // Use .issues for Zod errors
        const errorMessages = validated.error.issues.map(
          (e) => `${e.path.join(".")}: ${e.message}`,
        );
        result.errors.push({
          file: filePath,
          lineNumber,
          error: errorMessages.join("; "),
          rawLine: line.length > 200 ? `${line.slice(0, 200)}...` : line,
        });
      }
    } catch (parseError) {
      result.errors.push({
        file: filePath,
        lineNumber,
        error: `JSON parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        rawLine: line.length > 200 ? `${line.slice(0, 200)}...` : line,
      });
    }
  }

  return result;
}

function validateTarget(target: ValidationTarget): {
  totalFiles: number;
  totalLines: number;
  totalValid: number;
  errors: ValidationError[];
} {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${target.label}: ${target.path}\n`);

  if (!fs.existsSync(target.path)) {
    console.log("  Path does not exist, skipping.");
    return { totalFiles: 0, totalLines: 0, totalValid: 0, errors: [] };
  }

  let files: string[];
  if (fs.statSync(target.path).isDirectory()) {
    files = findJsonlFiles(target.path);
  } else {
    files = [target.path];
  }

  if (files.length === 0) {
    console.log("  No .jsonl files found.");
    return { totalFiles: 0, totalLines: 0, totalValid: 0, errors: [] };
  }

  console.log(`  Found ${files.length} JSONL file(s)\n`);

  let totalFiles = 0;
  let totalLines = 0;
  let totalValid = 0;
  const allErrors: ValidationError[] = [];

  for (const file of files) {
    const result = validateFile(file, target.schemaType);
    totalFiles++;
    totalLines += result.totalLines;
    totalValid += result.validLines;
    allErrors.push(...result.errors);

    const status =
      result.errors.length === 0 ? "✓" : `✗ (${result.errors.length} errors)`;
    console.log(
      `  ${status} ${path.relative(process.cwd(), file)} - ${result.validLines}/${result.totalLines} valid`,
    );
  }

  return { totalFiles, totalLines, totalValid, errors: allErrors };
}

function main() {
  const args = process.argv.slice(2);

  // Parse flags
  const claudeOnly = args.includes("--claude");
  const codexOnly = args.includes("--codex");
  const filteredArgs = args.filter((a) => a !== "--claude" && a !== "--codex");

  // Build targets
  const targets: ValidationTarget[] = [];

  if (filteredArgs.length > 0) {
    // Specific path provided - auto-detect type based on path
    const targetPath = filteredArgs[0];
    const isCodexPath = targetPath.includes(".codex");
    targets.push({
      path: targetPath,
      schemaType: isCodexPath ? "codex" : "claude",
      label: isCodexPath ? "CODEX" : "CLAUDE",
    });
  } else {
    // No path - use defaults based on flags
    if (!codexOnly) {
      targets.push({
        path: path.join(os.homedir(), ".claude", "projects"),
        schemaType: "claude",
        label: "CLAUDE",
      });
    }
    if (!claudeOnly) {
      targets.push({
        path: path.join(os.homedir(), ".codex", "sessions"),
        schemaType: "codex",
        label: "CODEX",
      });
    }
  }

  console.log("Session JSONL Validator");

  let grandTotalFiles = 0;
  let grandTotalLines = 0;
  let grandTotalValid = 0;
  const allErrors: ValidationError[] = [];

  for (const target of targets) {
    const result = validateTarget(target);
    grandTotalFiles += result.totalFiles;
    grandTotalLines += result.totalLines;
    grandTotalValid += result.totalValid;
    allErrors.push(...result.errors);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("GRAND TOTAL");
  console.log(
    `  ${grandTotalValid}/${grandTotalLines} lines valid across ${grandTotalFiles} files`,
  );

  if (allErrors.length > 0) {
    console.log(`\nErrors (${allErrors.length} total):\n`);

    // Group errors by error message to find patterns
    const errorPatterns = new Map<string, ValidationError[]>();
    for (const error of allErrors) {
      const key = error.error;
      if (!errorPatterns.has(key)) {
        errorPatterns.set(key, []);
      }
      errorPatterns.get(key)?.push(error);
    }

    // Show unique error patterns with counts
    const sortedPatterns = [...errorPatterns.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );

    for (const [errorMsg, errors] of sortedPatterns.slice(0, 20)) {
      console.log(`[${errors.length}x] ${errorMsg}`);
      // Show one example
      const example = errors[0];
      console.log(
        `     Example: ${path.basename(example.file)}:${example.lineNumber}`,
      );
      console.log("");
    }

    if (sortedPatterns.length > 20) {
      console.log(`... and ${sortedPatterns.length - 20} more error patterns`);
    }

    process.exit(1);
  }

  console.log("\nAll lines validated successfully!");
}

main();
