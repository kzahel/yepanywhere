import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { type UploadedFile, api, uploadFile } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { ENTER_SENDS_MESSAGE } from "../constants";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { getModelSetting, getThinkingSetting } from "../hooks/useModelSettings";
import { useProjectLayout } from "../layouts";
import type { PermissionMode } from "../types";

interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string;
}

const MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

const MODE_LABELS: Record<PermissionMode, string> = {
  default: "Ask before edits",
  acceptEdits: "Edit automatically",
  plan: "Plan mode",
  bypassPermissions: "Bypass permissions",
};

const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: "Claude will ask for approval before making changes",
  acceptEdits: "Claude can edit files without asking",
  plan: "Claude will create a plan before implementing",
  bypassPermissions: "Skip all permission checks (use with caution)",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function NewSessionPage() {
  const {
    projectId,
    project,
    loading,
    error,
    openSidebar,
    isWideScreen,
    toggleSidebar,
    isSidebarCollapsed,
  } = useProjectLayout();
  const navigate = useNavigate();
  const [message, setMessage, draftControls] = useDraftPersistence(
    `draft-new-session-${projectId}`,
  );
  const [mode, setMode] = useState<PermissionMode>("default");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, { uploaded: number; total: number }>
  >({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;

    const newPendingFiles: PendingFile[] = Array.from(files).map((file) => ({
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined,
    }));

    setPendingFiles((prev) => [...prev, ...newPendingFiles]);
    e.target.value = ""; // Reset for re-selection
  };

  const handleRemoveFile = (id: string) => {
    setPendingFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file?.previewUrl) {
        URL.revokeObjectURL(file.previewUrl);
      }
      return prev.filter((f) => f.id !== id);
    });
  };

  const handleModeSelect = (selectedMode: PermissionMode) => {
    setMode(selectedMode);
  };

  const handleStartSession = async () => {
    if (!projectId || !message.trim() || isStarting) return;

    const trimmedMessage = message.trim();
    setIsStarting(true);

    try {
      let sessionId: string;
      let processId: string;
      const uploadedFiles: UploadedFile[] = [];

      // Get model settings from localStorage
      const model = getModelSetting();
      const thinking = getThinkingSetting();
      const sessionOptions = { mode, model, thinking };

      if (pendingFiles.length > 0) {
        // Two-phase flow: create session first, then upload to real session folder
        // Step 1: Create the session without sending a message
        const createResult = await api.createSession(projectId, sessionOptions);
        sessionId = createResult.sessionId;
        processId = createResult.processId;

        // Step 2: Upload files to the real session folder
        for (const pendingFile of pendingFiles) {
          try {
            const uploadedFile = await uploadFile(
              projectId,
              sessionId,
              pendingFile.file,
              {
                onProgress: (bytesUploaded) => {
                  setUploadProgress((prev) => ({
                    ...prev,
                    [pendingFile.id]: {
                      uploaded: bytesUploaded,
                      total: pendingFile.file.size,
                    },
                  }));
                },
              },
            );
            uploadedFiles.push(uploadedFile);
          } catch (uploadErr) {
            console.error("Failed to upload file:", uploadErr);
            // Continue with other files
          }
        }

        // Step 3: Send the first message with attachments
        await api.queueMessage(
          sessionId,
          trimmedMessage,
          mode,
          uploadedFiles.length > 0 ? uploadedFiles : undefined,
        );
      } else {
        // No files - use single-step flow for efficiency
        const result = await api.startSession(
          projectId,
          trimmedMessage,
          sessionOptions,
        );
        sessionId = result.sessionId;
        processId = result.processId;
      }

      // Clean up preview URLs
      for (const pf of pendingFiles) {
        if (pf.previewUrl) {
          URL.revokeObjectURL(pf.previewUrl);
        }
      }

      draftControls.clearDraft();
      // Pass initial status so SessionPage can connect SSE immediately
      // without waiting for getSession to complete
      navigate(`/projects/${projectId}/sessions/${sessionId}`, {
        state: { initialStatus: { state: "owned", processId } },
      });
    } catch (err) {
      console.error("Failed to start session:", err);
      draftControls.restoreFromStorage();
      setIsStarting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      if (ENTER_SENDS_MESSAGE) {
        if (e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        handleStartSession();
      } else {
        if (e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          handleStartSession();
        }
      }
    }
  };

  // Render loading/error states
  if (loading || error) {
    return (
      <div
        className={
          isWideScreen ? "main-content-wrapper" : "main-content-mobile"
        }
      >
        <div
          className={
            isWideScreen
              ? "main-content-constrained"
              : "main-content-mobile-inner"
          }
        >
          <PageHeader
            title="New Session"
            onOpenSidebar={openSidebar}
            onToggleSidebar={toggleSidebar}
            isWideScreen={isWideScreen}
            isSidebarCollapsed={isSidebarCollapsed}
          />
          <main className="sessions-page-content">
            {loading ? (
              <div className="loading">Loading...</div>
            ) : (
              <div className="error">Error: {error?.message}</div>
            )}
          </main>
        </div>
      </div>
    );
  }

  return (
    <div
      className={isWideScreen ? "main-content-wrapper" : "main-content-mobile"}
    >
      <div
        className={
          isWideScreen
            ? "main-content-constrained"
            : "main-content-mobile-inner"
        }
      >
        <PageHeader
          title={project?.name ?? "New Session"}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="sessions-page-content">
          <div className="new-session-container">
            <div className="new-session-header">
              <h1>Start a New Session</h1>
              <p className="new-session-subtitle">
                What would you like to work on?
              </p>
            </div>

            {/* Message Input Area */}
            <div className="new-session-input-area">
              <textarea
                ref={textareaRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Describe what you'd like Claude to help you with..."
                disabled={isStarting}
                rows={6}
                className="new-session-textarea"
              />

              {/* File Attachments Section */}
              <div className="new-session-attachments">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={handleFileSelect}
                />

                <button
                  type="button"
                  className="attach-files-button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStarting}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                  Attach files
                </button>

                {pendingFiles.length > 0 && (
                  <div className="pending-files-list">
                    {pendingFiles.map((pf) => {
                      const progress = uploadProgress[pf.id];
                      return (
                        <div key={pf.id} className="pending-file-chip">
                          {pf.previewUrl && (
                            <img
                              src={pf.previewUrl}
                              alt=""
                              className="pending-file-preview"
                            />
                          )}
                          <div className="pending-file-info">
                            <span className="pending-file-name">
                              {pf.file.name}
                            </span>
                            <span className="pending-file-size">
                              {progress
                                ? `${Math.round((progress.uploaded / progress.total) * 100)}%`
                                : formatSize(pf.file.size)}
                            </span>
                          </div>
                          {!isStarting && (
                            <button
                              type="button"
                              className="pending-file-remove"
                              onClick={() => handleRemoveFile(pf.id)}
                              aria-label={`Remove ${pf.file.name}`}
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                aria-hidden="true"
                              >
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Permission Mode Selection */}
            <div className="new-session-mode-section">
              <h3>Permission Mode</h3>
              <div className="mode-options">
                {MODE_ORDER.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`mode-option ${mode === m ? "selected" : ""}`}
                    onClick={() => handleModeSelect(m)}
                    disabled={isStarting}
                  >
                    <span className={`mode-option-dot mode-${m}`} />
                    <div className="mode-option-content">
                      <span className="mode-option-label">
                        {MODE_LABELS[m]}
                      </span>
                      <span className="mode-option-desc">
                        {MODE_DESCRIPTIONS[m]}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Submit Button */}
            <div className="new-session-actions">
              <Link
                to={`/projects/${projectId}`}
                className="cancel-button"
                tabIndex={isStarting ? -1 : 0}
              >
                Cancel
              </Link>
              <button
                type="button"
                onClick={handleStartSession}
                disabled={isStarting || !message.trim()}
                className="start-session-button"
              >
                {isStarting ? (
                  <>
                    <span className="spinner" />
                    Starting...
                  </>
                ) : (
                  <>
                    Start Session
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                  </>
                )}
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
