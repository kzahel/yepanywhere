import { AgentAuthRouterSettings } from "../../components/AgentAuthRouterControls";
import { Link } from "react-router-dom";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  SERVER_CAPABILITIES,
  CLAUDE_GATEWAY_SERVICES_CAPABILITY,
  CODEX_CYBER_ACCESS_PROGRAM_SETTING_CAPABILITY,
  CODEX_PLAN_TOOL_SETTING_CAPABILITY,
  CODEX_REASONING_SUMMARIES,
  DEFAULT_CODEX_REASONING_SUMMARY,
  DEFAULT_IDLE_REAP_HOURS,
  DEFAULT_LONG_CONTEXT_EFFORT_WARNING_TOKENS,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  LONG_CONTEXT_EFFORT_WARNING_SLIDER_MAX_TOKENS,
  LONG_CONTEXT_EFFORT_WARNING_SLIDER_STEP_TOKENS,
  MAX_IDLE_REAP_HOURS,
  MAX_SUBAGENT_MAX_DEPTH,
  MIN_SUBAGENT_MAX_DEPTH,
  NEVER_IDLE_REAP_HOURS,
  MAX_CLAUDE_ADDITIONAL_MODEL_ID_LENGTH,
  isCodexReasoningSummary,
  isCodexPlanToolMode,
  isCodexCyberAccessProgram,
  isValidClaudeAdditionalModelId,
  isValidClaudeAdditionalModelLabel,
  normalizeIdleReapHours,
  type ClaudeAdditionalModelSelection,
  type CodexCyberAccessProgram,
  type CodexPlanToolMode,
  type CodexReasoningSummary,
  type LongContextEffortWarningSettings,
  type ModelInfo,
  type ProviderInfo,
  type ProviderName,
  serverHasCapability,
} from "@yep-anywhere/shared";
import type { ServerSettings } from "../../api/client";
import {
  Button,
  buttonClassName,
  IconButton,
} from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { CommittedRangeNumberInput } from "../../components/ui/CommittedRangeNumberInput";
import { Field, Select, TextInput } from "../../components/ui/Field";
import { Modal, type ModalAnchorRect } from "../../components/ui/Modal";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useToastContext } from "../../contexts/ToastContext";
import { useCodexUpdateStatus } from "../../hooks/useCodexUpdateStatus";
import { useProviders } from "../../hooks/useProviders";
import { useServerSettings } from "../../hooks/useServerSettings";
import { GatewayServicesSettings } from "./GatewayServicesSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { ProviderSignIn } from "./ProviderSignIn";
import {
  ClaudeAutoCompactPercentOverrideControl,
  YaCompactContextEarlyControl,
} from "./compactSettingsControls";
import { SettingsDocLink } from "./SettingsDocLink";
import { SettingsItem } from "./SettingsItem";
import { InstructionRestorationControl } from "./InstructionRestorationControl";
import { OllamaSettings } from "./OllamaProviderSettings";
import { ProviderSteerNowDefault } from "./SteerNowProviderDefaults";
import styles from "./ProvidersSettings.module.css";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { getProviderSessionDefaults } from "../../lib/newSessionDefaults";
import { getAllProviders } from "../../providers/registry";

const DEFAULT_CLAUDE_LOGIN_COMMAND = "claude auth login --claudeai";
const DEFAULT_CODEX_LOGIN_COMMAND = "codex login";
const CLAUDE_OLLAMA_DEPRECATION_DISMISSAL_KEY =
  "yep-anywhere:claude-ollama-deprecation-v1";
const PROVIDER_DEFAULT_SUBAGENT_MAX_DEPTH = -1;

function shouldShowClaudeOllamaDeprecation(): boolean {
  try {
    return (
      window.localStorage.getItem(CLAUDE_OLLAMA_DEPRECATION_DISMISSAL_KEY) !==
      "dismissed"
    );
  } catch {
    return true;
  }
}

function rememberClaudeOllamaDeprecationDismissal(): void {
  try {
    window.localStorage.setItem(
      CLAUDE_OLLAMA_DEPRECATION_DISMISSAL_KEY,
      "dismissed",
    );
  } catch {
    // The notice still stays dismissed for this mounted settings pane.
  }
}

type UpdateServerSetting = <K extends keyof ServerSettings>(
  key: K,
  value: ServerSettings[K],
) => Promise<void>;

function GrokBuildApiKeySettings() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const enabled = settings?.grokBuildUseXaiApiKey ?? false;

  return (
    <Checkbox
      className={styles.grokApiKey}
      label={t("providersGrokUseXaiApiKey")}
      description={t("providersGrokUseXaiApiKeyHint")}
      checked={enabled}
      onCheckedChange={(checked) =>
        updateSetting("grokBuildUseXaiApiKey", checked)
      }
    />
  );
}

function CodexUpdatePanel() {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const { settings, updateSetting } = useServerSettings();
  const {
    status,
    isChecking,
    isInstalling,
    error,
    installOutput,
    refresh,
    install,
  } = useCodexUpdateStatus();

  const policy = settings?.codexUpdatePolicy ?? "notify";
  const canAuto = status?.updateMethod === "npm";

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(t("providersCodexUpdateCommandCopied"), "success");
      } catch {
        showToast(t("providersCodexUpdateCopyFailed"), "error");
      }
    },
    [showToast, t],
  );

  if (!status?.installed || !status.latest) {
    return null;
  }

  const updateAvailable = status.updateAvailable;

  return (
    <div style={{ marginTop: "var(--space-2)", width: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {updateAvailable ? (
          <span>
            <strong>{t("providersCodexUpdateAvailable")}</strong>{" "}
            {status.installed} → {status.latest}
          </span>
        ) : (
          <span className="settings-hint">
            {t("providersCodexUpdateUpToDate", {
              version: status.installed,
            })}
          </span>
        )}
        <Button onClick={() => void refresh(true)} disabled={isChecking}>
          {isChecking
            ? t("providersCodexUpdateChecking")
            : t("providersCodexUpdateCheckNow")}
        </Button>
        {status.releaseUrl && updateAvailable && (
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="settings-link"
          >
            {t("providersCodexUpdateReleaseNotes")}
          </a>
        )}
        <div
          style={{
            display: "flex",
            gap: "var(--space-3)",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span className="settings-hint">
            {t("providersCodexUpdatePolicyTitle")}
          </span>
          <SegmentedControl
            size="small"
            activation="manual"
            aria-label={t("providersCodexUpdatePolicyTitle")}
            value={policy}
            onChange={(value) => void updateSetting("codexUpdatePolicy", value)}
            options={[
              {
                value: "auto",
                label: t("commonAuto"),
                disabled: !canAuto,
                tooltip: canAuto
                  ? undefined
                  : t("providersCodexUpdatePolicyAutoUnavailable"),
              },
              { value: "notify", label: t("providersCodexUpdatePolicyNotify") },
              { value: "off", label: t("commonOff") },
            ]}
          />
        </div>
      </div>

      {updateAvailable && (
        <div
          style={{
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "center",
            marginTop: "var(--space-2)",
            flexWrap: "wrap",
          }}
        >
          {status.updateMethod === "npm" ? (
            <Button onClick={() => void install()} disabled={isInstalling}>
              {isInstalling
                ? t("providersCodexUpdateInstalling")
                : t("providersCodexUpdateNow")}
            </Button>
          ) : status.manualInstallCommand ? (
            <span className="settings-hint">
              {t("providersCodexUpdateWithInstaller")}
            </span>
          ) : null}
          {status.manualInstallCommand ? (
            <>
              <code
                style={{
                  padding: "2px 6px",
                  background: "var(--bg-elevated)",
                  borderRadius: 4,
                  fontSize: "0.85em",
                }}
              >
                {status.manualInstallCommand}
              </code>
              <Button
                variant="ghost"
                size="small"
                onClick={() => void copy(status.manualInstallCommand ?? "")}
              >
                {t("remoteSetupCopy")}
              </Button>
            </>
          ) : status.updateMethod === "manual" ? (
            <span className="settings-hint">
              {t("providersCodexUpdateManualInstallHint")}
            </span>
          ) : null}
        </div>
      )}

      {error && (
        <p className="settings-hint" style={{ color: "var(--error-color)" }}>
          {error}
        </p>
      )}
      {installOutput && (
        <details style={{ marginTop: "var(--space-2)" }}>
          <summary className="settings-hint">
            {t("providersCodexUpdateInstallOutput")}
          </summary>
          <pre
            style={{
              fontSize: "0.8em",
              whiteSpace: "pre-wrap",
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {installOutput}
          </pre>
        </details>
      )}
    </div>
  );
}

function CodexReasoningSummarySetting({
  value,
  updateSetting,
}: {
  value: CodexReasoningSummary;
  updateSetting: UpdateServerSetting;
}) {
  const { t } = useI18n();
  const labels: Record<CodexReasoningSummary, string> = {
    auto: t("providersCodexReasoningSummaryAutomatic"),
    concise: t("providersCodexReasoningSummaryConcise"),
    detailed: t("providersCodexReasoningSummaryDetailed"),
    none: t("providersCodexReasoningSummaryOff"),
  };

  return (
    <SettingsItem
      id="provider-codex-reasoning-summary"
      label={t("providersCodexReasoningSummaryTitle")}
      description={t("providersCodexReasoningSummaryDescription")}
      keywords={[
        "model_reasoning_summary",
        "reasoning summary",
        "auto",
        "concise",
        "detailed",
        "none",
        "off",
      ]}
      valueText={labels[value]}
    >
      <Select
        aria-label={t("providersCodexReasoningSummaryAria")}
        value={value}
        onChange={(event) => {
          if (isCodexReasoningSummary(event.target.value)) {
            void updateSetting("codexReasoningSummary", event.target.value);
          }
        }}
      >
        {CODEX_REASONING_SUMMARIES.map((summary) => (
          <option key={summary} value={summary}>
            {labels[summary]}
          </option>
        ))}
      </Select>
    </SettingsItem>
  );
}

type CodexPlanToolSelection = CodexPlanToolMode | "inherit";

function CodexPlanToolSetting({
  value,
  updateSetting,
}: {
  value: CodexPlanToolMode | undefined;
  updateSetting: UpdateServerSetting;
}) {
  const { t } = useI18n();
  const selection: CodexPlanToolSelection = value ?? "inherit";
  const labels: Record<CodexPlanToolSelection, string> = {
    inherit: t("providersCodexPlanToolInherit"),
    "provider-default": t("providersCodexPlanToolProviderDefault"),
    enabled: t("providersCodexPlanToolEnabled"),
    disabled: t("providersCodexPlanToolDisabled"),
  };

  return (
    <SettingsItem
      id="provider-codex-plan-tool"
      label={t("providersCodexPlanToolTitle")}
      description={t("providersCodexPlanToolDescription")}
      keywords={["update_plan", "plan", "checklist", "tasks", "todo"]}
      valueText={labels[selection]}
    >
      <Select
        aria-label={t("providersCodexPlanToolAria")}
        value={selection}
        onChange={(event) => {
          if (event.target.value === "inherit") {
            void updateSetting("codexPlanToolMode", null);
          } else if (isCodexPlanToolMode(event.target.value)) {
            void updateSetting("codexPlanToolMode", event.target.value);
          }
        }}
      >
        {(Object.keys(labels) as CodexPlanToolSelection[]).map((mode) => (
          <option key={mode} value={mode}>
            {labels[mode]}
          </option>
        ))}
      </Select>
    </SettingsItem>
  );
}

type CodexCyberAccessSelection = CodexCyberAccessProgram | "inherit";

function CodexCyberAccessProgramSetting({
  value,
  updateSetting,
}: {
  value: CodexCyberAccessProgram | undefined;
  updateSetting: UpdateServerSetting;
}) {
  const { t } = useI18n();
  const selection: CodexCyberAccessSelection = value ?? "inherit";
  const labels: Record<CodexCyberAccessSelection, string> = {
    inherit: t("providersCodexCyberAccessInherit"),
    "provider-default": t("providersCodexCyberAccessProviderDefault"),
    standard: t("providersCodexCyberAccessStandard"),
    "daybreak-blue": t("providersCodexCyberAccessDaybreakBlue"),
    "daybreak-red": t("providersCodexCyberAccessDaybreakRed"),
  };

  return (
    <SettingsItem
      id="provider-codex-cyber-access"
      label={t("providersCodexCyberAccessTitle")}
      description={t("providersCodexCyberAccessDescription")}
      doc="topics/codex-sessions.md#per-turn-cyber-access-program"
      keywords={["daybreak", "cyber", "security", "access", "program"]}
      valueText={labels[selection]}
    >
      <Select
        aria-label={t("providersCodexCyberAccessAria")}
        value={selection}
        onChange={(event) => {
          if (event.target.value === "inherit") {
            void updateSetting("codexCyberAccessProgram", null);
          } else if (isCodexCyberAccessProgram(event.target.value)) {
            void updateSetting("codexCyberAccessProgram", event.target.value);
          }
        }}
      >
        {(Object.keys(labels) as CodexCyberAccessSelection[]).map((program) => (
          <option key={program} value={program}>
            {labels[program]}
          </option>
        ))}
      </Select>
    </SettingsItem>
  );
}

function ClaudeGatewaySettings({
  reloadProviders,
}: {
  reloadProviders: () => Promise<void>;
}) {
  const exampleUrl = "http://localhost:4141";
  const { t } = useI18n();
  const { settings, updateSettings } = useServerSettings();
  const [url, setUrl] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const serverValue = settings?.claudeGatewayUrl ?? "";
  const serverStartCommand = settings?.claudeGatewayStartCommand ?? "";
  const hasChanges =
    url.trim() !== serverValue || startCommand.trim() !== serverStartCommand;

  useEffect(() => {
    setUrl(settings?.claudeGatewayUrl ?? "");
  }, [settings?.claudeGatewayUrl]);

  useEffect(() => {
    setStartCommand(settings?.claudeGatewayStartCommand ?? "");
  }, [settings?.claudeGatewayStartCommand]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await updateSettings({
        claudeGatewayUrl: url.trim() || undefined,
        claudeGatewayStartCommand: startCommand.trim() || undefined,
      });
      await reloadProviders();
    } catch {
      // Error handled by useServerSettings.
    } finally {
      setIsSaving(false);
    }
  }, [reloadProviders, startCommand, updateSettings, url]);
  const canSave = hasChanges && !isSaving;
  return (
    <div
      id="provider-claude-gateway-configuration"
      className="settings-subsection"
    >
      <h3>{t("providersClaudeGatewayTitle")}</h3>
      <p className="settings-hint">
        {t("providersClaudeGatewayDescription")}{" "}
        <SettingsDocLink doc="topics/gateway-services.md" />
      </p>
      <form
        className="claude-gateway-settings-control"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) void handleSave();
        }}
      >
        <div className="claude-gateway-settings-row">
          <TextInput
            type="url"
            className={styles.gatewayUrl}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onFocus={() => {
              if (!url.trim()) setUrl(exampleUrl);
            }}
            placeholder={exampleUrl}
            aria-label={t("providersClaudeGatewayUrlAria")}
          />
          <Button variant="primary" type="submit" disabled={!canSave}>
            {isSaving ? t("providersSaving") : t("providersSave")}
          </Button>
        </div>

        <Field
          className={styles.gatewayStartCommand}
          label={t("providersClaudeGatewayStartCommandLabel")}
          hint={t("providersClaudeGatewayStartCommandHint")}
        >
          <TextInput
            mono
            value={startCommand}
            maxLength={10_000}
            onChange={(event) => setStartCommand(event.target.value)}
            placeholder={t("providersClaudeGatewayStartCommandPlaceholder")}
            aria-label={t("providersClaudeGatewayStartCommandAria")}
          />
        </Field>

        <p className="settings-hint">
          {t("providersClaudeGatewayIsolationHint")}
        </p>
      </form>
    </div>
  );
}

type ClaudeGatewayToggleSettingProps = {
  id: string;
  setting: "claudeGatewayDisableAgent" | "claudeGatewayDisablePlanMode";
  title: string;
  description: string;
};

function ClaudeGatewayToggleSetting({
  id,
  setting,
  title,
  description,
}: ClaudeGatewayToggleSettingProps) {
  const { settings, updateSetting } = useServerSettings();
  const enabled = settings?.[setting] ?? true;

  return (
    <div id={id} className="settings-subsection">
      <Checkbox
        label={title}
        description={description}
        checked={enabled}
        onCheckedChange={(checked) => void updateSetting(setting, checked)}
      />
    </div>
  );
}

function ProviderLoginCommandPanel({
  command,
  provider,
  onCopy,
}: {
  command: string;
  provider: string;
  onCopy: (command: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="settings-command-panel">
      <div
        className="settings-command-preview"
        role="group"
        aria-label={t("providersLoginCommandPreviewAria", { provider })}
      >
        <code>{command}</code>
      </div>
      <Button onClick={() => onCopy(command)}>
        {t("providersLoginCommandCopy", { provider })}
      </Button>
    </div>
  );
}

function ClaudeYaCompactEarlyMirror({
  serverProviders,
  settings,
  updateSetting,
}: {
  serverProviders: ProviderInfo[];
  settings: ServerSettings | null;
  updateSetting: UpdateServerSetting;
}) {
  const { t } = useI18n();
  const claudeProvider = serverProviders.find((p) => p.name === "claude");
  const claudeDefaults = getProviderSessionDefaults(
    settings?.newSessionDefaults,
    "claude",
  );
  const claudeModelId =
    typeof claudeDefaults.model === "string" &&
    claudeDefaults.model !== "default"
      ? claudeDefaults.model
      : claudeProvider?.models?.[0]?.id;
  if (!claudeModelId || claudeModelId === "default") {
    return null;
  }
  const modelInfo = claudeProvider?.models?.find((m) => m.id === claudeModelId);
  const stored =
    settings?.clientDefaults?.compactAtContextPercent?.[claudeModelId] ?? 0;
  return (
    <YaCompactContextEarlyControl
      id="provider-ya-compact-early"
      modelId={claudeModelId}
      contextWindow={modelInfo?.contextWindow}
      storedPercent={stored}
      map={settings?.clientDefaults?.compactAtContextPercent}
      updateSetting={updateSetting}
      description={t("providersYaCompactEarlyMirrorDescription", {
        model: modelInfo?.name ?? claudeModelId,
      })}
      searchable={false}
    />
  );
}

interface ClaudeAdditionalModelsSettingsProps {
  modelOptions: readonly ModelInfo[];
  selections: readonly ClaudeAdditionalModelSelection[];
  updateSetting: UpdateServerSetting;
  reloadProviders: () => Promise<void>;
}

function ClaudeAdditionalModelsSettings({
  modelOptions,
  selections,
  updateSetting,
  reloadProviders,
}: ClaudeAdditionalModelsSettingsProps) {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<ModalAnchorRect | null>(null);
  const [customId, setCustomId] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedIds = useMemo(
    () => new Set(selections.map((selection) => selection.id)),
    [selections],
  );
  const choices = useMemo(() => {
    const maintainedIds = new Set(modelOptions.map((model) => model.id));
    return [
      ...modelOptions,
      ...selections
        .filter((selection) => !maintainedIds.has(selection.id))
        .map(
          (selection): ModelInfo => ({
            id: selection.id,
            name: selection.label,
            description:
              selection.origin === "registry"
                ? t("providersAdditionalModelsUnlistedDescription")
                : t("providersAdditionalModelsCustomDescription"),
            catalogGroup: "additional",
          }),
        ),
    ];
  }, [modelOptions, selections, t]);

  const summary =
    selections.length === 0
      ? t("providersAdditionalModelsNone")
      : selections.length === 1
        ? t("providersAdditionalModelsOne")
        : t("providersAdditionalModelsMany", {
            count: String(selections.length),
          });

  const saveSelections = useCallback(
    async (nextSelections: ClaudeAdditionalModelSelection[]) => {
      setIsSaving(true);
      setError(null);
      try {
        await updateSetting("claudeAdditionalModels", nextSelections);
        await reloadProviders();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("providersAdditionalModelsSaveError"),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [reloadProviders, t, updateSetting],
  );

  const toggleModel = useCallback(
    (model: ModelInfo) => {
      const nextSelections = selectedIds.has(model.id)
        ? selections.filter((selection) => selection.id !== model.id)
        : [
            ...selections,
            {
              id: model.id,
              label: model.name,
              origin: "registry" as const,
            },
          ];
      void saveSelections(nextSelections);
    },
    [saveSelections, selectedIds, selections],
  );

  const addCustomModel = useCallback(() => {
    const id = customId.trim();
    if (!isValidClaudeAdditionalModelId(id)) {
      setError(t("providersAdditionalModelsInvalidId"));
      return;
    }
    if (selectedIds.has(id)) {
      setError(t("providersAdditionalModelsDuplicateId"));
      return;
    }

    const maintained = modelOptions.find((model) => model.id === id);
    // A custom entry stores label = id, so the id must also satisfy the label
    // bounds the server enforces; a registry match carries the maintained name.
    if (!maintained && !isValidClaudeAdditionalModelLabel(id)) {
      setError(t("providersAdditionalModelsInvalidId"));
      return;
    }
    const nextSelection: ClaudeAdditionalModelSelection = maintained
      ? {
          id,
          label: maintained.name,
          origin: "registry",
        }
      : {
          id,
          label: id,
          origin: "custom",
        };
    setCustomId("");
    void saveSelections([...selections, nextSelection]);
  }, [customId, modelOptions, saveSelections, selectedIds, selections, t]);

  const openEditor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    setAnchorRect(
      rect
        ? {
            bottom: rect.bottom,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          }
        : null,
    );
    setError(null);
    setOpen(true);
  }, []);

  return (
    <>
      <SettingsItem
        id="provider-claude-additional-models"
        label={t("providersAdditionalModelsTitle")}
        description={t("providersAdditionalModelsDescription")}
        valueText={summary}
        className="providers-additional-models-setting"
      >
        <Button
          ref={triggerRef}
          variant="outline"
          className="providers-additional-models-trigger"
          onClick={openEditor}
          aria-haspopup="dialog"
        >
          <span>{summary}</span>
          <span aria-hidden="true">▾</span>
        </Button>
      </SettingsItem>
      {open && (
        <Modal
          title={t("providersAdditionalModelsTitle")}
          onClose={() => setOpen(false)}
          anchorRect={anchorRect}
        >
          <div className="providers-additional-models-editor">
            <p className="settings-hint">
              {t("providersAdditionalModelsEditorDescription")}
            </p>
            <div className="providers-additional-models-list">
              {choices.map((model) => (
                <Checkbox
                  key={model.id}
                  className="providers-additional-model-option"
                  label={
                    <>
                      <strong>{model.name}</strong> <code>{model.id}</code>
                    </>
                  }
                  description={model.description || undefined}
                  checked={selectedIds.has(model.id)}
                  disabled={isSaving}
                  onCheckedChange={() => toggleModel(model)}
                />
              ))}
            </div>
            <details className="providers-additional-models-custom">
              <summary>{t("providersAdditionalModelsCustomTitle")}</summary>
              <p className="settings-hint">
                {t("providersAdditionalModelsCustomHint")}
              </p>
              <div className="providers-additional-models-custom-row">
                <TextInput
                  className={styles.customModelId}
                  value={customId}
                  maxLength={MAX_CLAUDE_ADDITIONAL_MODEL_ID_LENGTH}
                  placeholder={t("providersAdditionalModelsCustomPlaceholder")}
                  aria-label={t("providersAdditionalModelsCustomInputAria")}
                  onChange={(event) => setCustomId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addCustomModel();
                    }
                  }}
                />
                <Button
                  disabled={isSaving || !customId.trim()}
                  onClick={addCustomModel}
                >
                  {t("providersAdditionalModelsAdd")}
                </Button>
              </div>
            </details>
            {isSaving && (
              <p className="settings-hint">{t("providersSaving")}</p>
            )}
            {error && <p className="settings-warning">{error}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * Long-context effort-change warning: threshold slider plus per-provider
 * checkboxes. Contract: topics/mid-session-effort-change.md.
 */
function LongContextEffortWarningControl({
  value,
  providers,
  updateSetting,
}: {
  value: LongContextEffortWarningSettings;
  providers: readonly { id: string; displayName: string }[];
  updateSetting: UpdateServerSetting;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const thresholdTokens =
    value.thresholdTokens ?? DEFAULT_LONG_CONTEXT_EFFORT_WARNING_TOKENS;
  const enabledCount = providers.filter(
    (provider) => value.providers?.[provider.id as ProviderName] === true,
  ).length;

  const save = useCallback(
    async (next: LongContextEffortWarningSettings) => {
      try {
        await updateSetting("longContextEffortWarning", next);
        showToast(t("providersLongContextEffortWarningSaved"), "success");
      } catch (error) {
        showToast(
          error instanceof Error
            ? error.message
            : t("providersLongContextEffortWarningSaveError"),
          "error",
        );
      }
    },
    [showToast, t, updateSetting],
  );

  return (
    <SettingsItem
      id="providers-long-context-effort-warning"
      label={t("providersLongContextEffortWarningTitle")}
      description={t("providersLongContextEffortWarningDescription")}
      keywords={[
        "effort",
        "reasoning",
        "prompt cache",
        "cache",
        "long context",
        "fork",
        "warning",
      ]}
      className="settings-item--wide-control"
      valueText={
        enabledCount === 0
          ? t("providersLongContextEffortWarningOff")
          : t("providersLongContextEffortWarningValue", {
              tokens: thresholdTokens.toLocaleString(),
              count: String(enabledCount),
            })
      }
    >
      <div className={styles.limitControls}>
        <CommittedRangeNumberInput
          id="providers-long-context-effort-warning-threshold"
          min={0}
          max={LONG_CONTEXT_EFFORT_WARNING_SLIDER_MAX_TOKENS}
          numberMax={Number.MAX_SAFE_INTEGER}
          step={LONG_CONTEXT_EFFORT_WARNING_SLIDER_STEP_TOKENS}
          snapTextToStep={false}
          value={thresholdTokens}
          unit="tokens"
          ariaLabel={t("providersLongContextEffortWarningThresholdAria")}
          onCommit={(tokens) => {
            void save({ ...value, thresholdTokens: Math.round(tokens) });
          }}
        />
        <p className="settings-hint">
          {t("providersLongContextEffortWarningThresholdHint")}
        </p>
        <div className={styles.providerToggles}>
          {providers.map((provider) => {
            const providerId = provider.id as ProviderName;
            const enabled = value.providers?.[providerId] === true;
            return (
              <Checkbox
                key={provider.id}
                label={provider.displayName}
                checked={enabled}
                onCheckedChange={(checked) => {
                  const providersMap = { ...value.providers };
                  if (checked) {
                    providersMap[providerId] = true;
                  } else {
                    delete providersMap[providerId];
                  }
                  void save({ ...value, providers: providersMap });
                }}
              />
            );
          })}
        </div>
      </div>
    </SettingsItem>
  );
}

export function ProvidersSettings() {
  const signInBasePath = useRemoteBasePath();
  const { t } = useI18n();
  useSettingsPaneTitle(t("providersSectionTitle"));
  const [showClaudeOllamaDeprecation, setShowClaudeOllamaDeprecation] =
    useState(shouldShowClaudeOllamaDeprecation);
  const { showToast } = useToastContext();
  const {
    providers: serverProviders,
    loading: providersLoading,
    error: providersError,
    refetch: reloadProviders,
  } = useProviders();
  const { settings, updateSetting } = useServerSettings();
  const { version } = useVersion();

  const supportsCodexPlanToolSetting = serverHasCapability(
    version,
    CODEX_PLAN_TOOL_SETTING_CAPABILITY,
  );
  const supportsCodexCyberAccessProgram = serverHasCapability(
    version,
    CODEX_CYBER_ACCESS_PROGRAM_SETTING_CAPABILITY,
  );

  const supportsGatewayServices = serverHasCapability(
    version,
    CLAUDE_GATEWAY_SERVICES_CAPABILITY,
  );

  const idleReapHours = settings?.idleReapHours ?? DEFAULT_IDLE_REAP_HOURS;
  const subagentMaxDepth =
    settings?.subagentMaxDepth === undefined
      ? DEFAULT_SUBAGENT_MAX_DEPTH
      : settings.subagentMaxDepth;

  const handleCopyProviderLoginCommand = useCallback(
    async (command: string, provider: string) => {
      try {
        await navigator.clipboard.writeText(command);
        showToast(t("providersLoginCommandCopied", { provider }), "success");
      } catch {
        showToast(t("providersLoginCommandCopyError", { provider }), "error");
      }
    },
    [showToast, t],
  );

  const dismissClaudeOllamaDeprecation = useCallback(() => {
    setShowClaudeOllamaDeprecation(false);
    rememberClaudeOllamaDeprecationDismissal();
  }, []);

  // Merge server detection status with client-side metadata
  const registeredProviders = getAllProviders();
  const providerDisplayList = registeredProviders.flatMap((clientProvider) => {
    const serverInfo = serverProviders.find(
      (p) => p.name === clientProvider.id,
    );
    if (
      (clientProvider.id === "claude-ollama" ||
        clientProvider.id === "antigravity") &&
      !serverInfo
    ) {
      return [];
    }

    return [
      {
        ...clientProvider,
        installed: serverInfo?.installed ?? false,
        applicationDetected: serverInfo?.applicationDetected,
        authenticated: serverInfo?.authenticated ?? false,
        enabled: serverInfo?.enabled ?? false,
        loginCommand: serverInfo?.loginCommand,
        supportsInAppLogin: serverInfo?.supportsInAppLogin === true,
        supportsHostTerminalLogin:
          serverInfo?.supportsHostTerminalLogin === true,
        additionalModelOptions: serverInfo?.additionalModelOptions,
        supportsLaunchCompactPercentOverride:
          serverInfo?.supportsLaunchCompactPercentOverride === true,
      },
    ];
  });

  return (
    <SettingsSection
      description={t("providersSectionDescription")}
      doc={{
        path: "site/src/content/docs/providers.md",
        label: "providers guide",
      }}
    >
      <nav
        className={styles.signInShortcuts}
        aria-label={t("providerSignInShortcuts")}
      >
        {serverProviders
          .filter(
            (provider) =>
              (provider.name === "claude" || provider.name === "codex") &&
              provider.supportsInAppLogin,
          )
          .map((provider) => (
            <Link
              key={provider.name}
              className={buttonClassName()}
              to={`${signInBasePath}/provider-sign-in/${provider.name}`}
            >
              {t("providersSignIn", { provider: provider.displayName })}
            </Link>
          ))}
      </nav>
      {serverHasCapability(
        version,
        SERVER_CAPABILITIES.agentAuthRouter.name,
      ) && <AgentAuthRouterSettings />}

      <div className="settings-group">
        <SettingsItem
          id="providers-subagent-max-depth"
          label={t("providersSubagentMaxDepthLabel")}
          description={t("providersSubagentMaxDepthDescription")}
          className="settings-item--wide-control"
          valueText={
            subagentMaxDepth === null
              ? t("providersSubagentMaxDepthProviderDefault")
              : subagentMaxDepth === 0
                ? t("providersSubagentMaxDepthDisabled")
                : t("providersSubagentMaxDepthValue", {
                    value: subagentMaxDepth,
                  })
          }
        >
          <div className={styles.limitControls}>
            <CommittedRangeNumberInput
              id="providers-subagent-max-depth-control"
              min={PROVIDER_DEFAULT_SUBAGENT_MAX_DEPTH}
              max={MAX_SUBAGENT_MAX_DEPTH}
              numberMin={MIN_SUBAGENT_MAX_DEPTH}
              numberMax={MAX_SUBAGENT_MAX_DEPTH}
              step={1}
              list="providers-subagent-max-depth-ticks"
              value={subagentMaxDepth}
              unsetSliderValue={PROVIDER_DEFAULT_SUBAGENT_MAX_DEPTH}
              unit={t("providersSubagentMaxDepthUnit")}
              ariaLabel={t("providersSubagentMaxDepthAria")}
              onCommit={(value) => {
                void updateSetting("subagentMaxDepth", value);
              }}
            />
            <datalist id="providers-subagent-max-depth-ticks">
              <option
                value={PROVIDER_DEFAULT_SUBAGENT_MAX_DEPTH}
                label={t("providersSubagentMaxDepthProviderDefault")}
              />
              <option value={MIN_SUBAGENT_MAX_DEPTH} />
              <option value="1" />
              <option value="2" />
              <option value="3" />
              <option value={MAX_SUBAGENT_MAX_DEPTH} />
            </datalist>
            <p className="settings-hint">
              {t("providersSubagentMaxDepthCoverage")}
            </p>
          </div>
        </SettingsItem>
        <SettingsItem
          id="providers-idle-reap-hours"
          label={t("providersIdleReapHoursLabel")}
          description={t("providersIdleReapHoursDescription")}
          className="settings-item--wide-control"
          valueText={
            idleReapHours < 0
              ? t("providersIdleReapNever")
              : t("providersIdleReapHoursValue", {
                  value: idleReapHours,
                })
          }
        >
          <div className={styles.limitControls}>
            <CommittedRangeNumberInput
              id="providers-idle-reap-hours-control"
              min={NEVER_IDLE_REAP_HOURS}
              max={MAX_IDLE_REAP_HOURS}
              numberMin={NEVER_IDLE_REAP_HOURS}
              numberMax={MAX_IDLE_REAP_HOURS}
              step={1}
              list="providers-idle-reap-hours-ticks"
              value={idleReapHours}
              unit={t("providersIdleReapHoursUnit")}
              ariaLabel={t("providersIdleReapHoursAria")}
              snapTextToStep={false}
              onCommit={(value) => {
                void updateSetting(
                  "idleReapHours",
                  normalizeIdleReapHours(value),
                );
              }}
            />
            <datalist id="providers-idle-reap-hours-ticks">
              <option
                value={NEVER_IDLE_REAP_HOURS}
                label={t("providersIdleReapNever")}
              />
              <option value="0" />
              <option value="24" />
              <option value="48" />
              <option value={MAX_IDLE_REAP_HOURS} />
            </datalist>
            <p className="settings-hint">{t("providersIdleReapNeverHint")}</p>
          </div>
        </SettingsItem>
        {settings?.instructionRestoration !== undefined && (
          <InstructionRestorationControl
            value={settings.instructionRestoration}
            providers={providerDisplayList}
            save={(value) => updateSetting("instructionRestoration", value)}
          />
        )}
        {settings?.longContextEffortWarning !== undefined && (
          <LongContextEffortWarningControl
            value={settings.longContextEffortWarning}
            providers={providerDisplayList}
            updateSetting={updateSetting}
          />
        )}
        {providerDisplayList.map((provider) => (
          <Fragment key={provider.id}>
            <SettingsItem
              id={`provider-${provider.id}`}
              label={provider.displayName}
              description={provider.metadata.description}
              keywords={
                provider.id === "claude-gateway"
                  ? [
                      "gateway URL",
                      "start command",
                      "autostart",
                      "disable agent",
                      "disable plan mode",
                    ]
                  : undefined
              }
              after={
                <>
                  {provider.id === "claude-gateway" &&
                    supportsGatewayServices && (
                      <GatewayServicesSettings
                        reloadProviders={reloadProviders}
                      />
                    )}
                  {provider.id === "claude-ollama" &&
                  showClaudeOllamaDeprecation ? (
                    <div className="provider-deprecation-notice" role="status">
                      <span>{t("providersClaudeOllamaDeprecationNotice")}</span>
                      <IconButton
                        size="small"
                        className={styles.deprecationDismiss}
                        label={t("providersClaudeOllamaDeprecationDismissAria")}
                        onClick={dismissClaudeOllamaDeprecation}
                      >
                        ×
                      </IconButton>
                    </div>
                  ) : undefined}
                </>
              }
              info={
                <>
                  <div className="settings-item-header">
                    <strong>{provider.displayName}</strong>
                    {provider.installed ? (
                      <span className="settings-status-badge settings-status-detected">
                        {t("providersRuntimeReady")}
                      </span>
                    ) : (
                      <span className="settings-status-badge settings-status-not-detected">
                        {t("providersRuntimeUnavailable")}
                      </span>
                    )}
                  </div>
                  <p>{provider.metadata.description}</p>
                  {(provider.id === "claude" || provider.id === "codex") &&
                    provider.applicationDetected !== undefined && (
                      <p className="settings-hint">
                        {t("providersDesktopApplicationStatus", {
                          status: provider.applicationDetected
                            ? t("providersDetected")
                            : t("providersNotDetected"),
                        })}
                      </p>
                    )}
                  {provider.installed && (
                    <p className="settings-hint">
                      {t("providersAuthenticationStatus", {
                        status:
                          provider.authenticated || provider.enabled
                            ? t("providersAuthenticated")
                            : t("providersNotAuthenticated"),
                      })}
                    </p>
                  )}
                  {provider.metadata.limitations.length > 0 && (
                    <ul className="settings-limitations">
                      {provider.metadata.limitations.map((limitation) => (
                        <li key={limitation}>{limitation}</li>
                      ))}
                    </ul>
                  )}
                  {(provider.id === "claude" || provider.id === "codex") &&
                    provider.installed &&
                    !provider.authenticated && (
                      <div style={{ marginTop: "var(--space-2)" }}>
                        <p className="settings-hint">
                          {t("providersLoginHint", {
                            provider: provider.displayName,
                          })}
                        </p>
                        <ProviderLoginCommandPanel
                          command={
                            provider.loginCommand ??
                            (provider.id === "claude"
                              ? DEFAULT_CLAUDE_LOGIN_COMMAND
                              : DEFAULT_CODEX_LOGIN_COMMAND)
                          }
                          provider={provider.displayName}
                          onCopy={(command) =>
                            void handleCopyProviderLoginCommand(
                              command,
                              provider.displayName,
                            )
                          }
                        />
                        {provider.supportsInAppLogin && (
                          <ProviderSignIn
                            provider={provider.id}
                            displayName={provider.displayName}
                            supportsHostTerminal={
                              provider.supportsHostTerminalLogin
                            }
                            onSignedIn={reloadProviders}
                          />
                        )}
                      </div>
                    )}
                  {(provider.id === "claude" || provider.id === "codex") &&
                    provider.applicationDetected === true &&
                    !provider.installed && (
                      <p className="settings-hint">
                        {t("providersApplicationWithoutRuntimeHint", {
                          provider: provider.displayName,
                        })}
                      </p>
                    )}
                  {provider.id === "claude-ollama" && <OllamaSettings />}
                  {provider.id === "grok" && <GrokBuildApiKeySettings />}
                  {provider.id === "claude-gateway" && (
                    <>
                      {settings && version && !supportsGatewayServices && (
                        <ClaudeGatewaySettings
                          reloadProviders={reloadProviders}
                        />
                      )}
                      <ClaudeGatewayToggleSetting
                        id="provider-claude-gateway-disable-agent"
                        setting="claudeGatewayDisableAgent"
                        title={t("providersClaudeGatewayDisableAgentTitle")}
                        description={t(
                          "providersClaudeGatewayDisableAgentDescription",
                        )}
                      />
                      <ClaudeGatewayToggleSetting
                        id="provider-claude-gateway-disable-plan-mode"
                        setting="claudeGatewayDisablePlanMode"
                        title={t("providersClaudeGatewayDisablePlanModeTitle")}
                        description={t(
                          "providersClaudeGatewayDisablePlanModeDescription",
                        )}
                      />
                    </>
                  )}
                  {provider.id === "codex" && provider.installed && (
                    <>
                      <div style={{ marginTop: "var(--space-2)" }}>
                        <Button
                          disabled={providersLoading}
                          onClick={() => void reloadProviders()}
                        >
                          {providersLoading
                            ? t("providersModelsRefreshing")
                            : t("providersModelsRefresh")}
                        </Button>
                        {providersError && (
                          <p className="settings-hint" role="alert">
                            {t("providersModelsRefreshFailed")}
                          </p>
                        )}
                      </div>
                      <CodexUpdatePanel />
                    </>
                  )}
                </>
              }
            >
              {provider.metadata.website && (
                <a
                  href={provider.metadata.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="settings-link"
                >
                  {t("providersWebsite")}
                </a>
              )}
            </SettingsItem>
            <ProviderSteerNowDefault name={provider.id} />
            {provider.id === "codex" && (
              <CodexReasoningSummarySetting
                value={
                  settings?.codexReasoningSummary ??
                  DEFAULT_CODEX_REASONING_SUMMARY
                }
                updateSetting={updateSetting}
              />
            )}
            {provider.id === "codex" && supportsCodexPlanToolSetting && (
              <CodexPlanToolSetting
                value={settings?.codexPlanToolMode ?? undefined}
                updateSetting={updateSetting}
              />
            )}
            {provider.id === "codex" && supportsCodexCyberAccessProgram && (
              <CodexCyberAccessProgramSetting
                value={settings?.codexCyberAccessProgram ?? undefined}
                updateSetting={updateSetting}
              />
            )}
            {provider.id === "claude" &&
              provider.supportsLaunchCompactPercentOverride && (
                <ClaudeAutoCompactPercentOverrideControl
                  id="provider-claude-auto-compact"
                  value={settings?.claudeAutoCompactPercentOverride}
                  updateSetting={updateSetting}
                />
              )}
            {provider.id === "claude" && (
              <ClaudeYaCompactEarlyMirror
                serverProviders={serverProviders}
                settings={settings}
                updateSetting={updateSetting}
              />
            )}
            {provider.id === "claude" && (
              <ClaudeAdditionalModelsSettings
                modelOptions={provider.additionalModelOptions ?? []}
                selections={settings?.claudeAdditionalModels ?? []}
                updateSetting={updateSetting}
                reloadProviders={reloadProviders}
              />
            )}
          </Fragment>
        ))}
      </div>
    </SettingsSection>
  );
}
