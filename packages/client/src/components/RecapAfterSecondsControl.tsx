import { recapAfterSecondsControlStateClasses } from "./composerStateClasses";
import recapStyles from "./RecapAfterSecondsControl.module.css";
import rowsStyles from "../pages/settings/SettingsRows.module.css";
import {
  DEFAULT_RECAP_AFTER_SECONDS,
  MAX_RECAP_AFTER_SECONDS,
  MIN_RECAP_AFTER_SECONDS,
  type RecapMode,
  normalizeRecapAfterSeconds,
} from "@yep-anywhere/shared";
import {
  type KeyboardEvent,
  type ReactNode,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import { CommittedRangeInput } from "./ui/CommittedRangeInput";
import { TextInput } from "./ui/Field";

interface RecapAfterSecondsControlProps {
  value?: number;
  disabled?: boolean;
  className?: string;
  label?: ReactNode;
  mode?: RecapMode;
  onCommit: (value: number) => void | Promise<void>;
}

const RECAP_AFTER_SECONDS_SLIDER_MAX = 3000;

export function RecapAfterSecondsControl({
  value,
  disabled,
  className,
  label,
  mode = "side-session",
  onCommit,
}: RecapAfterSecondsControlProps) {
  const { t } = useI18n();
  const normalizedValue = useMemo(
    () => normalizeRecapAfterSeconds(value ?? DEFAULT_RECAP_AFTER_SECONDS),
    [value],
  );
  const [draftValue, setDraftValue] = useState(normalizedValue);
  const [draftText, setDraftText] = useState(String(normalizedValue));
  const lastCommittedRef = useRef<number | null>(null);

  useEffect(() => {
    setDraftValue(normalizedValue);
    setDraftText(String(normalizedValue));
    lastCommittedRef.current = null;
  }, [normalizedValue]);

  const commitValue = useCallback(
    (rawValue: number) => {
      const next = normalizeRecapAfterSeconds(rawValue);
      setDraftValue(next);
      setDraftText(String(next));
      if (next !== normalizedValue && lastCommittedRef.current !== next) {
        lastCommittedRef.current = next;
        void onCommit(next);
      }
    },
    [normalizedValue, onCommit],
  );

  const commitText = useCallback(() => {
    commitValue(Number(draftText));
  }, [commitValue, draftText]);

  const resetDraft = useCallback(() => {
    setDraftValue(normalizedValue);
    setDraftText(String(normalizedValue));
  }, [normalizedValue]);

  const updateSliderDraft = (rawValue: number) => {
    const next = normalizeRecapAfterSeconds(rawValue);
    setDraftText(String(next));
  };

  const updateTextDraft = (text: string) => {
    setDraftText(text);
    if (text.trim() === "") {
      return;
    }
    const parsed = Number(text);
    if (Number.isFinite(parsed)) {
      setDraftValue(normalizeRecapAfterSeconds(parsed));
    }
  };

  const commitSlider = (rawValue: number) => {
    commitValue(rawValue);
  };

  const handleTextBlur = () => {
    commitText();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitText();
    } else if (event.key === "Escape") {
      event.preventDefault();
      resetDraft();
    }
  };
  const sliderValue = Math.min(draftValue, RECAP_AFTER_SECONDS_SLIDER_MAX);
  const sliderFillPercent =
    ((sliderValue - MIN_RECAP_AFTER_SECONDS) /
      (RECAP_AFTER_SECONDS_SLIDER_MAX - MIN_RECAP_AFTER_SECONDS)) *
    100;
  const sliderStyle = {
    "--recap-slider-fill": `${Math.min(100, Math.max(0, sliderFillPercent))}%`,
  } as CSSProperties;

  return (
    <div
      className={
        className
          ? `${recapStyles["recap-after-seconds-control"]} ${recapAfterSecondsControlStateClasses[`recap-after-seconds-control--${mode}`] ?? ""} ${className}`
          : `${recapStyles["recap-after-seconds-control"]} ${recapAfterSecondsControlStateClasses[`recap-after-seconds-control--${mode}`] ?? ""}`
      }
      data-recap-after-seconds-control--inline={
        className
          ?.split(" ")
          .includes(recapStyles["recap-after-seconds-control--inline"] ?? "") ||
        undefined
      }
      data-recap-after-seconds-control
    >
      <span
        className={recapStyles["recap-after-seconds-label"]}
        data-recap-after-seconds-label
      >
        {label ?? t("recapAfterSecondsLabel")}
      </span>
      <span
        className={`${rowsStyles.outputAppearanceSliderRow} ${recapStyles["recap-after-seconds-row"]}`}
        data-range-number
      >
        <CommittedRangeInput
          min={MIN_RECAP_AFTER_SECONDS}
          max={RECAP_AFTER_SECONDS_SLIDER_MAX}
          step={1}
          style={sliderStyle}
          value={sliderValue}
          disabled={disabled}
          aria-label={t("recapAfterSecondsAria")}
          onDraftChange={updateSliderDraft}
          onCommit={commitSlider}
        />
        <TextInput
          type="number"
          size="small"
          unit={t("recapAfterSecondsUnit")}
          min={MIN_RECAP_AFTER_SECONDS}
          max={MAX_RECAP_AFTER_SECONDS}
          step={1}
          value={draftText}
          disabled={disabled}
          aria-label={t("recapAfterSecondsAria")}
          onChange={(event) => updateTextDraft(event.currentTarget.value)}
          onBlur={handleTextBlur}
          onKeyDown={handleKeyDown}
        />
      </span>
    </div>
  );
}
