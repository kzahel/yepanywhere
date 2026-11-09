import {
  VOICE_INPUT_CAPABILITY,
  SPEECH_BACKEND_SETUP_CAPABILITY,
  SERVER_CAPABILITIES,
  hasServerCapabilityAdvertisement,
  serverHasCapability,
} from "@yep-anywhere/shared";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useId,
  useMemo,
} from "react";
import {
  FilterDropdown,
  type FilterOption,
} from "../../components/FilterDropdown";
import { SpeechSmartTurnControls } from "../../components/SpeechSmartTurnControls";
import { SpeechMessagePrefixControls } from "../../components/SpeechMessagePrefixControls";
import { WhisperModelControls } from "../../components/WhisperModelControls";
import { Switch } from "../../components/ui/Switch";
import { SpeechBackendSetup } from "./SpeechBackendSetup";
import { useCanAdministerHost } from "../../hooks/useActingPrincipal";
import { useModelSettings } from "../../hooks/useModelSettings";
import { useBrowserXaiSttApiKey } from "../../hooks/useBrowserXaiSttApiKey";
import { useSpeechCaptureSettings } from "../../hooks/useSpeechCaptureSettings";
import { useSpeechSourceRuntime } from "../../hooks/useSpeechSourceRuntime";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  canSpeechMethodStream,
  getSpeechMethodCapabilities,
  getSpeechMethods,
  isBrowserNativeSpeechAvailable,
  isServerRoutedSpeechMethod,
  resolveSpeechMethod,
  type SpeechMethodId,
} from "../../lib/speechProviders/methods";
import {
  cleanParakeetSpeechModel,
  getCompatibleParakeetModelForBackend,
  getParakeetModelBackendLabel,
  getParakeetSpeechPresetValue,
  isParakeetModelBackend,
  PARAKEET_SPEECH_MODEL_PRESETS,
  type ParakeetModelBackendId,
  resolveParakeetModelBackend,
  requestedParakeetModel,
} from "../../lib/speechProviders/parakeetModels";
import { prewarmYaServerSpeechBackend } from "../../lib/speechProviders/YaServerProvider";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { SpeechVocabularyControls } from "./SpeechVocabularyControls";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

function prewarmSpeechModel(backend: string, model?: string): void {
  void prewarmYaServerSpeechBackend(backend, model).catch((error: unknown) => {
    console.warn(
      "[YaSTT] Speech model prewarm failed",
      error instanceof Error ? error.message : String(error),
    );
  });
}

export function SpeechSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("speechSettingsTitle"));
  const {
    voiceInputEnabled,
    setVoiceInputEnabled,
    speechMethod,
    hasStoredSpeechMethod,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
    parakeetSpeechModel,
    setParakeetSpeechModel,
    whisperSpeechModel,
    setWhisperSpeechModel,
  } = useModelSettings();
  const parakeetModelPresetId = useId();
  const parakeetModelInputId = useId();
  const {
    keepMicWarm,
    setKeepMicWarm,
    reducePlayback,
    setReducePlayback,
    audioWorklet,
    setAudioWorklet,
    unspokenPunctuation,
    setUnspokenPunctuation,
    followUpListenMs,
    setFollowUpListenMs,
    asrAttributionMs,
    setAsrAttributionMs,
    speechMessagePrefixMode,
    setSpeechMessagePrefixMode,
    speechMessageCustomPrefix,
    setSpeechMessageCustomPrefix,
  } = useSpeechCaptureSettings();
  const {
    browserXaiSttApiKey,
    hasBrowserXaiSttApiKey,
    setBrowserXaiSttApiKey,
  } = useBrowserXaiSttApiKey();
  const { relayTransport, relayedServerSpeechAvailable } =
    useSpeechSourceRuntime();
  const { version: versionInfo, loading: versionLoading } = useVersion();
  // Backend setup and the learned vocabulary are host administration; a
  // limited user dictates through the backends without seeing either.
  const canAdministerHost = useCanAdministerHost();
  const recentModels = serverHasCapability(
    versionInfo,
    SERVER_CAPABILITIES.localSpeechModelSelection.name,
  );
  const undoState = useMemo(
    () => ({
      voiceInputEnabled,
      speechMethod,
      speechSmartTurnSettings,
      keepMicWarm,
      reducePlayback,
      audioWorklet,
      unspokenPunctuation,
      followUpListenMs,
      asrAttributionMs,
      speechMessagePrefixMode,
      speechMessageCustomPrefix,
      parakeetSpeechModel,
      whisperSpeechModel,
      browserXaiSttApiKey,
    }),
    [
      voiceInputEnabled,
      speechMethod,
      speechSmartTurnSettings,
      keepMicWarm,
      reducePlayback,
      audioWorklet,
      unspokenPunctuation,
      followUpListenMs,
      asrAttributionMs,
      speechMessagePrefixMode,
      speechMessageCustomPrefix,
      parakeetSpeechModel,
      whisperSpeechModel,
      browserXaiSttApiKey,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: typeof undoState) => {
      setVoiceInputEnabled(snapshot.voiceInputEnabled);
      setSpeechMethod(snapshot.speechMethod);
      setSpeechSmartTurnSettings(snapshot.speechSmartTurnSettings);
      setKeepMicWarm(snapshot.keepMicWarm);
      setReducePlayback(snapshot.reducePlayback);
      setAudioWorklet(snapshot.audioWorklet);
      setUnspokenPunctuation(snapshot.unspokenPunctuation);
      setFollowUpListenMs(snapshot.followUpListenMs);
      setAsrAttributionMs(snapshot.asrAttributionMs);
      setSpeechMessagePrefixMode(snapshot.speechMessagePrefixMode);
      setSpeechMessageCustomPrefix(snapshot.speechMessageCustomPrefix);
      setParakeetSpeechModel(snapshot.parakeetSpeechModel);
      setWhisperSpeechModel(snapshot.whisperSpeechModel);
      setBrowserXaiSttApiKey(snapshot.browserXaiSttApiKey);
    },
    [
      setVoiceInputEnabled,
      setSpeechMethod,
      setSpeechSmartTurnSettings,
      setKeepMicWarm,
      setReducePlayback,
      setAudioWorklet,
      setUnspokenPunctuation,
      setFollowUpListenMs,
      setAsrAttributionMs,
      setSpeechMessagePrefixMode,
      setSpeechMessageCustomPrefix,
      setParakeetSpeechModel,
      setWhisperSpeechModel,
      setBrowserXaiSttApiKey,
    ],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);
  const serverVoiceEnabled =
    !hasServerCapabilityAdvertisement(versionInfo) ||
    serverHasCapability(versionInfo, VOICE_INPUT_CAPABILITY);
  const serverBackends = versionInfo?.voiceBackends ?? [];
  const backendStatuses = versionInfo?.voiceBackendStatuses ?? [];
  const discoverableServerBackends =
    backendStatuses.length > 0
      ? backendStatuses.map((backend) => backend.id)
      : serverBackends;
  const backendOptions: FilterOption<SpeechMethodId>[] = getSpeechMethods(
    discoverableServerBackends,
    undefined,
    { directXaiAvailable: hasBrowserXaiSttApiKey },
  ).map((method) => {
    const backend = backendStatuses.find((entry) => entry.id === method.id);
    const validating = backend?.validationStatus === "pending";
    const unavailable = backend?.validationStatus === "disabled";
    return {
      value: method.id,
      label: method.label,
      description: validating
        ? t("speechSettingsBackendValidating")
        : unavailable
          ? backend.disabledReason || t("speechSettingsBackendUnavailable")
          : method.description,
      disabled: !method.clientSupported || validating || unavailable,
    };
  });
  const selectedBackend = resolveSpeechMethod(
    speechMethod,
    serverBackends,
    hasStoredSpeechMethod,
    {
      directXaiAvailable: hasBrowserXaiSttApiKey,
      browserNativeAvailable: isBrowserNativeSpeechAvailable(),
    },
  );
  const selectedBackendLabel =
    backendOptions.find((option) => option.value === selectedBackend)?.label ??
    selectedBackend ??
    t("speechSettingsBackendUnavailable");
  const selectedBackendCapabilities =
    selectedBackend === null
      ? {}
      : getSpeechMethodCapabilities(
          selectedBackend,
          versionInfo?.voiceBackendCapabilities,
        );
  const selectedBackendServerRouted =
    selectedBackend !== null && isServerRoutedSpeechMethod(selectedBackend);
  const showParakeetModelControls =
    selectedBackend !== null && isParakeetModelBackend(selectedBackend);
  const selectedParakeetPreset =
    recentModels && !parakeetSpeechModel.trim()
      ? "default"
      : getParakeetSpeechPresetValue(
          requestedParakeetModel(parakeetSpeechModel, recentModels) ?? "",
        );
  const enabledParakeetBackends = useMemo(() => {
    const backends: ParakeetModelBackendId[] = [];
    const addBackend = (backendId: string) => {
      if (isParakeetModelBackend(backendId) && !backends.includes(backendId)) {
        backends.push(backendId);
      }
    };
    if (selectedBackend !== null) addBackend(selectedBackend);
    for (const backendId of serverBackends) {
      addBackend(backendId);
    }
    return backends;
  }, [selectedBackend, serverBackends]);
  const selectedBackendCanStream =
    selectedBackend !== null &&
    canSpeechMethodStream({
      methodId: selectedBackend,
      serverCapabilities: versionInfo?.voiceBackendCapabilities,
      relayTransport,
      relayedServerSpeechAvailable,
    });
  const supportsSelectedSmartTurn =
    selectedBackendCanStream && selectedBackendCapabilities.smartTurn === true;
  const smartTurnUnavailableHint =
    relayTransport &&
    selectedBackendServerRouted &&
    !relayedServerSpeechAvailable
      ? t("speechSettingsStreamingRelayUnavailable")
      : t("speechSettingsSmartTurnUnavailable", {
          backend: selectedBackendLabel,
        });
  const prewarmParakeetModel = useCallback(
    (modelValue: string, backendId?: SpeechMethodId) => {
      const targetBackend = backendId ?? selectedBackend;
      if (targetBackend === null || !isParakeetModelBackend(targetBackend)) {
        return;
      }
      const model = requestedParakeetModel(modelValue, recentModels);
      prewarmSpeechModel(targetBackend, model);
    },
    [selectedBackend, recentModels],
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
      if (selectedBackend === null) return;
      const model = modelValue.trim();
      const backendId = resolveParakeetModelBackend(
        model,
        selectedBackend,
        enabledParakeetBackends,
      );
      if (!backendId) return;
      setParakeetSpeechModel(model);
      if (backendId !== selectedBackend) {
        setSpeechMethod(backendId);
      }
      prewarmParakeetModel(model, backendId);
    },
    [
      enabledParakeetBackends,
      prewarmParakeetModel,
      selectedBackend,
      setParakeetSpeechModel,
      setSpeechMethod,
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

  return (
    <SettingsSection
      description={t("speechSettingsDescription")}
      doc="site/src/content/docs/notifications-and-voice.md#browser-voice-input"
    >
      <div className="settings-group">
        {canAdministerHost && (
          <SettingsItem
            id="speech-vocabulary"
            label={t("speechVocabularyTitle")}
            description={t("speechVocabularyDescription")}
            keywords={[
              t("speechVocabularyScan"),
              t("speechVocabularyReset"),
              t("speechVocabularyExplore"),
              t("speechVocabularyBiasing"),
              "keyterms",
              "lexicon",
            ]}
            layout="custom"
            baseClassName=""
          >
            {serverHasCapability(
              versionInfo,
              SERVER_CAPABILITIES.speechVocabulary.name,
            ) ? (
              <SpeechVocabularyControls />
            ) : (
              <>
                <h3>{t("speechVocabularyTitle")}</h3>
                <p>
                  {t(
                    versionInfo?.sqlite?.state === "disabled"
                      ? "speechVocabularyStorageDisabled"
                      : versionInfo?.sqlite?.state === "error" ||
                          versionInfo?.sqlite?.state === "unsupported"
                        ? "speechVocabularyStorageUnavailable"
                        : "speechVocabularyServerUnavailable",
                  )}
                </p>
              </>
            )}
          </SettingsItem>
        )}
        <SettingsItem
          label={t("speechSettingsVoiceInputTitle")}
          description={t("speechSettingsVoiceInputDescription")}
          info={
            <>
              <strong>{t("speechSettingsVoiceInputTitle")}</strong>
              <p>{t("speechSettingsVoiceInputDescription")}</p>
              {!serverVoiceEnabled && (
                <p className="settings-hint">
                  {t("speechSettingsServerDisabled")}
                </p>
              )}
            </>
          }
        >
          <Switch
            checked={voiceInputEnabled && serverVoiceEnabled}
            disabled={versionLoading || !serverVoiceEnabled}
            onCheckedChange={(checked) => setVoiceInputEnabled(checked)}
            aria-label={t("speechSettingsVoiceInputTitle")}
          />
        </SettingsItem>

        {showParakeetModelControls && (
          <SettingsItem
            label={t("speechSettingsParakeetModelTitle")}
            description={t("speechSettingsParakeetModelDescription")}
            className="model-settings-item"
          >
            <div className="speech-backend-settings-field">
              <select
                id={parakeetModelPresetId}
                className="settings-select speech-parakeet-model-select"
                value={selectedParakeetPreset}
                onChange={(event) => {
                  const preset = event.currentTarget.value;
                  if (!preset) return;
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
                {PARAKEET_SPEECH_MODEL_PRESETS.filter(
                  (preset) => recentModels || !preset.requiresRecentModels,
                ).map((preset) => {
                  const backendId = resolveParakeetModelBackend(
                    preset.value,
                    selectedBackend,
                    enabledParakeetBackends,
                  );
                  const requiredBackends = preset.supportedBackends
                    .map(getParakeetModelBackendLabel)
                    .join(" or ");
                  return (
                    <option
                      key={preset.value}
                      value={preset.value}
                      disabled={!backendId}
                    >
                      {backendId
                        ? preset.label
                        : `${preset.label} (${t(
                            "speechSettingsParakeetModelRequiresBackend",
                            { backend: requiredBackends },
                          )})`}
                    </option>
                  );
                })}
              </select>
              <input
                id={parakeetModelInputId}
                className="settings-input"
                value={parakeetSpeechModel}
                placeholder={t(
                  recentModels
                    ? "speechSettingsModelServerDefault"
                    : "speechSettingsParakeetModelPlaceholder",
                )}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setParakeetSpeechModel(event.currentTarget.value)
                }
                onBlur={(event) =>
                  prewarmParakeetModel(event.currentTarget.value)
                }
                onKeyDown={handleParakeetModelKeyDown}
                aria-label={t("speechSettingsParakeetModelInputLabel")}
              />
              <p className="settings-hint">
                {t("speechSettingsParakeetModelHint")}
              </p>
            </div>
          </SettingsItem>
        )}

        {selectedBackend === "ya-whisper" && recentModels && (
          <SettingsItem
            label={t("speechSettingsWhisperModelTitle")}
            description={t("speechSettingsWhisperModelDescription")}
            className="model-settings-item"
          >
            <WhisperModelControls
              model={whisperSpeechModel}
              onChange={setWhisperSpeechModel}
            />
          </SettingsItem>
        )}

        <SettingsItem
          label={t("speechSettingsBackendTitle")}
          description={t("speechSettingsBackendDescription")}
          valueText={selectedBackendLabel}
          className="model-settings-item"
          after={
            relayTransport &&
            !relayedServerSpeechAvailable &&
            selectedBackend === "ya-grok" && (
              <p className="settings-hint">
                {t("speechSettingsStreamingRelayUnavailable")}
              </p>
            )
          }
        >
          <div className="speech-backend-settings-field">
            <FilterDropdown
              label={t("speechSettingsBackendTitle")}
              options={backendOptions}
              selected={selectedBackend === null ? [] : [selectedBackend]}
              onChange={(selected) => {
                const nextBackend = selected[0];
                if (!nextBackend) return;
                if (isParakeetModelBackend(nextBackend)) {
                  prepareParakeetBackend(nextBackend);
                } else if (
                  nextBackend === "ya-granite" ||
                  nextBackend === "ya-qwen" ||
                  nextBackend === "ya-whisper"
                ) {
                  prewarmSpeechModel(
                    nextBackend,
                    nextBackend === "ya-whisper"
                      ? whisperSpeechModel.trim() || undefined
                      : undefined,
                  );
                }
                setSpeechMethod(nextBackend);
              }}
              multiSelect={false}
              placeholder={
                selectedBackend === null
                  ? t("speechSettingsBackendUnavailable")
                  : t("speechSettingsBackendPlaceholder")
              }
              fullWidth
            />
            {serverBackends.length === 0 && (
              <p className="settings-hint">
                {t("speechSettingsNoServerBackends")}
              </p>
            )}
          </div>
        </SettingsItem>

        <SettingsItem
          label={t("speechSettingsXaiKeyTitle")}
          description={t("speechSettingsXaiKeyDescription")}
          className="model-settings-item"
        >
          <input
            type="password"
            id="xai-stt-api-key"
            name="xai-stt-api-key"
            className="settings-input"
            value={browserXaiSttApiKey}
            placeholder={t("speechSettingsXaiKeyPlaceholder")}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => {
              setBrowserXaiSttApiKey(event.currentTarget.value);
            }}
            aria-label={t("speechSettingsXaiKeyTitle")}
          />
        </SettingsItem>

        <SettingsItem
          label={t("speechSettingsUnspokenPunctuationTitle")}
          description={t("speechSettingsUnspokenPunctuationDescription")}
        >
          <Switch
            checked={unspokenPunctuation}
            onCheckedChange={(checked) => setUnspokenPunctuation(checked)}
            aria-label={t("speechSettingsUnspokenPunctuationTitle")}
          />
        </SettingsItem>

        <SettingsItem
          label={t("speechSettingsKeepMicWarmTitle")}
          description={t("speechSettingsKeepMicWarmDescription")}
        >
          <Switch
            checked={keepMicWarm}
            onCheckedChange={(checked) => setKeepMicWarm(checked)}
            aria-label={t("speechSettingsKeepMicWarmTitle")}
          />
        </SettingsItem>

        <SettingsItem
          label={t("speechSettingsReducePlaybackTitle")}
          description={t("speechSettingsReducePlaybackDescription")}
        >
          <Switch
            checked={reducePlayback}
            onCheckedChange={(checked) => setReducePlayback(checked)}
            aria-label={t("speechSettingsReducePlaybackTitle")}
          />
        </SettingsItem>

        <SettingsItem
          label={t("speechSettingsAudioWorkletTitle")}
          description={t("speechSettingsAudioWorkletDescription")}
        >
          <Switch
            checked={audioWorklet}
            onCheckedChange={(checked) => setAudioWorklet(checked)}
            aria-label={t("speechSettingsAudioWorkletTitle")}
          />
        </SettingsItem>

        <SettingsItem
          label={t("speechSettingsSmartTurnTitle")}
          description={t("speechSettingsSmartTurnDescription", {
            backend: selectedBackendLabel,
          })}
          doc="topics/mic-button-speech-ui.md#speech-input-ux-overview"
          className="model-settings-item"
        >
          {supportsSelectedSmartTurn ? (
            <SpeechSmartTurnControls
              settings={speechSmartTurnSettings}
              onChange={setSpeechSmartTurnSettings}
            />
          ) : (
            <p className="settings-hint">{smartTurnUnavailableHint}</p>
          )}
        </SettingsItem>

        <SettingsItem
          label={t("speechSettingsMessagePrefixTitle")}
          description={t("speechSettingsMessagePrefixDescription")}
          className="model-settings-item"
        >
          <SpeechMessagePrefixControls showDescription={false} />
        </SettingsItem>

        {canAdministerHost &&
          serverHasCapability(versionInfo, SPEECH_BACKEND_SETUP_CAPABILITY) && (
            <SpeechBackendSetup />
          )}
      </div>
    </SettingsSection>
  );
}
