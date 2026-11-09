import { type ChangeEvent, useId } from "react";
import {
  MAX_SPEECH_ASR_ATTRIBUTION_MS,
  MAX_SPEECH_MESSAGE_CUSTOM_PREFIX_LENGTH,
  type SpeechMessagePrefixMode,
  useSpeechCaptureSettings,
} from "../hooks/useSpeechCaptureSettings";
import { useI18n } from "../i18n";
import { Select, TextInput } from "./ui/Field";
import { RangeNumberRow } from "./ui/RangeNumberRow";
import { MicrophoneIcon } from "./MicrophoneIcon";
import styles from "./SpeechMessagePrefixControls.module.css";

interface SpeechMessagePrefixControlsProps {
  disabled?: boolean;
  /**
   * Render the prefix explanation inside the component. The full settings
   * page passes false because its section description already carries it.
   */
  showDescription?: boolean;
}

export function SpeechMessagePrefixControls({
  disabled = false,
  showDescription = true,
}: SpeechMessagePrefixControlsProps) {
  const { t } = useI18n();
  const id = useId();
  const {
    asrAttributionMs,
    setAsrAttributionMs,
    speechMessagePrefixMode,
    setSpeechMessagePrefixMode,
    speechMessageCustomPrefix,
    setSpeechMessageCustomPrefix,
    speechMessagePrefix,
  } = useSpeechCaptureSettings();
  const handlePrefixModeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setSpeechMessagePrefixMode(event.target.value as SpeechMessagePrefixMode);
  };

  return (
    <div className={styles.root}>
      <div className={styles.control}>
        <div
          className={styles.selectShell}
          data-disabled={disabled || undefined}
        >
          {speechMessagePrefixMode === "microphone" && (
            <MicrophoneIcon className={styles.selectIcon} />
          )}
          <Select
            id={`${id}-prefix`}
            className={
              speechMessagePrefixMode === "microphone"
                ? `${styles.select} ${styles.selectWithIcon}`
                : styles.select
            }
            value={speechMessagePrefixMode}
            disabled={disabled}
            aria-label={t("speechSettingsMessagePrefixTitle")}
            onChange={handlePrefixModeChange}
          >
            <option value="off">{t("commonOff")}</option>
            <option value="microphone">
              {t("appearanceToolbarCollapsedButtonMicrophone")}
            </option>
            <option value="asr">[ASR]</option>
            <option value="stt">[STT]</option>
            <option value="dictation">[Dictation]</option>
            <option value="custom">
              {t("speechSettingsMessagePrefixCustom")}
            </option>
          </Select>
        </div>
        {speechMessagePrefixMode === "custom" && (
          <TextInput
            value={speechMessageCustomPrefix}
            maxLength={MAX_SPEECH_MESSAGE_CUSTOM_PREFIX_LENGTH}
            disabled={disabled}
            aria-label={t("speechSettingsMessagePrefixCustomLabel")}
            placeholder={t("speechSettingsMessagePrefixCustomPlaceholder")}
            onChange={(event) =>
              setSpeechMessageCustomPrefix(event.currentTarget.value)
            }
          />
        )}
        {showDescription && (
          <p className={styles.hint}>
            {t("speechSettingsMessagePrefixDescription")}
          </p>
        )}
        {speechMessagePrefix && (
          <p className={styles.preview}>
            {t("speechSettingsMessagePrefixPreview", {
              example: `${speechMessagePrefix} ${t("speechSettingsMessagePrefixPreviewText")}`,
            })}
          </p>
        )}
      </div>
      <RangeNumberRow
        id={`${id}-attribution`}
        label={t("speechSettingsAsrAttributionRowLabel")}
        min={0}
        max={MAX_SPEECH_ASR_ATTRIBUTION_MS}
        step={100}
        value={asrAttributionMs}
        disabled={disabled || !speechMessagePrefix}
        numberAriaLabel="Quick-send speech-prefix window milliseconds"
        unit="ms"
        hint={
          speechMessagePrefix
            ? t("speechSettingsAsrAttributionDescription", {
                prefix: speechMessagePrefix,
              })
            : t("speechSettingsAsrAttributionDisabledDescription")
        }
        onCommit={setAsrAttributionMs}
      />
    </div>
  );
}
