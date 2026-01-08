import {
  type ModelInfo,
  type ProviderName,
  resolveModel,
} from "@yep-anywhere/shared";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { type UploadedFile, api, uploadFile } from "../api/client";
import { ENTER_SENDS_MESSAGE } from "../constants";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import {
  getModelSetting,
  getThinkingSetting,
  useModelSettings,
} from "../hooks/useModelSettings";
import {
  getAvailableProviders,
  getDefaultProvider,
  useProviders,
} from "../hooks/useProviders";
import type { PermissionMode } from "../types";
import { FilterDropdown, type FilterOption } from "./FilterDropdown";
import { clearFabPrefill, getFabPrefill } from "./FloatingActionButton";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";

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

export interface NewSessionFormProps {
  projectId: string;
  /** Whether to focus the textarea on mount (default: true) */
  autoFocus?: boolean;
  /** Number of rows for the textarea (default: 6) */
  rows?: number;
  /** Placeholder text for the textarea */
  placeholder?: string;
  /** Compact mode: no header, no mode selector (default: false) */
  compact?: boolean;
}

export function NewSessionForm({
  projectId,
  autoFocus = true,
  rows = 6,
  placeholder = "Describe what you'd like help with...",
  compact = false,
}: NewSessionFormProps) {
  const navigate = useNavigate();
  const [message, setMessage, draftControls] = useDraftPersistence(
    `draft-new-session-${projectId}`,
  );
  const [mode, setMode] = useState<PermissionMode>("default");
  const [selectedProvider, setSelectedProvider] = useState<ProviderName | null>(
    null,
  );
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, { uploaded: number; total: number }>
  >({});
  const [interimTranscript, setInterimTranscript] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);

  // Thinking toggle state
  const { thinkingEnabled, toggleThinking, thinkingLevel } = useModelSettings();

  // Fetch available providers
  const { providers, loading: providersLoading } = useProviders();
  const availableProviders = getAvailableProviders(providers);

  // Get models and capabilities for the currently selected provider
  const selectedProviderInfo = providers.find(
    (p) => p.name === selectedProvider,
  );
  const availableModels: ModelInfo[] = selectedProviderInfo?.models ?? [];
  // Default to true for backwards compatibility with providers that don't set these flags
  const supportsPermissionMode =
    selectedProviderInfo?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    selectedProviderInfo?.supportsThinkingToggle ?? true;

  // Set default provider when providers load
  useEffect(() => {
    if (!selectedProvider && providers.length > 0) {
      const defaultProvider = getDefaultProvider(providers);
      if (defaultProvider) {
        setSelectedProvider(defaultProvider.name);
        // Set default model based on user settings
        if (defaultProvider.models && defaultProvider.models.length > 0) {
          const targetModelId = resolveModel(getModelSetting());
          // Find the preferred model in available models
          const matchingModel = defaultProvider.models.find(
            (m) => m.id === targetModelId,
          );
          // Use preferred model if available, otherwise fall back to first model
          setSelectedModel(
            matchingModel?.id ?? defaultProvider.models[0]?.id ?? null,
          );
        }
      }
    }
  }, [providers, selectedProvider]);

  // When provider changes, reset model based on user settings
  const handleProviderSelect = (providerName: ProviderName) => {
    setSelectedProvider(providerName);
    const provider = providers.find((p) => p.name === providerName);
    if (provider?.models && provider.models.length > 0) {
      const targetModelId = resolveModel(getModelSetting());
      // Find the preferred model in available models
      const matchingModel = provider.models.find((m) => m.id === targetModelId);
      // Use preferred model if available, otherwise fall back to first model
      setSelectedModel(matchingModel?.id ?? provider.models[0]?.id ?? null);
    } else {
      setSelectedModel(null);
    }
  };

  // Build model options for FilterDropdown
  const modelOptions = useMemo((): FilterOption<string>[] => {
    return availableModels.map((model) => ({
      value: model.id,
      label: model.size
        ? `${model.name} (${(model.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`
        : model.name,
    }));
  }, [availableModels]);

  // Handle model selection from FilterDropdown
  const handleModelSelect = useCallback((selected: string[]) => {
    setSelectedModel(selected[0] ?? null);
  }, []);

  // Combined display text: committed text + interim transcript
  const displayText = interimTranscript
    ? message + (message.trimEnd() ? " " : "") + interimTranscript
    : message;

  // Focus textarea on mount if autoFocus is enabled
  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  // Check for FAB pre-fill on mount (when coming from FloatingActionButton)
  useEffect(() => {
    const prefill = getFabPrefill();
    if (prefill) {
      setMessage(prefill);
      clearFabPrefill();
      // Focus and move cursor to end
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(prefill.length, prefill.length);
      }
    }
  }, [setMessage]);

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
    // Stop voice recording and get any pending interim text
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";

    // Combine committed text with any pending voice text
    let finalMessage = message.trimEnd();
    if (pendingVoice) {
      finalMessage = finalMessage
        ? `${finalMessage} ${pendingVoice}`
        : pendingVoice;
    }

    const hasContent = finalMessage.trim() || pendingFiles.length > 0;
    if (!projectId || !hasContent || isStarting) return;

    const trimmedMessage = finalMessage.trim();
    setInterimTranscript("");
    setIsStarting(true);

    try {
      let sessionId: string;
      let processId: string;
      const uploadedFiles: UploadedFile[] = [];

      // Get model and thinking settings
      const thinking = getThinkingSetting();
      const sessionOptions = {
        mode,
        model: selectedModel ?? undefined,
        thinking,
        provider: selectedProvider ?? undefined,
      };

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
      // Also pass initial message as optimistic title (session name = first message)
      navigate(`/projects/${projectId}/sessions/${sessionId}`, {
        state: {
          initialStatus: { state: "owned", processId },
          initialTitle: trimmedMessage,
        },
      });
    } catch (err) {
      console.error("Failed to start session:", err);
      draftControls.restoreFromStorage();
      setIsStarting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      // On mobile (touch devices), Enter adds newline - must use send button
      // On desktop, Enter sends message, Shift/Ctrl+Enter adds newline
      const isMobile = window.matchMedia("(pointer: coarse)").matches;

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        handleStartSession();
        return;
      }

      if (isMobile) {
        // Mobile: Enter always adds newline, send button required
        return;
      }

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

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      const newPendingFiles: PendingFile[] = files.map((file) => ({
        id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined,
      }));
      setPendingFiles((prev) => [...prev, ...newPendingFiles]);
    }
  };

  // Voice input handlers
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      const trimmed = message.trimEnd();
      if (trimmed) {
        setMessage(`${trimmed} ${transcript}`);
      } else {
        setMessage(transcript);
      }
      setInterimTranscript("");
    },
    [message, setMessage],
  );

  const handleInterimTranscript = useCallback((transcript: string) => {
    setInterimTranscript(transcript);
  }, []);

  const hasContent = message.trim() || pendingFiles.length > 0;

  // Shared input area with toolbar (textarea + attach/voice on left, send on right)
  const inputArea = (
    <>
      <textarea
        ref={textareaRef}
        value={displayText}
        onChange={(e) => {
          setInterimTranscript("");
          setMessage(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={placeholder}
        disabled={isStarting}
        rows={rows}
        className="new-session-form-textarea"
      />
      <div className="new-session-form-toolbar">
        <div className="new-session-form-toolbar-left">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFileSelect}
          />
          <button
            type="button"
            className="toolbar-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStarting}
            aria-label="Attach files"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <VoiceInputButton
            ref={voiceButtonRef}
            onTranscript={handleVoiceTranscript}
            onInterimTranscript={handleInterimTranscript}
            onListeningStart={() => textareaRef.current?.focus()}
            disabled={isStarting}
            className="toolbar-button"
          />
          {supportsThinkingToggle && (
            <button
              type="button"
              className={`toolbar-button ${thinkingEnabled ? "active" : ""}`}
              onClick={toggleThinking}
              disabled={isStarting}
              title={
                thinkingEnabled
                  ? `Extended thinking: ${thinkingLevel}`
                  : "Enable extended thinking"
              }
              aria-pressed={thinkingEnabled}
              aria-label="Toggle extended thinking"
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
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={handleStartSession}
          disabled={isStarting || !hasContent}
          className="send-button"
          aria-label="Start session"
        >
          <span className="send-icon">{isStarting ? "..." : "↑"}</span>
        </button>
      </div>
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
                  <span className="pending-file-name">{pf.file.name}</span>
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
    </>
  );

  // Compact mode: just the input area, no header or mode selector
  if (compact) {
    return (
      <div
        className={`new-session-form new-session-form-compact ${interimTranscript ? "voice-recording" : ""}`}
      >
        {inputArea}
      </div>
    );
  }

  // Full mode: form with header, input area, and mode selector
  return (
    <div
      className={`new-session-form new-session-container ${interimTranscript ? "voice-recording" : ""}`}
    >
      <div className="new-session-header">
        <h1>Start a New Session</h1>
        <p className="new-session-subtitle">What would you like to work on?</p>
      </div>

      <div className="new-session-input-area">{inputArea}</div>

      {/* Provider Selection */}
      {!providersLoading && availableProviders.length > 1 && (
        <div className="new-session-provider-section">
          <h3>AI Provider</h3>
          <div className="provider-options">
            {providers.map((p) => {
              const isAvailable = p.installed && (p.authenticated || p.enabled);
              const isSelected = selectedProvider === p.name;
              return (
                <button
                  key={p.name}
                  type="button"
                  className={`provider-option ${isSelected ? "selected" : ""} ${!isAvailable ? "disabled" : ""}`}
                  onClick={() => isAvailable && handleProviderSelect(p.name)}
                  disabled={isStarting || !isAvailable}
                  title={
                    !isAvailable
                      ? `${p.displayName} is not available (${!p.installed ? "not installed" : "not authenticated"})`
                      : p.displayName
                  }
                >
                  <span className={`provider-option-dot provider-${p.name}`} />
                  <div className="provider-option-content">
                    <span className="provider-option-label">
                      {p.displayName}
                    </span>
                    {!isAvailable && (
                      <span className="provider-option-status">
                        {!p.installed ? "Not installed" : "Not authenticated"}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Model Selection */}
      {selectedProvider && modelOptions.length > 0 && (
        <div className="new-session-model-section">
          <h3>Model</h3>
          <FilterDropdown
            label="Model"
            options={modelOptions}
            selected={selectedModel ? [selectedModel] : []}
            onChange={handleModelSelect}
            multiSelect={false}
            placeholder="Select model"
          />
        </div>
      )}

      {/* Permission Mode Selection - only for providers that support it */}
      {supportsPermissionMode && (
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
                  <span className="mode-option-label">{MODE_LABELS[m]}</span>
                  <span className="mode-option-desc">
                    {MODE_DESCRIPTIONS[m]}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
