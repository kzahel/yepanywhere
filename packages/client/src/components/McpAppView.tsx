import {
  MCP_APP_MIME_TYPE,
  MCP_APP_PROXY_PATH,
  MCP_APP_PROXY_SANDBOX,
  type McpAppApprovalRequired,
  type McpAppDisplayMode,
  type McpAppHostRequest,
  type McpAppResourceCsp,
  type McpAppToolCall,
  mcpAppModelContextText,
} from "@yep-anywhere/shared";
import type { ToolResultData } from "@yep-anywhere/shared/transcript/items";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useResolvedTheme } from "../hooks/useTheme";
import { useI18n } from "../i18n";
import { McpAppBridge, mcpAppToolResult } from "../lib/mcpAppBridge";
import { Button } from "./ui/Button";
import styles from "./McpAppView.module.css";

interface LoadedView {
  html: string;
  csp: McpAppResourceCsp;
  prefersBorder?: boolean;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; view: LoadedView }
  | { kind: "error"; message: string };

interface PendingApproval {
  toolTitle: string;
  resolve: (decision: "once" | "always" | "deny") => void;
}

const INLINE_MIN_HEIGHT = 80;
const INLINE_MAX_HEIGHT = 600;
const HOST_VERSION = "1";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function decodeBase64Utf8(blob: string): string {
  const bytes = Uint8Array.from(atob(blob), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The view resource's HTML and declared policy, or why it is unusable. */
export function mcpAppViewFromResource(response: unknown): LoadedView {
  const contents = record(response).contents;
  const first = record(Array.isArray(contents) ? contents[0] : undefined);
  const mimeType =
    typeof first.mimeType === "string"
      ? first.mimeType.replace(/\s+/g, "").toLowerCase()
      : "";
  if (mimeType !== MCP_APP_MIME_TYPE) {
    throw new Error(
      `The view resource is ${mimeType || "untyped"}, not ${MCP_APP_MIME_TYPE}`,
    );
  }
  const html =
    typeof first.text === "string"
      ? first.text
      : typeof first.blob === "string"
        ? decodeBase64Utf8(first.blob)
        : undefined;
  if (html === undefined) throw new Error("The view resource has no content");
  const ui = record(record(first._meta).ui);
  const csp = record(ui.csp) as McpAppResourceCsp;
  return {
    html,
    csp,
    ...(typeof ui.prefersBorder === "boolean"
      ? { prefersBorder: ui.prefersBorder }
      : {}),
  };
}

/**
 * One MCP App view, framed through the sandbox proxy on the isolated artifact
 * origin and connected to YA by the bridge. Loading it fetches the resource
 * from the live session; nothing runs until the reader asks to see it.
 */
export function McpAppView({
  call,
  callId,
  projectId,
  sessionId,
  proxyOrigin,
  toolInput,
  toolResult,
  status,
  displayMode,
  onRequestDisplayMode,
  insertIntoComposer,
}: {
  call: McpAppToolCall;
  callId: string;
  projectId: string;
  sessionId: string;
  proxyOrigin: string;
  toolInput: unknown;
  toolResult?: ToolResultData;
  status: string;
  displayMode: McpAppDisplayMode;
  onRequestDisplayMode: (mode: string) => McpAppDisplayMode;
  insertIntoComposer: ((text: string) => unknown) | null;
}) {
  const { t } = useI18n();
  const runtime = useCurrentSourceRuntime();
  const theme = useResolvedTheme();
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [height, setHeight] = useState(INLINE_MIN_HEIGHT * 2);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const allowAllRef = useRef(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [bridge, setBridge] = useState<McpAppBridge | null>(null);
  // Read when the bridge is built or a handler runs; a change alone does not
  // rebuild the bridge, which would reload the view.
  const latest = useRef({
    displayMode,
    onRequestDisplayMode,
    insertIntoComposer,
    toolInput,
    theme,
  });
  latest.current = {
    displayMode,
    onRequestDisplayMode,
    insertIntoComposer,
    toolInput,
    theme,
  };

  const request = useCallback(
    (body: McpAppHostRequest) =>
      runtime.transport.fetch<unknown>(
        `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/mcp-apps`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    [runtime.transport, projectId, sessionId],
  );

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    request({
      kind: "readResource",
      server: call.server,
      uri: call.resourceUri,
      originCallId: callId,
    })
      .then((response) => {
        if (!cancelled)
          setState({ kind: "ready", view: mcpAppViewFromResource(response) });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [request, call.server, call.resourceUri, callId]);

  const view = state.kind === "ready" ? state.view : null;
  useEffect(() => {
    if (!view) return;
    const askApproval = (toolTitle: string) =>
      new Promise<"once" | "always" | "deny">((resolve) =>
        setApproval({
          toolTitle,
          resolve: (decision) => {
            setApproval(null);
            resolve(decision);
          },
        }),
      );
    const created = new McpAppBridge({
      frame: () => frameRef.current?.contentWindow,
      proxyOrigin,
      html: view.html,
      csp: view.csp,
      hostVersion: HOST_VERSION,
      toolInput: latest.current.toolInput,
      hostContext: {
        toolInfo: { id: callId, tool: { name: call.tool, inputSchema: {} } },
        theme: latest.current.theme,
        displayMode: latest.current.displayMode,
        availableDisplayModes: ["inline", "fullscreen"],
        platform: window.matchMedia?.("(pointer: coarse)").matches
          ? "mobile"
          : "web",
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        containerDimensions:
          latest.current.displayMode === "inline"
            ? { maxHeight: INLINE_MAX_HEIGHT }
            : {},
      },
      handlers: {
        callTool: async (name, args) => {
          const call_ = {
            kind: "callTool" as const,
            server: call.server,
            tool: name,
            ...(args ? { arguments: args } : {}),
          };
          let response = await request({
            ...call_,
            approved: allowAllRef.current,
          });
          if (record(response).approvalRequired === true) {
            const decision = await askApproval(
              (response as McpAppApprovalRequired).toolTitle,
            );
            if (decision === "deny") throw new Error("The reader declined");
            if (decision === "always") allowAllRef.current = true;
            response = await request({ ...call_, approved: true });
          }
          return response;
        },
        readResource: (uri) =>
          request({
            kind: "readResource",
            server: call.server,
            uri,
            originCallId: callId,
          }),
        openLink: (url) => {
          window.open(url, "_blank", "noopener,noreferrer");
        },
        message: (text) => {
          const insert = latest.current.insertIntoComposer;
          if (!insert) throw new Error("No composer is available");
          insert(text);
        },
        updateModelContext: async (params) => {
          await request({
            kind: "updateModelContext",
            key: callId,
            server: call.server,
            tool: call.tool,
            text: mcpAppModelContextText(params),
          });
        },
        requestDisplayMode: (mode) => latest.current.onRequestDisplayMode(mode),
        sizeChanged: ({ height: next }) => {
          if (next !== undefined)
            setHeight(
              Math.max(INLINE_MIN_HEIGHT, Math.min(INLINE_MAX_HEIGHT, next)),
            );
        },
      },
    });
    setBridge(created);
    const listener = (event: MessageEvent) => created.handleMessage(event);
    window.addEventListener("message", listener);
    return () => {
      window.removeEventListener("message", listener);
      void created.teardown("closed");
      setBridge(null);
    };
  }, [view, proxyOrigin, request, call.server, call.tool, callId]);

  useEffect(() => {
    if (!bridge) return;
    if (toolResult && status !== "pending") {
      bridge.setToolResult(
        mcpAppToolResult(toolResult.content, toolResult.isError),
      );
    } else if (status === "aborted" || status === "incomplete") {
      bridge.setCancelled(status);
    }
  }, [bridge, toolResult, status]);

  useEffect(() => {
    bridge?.setHostContext({ theme });
  }, [bridge, theme]);

  if (state.kind === "loading")
    return (
      <p className={styles.status} role="status">
        {t("mcpAppViewLoading")}
      </p>
    );
  if (state.kind === "error")
    return (
      <p className={styles.status} role="alert">
        {t("mcpAppViewUnavailable", { reason: state.message })}
      </p>
    );
  const src = `${proxyOrigin}${MCP_APP_PROXY_PATH}?host=${encodeURIComponent(window.location.origin)}&csp=${encodeURIComponent(JSON.stringify(state.view.csp))}`;
  return (
    <div
      className={`${styles.view} ${displayMode === "inline" ? styles.inline : styles.fill} ${state.view.prefersBorder === false ? "" : styles.bordered}`}
    >
      {approval && (
        <div className={styles.approval} role="alertdialog">
          <span>
            {t("mcpAppViewApprove", {
              server: call.server,
              tool: approval.toolTitle,
            })}
          </span>
          <Button variant="primary" onClick={() => approval.resolve("once")}>
            {t("mcpAppViewAllowOnce")}
          </Button>
          <Button onClick={() => approval.resolve("always")}>
            {t("mcpAppViewAllowAlways")}
          </Button>
          <Button onClick={() => approval.resolve("deny")}>
            {t("mcpAppViewDeny")}
          </Button>
        </div>
      )}
      <iframe
        ref={frameRef}
        src={src}
        title={t("mcpAppViewFrame", { server: call.server, tool: call.tool })}
        sandbox={MCP_APP_PROXY_SANDBOX}
        referrerPolicy="no-referrer"
        className={styles.frame}
        style={displayMode === "inline" ? { height } : undefined}
      />
    </div>
  );
}
