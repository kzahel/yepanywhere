import rowsStyles from "./SettingsRows.module.css";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Textarea, TextInput } from "../../components/ui/Field";
import { Switch } from "../../components/ui/Switch";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";

const DEFAULT_OLLAMA_SYSTEM_PROMPT =
  "You are a helpful coding assistant. You help users with software engineering tasks. You have access to tools for reading files, editing files, running shell commands, and searching code. Use tools when needed to answer questions or make changes. Be concise and direct.";

function OllamaUrlInput() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const [url, setUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const serverValue = settings?.ollamaUrl ?? "";

  useEffect(() => {
    if (settings) {
      setUrl(settings.ollamaUrl ?? "");
    }
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await updateSetting("ollamaUrl", url.trim() || undefined);
      setHasChanges(false);
    } catch {
      // Error handled by useServerSettings
    } finally {
      setIsSaving(false);
    }
  }, [url, updateSetting]);

  return (
    <form
      style={{ marginTop: "var(--space-2)", width: "100%" }}
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges && !isSaving) void handleSave();
      }}
    >
      <div
        style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}
      >
        <TextInput
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setHasChanges(e.target.value !== serverValue);
          }}
          placeholder="http://localhost:11434"
          aria-label={t("providersOllamaUrlLabel")}
          style={{ flex: 1 }}
        />
        <Button
          variant="primary"
          type="submit"
          disabled={!hasChanges || isSaving}
        >
          {isSaving ? t("providersSaving") : t("providersSave")}
        </Button>
      </div>
      <span className={rowsStyles.hint}>{t("providersOllamaUrlHint")}</span>
    </form>
  );
}

function OllamaUseFullSystemPrompt() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const enabled = settings?.ollamaUseFullSystemPrompt ?? false;
  const hintId = useId();

  return (
    <div style={{ marginTop: "var(--space-2)" }}>
      <Switch
        label={t("providersUseFullPrompt")}
        aria-describedby={hintId}
        checked={enabled}
        onCheckedChange={(checked) =>
          updateSetting("ollamaUseFullSystemPrompt", checked)
        }
      />
      <p
        id={hintId}
        className={rowsStyles.hint}
        style={{ margin: "var(--space-1) 0 0" }}
      >
        {t("providersUseFullPromptHint")}
      </p>
    </div>
  );
}

function OllamaSystemPromptInput() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const [prompt, setPrompt] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const serverValue = settings?.ollamaSystemPrompt ?? "";

  useEffect(() => {
    if (settings) {
      setPrompt(settings.ollamaSystemPrompt ?? "");
    }
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await updateSetting("ollamaSystemPrompt", prompt.trim() || undefined);
      setHasChanges(false);
    } catch {
      // Error handled by useServerSettings
    } finally {
      setIsSaving(false);
    }
  }, [prompt, updateSetting]);

  return (
    <div style={{ marginTop: "var(--space-2)", width: "100%" }}>
      <Textarea
        mono
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          setHasChanges(e.target.value !== serverValue);
        }}
        placeholder={DEFAULT_OLLAMA_SYSTEM_PROMPT}
        aria-label={t("providersOllamaPromptLabel")}
        rows={4}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "var(--space-2)",
        }}
      >
        <span className={rowsStyles.hint}>
          {t("providersOllamaPromptHint")}
        </span>
        <Button
          variant="primary"
          disabled={!hasChanges || isSaving}
          onClick={handleSave}
        >
          {isSaving ? t("providersSaving") : t("providersSave")}
        </Button>
      </div>
    </div>
  );
}

/** Claude-over-Ollama endpoint and system-prompt settings. */
export function OllamaSettings() {
  const { settings } = useServerSettings();
  const useFullPrompt = settings?.ollamaUseFullSystemPrompt ?? false;

  return (
    <>
      <OllamaUrlInput />
      <OllamaUseFullSystemPrompt />
      {!useFullPrompt && <OllamaSystemPromptInput />}
    </>
  );
}
