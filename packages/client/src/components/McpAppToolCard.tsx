import type { McpAppDisplayMode, McpAppToolCall } from "@yep-anywhere/shared";
import type {
  ToolCallItem,
  ToolResultData,
} from "@yep-anywhere/shared/transcript/items";
import { useCallback, useContext, useMemo, useRef, useState } from "react";
import { ComposerInsertContext } from "../contexts/ComposerInsertContext";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useMcpAppViewsEnabled } from "../hooks/useMcpAppViewsEnabled";
import { useRetainedVersionInfo } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { artifactAudience, artifactOrigin } from "../lib/artifactPreview";
import { McpAppView } from "./McpAppView";
import styles from "./McpAppToolCard.module.css";
import { SessionManagedPanel } from "./SessionManagedViewer";
import { Button } from "./ui/Button";

type CardMode = "closed" | McpAppDisplayMode;

/**
 * The launcher and inline host for a tool call's MCP App view. Nothing loads
 * until the reader asks: replayed history never re-runs a view on its own.
 * Inline mode frames the view in the row; fullscreen mode hands it to the
 * session's managed viewer, which is the right pane when that is enabled and
 * a covering modal otherwise.
 */
export function McpAppToolCard({
  mcpApp,
  callId,
  toolInput,
  toolResult,
  status,
}: {
  mcpApp: McpAppToolCall;
  callId: string;
  toolInput: unknown;
  toolResult?: ToolResultData;
  status: ToolCallItem["status"];
}) {
  const { t } = useI18n();
  const metadata = useOptionalSessionMetadata();
  const runtime = useCurrentSourceRuntime();
  const version = useRetainedVersionInfo(runtime.sourceKey);
  const enabled = useMcpAppViewsEnabled();
  const insertIntoComposer = useContext(ComposerInsertContext);
  const [mode, setMode] = useState<CardMode>("closed");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const close = useCallback(() => setMode("closed"), []);
  const requestDisplayMode = useCallback(
    (requested: string): McpAppDisplayMode => {
      if (requested === "inline" || requested === "fullscreen") {
        setMode(requested);
        return requested;
      }
      const current = modeRef.current;
      return current === "closed" ? mcpApp.displayMode : current;
    },
    [mcpApp.displayMode],
  );
  const config = version?.artifactViewer;
  const proxyOrigin = config
    ? artifactOrigin(
        config,
        artifactAudience(window.location.hostname),
        window.location.href,
      )
    : undefined;
  // The input only seeds a view when it loads; a later identity change must
  // not rebuild the element the panel holds.
  const toolInputRef = useRef(toolInput);
  toolInputRef.current = toolInput;
  const resultContent = toolResult?.content;
  const resultIsError = toolResult?.isError === true;
  const projectId = metadata?.projectId;
  const sessionId = metadata?.sessionId;
  // The managed panel re-presents whenever its content element changes, so
  // the element changes only when something the view uses does.
  const view = useCallback(
    (displayMode: McpAppDisplayMode) =>
      projectId && sessionId && proxyOrigin ? (
        <McpAppView
          call={mcpApp}
          callId={callId}
          projectId={projectId}
          sessionId={sessionId}
          proxyOrigin={proxyOrigin}
          toolInput={toolInputRef.current}
          toolResult={
            resultContent === undefined
              ? undefined
              : { content: resultContent, isError: resultIsError }
          }
          status={status}
          displayMode={displayMode}
          onRequestDisplayMode={requestDisplayMode}
          insertIntoComposer={insertIntoComposer}
        />
      ) : null,
    [
      mcpApp,
      callId,
      projectId,
      sessionId,
      proxyOrigin,
      resultContent,
      resultIsError,
      status,
      requestDisplayMode,
      insertIntoComposer,
    ],
  );
  const panelView = useMemo(() => view("fullscreen"), [view]);

  if (!metadata || !enabled) return null;
  if (!proxyOrigin)
    return <p className={styles.note}>{t("mcpAppViewNeedsArtifactOrigin")}</p>;

  const label = t("mcpAppViewFrame", {
    server: mcpApp.server,
    tool: mcpApp.tool,
  });

  return (
    <div className={styles.card} data-mcp-app-card={callId}>
      <div className={styles.actions}>
        {mode === "closed" ? (
          <Button variant="outline" onClick={() => setMode(mcpApp.displayMode)}>
            {t("mcpAppViewShow")}
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={() =>
                setMode(mode === "inline" ? "fullscreen" : "inline")
              }
            >
              {t(
                mode === "inline" ? "mcpAppViewExpand" : "mcpAppViewShowInline",
              )}
            </Button>
            <Button variant="outline" onClick={close}>
              {t("mcpAppViewClose")}
            </Button>
          </>
        )}
      </div>
      {mode === "inline" && view("inline")}
      {mode === "fullscreen" && (
        <SessionManagedPanel
          viewerId={`mcp-app:${callId}`}
          sessionId={metadata.sessionId}
          title={label}
          label={label}
          onClose={close}
        >
          {panelView}
        </SessionManagedPanel>
      )}
    </div>
  );
}
