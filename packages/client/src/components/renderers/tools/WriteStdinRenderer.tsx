import { decodeCodeModeOutput } from "@yep-anywhere/shared";
import { CodeModeOutput } from "./CodeModeOutput";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import { type ReactNode, useState } from "react";
import {
  extractDetachedCellId,
  formatCommandDuration,
  getCommandResultMeta,
  parseShellToolOutput,
} from "@yep-anywhere/shared/transcript/shellToolOutput";
import { getPathBasename, makeDisplayPath } from "../../../lib/text";
import { ActivityDetailModal } from "../../ActivityDetailModal";
import { AnsiText } from "../../ui/AnsiText";
import { FixedFontMathToggle } from "../../ui/FixedFontMathToggle";
import type { ToolSummaryContext } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getSessionId(input: unknown): string {
  if (!isRecord(input)) {
    return "unknown";
  }
  const value = input.session_id;
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return "unknown";
}

function getCellId(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const value = input.cell_id ?? input.cellId;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function getTargetLine(input: unknown): string {
  const sessionId = getSessionId(input);
  if (sessionId !== "unknown") {
    return `command session ${sessionId}`;
  }
  const cellId = getCellId(input);
  if (cellId) {
    return `script cell ${cellId}`;
  }
  return "command session unknown";
}

function getChars(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.chars !== "string") {
    return undefined;
  }
  return input.chars;
}

function getLinkedCommand(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (
    typeof input.linked_command === "string" &&
    input.linked_command.trim().length > 0
  ) {
    return input.linked_command;
  }
  if (typeof input.command === "string" && input.command.trim().length > 0) {
    return input.command;
  }
  if (typeof input.cmd === "string" && input.cmd.trim().length > 0) {
    return input.cmd;
  }
  return undefined;
}

function getLinkedFilePath(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.linked_file_path !== "string") {
    return undefined;
  }
  const filePath = input.linked_file_path.trim();
  return filePath.length > 0 ? filePath : undefined;
}

function getFileName(filePath: string): string {
  return getPathBasename(filePath);
}

function getLinkedToolName(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.linked_tool_name !== "string") {
    return undefined;
  }
  const toolName = input.linked_tool_name.trim();
  return toolName.length > 0 ? toolName : undefined;
}

function getInputTargetLabel(
  input: unknown,
  context?: ToolSummaryContext,
): string | undefined {
  const filePath = getLinkedFilePath(input);
  if (filePath) {
    return getFileName(makeDisplayPath(filePath, context?.projectPath));
  }
  return getLinkedCommand(input);
}

function getOriginLabel(
  input: unknown,
  context?: ToolSummaryContext,
): string | undefined {
  const linkedToolName = getLinkedToolName(input);
  const target = getInputTargetLabel(input, context);
  const prefix =
    linkedToolName === "Read"
      ? "Read via PTY"
      : linkedToolName === "Write"
        ? "Write via PTY"
        : linkedToolName === "Edit"
          ? "Edit via PTY"
          : linkedToolName === "Bash"
            ? "Command via PTY"
            : undefined;

  if (prefix && target) {
    return `${prefix}: ${target}`;
  }
  if (prefix) {
    return prefix;
  }
  return target;
}

function formatChars(chars: string | undefined): string {
  if (chars === undefined || chars.length === 0) {
    return "(poll)";
  }

  const escapedJson = JSON.stringify(chars);
  if (!escapedJson || escapedJson.length < 2) {
    return chars;
  }

  const escaped = escapedJson.slice(1, -1);
  if (escaped.length <= 80) {
    return escaped;
  }
  return `${escaped.slice(0, 77)}...`;
}

function getResultText(result: unknown): string {
  const decoded = decodeCodeModeOutput(result);
  if (decoded)
    return decoded.parts
      .filter((part) => part.kind !== "script-status")
      .map((part) => part.text)
      .join("\n");
  if (typeof result === "string") {
    return result;
  }

  if (isRecord(result)) {
    // Normalized command results carry the text under content/stdout;
    // unified-exec chunk records carry it under output.
    for (const field of ["content", "stdout", "output"]) {
      const value = result[field];
      if (typeof value === "string") {
        return value;
      }
    }
  }

  if (result === null || result === undefined) {
    return "";
  }

  if (typeof result === "number" || typeof result === "boolean") {
    return String(result);
  }

  return JSON.stringify(result, null, 2);
}

/** Compact runtime ("30s", "2m14s") from structured metadata or the shell
 * envelope's "Wall time N seconds" line. */
function getCompactDuration(result: unknown, text: string): string | undefined {
  const meta = getCommandResultMeta(result);
  if (meta.durationSeconds !== undefined) {
    return formatCommandDuration(meta.durationSeconds) || undefined;
  }
  const wallTime = parseShellToolOutput(text).wallTime;
  if (!wallTime) {
    return undefined;
  }
  const seconds = Number.parseFloat(wallTime);
  return Number.isFinite(seconds)
    ? formatCommandDuration(seconds) || undefined
    : wallTime;
}

/**
 * Command metadata line for the expanded result body — runtime always when
 * known, exit code only when nonzero (contract:
 * topics/provider-output-contract.md § Command execution metadata).
 */
function getResultMetaLine(result: unknown, text: string): string | null {
  const meta = getCommandResultMeta(result);
  const parsed = parseShellToolOutput(text);
  const exitCode = meta.exitCode ?? parsed.exitCode;
  const duration =
    meta.durationSeconds !== undefined
      ? formatCommandDuration(meta.durationSeconds)
      : parsed.wallTime;

  const parts: string[] = [];
  if (duration) {
    parts.push(duration);
  }
  if (exitCode !== undefined && exitCode !== 0) {
    parts.push(`rc=${exitCode}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function countContentLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split("\n").filter(Boolean).length;
}

function renderFixedFontMathPanel(
  html: string,
  className = "code-block",
): ReactNode {
  return (
    <div className={`${className} fixed-font-rendered-panel`}>
      <div
        className="fixed-font-rendered__content"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted HTML from local rendering
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function ReadViaPtyFile({
  filePath,
  output,
  inline = false,
}: {
  filePath: string;
  output: string;
  inline?: boolean;
}) {
  const [showModal, setShowModal] = useState(false);
  const fileName = getFileName(filePath);
  const lines = output.split("\n");
  const lineCount = countContentLines(output);
  const buttonClass = inline ? "file-link-inline" : "file-link-button";
  const lineCountClass = inline ? "file-line-count-inline" : "file-line-count";
  const wrapperClass = inline ? undefined : "read-text-result";

  return (
    <>
      <div className={wrapperClass}>
        <button
          type="button"
          className={buttonClass}
          onClick={() => setShowModal(true)}
        >
          {fileName}
          <span className={lineCountClass}>{lineCount} lines</span>
        </button>
      </div>
      {showModal && (
        <ActivityDetailModal
          title={<span className="file-path">{fileName}</span>}
          label={fileName}
          onClose={() => setShowModal(false)}
        >
          <div className="file-content-modal">
            <div className="file-content-with-lines">
              <div className="line-numbers">
                {lines.map((_, i) => (
                  <div key={`ln-${i + 1}`}>{i + 1}</div>
                ))}
              </div>
              <pre className="line-content">
                <code>{output}</code>
              </pre>
            </div>
          </div>
        </ActivityDetailModal>
      )}
    </>
  );
}

export const writeStdinRenderer = defineTool(toolDisplayContracts.WriteStdin, {
  tool: "WriteStdin",
  displayName: "Shell",
  pendingDisplayName: "Waiting",

  renderToolUse(input, _context) {
    const summaryContext = { projectPath: _context.projectPath };
    const chars = getChars(input);
    const command = getLinkedCommand(input);
    const filePath = getLinkedFilePath(input);
    const originLabel = getOriginLabel(input, summaryContext);
    const action =
      chars === undefined || chars.length === 0
        ? "waiting for output"
        : `input: ${formatChars(chars)}`;

    const originLine = originLabel ? `origin: ${originLabel}\n` : "";
    const fileLine = filePath
      ? `file: ${makeDisplayPath(filePath, _context.projectPath)}\n`
      : "";
    const commandLine = command ? `command: ${command}\n` : "";

    return (
      <div className="bash-tool-use">
        <pre className="code-block">
          <code>{`${originLine}${fileLine}${commandLine}${getTargetLine(input)}\n${action}`}</code>
        </pre>
      </div>
    );
  },

  renderToolResult(result, isError, _context, input) {
    if (
      decodeCodeModeOutput(result) &&
      !(getLinkedToolName(input) === "Read" && getLinkedFilePath(input))
    ) {
      return <CodeModeOutput result={result} isError={isError} shellMetadata />;
    }
    const text = getResultText(result);
    const parsed = parseShellToolOutput(text);
    const linkedToolName = getLinkedToolName(input);
    const linkedFilePath = getLinkedFilePath(input);
    const metaLine = getResultMetaLine(result, text);
    const metaRow = metaLine ? (
      <div className="command-result-meta">{metaLine}</div>
    ) : null;

    if (!parsed.output.trim()) {
      const exitCode = getCommandResultMeta(result).exitCode ?? parsed.exitCode;
      if (exitCode !== undefined && exitCode !== 0) {
        return (
          <>
            <div className="bash-empty">{`Command exited with code ${exitCode}`}</div>
            {metaRow}
          </>
        );
      }
      // A detached poll is not "no output": the script is still running and
      // its output arrives with a later wait on the named cell.
      const detachedCellId = extractDetachedCellId(text);
      if (detachedCellId) {
        return (
          <>
            <div className="bash-empty">
              {`Still running — output continues as script cell ${detachedCellId}`}
            </div>
            {metaRow}
          </>
        );
      }
      return (
        <>
          <div className="bash-empty">No output</div>
          {metaRow}
        </>
      );
    }

    if (linkedToolName === "Read" && linkedFilePath) {
      return (
        <ReadViaPtyFile filePath={linkedFilePath} output={parsed.output} />
      );
    }

    return (
      <div className={`bash-result ${isError ? "bash-result-error" : ""}`}>
        <FixedFontMathToggle
          sourceText={parsed.output}
          sourceView={
            <pre className={`code-block ${isError ? "code-block-error" : ""}`}>
              <AnsiText text={parsed.output} />
            </pre>
          }
          renderRenderedView={(html) =>
            renderFixedFontMathPanel(
              html,
              `code-block ${isError ? "code-block-error" : ""}`.trim(),
            )
          }
        />
        {metaRow}
      </div>
    );
  },

  getUseSummary(input, context) {
    const sessionId = getSessionId(input);
    const chars = getChars(input);
    const inputSummary = getOriginLabel(input, context);

    if (chars === undefined || chars.length === 0) {
      if (inputSummary) {
        return inputSummary;
      }
      return "waiting for output";
    }
    if (inputSummary) {
      return `${inputSummary} (input)`;
    }
    return `sent input (${sessionId})`;
  },

  getResultSummary(result, isError) {
    if (isError) {
      return "Error";
    }

    const decoded = decodeCodeModeOutput(result);
    const failedCommands = decoded?.parts.flatMap((part) =>
      part.kind === "command-output" && part.exitCode
        ? [`rc=${part.exitCode}`]
        : [],
    );
    if (failedCommands?.length) return failedCommands.join(" · ");
    if (decoded?.parts.every((part) => part.kind === "script-status")) {
      return decoded.parts[0]?.text.startsWith("Script running")
        ? "still running"
        : "No output";
    }
    const text = getResultText(result);
    const parsed = parseShellToolOutput(text);
    const meta = getCommandResultMeta(result);
    const exitCode = meta.exitCode ?? parsed.exitCode;
    const duration =
      meta.durationSeconds !== undefined
        ? formatCommandDuration(meta.durationSeconds)
        : parsed.wallTime;

    // Exit code 0 is the default and stays silent per the command-metadata
    // contract.
    if (exitCode !== undefined && exitCode !== 0) {
      return duration ? `rc=${exitCode} in ${duration}` : `rc=${exitCode}`;
    }

    const compactDuration = getCompactDuration(result, text);
    const withDuration = (summary: string) =>
      compactDuration ? `${summary} · ${compactDuration}` : summary;

    if (!parsed.output.trim()) {
      return withDuration(
        extractDetachedCellId(text) ? "still running" : "No output",
      );
    }

    const lineCount = parsed.output.split("\n").filter(Boolean).length;
    return withDuration(`${lineCount} lines`);
  },

  renderInteractiveSummary(input, result, isError, _context) {
    if (isError) {
      return null;
    }

    const linkedToolName = getLinkedToolName(input);
    const linkedFilePath = getLinkedFilePath(input);
    if (linkedToolName !== "Read" || !linkedFilePath) {
      return null;
    }

    const text = getResultText(result);
    const parsed = parseShellToolOutput(text);
    if (!parsed.output.trim()) {
      return null;
    }

    return (
      <ReadViaPtyFile filePath={linkedFilePath} output={parsed.output} inline />
    );
  },
});
