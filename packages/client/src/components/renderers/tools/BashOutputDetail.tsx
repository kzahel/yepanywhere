import codeStyles from "../CodeOutput.module.css";
import type { ReactNode } from "react";
import { getDisplayBashCommandFromInput as getBashCommand } from "../../../lib/bashCommand";
import { normalizeBashResult } from "../../../lib/bashResult";
import { formatCommandDuration } from "@yep-anywhere/shared/transcript/shellToolOutput";
import { ProjectPathLinkedText } from "../../ProjectPathLinkedText";
import { ToolOutputText } from "../../ToolOutputText";
import { Badge } from "../../ui/Badge";
import { FixedFontMathToggle } from "../../ui/FixedFontMathToggle";
import { InnerHtml } from "../../ui/InnerHtml";
import { OutputCopyButton } from "./outputPreview";
import { NestedHarnessLaunchLink } from "./NestedHarnessLaunchLink";
import type { RenderContext } from "../types";
import type { BashInput, BashResult } from "./types";
import styles from "./BashRenderer.module.css";
export function renderFixedFontMathPanel(
  html: string,
  className = codeStyles.codeBlock,
) {
  return (
    <div
      className={`${className} ${codeStyles.fixedFontRenderedPanel}`}
      data-fixed-font-rendered-panel
    >
      {/* KaTeX output is trusted HTML from local rendering. */}
      <InnerHtml
        className={`${codeStyles.fixedFontRenderedContent} ${styles.fixedWidthOutput}`}
        data-fixed-font-rendered__content
        trustedHtml={html}
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
    <div className={styles.bashSectionHeader} data-bash-section-header>
      <div className={styles.bashModalLabel} data-bash-modal-label>
        {label}
      </div>
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
    <div className={styles.bashModalSections} data-bash-modal-sections>
      <div className={styles.bashModalSection} data-bash-modal-section>
        <BashSectionHeader
          label="Command"
          copyText={command}
          copyLabel="Copy command"
        />
        <div className={styles.bashModalCode} data-bash-modal-code>
          <pre className={codeStyles.codeBlock} data-code-block>
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
        <div className={styles.bashModalSection} data-bash-modal-section>
          <BashSectionHeader
            label="Output"
            copyText={stdout}
            copyLabel="Copy output"
          />
          <div className={styles.bashModalCode} data-bash-modal-code>
            <FixedFontMathToggle
              sourceText={stdout}
              projectPathLinks={projectPathLinks}
              sourceView={
                <pre className={codeStyles.codeBlock} data-code-block>
                  <ToolOutputText text={stdout} />
                </pre>
              }
              renderRenderedView={(html) => renderFixedFontMathPanel(html)}
            />
          </div>
        </div>
      )}
      {stderr && (
        <div className={styles.bashModalSection} data-bash-modal-section>
          <BashSectionHeader
            label={
              <span
                className={styles.bashModalLabelError}
                data-bash-modal-label-error
              >
                {isError ? "Error" : "Stderr"}
              </span>
            }
            copyText={stderr}
            copyLabel={isError ? "Copy error output" : "Copy stderr"}
          />
          <div
            className={`${styles.bashModalCode} ${styles.bashModalCodeError}`}
            data-bash-modal-code
            data-bash-modal-code-error
          >
            <FixedFontMathToggle
              sourceText={stderr}
              projectPathLinks={projectPathLinks}
              sourceView={
                <pre
                  className={`${codeStyles.codeBlock} ${codeStyles.codeBlockError}`}
                  data-code-block
                  data-code-block-error
                >
                  <ToolOutputText text={stderr} />
                </pre>
              }
              renderRenderedView={(html) =>
                renderFixedFontMathPanel(
                  html,
                  `${codeStyles.codeBlock} ${codeStyles.codeBlockError}`,
                )
              }
            />
          </div>
        </div>
      )}
      {!stdout && !stderr && result && !result.interrupted && (
        <div className={styles.bashModalSection} data-bash-modal-section>
          <div className={styles.bashModalLabel} data-bash-modal-label>
            Output
          </div>
          <div className={styles.bashModalEmpty} data-bash-modal-empty>
            No output
          </div>
        </div>
      )}
      {result?.interrupted && (
        <div className={styles.bashModalSection} data-bash-modal-section>
          <Badge tone="warning">Interrupted</Badge>
        </div>
      )}
      {result?.backgroundTaskId && (
        <div className={styles.bashModalSection} data-bash-modal-section>
          <Badge tone="info">Background: {result.backgroundTaskId}</Badge>
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
    <div className={styles.bashResultMetaBadges} data-bash-result-meta-badges>
      {showExit && <Badge tone="danger">rc={result?.exitCode}</Badge>}
      {showDuration && result?.durationSeconds !== undefined && (
        <Badge tone="info">
          {formatCommandDuration(result.durationSeconds)}
        </Badge>
      )}
    </div>
  );
}
