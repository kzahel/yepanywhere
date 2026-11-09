import { useState } from "react";
import { useI18n } from "../i18n";
import { prewarmYaServerSpeechBackend } from "../lib/speechProviders/YaServerProvider";
import { englishModelWer } from "../lib/speechProviders/englishModelWer";
import styles from "./WhisperModelControls.module.css";
import { Select, TextInput } from "./ui/Field";

const PRESETS = [
  ["distil-large-v3.5", "Distil large v3.5 English · 756M parameters"],
  ["large-v3", "Large v3 multilingual"],
  ["turbo", "Large v3 turbo multilingual"],
  ["distil-large-v3", "Distil large v3 English"],
] as const;

/** Render only after local-speech-model-selection is known present. */
export function WhisperModelControls({
  model = "",
  onChange,
  onBeforeChange,
}: {
  model?: string;
  onChange: (model: string) => void;
  onBeforeChange?: () => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const prewarm = async (value: string) => {
    setError(null);
    try {
      await prewarmYaServerSpeechBackend(
        "ya-whisper",
        value.trim() || undefined,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className={styles.controls}>
      <Select
        aria-label={t("speechSettingsWhisperModelTitle")}
        value={
          !model
            ? ""
            : PRESETS.some(([value]) => value === model)
              ? model
              : "custom"
        }
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "custom") return;
          onBeforeChange?.();
          onChange(value);
          void prewarm(value);
        }}
      >
        <option value="">{t("speechSettingsModelServerDefault")}</option>
        {PRESETS.map(([value, label]) => (
          <option key={value} value={value}>
            {label} · {englishModelWer(value)}
          </option>
        ))}
        <option value="custom">{t("speechSettingsParakeetCustomModel")}</option>
      </Select>
      <TextInput
        aria-label={t("speechSettingsWhisperModelInputLabel")}
        value={model}
        placeholder="distil-large-v3.5"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          onBeforeChange?.();
          onChange(event.currentTarget.value);
        }}
        onBlur={(event) => void prewarm(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void prewarm(event.currentTarget.value);
        }}
      />
      {error && (
        <span role="status">
          {t("speechSettingsModelLoadError", { error })}
        </span>
      )}
    </div>
  );
}
