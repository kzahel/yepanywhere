import type { ReactNode } from "react";
import { getDisplayBashCommandFromInput as getBashCommand } from "../../../lib/bashCommand";
import { normalizeBashResult } from "../../../lib/bashResult";
import { formatCommandDuration } from "@yep-anywhere/shared/transcript/shellToolOutput";
import { ProjectPathLinkedText } from "../../ProjectPathLinkedText";
import { ToolOutputText } from "../../ToolOutputText";
import { FixedFontMathToggle } from "../../ui/FixedFontMathToggle";
import { OutputCopyButton } from "./outputPreview";
import { NestedHarnessLaunchLink } from "./NestedHarnessLaunchLink";
import type { RenderContext } from "../types";
import type { BashInput, BashResult } from "./types";
import styles from "./BashRenderer.module.css";
export function renderFixedFontMathPanel(
  html: string,
  className = "code-block",
) {
  return (
    <div className={`${className} fixed-font-rendered-panel`}>
      <div
        className={`fixed-font-rendered__content ${styles.fixedWidthOutput}`}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output is trusted HTML from local rendering
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function BashSectionHeader({
  label,
  copyText,
  copyLabel,
}: {
  label: ReactNode;
  copyText: string;
  copyLabel: string;
}) {
  return (
    <div className="bash-section-header">
      <div className="bash-modal-label">{label}</div>
      <OutputCopyButton text={copyText} label={copyLabel} />
    </div>
  );
}

/**
 * Modal content for viewing full bash input and output
 */
export function BashModalContent({
  input,
  result: rawResult,
  isError,
  projectPathLinks,
}: {
  input: BashInput;
  result: BashResult | string | undefined;
  isError: boolean;
  projectPathLinks?: RenderContext["projectPathLinks"];
}) {
  // Normalize result to handle both structured and string formats
  const result =
    typeof rawResult === "string"
      ? normalizeBashResult(rawResult, isError)
      : rawResult;
  const command = getBashCommand(input);
  const stdout = result?.stdout || "";
  const stderr = result?.stderr || "";

  return (
    <div className="bash-modal-sections">
      <div className="bash-modal-section">
        <BashSectionHeader
          label="Command"
          copyText={command}
          copyLabel="Copy command"
        />
        <div className="bash-modal-code">
          <pre className="code-block">
            <code>
              <ProjectPathLinkedText
                text={command}
                links={input._projectPathLinks}
              />
            </code>
          </pre>
        </div>
        <NestedHarnessLaunchLink command={command} />
      </div>
      {stdout && (
        <div className="bash-modal-section">
          <BashSectionHeader
            label="Output"
            copyText={stdout}
            copyLabel="Copy output"
          />
          <div className="bash-modal-code">
            <FixedFontMathToggle
              sourceText={stdout}
              projectPathLinks={projectPathLinks}
              sourceView={
                <pre className="code-block">
                  <ToolOutputText text={stdout} />
                </pre>
              }
              renderRenderedView={(html) => renderFixedFontMathPanel(html)}
            />
          </div>
        </div>
      )}
      {stderr && (
        <div className="bash-modal-section">
          <BashSectionHeader
            label={
              <span className="bash-modal-label-error">
                {isError ? "Error" : "Stderr"}
              </span>
            }
            copyText={stderr}
            copyLabel={isError ? "Copy error output" : "Copy stderr"}
          />
          <div className="bash-modal-code bash-modal-code-error">
            <FixedFontMathToggle
              sourceText={stderr}
              projectPathLinks={projectPathLinks}
              sourceView={
                <pre className="code-block code-block-error">
                  <ToolOutputText text={stderr} />
                </pre>
              }
              renderRenderedView={(html) =>
                renderFixedFontMathPanel(html, "code-block code-block-error")
              }
            />
          </div>
        </div>
      )}
      {!stdout && !stderr && result && !result.interrupted && (
        <div className="bash-modal-section">
          <div className="bash-modal-label">Output</div>
          <div className="bash-modal-empty">No output</div>
        </div>
      )}
      {result?.interrupted && (
        <div className="bash-modal-section">
          <span className="badge badge-warning">Interrupted</span>
        </div>
      )}
      {result?.backgroundTaskId && (
        <div className="bash-modal-section">
          <span className="badge badge-info">
            Background: {result.backgroundTaskId}
          </span>
        </div>
      )}
      <BashResultMetaBadges result={result} />
    </div>
  );
}

/**
 * Runtime and exit-code badges for command detail views. Exit code 0 stays
 * silent; runtime shows whenever the provider reported one (contract:
 * topics/provider-output-contract.md § Command execution metadata).
 */
export function BashResultMetaBadges({
  result,
}: {
  result: BashResult | undefined;
}) {
  const showExit = result?.exitCode !== undefined && result.exitCode !== 0;
  const showDuration = result?.durationSeconds !== undefined;
  if (!showExit && !showDuration) {
    return null;
  }
  return (
    <div className="bash-result-meta-badges">
      {showExit && (
        <span className="badge badge-error">rc={result?.exitCode}</span>
      )}
      {showDuration && result?.durationSeconds !== undefined && (
        <span className="badge badge-info">
          {formatCommandDuration(result.durationSeconds)}
        </span>
      )}
    </div>
  );
}

/**
 * Bash tool use - shows command in code block with collapse for long commands
 */
