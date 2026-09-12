import { toolDisplayDiagnostics } from "../renderers/tools/displayDiagnostics";
import { Component, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";
import styles from "./ToolDisplayBoundary.module.css";

interface ToolRecord {
  id: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: unknown;
  status: ToolCallItem["status"];
}

function rawText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

/** Keep the original provider input and output inspectable without invoking a
 * specialized renderer, including when a tool rejected its own arguments. */
export function RawToolDisplay({
  toolName,
  toolInput,
  toolResult,
  status,
  error,
}: ToolRecord & { error?: Error }) {
  const { t } = useI18n();
  return (
    <div className={styles.row} data-tool-display="raw">
      <div className={styles.header}>
        <strong>{toolName}</strong>
        <span className={styles.status} data-status={status}>
          {t(`toolDisplay.status.${status}`)}
        </span>
      </div>
      {error && <pre className={styles.output}>{error.message}</pre>}
      <details className={styles.details}>
        <summary>{t("toolDisplay.rawNotice")}</summary>
        {toolResult !== undefined && (
          <>
            <strong>{t("toolDisplay.output")}</strong>
            <pre className={styles.output}>{rawText(toolResult)}</pre>
          </>
        )}
        <strong>{t("toolDisplay.input")}</strong>
        <pre className={styles.output}>{rawText(toolInput)}</pre>
      </details>
    </div>
  );
}

interface BoundaryProps extends ToolRecord {
  children: ReactNode;
}
interface BoundaryState {
  error: Error | null;
  record: ToolRecord;
}

/** Last-resort containment for renderer bugs. A fresh provider record retries
 * rendering, so an interrupted/streaming shape cannot permanently poison a row.
 */
export class ToolDisplayBoundary extends Component<
  BoundaryProps,
  BoundaryState
> {
  state: BoundaryState = { error: null, record: this.props };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState) {
    const previous = state.record;
    if (
      previous.id !== props.id ||
      previous.toolName !== props.toolName ||
      previous.toolInput !== props.toolInput ||
      previous.toolResult !== props.toolResult ||
      previous.status !== props.status
    ) {
      return { error: null, record: props };
    }
    return null;
  }

  componentDidCatch() {
    toolDisplayDiagnostics.renderCatches++;
  }

  render() {
    return this.state.error ? (
      <RawToolDisplay {...this.props} error={this.state.error} />
    ) : (
      this.props.children
    );
  }
}
