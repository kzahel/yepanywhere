import { Component, type ErrorInfo, type ReactNode } from "react";
import enMessages from "../i18n/en.json";
import { activityBus } from "../lib/activityBus";
import { writeClipboardText } from "../lib/clipboard";
import { retirePrebootComposer } from "../lib/prebootComposer";
import { UI_KEYS } from "../lib/storageKeys";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  crashContext: CrashContext | null;
  serverVersion: string | null;
  versionLoading: boolean;
  copyStatus: "idle" | "copied" | "failed";
}

interface CrashContext {
  capturedAt: string;
  url: string;
  userAgent: string;
  /**
   * Whether the tab was on screen when it crashed. A hidden tab runs on
   * throttled timers and wakes with its backlog, which is a different story
   * from the same crash in front of the reader.
   */
  visibility: string;
  /** Newest first, each as "<event type> <age>s". See the activity bus. */
  recentActivityEvents: string[];
  dom: {
    nodes: number;
    messageRows: number;
    streamingBlocks: number;
    conversationActivityRows: number;
    thinkingPreviewRows: number;
  };
  preferences: {
    conversationView: string | null;
    conversationViewTurnLimit: string | null;
    thinkingVisible: string | null;
  };
}

const GITHUB_ISSUES_URL = "https://github.com/kzahel/yepanywhere/issues/new";

function getClientVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown";
}

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function redactClientCrashUrl(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return "unknown";
  }
  const segments = url.pathname.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === "share") {
      segments[index + 1] = "[redacted]";
    }
  }
  const route = segments.join("/");
  return url.origin === "null"
    ? `${url.protocol}${route}`
    : `${url.origin}${route}`;
}

function captureCrashContext(): CrashContext {
  const capturedAtMs = Date.now();
  return {
    capturedAt: new Date(capturedAtMs).toISOString(),
    url: redactClientCrashUrl(window.location.href),
    userAgent: navigator.userAgent,
    visibility: document.visibilityState,
    recentActivityEvents: activityBus
      .getRecentEvents()
      .map(
        (event) =>
          `${event.type}${event.origin === "local" ? " (local)" : ""} ${(
            (capturedAtMs - event.atMs) / 1000
          ).toFixed(1)}s`,
      )
      .reverse(),
    dom: {
      nodes: document.getElementsByTagName("*").length,
      messageRows: document.querySelectorAll("[data-message-render-row]")
        .length,
      streamingBlocks: document.querySelectorAll(".streaming-block").length,
      conversationActivityRows: document.querySelectorAll(
        "[data-conversation-activity-row]",
      ).length,
      thinkingPreviewRows: document.querySelectorAll(
        "[data-conversation-thinking-preview]",
      ).length,
    },
    preferences: {
      conversationView: readPreference(UI_KEYS.conversationView),
      conversationViewTurnLimit: readPreference(
        UI_KEYS.conversationViewTurnLimit,
      ),
      thinkingVisible: readPreference(UI_KEYS.sessionThinkingVisible),
    },
  };
}

export function formatClientCrashDiagnostic(
  error: Error | null,
  errorInfo: ErrorInfo | null,
  context: CrashContext | null,
  serverVersion: string | null,
): string {
  const lines = [
    "Yep Anywhere client fatal error",
    `Timestamp: ${context?.capturedAt ?? "unknown"}`,
    `URL: ${context?.url ?? "unknown"}`,
    `Client version: ${getClientVersion()}`,
    `Server version: ${serverVersion ?? "unknown"}`,
    `User agent: ${context?.userAgent ?? "unknown"}`,
    `Tab: ${context?.visibility ?? "unknown"}`,
    `DOM: ${JSON.stringify(context?.dom ?? null)}`,
    `Preferences: ${JSON.stringify(context?.preferences ?? null)}`,
    `Activity events before the crash (newest first): ${
      context?.recentActivityEvents?.length
        ? context.recentActivityEvents.join(", ")
        : "none"
    }`,
    "",
    `Error: ${error?.message ?? "Unknown error"}`,
  ];

  if (error?.stack) {
    lines.push("", "JavaScript stack:", error.stack);
  }
  if (errorInfo?.componentStack) {
    lines.push("", "React component stack:", errorInfo.componentStack);
  }
  return lines.join("\n");
}

export function buildClientCrashIssueUrl(
  error: Error | null,
  diagnostic: string,
): string {
  const titleMessage = (error?.message ?? "Unknown error")
    .split("\n", 1)[0]
    ?.slice(0, 100);
  const body = [
    "## What was happening",
    "",
    "<!-- What action or live update immediately preceded the crash? -->",
    "",
    "## Diagnostic",
    "",
    "```text",
    diagnostic,
    "```",
  ].join("\n");
  const params = new URLSearchParams({
    title: `Client crash: ${titleMessage}`,
    body,
    labels: "bug",
  });
  return `${GITHUB_ISSUES_URL}?${params.toString()}`;
}

/**
 * Error boundary that catches rendering errors and displays a helpful fallback UI.
 * Shows version information to help diagnose client/server version mismatches.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      crashContext: null,
      serverVersion: null,
      versionLoading: false,
      copyStatus: "idle",
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // This render-phase hook still sees the previously committed session DOM;
    // componentDidCatch runs after React has replaced it with the fallback.
    return { hasError: true, error, crashContext: captureCrashContext() };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const crashContext = this.state.crashContext ?? captureCrashContext();
    this.setState({ errorInfo, crashContext, versionLoading: true });
    // The crash report must not sit under a composer that will never load.
    retirePrebootComposer();

    // Fetch server version to help diagnose version mismatches
    this.fetchServerVersion();

    // Keep one self-contained string so optional remote console collection
    // preserves the component stack instead of depending on object formatting.
    console.error(
      `[ErrorBoundary] Fatal client render error\n${formatClientCrashDiagnostic(
        error,
        errorInfo,
        crashContext,
        null,
      )}`,
    );
  }

  async fetchServerVersion() {
    try {
      const res = await fetch("/api/version");
      if (res.ok) {
        const data = (await res.json()) as { current?: unknown };
        this.setState({
          serverVersion: typeof data.current === "string" ? data.current : null,
          versionLoading: false,
        });
        return;
      }
    } catch {
      // Ignore - version fetch failed (might be why we're in an error state)
    }
    this.setState({ versionLoading: false });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleCopyDiagnostics = async () => {
    const diagnostic = formatClientCrashDiagnostic(
      this.state.error,
      this.state.errorInfo,
      this.state.crashContext,
      this.state.serverVersion,
    );
    const copied = await writeClipboardText(diagnostic);
    this.setState({ copyStatus: copied ? "copied" : "failed" });
  };

  /**
   * Whether the frontend and server are actually running different versions.
   *
   * Both versions are known here: the client's is compiled in and the
   * server's was fetched when the error was caught. A server that did not
   * answer leaves `serverVersion` null, which the diagnostic below reports as
   * unknown; an unanswered request is not evidence of a mismatch.
   */
  isLikelyVersionMismatch(): boolean {
    const { serverVersion } = this.state;
    if (!serverVersion) return false;
    return serverVersion !== getClientVersion();
  }

  render() {
    if (this.state.hasError) {
      const {
        error,
        errorInfo,
        crashContext,
        serverVersion,
        versionLoading,
        copyStatus,
      } = this.state;
      const isVersionMismatch = this.isLikelyVersionMismatch();
      const diagnostic = formatClientCrashDiagnostic(
        error,
        errorInfo,
        crashContext,
        serverVersion,
      );
      const issueUrl = buildClientCrashIssueUrl(error, diagnostic);
      const copyLabel =
        copyStatus === "copied"
          ? enMessages.errorBoundaryDiagnosticsCopied
          : copyStatus === "failed"
            ? enMessages.errorBoundaryDiagnosticsCopyFailed
            : enMessages.errorBoundaryCopyDiagnostics;

      return (
        <div style={styles.container}>
          <div style={styles.card}>
            <h1 style={styles.title}>{enMessages.errorBoundaryTitle}</h1>

            {isVersionMismatch && (
              <div style={styles.versionWarning}>
                <strong>{enMessages.errorBoundaryVersionMismatchTitle}</strong>
                <p style={styles.versionHint}>
                  {enMessages.errorBoundaryVersionMismatchHint}
                </p>
              </div>
            )}

            <div style={styles.errorBox}>
              <code style={styles.errorText}>
                {error?.message || "Unknown error"}
              </code>
            </div>

            <div style={styles.versionInfo}>
              <div style={styles.versionRow}>
                <span style={styles.versionLabel}>
                  {enMessages.errorBoundaryServerVersion}
                </span>
                <span style={styles.versionValue}>
                  {versionLoading ? "Loading..." : serverVersion || "Unknown"}
                </span>
              </div>
              {isVersionMismatch && (
                <p style={styles.updateHint}>
                  {enMessages.errorBoundaryToUpdate}{" "}
                  <code>npm i -g yepanywhere</code>
                </p>
              )}
            </div>

            <div style={styles.diagnosticSection}>
              <details style={styles.diagnosticDetails}>
                <summary style={styles.diagnosticSummary}>
                  {enMessages.errorBoundaryDiagnosticDetails}
                </summary>
                <pre style={styles.diagnosticText}>{diagnostic}</pre>
              </details>
              <button
                type="button"
                onClick={this.handleCopyDiagnostics}
                style={styles.diagnosticCopyButton}
                aria-label={copyLabel}
                title={copyLabel}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {copyStatus === "copied" ? (
                    <path d="m5 12 4 4L19 6" />
                  ) : (
                    <>
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </>
                  )}
                </svg>
              </button>
            </div>

            <div style={styles.actions}>
              <button
                type="button"
                onClick={this.handleReload}
                style={styles.reloadButton}
              >
                {enMessages.errorBoundaryReloadPage}
              </button>
              <button
                type="button"
                onClick={this.handleCopyDiagnostics}
                style={styles.secondaryButton}
              >
                {copyLabel}
              </button>
              <a
                href={issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.issueLink}
              >
                {enMessages.errorBoundaryReportIssue}
              </a>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Inline styles to ensure they work even if CSS fails to load
const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    padding: "20px",
    backgroundColor: "#1a1a2e",
    color: "#e4e4e7",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  card: {
    maxWidth: "500px",
    width: "100%",
    padding: "32px",
    backgroundColor: "#16162a",
    borderRadius: "12px",
    border: "1px solid #3f3f46",
  },
  title: {
    margin: "0 0 20px 0",
    fontSize: "24px",
    fontWeight: 600,
    color: "#f4f4f5",
  },
  versionWarning: {
    padding: "16px",
    marginBottom: "20px",
    backgroundColor: "#422006",
    border: "1px solid #92400e",
    borderRadius: "8px",
    color: "#fcd34d",
  },
  versionHint: {
    margin: "8px 0 0 0",
    fontSize: "14px",
    color: "#fde68a",
  },
  errorBox: {
    padding: "12px 16px",
    marginBottom: "20px",
    backgroundColor: "#27272a",
    borderRadius: "6px",
    overflow: "auto",
  },
  errorText: {
    fontSize: "13px",
    color: "#fca5a5",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  versionInfo: {
    marginBottom: "24px",
    padding: "12px 16px",
    backgroundColor: "#27272a",
    borderRadius: "6px",
  },
  versionRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  versionLabel: {
    fontSize: "14px",
    color: "#a1a1aa",
  },
  versionValue: {
    fontSize: "14px",
    fontFamily: "monospace",
    color: "#e4e4e7",
  },
  updateHint: {
    margin: "12px 0 0 0",
    fontSize: "13px",
    color: "#a1a1aa",
  },
  diagnosticSection: {
    position: "relative",
    marginBottom: "24px",
  },
  diagnosticDetails: {
    padding: "12px 16px",
    backgroundColor: "#27272a",
    borderRadius: "6px",
  },
  diagnosticSummary: {
    paddingRight: "44px",
    lineHeight: "44px",
    cursor: "pointer",
    fontSize: "14px",
    color: "#d4d4d8",
  },
  diagnosticCopyButton: {
    position: "absolute",
    top: "12px",
    right: "16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "44px",
    height: "44px",
    padding: 0,
    color: "#d4d4d8",
    backgroundColor: "transparent",
    border: "1px solid #52525b",
    borderRadius: "6px",
    cursor: "pointer",
  },
  diagnosticText: {
    maxHeight: "240px",
    margin: "12px 0 0 0",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontSize: "11px",
    color: "#d4d4d8",
  },
  actions: {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
  },
  reloadButton: {
    flex: 1,
    minWidth: "120px",
    padding: "12px 24px",
    fontSize: "15px",
    fontWeight: 500,
    color: "#fff",
    backgroundColor: "#6366f1",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  },
  secondaryButton: {
    flex: 1,
    minWidth: "120px",
    padding: "12px 24px",
    fontSize: "15px",
    fontWeight: 500,
    color: "#d4d4d8",
    backgroundColor: "transparent",
    border: "1px solid #52525b",
    borderRadius: "8px",
    cursor: "pointer",
  },
  issueLink: {
    flex: 1,
    minWidth: "120px",
    padding: "12px 24px",
    fontSize: "15px",
    fontWeight: 500,
    color: "#a1a1aa",
    backgroundColor: "transparent",
    border: "1px solid #3f3f46",
    borderRadius: "8px",
    textAlign: "center",
    textDecoration: "none",
  },
};
