/**
 * Transcript block for a `!!` bang command run: command line, status/exit,
 * markdown-rendered output with a raw toggle, stderr, and the recall /
 * re-run / echo / delete actions. Contract: topics/bang-commands.md.
 */

import type { BangCommandTranscriptDisplayObject } from "@yep-anywhere/shared";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { MarkdownPreview } from "./MarkdownPreview";
import { Button } from "./ui/Button";
import styles from "./BangCommandDisplayObject.module.css";

export interface BangCommandOutput {
  stdout: string;
  stderr: string;
  stdoutHtml: string;
  mode: "markdown" | "json" | "ansi" | "toon" | "raw";
  responseTruncated: boolean;
}

export interface BangCommandHandlers {
  shouldExpandOutput?: (objectId: string) => boolean;
  onKill?: (objectId: string) => void;
  onDelete?: (objectId: string) => void;
  onRerun?: (command: string) => void;
  onRecall?: (command: string) => void;
  onEcho?: (object: BangCommandTranscriptDisplayObject) => void;
  fetchOutput?: (objectId: string) => Promise<BangCommandOutput>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

const statusModifierByStatus: Record<
  BangCommandTranscriptDisplayObject["status"],
  string | undefined
> = {
  running: undefined,
  done: undefined,
  error: styles.error,
  killed: styles.killed,
};

export function BangCommandDisplayObject({
  object,
  handlers,
  outputExpanded,
  onOutputExpandedChange,
}: {
  object: BangCommandTranscriptDisplayObject;
  handlers?: BangCommandHandlers;
  outputExpanded?: boolean;
  onOutputExpandedChange?: (expanded: boolean) => void;
}) {
  const { t } = useI18n();
  const [output, setOutput] = useState<BangCommandOutput | null>(null);
  const [locallyExpanded, setLocallyExpanded] = useState(
    () =>
      handlers?.shouldExpandOutput?.(object.id) ?? object.status === "running",
  );
  const [outputLoading, setOutputLoading] = useState(false);
  const [outputLoadFailed, setOutputLoadFailed] = useState(false);
  const [outputLoadAttempt, setOutputLoadAttempt] = useState(0);
  const [showRaw, setShowRaw] = useState(false);
  const fetchedForRef = useRef<string | null>(null);

  const finished = object.status !== "running";
  const fetchOutput = handlers?.fetchOutput;
  const expanded = outputExpanded ?? locallyExpanded;
  const setExpanded = (next: boolean) => {
    if (outputExpanded === undefined) {
      setLocallyExpanded(next);
    }
    onOutputExpandedChange?.(next);
  };
  useEffect(() => {
    void outputLoadAttempt;
    if (!expanded) {
      fetchedForRef.current = null;
      setOutput(null);
      setOutputLoading(false);
      setOutputLoadFailed(false);
      setShowRaw(false);
      return;
    }
    if (!finished || !fetchOutput) return;
    const fetchKey = `${object.id}:${object.status}`;
    if (fetchedForRef.current === fetchKey) return;
    fetchedForRef.current = fetchKey;
    setOutputLoading(true);
    setOutputLoadFailed(false);
    let cancelled = false;
    fetchOutput(object.id).then(
      (result) => {
        if (!cancelled) {
          setOutput(result);
          setOutputLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          fetchedForRef.current = null;
          setOutputLoading(false);
          setOutputLoadFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    expanded,
    finished,
    fetchOutput,
    object.id,
    object.status,
    outputLoadAttempt,
  ]);

  const stderrText = output?.stderr ?? object.stderrPreview ?? "";
  const rawStdout = output?.stdout ?? object.stdoutPreview ?? "";
  const renderedHtml = output?.stdoutHtml ?? "";
  const exitLabel =
    object.exitCode !== undefined
      ? t("bangExitCode", { code: String(object.exitCode) })
      : null;

  return (
    <div
      className={[styles.root, statusModifierByStatus[object.status]]
        .filter(Boolean)
        .join(" ")}
      role="group"
      aria-label={t("bangBlockAriaLabel")}
    >
      <div className={styles.header}>
        <span className={styles.glyph} aria-hidden="true">
          !!
        </span>
        <code className={styles.line} title={object.cwd}>
          {object.command}
        </code>
        <span className={styles.meta}>
          {object.status === "running" && (
            <span className={styles.running}>
              <span className={styles.spinner} aria-hidden="true" />
              {t("bangRunning")}
            </span>
          )}
          {exitLabel && (
            <span
              className={object.exitCode === 0 ? undefined : styles.exitNonzero}
            >
              {exitLabel}
            </span>
          )}
          {object.durationMs !== undefined && (
            <span>{formatDuration(object.durationMs)}</span>
          )}
        </span>
      </div>

      {object.error && (
        <div className={styles.error} role="alert">
          {object.error}
        </div>
      )}

      {object.status === "running" ? (
        (object.stdoutPreview || object.stderrPreview) && (
          <pre className={styles.preview}>
            {[object.stdoutPreview, object.stderrPreview]
              .filter(Boolean)
              .join("\n")}
          </pre>
        )
      ) : renderedHtml && !showRaw ? (
        <MarkdownPreview
          className={styles.output}
          html={renderedHtml}
          ariaLabel={t("bangOutputAriaLabel")}
        />
      ) : rawStdout ? (
        <pre className={styles.preview}>{rawStdout}</pre>
      ) : null}

      {finished && stderrText.trim() && (
        <details className={styles.stderr} open>
          <summary>{t("bangStderrLabel")}</summary>
          <pre className={styles.preview}>{stderrText}</pre>
        </details>
      )}

      {(object.stdoutTruncated || output?.responseTruncated) && (
        <div className={styles.truncated}>{t("bangTruncatedNote")}</div>
      )}

      <div className={styles.actions}>
        {object.status === "running" && handlers?.onKill && (
          <Button size="small" onClick={() => handlers.onKill?.(object.id)}>
            {t("bangCancel")}
          </Button>
        )}
        {finished && renderedHtml && (
          <Button size="small" onClick={() => setShowRaw((value) => !value)}>
            {showRaw ? t("bangRendered") : t("bangRaw")}
          </Button>
        )}
        {finished && fetchOutput && (
          <Button
            size="small"
            disabled={outputLoading}
            onClick={() => {
              if (outputLoadFailed) {
                setOutputLoadFailed(false);
                setOutputLoadAttempt((attempt) => attempt + 1);
              } else {
                setExpanded(!expanded);
              }
            }}
          >
            {outputLoading
              ? t("bangLoadingOutput")
              : outputLoadFailed
                ? t("bangRetryOutput")
                : expanded
                  ? t("bangHideOutput")
                  : t("bangLoadOutput")}
          </Button>
        )}
        {handlers?.onRecall && (
          <Button
            size="small"
            onClick={() => handlers.onRecall?.(object.command)}
            title={t("bangRecallTitle")}
          >
            {t("bangRecall")}
          </Button>
        )}
        {finished && handlers?.onRerun && (
          <Button
            size="small"
            onClick={() => handlers.onRerun?.(object.command)}
          >
            {t("bangRerun")}
          </Button>
        )}
        {finished && handlers?.onEcho && (
          <Button
            size="small"
            onClick={() => handlers.onEcho?.(object)}
            title={t("bangEchoTitle")}
          >
            {t("bangEcho")}
          </Button>
        )}
        {finished && handlers?.onDelete && (
          <Button
            variant="danger-outline"
            size="small"
            onClick={() => handlers.onDelete?.(object.id)}
          >
            {t("bangDelete")}
          </Button>
        )}
      </div>
    </div>
  );
}
