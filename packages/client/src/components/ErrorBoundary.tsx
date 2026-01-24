import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  serverVersion: string | null;
  versionLoading: boolean;
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
      serverVersion: null,
      versionLoading: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });

    // Fetch server version to help diagnose version mismatches
    this.fetchServerVersion();

    // Log error for debugging
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  async fetchServerVersion() {
    this.setState({ versionLoading: true });
    try {
      const res = await fetch("/api/version");
      if (res.ok) {
        const data = await res.json();
        this.setState({ serverVersion: data.current });
      }
    } catch {
      // Ignore - version fetch failed (might be why we're in an error state)
    } finally {
      this.setState({ versionLoading: false });
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  // Check if the error looks like a property access error (common in version mismatches)
  isLikelyVersionMismatch(): boolean {
    const { error } = this.state;
    if (!error) return false;

    const msg = error.message.toLowerCase();
    return (
      msg.includes("cannot read properties of undefined") ||
      msg.includes("cannot read property") ||
      msg.includes("is not a function") ||
      msg.includes("is undefined")
    );
  }

  render() {
    if (this.state.hasError) {
      const { error, serverVersion, versionLoading } = this.state;
      const isVersionMismatch = this.isLikelyVersionMismatch();

      return (
        <div style={styles.container}>
          <div style={styles.card}>
            <h1 style={styles.title}>Something went wrong</h1>

            {isVersionMismatch && (
              <div style={styles.versionWarning}>
                <strong>Possible version mismatch detected.</strong>
                <p style={styles.versionHint}>
                  The frontend and yepanywhere server may be running different
                  versions. Try refreshing or updating your yepanywhere
                  installation.
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
                <span style={styles.versionLabel}>Server version:</span>
                <span style={styles.versionValue}>
                  {versionLoading ? "Loading..." : serverVersion || "Unknown"}
                </span>
              </div>
              {isVersionMismatch && (
                <p style={styles.updateHint}>
                  To update: <code>npm i -g yepanywhere</code>
                </p>
              )}
            </div>

            <div style={styles.actions}>
              <button
                type="button"
                onClick={this.handleReload}
                style={styles.reloadButton}
              >
                Reload Page
              </button>
              <a
                href="https://github.com/anthropics/yep-anywhere/issues"
                target="_blank"
                rel="noopener noreferrer"
                style={styles.issueLink}
              >
                Report Issue
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
