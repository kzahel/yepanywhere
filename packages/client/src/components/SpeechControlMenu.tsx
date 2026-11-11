import speechStyles from "./SpeechControlMenu.module.css";
import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FilterOption } from "./FilterDropdown";
import { SpeechMessagePrefixControls } from "./SpeechMessagePrefixControls";
import { WhisperModelControls } from "./WhisperModelControls";
import { useVersion } from "../hooks/useVersion";
import { SpeechSmartTurnControls } from "./SpeechSmartTurnControls";
import { IconButton } from "./ui/Button";
import { useModelSettings } from "../hooks/useModelSettings";
import { useSpeechCaptureSettings } from "../hooks/useSpeechCaptureSettings";
import { useI18n } from "../i18n";
import type { SpeechMethodId } from "../lib/speechProviders/methods";
import {
  cleanParakeetSpeechModel,
  getCompatibleParakeetModelForBackend,
  getParakeetSpeechPresetValue,
  isParakeetModelBackend,
  PARAKEET_SPEECH_MODEL_PRESETS,
  type ParakeetModelBackendId,
  resolveParakeetModelBackend,
  requestedParakeetModel,
} from "../lib/speechProviders/parakeetModels";
import type { SpeechSmartTurnSettings } from "../lib/speechProviders/SpeechProvider";
import { prewarmYaServerSpeechBackend } from "../lib/speechProviders/YaServerProvider";

interface DataAttributes {
  "data-session-toolbar-control"?: string;
  "data-session-toolbar-special-context"?: "true";
}

interface SpeechControlMenuProps {
  trigger: ReactNode;
  showMethodSelector: boolean;
  methodOptions: FilterOption<SpeechMethodId>[];
  selectedMethod: SpeechMethodId | null;
  onMethodChange: (selected: string[]) => void;
  smartTurnSettings?: SpeechSmartTurnSettings;
  onSmartTurnSettingsChange?: (settings: SpeechSmartTurnSettings) => void;
  smartTurnDisabled?: boolean;
  onPointerNearTrigger?: () => void;
  onBeforeOpen?: () => void;
  onBeforeCaptureChange?: () => void;
  rootDataAttributes?: DataAttributes;
}

const LONG_PRESS_MS = 500;
const POINTER_NEAR_MARGIN_PX = 32;

function getMediaDevices(): MediaDevices | null {
  return typeof navigator !== "undefined" ? navigator.mediaDevices : null;
}

function audioInputLabel(device: MediaDeviceInfo, index: number): string {
  return device.label || `Microphone ${index + 1}`;
}

export function SpeechControlMenu({
  trigger,
  showMethodSelector,
  methodOptions,
  selectedMethod,
  onMethodChange,
  smartTurnSettings,
  onSmartTurnSettingsChange,
  smartTurnDisabled = false,
  onPointerNearTrigger,
  onBeforeOpen,
  onBeforeCaptureChange,
  rootDataAttributes,
}: SpeechControlMenuProps) {
  const { t } = useI18n();
  const micDeviceSelectId = useId();
  const parakeetModelPresetId = useId();
  const parakeetModelInputId = useId();
  const methodDescriptionIdPrefix = useId();
  const { micDeviceId, setMicDeviceId, reducePlayback, setReducePlayback } =
    useSpeechCaptureSettings();
  const {
    parakeetSpeechModel,
    setParakeetSpeechModel,
    whisperSpeechModel,
    setWhisperSpeechModel,
  } = useModelSettings();
  const { version } = useVersion();
  const recentModels = serverHasCapability(
    version,
    SERVER_CAPABILITIES.localSpeechModelSelection.name,
  );
  const [open, setOpen] = useState(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceError, setMicDeviceError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const keepInsideViewport = () => {
      const rect = panel.getBoundingClientRect();
      const desiredLeft = Math.max(
        8,
        Math.min(rect.left, window.innerWidth - rect.width - 8),
      );
      const shift = desiredLeft - rect.left;
      if (shift !== 0) panel.style.left = `${panel.offsetLeft + shift}px`;
    };
    keepInsideViewport();
    window.addEventListener("resize", keepInsideViewport);
    return () => window.removeEventListener("resize", keepInsideViewport);
  }, [open]);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressOpenedRef = useRef(false);
  const pointerNearRef = useRef(false);
  const selectedMethodLabel = useMemo(
    () =>
      methodOptions.find((option) => option.value === selectedMethod)?.label ??
      selectedMethod ??
      t("speechSettingsBackendUnavailable"),
    [methodOptions, selectedMethod, t],
  );
  const showSmartTurnControls =
    !!smartTurnSettings && !!onSmartTurnSettingsChange;
  const showMicDeviceControls =
    selectedMethod !== null && selectedMethod !== "browser-native";
  const showParakeetModelControls =
    selectedMethod !== null && isParakeetModelBackend(selectedMethod);
  const enabledParakeetBackends = useMemo(() => {
    const backends: ParakeetModelBackendId[] = [];
    const addBackend = (backendId: string) => {
      if (isParakeetModelBackend(backendId) && !backends.includes(backendId)) {
        backends.push(backendId);
      }
    };
    if (selectedMethod !== null) addBackend(selectedMethod);
    for (const option of methodOptions) {
      addBackend(option.value);
    }
    return backends;
  }, [methodOptions, selectedMethod]);
  // Show only the models the *selected* backend can actually run, so each
  // backend lists its own models (ya-parakeet: tdt+ctc; ya-nemo: all three).
  // The backends are kept separate on purpose; no cross-backend auto-switch
  // from this dropdown. Switching backends still normalizes an incompatible
  // model (see prepareParakeetBackend) and the mic reconciles as a safety net.
  const parakeetPresetOptions = useMemo(
    () =>
      selectedMethod !== null && isParakeetModelBackend(selectedMethod)
        ? PARAKEET_SPEECH_MODEL_PRESETS.filter(
            (preset) =>
              preset.supportedBackends.includes(selectedMethod) &&
              (recentModels || !preset.requiresRecentModels),
          )
        : [],
    [selectedMethod, recentModels],
  );
  const storedParakeetPreset = getParakeetSpeechPresetValue(
    requestedParakeetModel(parakeetSpeechModel, recentModels) ?? "",
  );
  const selectedParakeetPreset =
    recentModels && !parakeetSpeechModel.trim()
      ? "default"
      : parakeetPresetOptions.some(
            (preset) => preset.value === storedParakeetPreset,
          )
        ? storedParakeetPreset
        : "";
  const selectedMicDeviceUnavailable =
    !!micDeviceId &&
    !micDevices.some((device) => device.deviceId === micDeviceId);

  const prewarmParakeetModel = useCallback(
    (modelValue: string, backendId?: SpeechMethodId) => {
      const targetBackend = backendId ?? selectedMethod;
      if (targetBackend === null || !isParakeetModelBackend(targetBackend)) {
        return;
      }
      const model = requestedParakeetModel(modelValue, recentModels);
      void prewarmYaServerSpeechBackend(targetBackend, model).catch(
        (err: unknown) => {
          console.warn(
            "[YaSTT] Speech model prewarm failed",
            err instanceof Error ? err.message : String(err),
          );
        },
      );
    },
    [selectedMethod, recentModels],
  );

  const handleParakeetModelKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      prewarmParakeetModel(event.currentTarget.value);
    },
    [prewarmParakeetModel],
  );
  const selectParakeetPreset = useCallback(
    (modelValue: string) => {
      if (selectedMethod === null) return;
      const model = modelValue.trim();
      const backendId = resolveParakeetModelBackend(
        model,
        selectedMethod,
        enabledParakeetBackends,
      );
      if (!backendId) return;
      setParakeetSpeechModel(model);
      if (backendId !== selectedMethod) {
        onMethodChange([backendId]);
      }
      prewarmParakeetModel(model, backendId);
    },
    [
      enabledParakeetBackends,
      onMethodChange,
      prewarmParakeetModel,
      selectedMethod,
      setParakeetSpeechModel,
    ],
  );
  const prepareParakeetBackend = useCallback(
    (backendId: SpeechMethodId) => {
      if (!isParakeetModelBackend(backendId)) return;
      const model = getCompatibleParakeetModelForBackend(
        parakeetSpeechModel,
        backendId,
      );
      if (model !== cleanParakeetSpeechModel(parakeetSpeechModel)) {
        setParakeetSpeechModel(model);
      }
      prewarmParakeetModel(model, backendId);
    },
    [parakeetSpeechModel, prewarmParakeetModel, setParakeetSpeechModel],
  );

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const openMenu = useCallback(() => {
    onBeforeOpen?.();
    setOpen(true);
  }, [onBeforeOpen]);

  const refreshMicDevices = useCallback(async () => {
    const mediaDevices = getMediaDevices();
    if (typeof mediaDevices?.enumerateDevices !== "function") {
      setMicDevices([]);
      setMicDeviceError("Microphone list unavailable");
      return;
    }

    try {
      const devices = await mediaDevices.enumerateDevices();
      setMicDevices(
        devices.filter(
          (device) => device.kind === "audioinput" && device.deviceId,
        ),
      );
      setMicDeviceError(null);
    } catch {
      setMicDevices([]);
      setMicDeviceError("Microphone list unavailable");
    }
  }, []);

  useEffect(() => {
    if (!open || !showMicDeviceControls) return;
    void refreshMicDevices();

    const mediaDevices = getMediaDevices();
    if (typeof mediaDevices?.addEventListener !== "function") return;
    mediaDevices.addEventListener("devicechange", refreshMicDevices);
    return () =>
      mediaDevices.removeEventListener?.("devicechange", refreshMicDevices);
  }, [open, refreshMicDevices, showMicDeviceControls]);

  useEffect(() => {
    if (!onPointerNearTrigger) return;

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      if (event.pointerType && event.pointerType !== "mouse") return;
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const near =
        event.clientX >= rect.left - POINTER_NEAR_MARGIN_PX &&
        event.clientX <= rect.right + POINTER_NEAR_MARGIN_PX &&
        event.clientY >= rect.top - POINTER_NEAR_MARGIN_PX &&
        event.clientY <= rect.bottom + POINTER_NEAR_MARGIN_PX;
      if (!near) {
        pointerNearRef.current = false;
        return;
      }
      if (pointerNearRef.current) return;
      pointerNearRef.current = true;
      onPointerNearTrigger();
    };

    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [onPointerNearTrigger]);

  useEffect(() => {
    return clearLongPress;
  }, [clearLongPress]);

  useEffect(() => {
    if (!open) return;

    const handleDocumentPointerDown = (event: globalThis.PointerEvent) => {
      const root = rootRef.current;
      if (root?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    return () =>
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      );
  }, [open]);

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (panelRef.current?.contains(event.target as Node)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearLongPress();
    longPressOpenedRef.current = false;
    if (!open) {
      onBeforeOpen?.();
    }
    setOpen((current) => !current);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    clearLongPress();
    longPressOpenedRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressOpenedRef.current = true;
      longPressTimerRef.current = null;
      openMenu();
    }, LONG_PRESS_MS);
  };

  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (panelRef.current?.contains(event.target as Node)) {
      return;
    }

    if (longPressOpenedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      longPressOpenedRef.current = false;
      return;
    }

    if (open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: This non-interactive wrapper captures long-press/context gestures for the nested speech trigger and popup.
    <div
      ref={rootRef}
      role="presentation"
      className={`${speechStyles.speechControlMenu}${open ? ` ${speechStyles["is-open"]}` : ""}`}
      {...rootDataAttributes}
      onClickCapture={handleClickCapture}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
    >
      {trigger}
      {open && (
        <div
          ref={panelRef}
          className={speechStyles.speechOptionsPanel}
          role="dialog"
          aria-label="Speech options"
        >
          <div className={speechStyles.speechOptionsHeader}>
            <div className={speechStyles.speechOptionsTitleBlock}>
              <span className={speechStyles.speechOptionsTitle}>Speech</span>
              <span className={speechStyles.speechOptionsSubtitle}>
                {selectedMethodLabel}
              </span>
            </div>
            <IconButton
              size="small"
              label="Close speech options"
              onClick={() => setOpen(false)}
            >
              x
            </IconButton>
          </div>
          {showSmartTurnControls && (
            <section className={speechStyles.speechOptionsSection}>
              <SpeechSmartTurnControls
                settings={smartTurnSettings}
                onChange={onSmartTurnSettingsChange}
                disabled={smartTurnDisabled}
              />
            </section>
          )}
          <section className={speechStyles.speechOptionsSection}>
            <div className={speechStyles.speechOptionsSectionTitle}>
              {t("speechSettingsMessagePrefixTitle")}
            </div>
            <SpeechMessagePrefixControls disabled={smartTurnDisabled} />
          </section>
          {showParakeetModelControls && (
            <section className={speechStyles.speechOptionsSection}>
              <label
                className={speechStyles.speechOptionsSectionTitle}
                htmlFor={parakeetModelPresetId}
              >
                {t("speechSettingsParakeetModelTitle")}
              </label>
              <select
                id={parakeetModelPresetId}
                className={speechStyles.speechParakeetModelSelect}
                value={selectedParakeetPreset}
                onChange={(event) => {
                  const preset = event.currentTarget.value;
                  if (!preset) return;
                  onBeforeCaptureChange?.();
                  selectParakeetPreset(preset === "default" ? "" : preset);
                }}
                aria-label={t("speechSettingsParakeetModelPresetLabel")}
              >
                {recentModels && (
                  <option value="default">
                    {t("speechSettingsModelServerDefault")}
                  </option>
                )}
                <option value="">
                  {t("speechSettingsParakeetCustomModel")}
                </option>
                {parakeetPresetOptions.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
              <input
                id={parakeetModelInputId}
                className={speechStyles.speechParakeetModelInput}
                value={parakeetSpeechModel}
                placeholder={t(
                  recentModels
                    ? "speechSettingsModelServerDefault"
                    : "speechSettingsParakeetModelPlaceholder",
                )}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  onBeforeCaptureChange?.();
                  setParakeetSpeechModel(event.currentTarget.value);
                }}
                onBlur={(event) =>
                  prewarmParakeetModel(event.currentTarget.value)
                }
                onKeyDown={handleParakeetModelKeyDown}
                aria-label={t("speechSettingsParakeetModelInputLabel")}
              />
            </section>
          )}
          {selectedMethod === "ya-whisper" && recentModels && (
            <section className={speechStyles.speechOptionsSection}>
              <div className={speechStyles.speechOptionsSectionTitle}>
                {t("speechSettingsWhisperModelTitle")}
              </div>
              <WhisperModelControls
                model={whisperSpeechModel}
                onChange={setWhisperSpeechModel}
                onBeforeChange={onBeforeCaptureChange}
              />
            </section>
          )}
          {showMethodSelector && (
            <section className={speechStyles.speechOptionsSection}>
              <div className={speechStyles.speechOptionsSectionTitle}>
                STT backend
              </div>
              <div
                className={speechStyles.speechMethodOptions}
                role="radiogroup"
                aria-label="STT backend"
              >
                {methodOptions.map((option) => {
                  const selected = option.value === selectedMethod;
                  const descriptionId = option.description
                    ? `${methodDescriptionIdPrefix}-${option.value}-description`
                    : undefined;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`${speechStyles.speechMethodOption}${selected ? ` ${speechStyles.selected}` : ""}`}
                      role="radio"
                      aria-checked={selected}
                      aria-label={option.label}
                      aria-describedby={descriptionId}
                      disabled={option.disabled}
                      onClick={() => {
                        if (option.value !== selectedMethod) {
                          onBeforeCaptureChange?.();
                        }
                        prepareParakeetBackend(option.value);
                        onMethodChange([option.value]);
                      }}
                    >
                      <span
                        className={speechStyles.speechMethodRadio}
                        aria-hidden="true"
                      >
                        {selected && (
                          <span className={speechStyles.speechMethodRadioDot} />
                        )}
                      </span>
                      <span className={speechStyles.speechMethodCopy}>
                        <span className={speechStyles.speechMethodLabel}>
                          {option.label}
                        </span>
                        {option.description && (
                          <span
                            id={descriptionId}
                            className={speechStyles.speechMethodDescription}
                            title={option.description}
                          >
                            {option.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          {showMicDeviceControls && (
            <section className={speechStyles.speechOptionsSection}>
              <label
                className={speechStyles.speechOptionsSectionTitle}
                htmlFor={micDeviceSelectId}
              >
                Microphone
              </label>
              <select
                id={micDeviceSelectId}
                className={speechStyles.speechMicDeviceSelect}
                value={micDeviceId ?? ""}
                onChange={(event) => {
                  onBeforeCaptureChange?.();
                  setMicDeviceId(event.currentTarget.value || null);
                }}
                onFocus={() => void refreshMicDevices()}
              >
                <option value="">System default</option>
                {selectedMicDeviceUnavailable && micDeviceId && (
                  <option value={micDeviceId}>
                    Selected microphone unavailable
                  </option>
                )}
                {micDevices.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {audioInputLabel(device, index)}
                  </option>
                ))}
              </select>
              {micDeviceError && (
                <div className={speechStyles.speechMicDeviceError}>
                  {micDeviceError}
                </div>
              )}
            </section>
          )}
          <section className={speechStyles.speechOptionsSection}>
            <div className={speechStyles.speechOptionsSectionTitle}>
              {t("speechSettingsReducePlaybackSection")}
            </div>
            <label className={speechStyles.speechMethodOption}>
              <input
                type="checkbox"
                checked={reducePlayback}
                onChange={(event) => {
                  onBeforeCaptureChange?.();
                  setReducePlayback(event.currentTarget.checked);
                }}
              />
              <span className={speechStyles.speechMethodCopy}>
                <span className={speechStyles.speechMethodLabel}>
                  {t("speechSettingsReducePlaybackTitle")}
                </span>
              </span>
            </label>
          </section>
        </div>
      )}
    </div>
  );
}
