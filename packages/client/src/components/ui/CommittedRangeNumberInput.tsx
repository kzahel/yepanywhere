import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { CommittedRangeInput } from "./CommittedRangeInput";
import { TextInput } from "./Field";

interface CommittedRangeNumberInputBaseProps {
  id?: string;
  min: number;
  max: number;
  numberMin?: number;
  numberMax?: number;
  step?: number;
  list?: string;
  unit?: ReactNode;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  onEdit?: () => void;
  snapTextToStep?: boolean;
}

type CommittedRangeNumberInputProps = CommittedRangeNumberInputBaseProps &
  (
    | {
        value: number;
        unsetSliderValue?: never;
        onCommit: (value: number) => void;
      }
    | {
        value: number | null;
        unsetSliderValue: number;
        onCommit: (value: number | null) => void;
      }
  );

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function displayRangeValue(
  value: number | null,
  unsetSliderValue: number | undefined,
  min: number,
  max: number,
): number {
  if (value !== null) return clamp(value, min, max);
  if (unsetSliderValue === undefined) {
    throw new Error("A null range value requires unsetSliderValue");
  }
  return unsetSliderValue;
}

export function CommittedRangeNumberInput(
  props: CommittedRangeNumberInputProps,
) {
  const {
    id,
    min,
    max,
    numberMin = min,
    numberMax = max,
    step = 1,
    list,
    value,
    unsetSliderValue,
    unit,
    disabled,
    ariaLabel,
    className,
    onEdit,
    snapTextToStep = true,
  } = props;
  const [rangeValue, setRangeValue] = useState(() =>
    displayRangeValue(value, unsetSliderValue, min, max),
  );
  const [textDraft, setTextDraft] = useState(
    value === null ? "" : String(value),
  );

  useEffect(() => {
    setRangeValue(displayRangeValue(value, unsetSliderValue, min, max));
    setTextDraft(value === null ? "" : String(value));
  }, [max, min, unsetSliderValue, value]);

  const normalizeRange = useCallback(
    (next: number) => {
      const stepped = min + Math.round((next - min) / step) * step;
      return clamp(stepped, min, max);
    },
    [max, min, step],
  );

  const resetDraft = useCallback(() => {
    setRangeValue(displayRangeValue(value, unsetSliderValue, min, max));
    setTextDraft(value === null ? "" : String(value));
  }, [max, min, unsetSliderValue, value]);

  const commit = useCallback(
    (next: number, snapToStep = true, lowerBound = min, upperBound = max) => {
      const normalized = snapToStep
        ? normalizeRange(next)
        : clamp(next, lowerBound, upperBound);
      if (unsetSliderValue !== undefined && normalized === unsetSliderValue) {
        setRangeValue(unsetSliderValue);
        setTextDraft("");
        if (props.unsetSliderValue !== undefined) props.onCommit(null);
        return;
      }
      setRangeValue(clamp(normalized, min, max));
      setTextDraft(String(normalized));
      props.onCommit(normalized);
    },
    [max, min, normalizeRange, props, unsetSliderValue],
  );

  const commitText = useCallback(() => {
    if (textDraft.trim() === "") {
      if (props.unsetSliderValue !== undefined) {
        setRangeValue(props.unsetSliderValue);
        setTextDraft("");
        props.onCommit(null);
      } else {
        resetDraft();
      }
      return;
    }
    const parsed = Number(textDraft);
    if (!Number.isFinite(parsed)) {
      resetDraft();
      return;
    }
    commit(parsed, snapTextToStep, numberMin, numberMax);
  }, [
    commit,
    numberMax,
    numberMin,
    props,
    resetDraft,
    snapTextToStep,
    textDraft,
  ]);

  const handleTextKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitText();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      resetDraft();
      event.currentTarget.blur();
    }
  };

  return (
    <span
      className={
        className
          ? `output-appearance-slider-row ${className}`
          : "output-appearance-slider-row"
      }
    >
      <CommittedRangeInput
        id={id}
        min={min}
        max={max}
        step={step}
        list={list}
        value={rangeValue}
        disabled={disabled}
        aria-label={ariaLabel}
        onDraftChange={(next) => {
          setTextDraft(next === unsetSliderValue ? "" : String(next));
          onEdit?.();
        }}
        onCommit={commit}
      />
      <TextInput
        id={id ? `${id}-number` : undefined}
        type="number"
        size="small"
        unit={unit || undefined}
        className={unit ? undefined : "output-appearance-number"}
        min={numberMin}
        max={numberMax}
        step={snapTextToStep ? step : "any"}
        value={textDraft}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => {
          const nextText = event.currentTarget.value;
          setTextDraft(nextText);
          if (nextText.trim() === "") {
            if (unsetSliderValue !== undefined) onEdit?.();
            return;
          }
          const parsed = Number(nextText);
          if (!Number.isFinite(parsed)) return;
          setRangeValue(clamp(parsed, min, max));
          onEdit?.();
        }}
        onBlur={commitText}
        onKeyDown={handleTextKeyDown}
      />
    </span>
  );
}
