import { useState } from "react";
import type { RemoteExecutorTestResult } from "../../api/client";
import { useRemoteExecutors } from "../../hooks/useRemoteExecutors";

interface ExecutorStatus {
  testing: boolean;
  result?: RemoteExecutorTestResult;
}

export function RemoteExecutorsSettings() {
  const { executors, loading, addExecutor, removeExecutor, testExecutor } =
    useRemoteExecutors();

  const [newHost, setNewHost] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [executorStatus, setExecutorStatus] = useState<
    Record<string, ExecutorStatus>
  >({});

  const handleAddExecutor = async () => {
    if (!newHost.trim() || isAdding) return;

    setIsAdding(true);
    setAddError(null);

    try {
      await addExecutor(newHost.trim());
      setNewHost("");
    } catch (err) {
      setAddError(
        err instanceof Error ? err.message : "Failed to add executor",
      );
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemoveExecutor = async (host: string) => {
    try {
      await removeExecutor(host);
      // Clear status for removed executor
      setExecutorStatus((prev) => {
        const { [host]: _, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      console.error("Failed to remove executor:", err);
    }
  };

  const handleTestExecutor = async (host: string) => {
    setExecutorStatus((prev) => ({
      ...prev,
      [host]: { testing: true },
    }));

    try {
      const result = await testExecutor(host);
      setExecutorStatus((prev) => ({
        ...prev,
        [host]: { testing: false, result },
      }));
    } catch (err) {
      setExecutorStatus((prev) => ({
        ...prev,
        [host]: {
          testing: false,
          result: {
            success: false,
            error: err instanceof Error ? err.message : "Connection failed",
          },
        },
      }));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddExecutor();
    }
  };

  return (
    <section className="settings-section">
      <h2>Remote Executors</h2>
      <p className="settings-section-description">
        Run Claude sessions on remote machines via SSH. Add SSH host aliases
        from your ~/.ssh/config file.
      </p>

      {/* Add new executor */}
      <div className="settings-group">
        <div className="settings-item">
          <div className="settings-item-info">
            <strong>Add Remote Executor</strong>
            <p>Enter an SSH host alias (e.g., "devbox", "gpu-server")</p>
          </div>
          <div className="remote-executor-add">
            <input
              type="text"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="SSH host alias"
              disabled={isAdding}
              className="remote-executor-input"
            />
            <button
              type="button"
              onClick={handleAddExecutor}
              disabled={!newHost.trim() || isAdding}
              className="remote-executor-add-button"
            >
              {isAdding ? "Adding..." : "Add"}
            </button>
          </div>
          {addError && <p className="settings-error">{addError}</p>}
        </div>
      </div>

      {/* Executor list */}
      <div className="settings-group">
        <h3>Configured Executors</h3>
        {loading ? (
          <p className="settings-loading">Loading...</p>
        ) : executors.length === 0 ? (
          <p className="settings-empty">
            No remote executors configured. Add one above to run sessions on
            remote machines.
          </p>
        ) : (
          <div className="remote-executor-list">
            {executors.map((host) => {
              const status = executorStatus[host];
              return (
                <div key={host} className="remote-executor-item">
                  <div className="remote-executor-item-info">
                    <span className="remote-executor-host">{host}</span>
                    {status?.result && (
                      <span
                        className={`settings-status-badge ${status.result.success ? "settings-status-detected" : "settings-status-not-detected"}`}
                      >
                        {status.result.success ? "Connected" : "Failed"}
                      </span>
                    )}
                  </div>
                  {status?.result && !status.result.success && (
                    <p className="settings-error remote-executor-error">
                      {status.result.error}
                    </p>
                  )}
                  {status?.result?.success && (
                    <p className="remote-executor-details">
                      {status.result.claudeAvailable
                        ? "Claude CLI available"
                        : "Claude CLI not found"}
                    </p>
                  )}
                  <div className="remote-executor-actions">
                    <button
                      type="button"
                      onClick={() => handleTestExecutor(host)}
                      disabled={status?.testing}
                      className="remote-executor-test-button"
                    >
                      {status?.testing ? "Testing..." : "Test Connection"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveExecutor(host)}
                      className="remote-executor-remove-button"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Help text */}
      <div className="settings-group">
        <h3>Setup Requirements</h3>
        <ul className="settings-requirements">
          <li>SSH host alias configured in ~/.ssh/config</li>
          <li>SSH key-based authentication (no password prompts)</li>
          <li>Claude CLI installed on the remote machine</li>
          <li>
            Project paths must be the same on local and remote machines (e.g.,
            ~/code/project)
          </li>
        </ul>
      </div>
    </section>
  );
}
