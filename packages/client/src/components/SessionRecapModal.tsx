import {
  DEFAULT_RECAP_AFTER_SECONDS,
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  type ModelInfo,
  type ProviderName,
  type RecapMode,
  normalizeRecapAfterSeconds,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useProviders } from "../hooks/useProviders";
import { useI18n } from "../i18n";
import { getRecapModeDescription } from "../lib/recapModes";
import { RecapAfterSecondsControl } from "./RecapAfterSecondsControl";
import styles from "./SessionRecapModal.module.css";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Select } from "./ui/Field";
import { SegmentedControl } from "./ui/SegmentedControl";

interface SessionRecapModalProps {
  sessionId: string;
  processId: string;
  provider?: ProviderName;
  currentModel?: string;
  onClose: () => void;
  onSaved: (settings: {
    recapMode: RecapMode;
    recapAfterSeconds: number;
    helperSideModel: string;
  }) => void;
}

const RECAP_MODE_ORDER: RecapMode[] = ["off", "side-session", "fork"];
type Translate = ReturnType<typeof useI18n>["t"];

function modeLabel(mode: RecapMode, t: Translate): string {
  if (mode === "native") return t("recapModeNative");
  if (mode === "fork") return t("recapModeFork");
  if (mode === "side-session") return t("recapModeSideSession");
  return t("recapModeOff");
}

export function SessionRecapModal({
  sessionId,
  processId,
  provider,
  currentModel,
  onClose,
  onSaved,
}: SessionRecapModalProps) {
  const { t } = useI18n();
  const { providers } = useProviders();
  const [recapMode, setRecapMode] = useState<RecapMode>("off");
  const [recapAfterSeconds, setRecapAfterSeconds] = useState(
    DEFAULT_RECAP_AFTER_SECONDS,
  );
  const [helperSideModel, setHelperSideModel] = useState<string>(
    HELPER_SIDE_MODEL_CHEAPEST,
  );
  const [processProvider, setProcessProvider] = useState<
    ProviderName | undefined
  >(provider);
  const [processModel, setProcessModel] = useState<string | undefined>(
    currentModel,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    api
      .getProcessInfo(sessionId)
      .then((response) => {
        if (cancelled) return;
        const process = response.process;
        setRecapMode(
          process?.recapMode === "native"
            ? "off"
            : (process?.recapMode ?? "off"),
        );
        setRecapAfterSeconds(
          normalizeRecapAfterSeconds(process?.recapAfterSeconds),
        );
        setHelperSideModel(
          process?.helperSideModel ?? HELPER_SIDE_MODEL_CHEAPEST,
        );
        setProcessProvider(
          (process?.provider as ProviderName | undefined) ?? provider,
        );
        setProcessModel(process?.model ?? currentModel);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : t("sessionRecapLoadFailed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentModel, provider, sessionId, t]);

  const providerInfo = providers.find((p) => p.name === processProvider);
  const models = providerInfo?.models ?? [];
  const modeAvailability = useMemo(
    () => ({
      off: true,
      native: false,
      fork: providerInfo?.supportsRecaps === true,
      "side-session": providerInfo?.supportsRecaps === true,
    }),
    [providerInfo],
  );
  const modelOptions = useMemo<ModelInfo[]>(
    () => [
      {
        id: HELPER_SIDE_MODEL_CHEAPEST,
        name: t("helperSideModelCheapest"),
      },
      {
        id: HELPER_SIDE_MODEL_SAME_AS_MAIN,
        name: t("helperSideModelSameAsMain"),
        description:
          processModel && processModel !== HELPER_SIDE_MODEL_SAME_AS_MAIN
            ? processModel
            : undefined,
      },
      ...models,
    ],
    [models, processModel, t],
  );
  const effectiveHelperSideModel = modelOptions.some(
    (model) => model.id === helperSideModel,
  )
    ? helperSideModel
    : HELPER_SIDE_MODEL_CHEAPEST;

  const save = useCallback(async () => {
    if (!modeAvailability[recapMode]) {
      setError(t("sessionRecapUnsupportedMode"));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const result = await api.setProcessRecapConfig(processId, {
        recapMode,
        recapAfterSeconds,
        helperSideModel: effectiveHelperSideModel,
      });
      onSaved({
        recapMode: result.recapMode,
        recapAfterSeconds: result.recapAfterSeconds,
        helperSideModel: result.helperSideModel,
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("sessionRecapSaveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    effectiveHelperSideModel,
    modeAvailability,
    onClose,
    onSaved,
    processId,
    recapAfterSeconds,
    recapMode,
    t,
  ]);

  return (
    <Dialog
      title={t("sessionRecapTitle")}
      size="medium"
      onClose={isSaving ? () => {} : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={isSaving}>
            {t("modalCancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            busy={isSaving}
            disabled={isLoading || !modeAvailability[recapMode]}
          >
            {t("sessionRecapSave")}
          </Button>
        </>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      <div className="settings-item model-settings-item">
        <div className="settings-item-info">
          <strong>{t("sessionRecapModeTitle")}</strong>
          <p>{t("sessionRecapModeDescription")}</p>
        </div>
        <SegmentedControl
          className="model-settings-chip-group"
          aria-label={t("sessionRecapModeTitle")}
          options={RECAP_MODE_ORDER.map((mode) => ({
            value: mode,
            label: modeLabel(mode, t),
            tooltip: getRecapModeDescription(mode, t, recapAfterSeconds),
            disabled: !modeAvailability[mode],
          }))}
          value={recapMode}
          onChange={setRecapMode}
          disabled={isLoading || isSaving}
        />
        <p className="recap-mode-caption">
          {getRecapModeDescription(recapMode, t, recapAfterSeconds)}
        </p>
      </div>

      {recapMode !== "off" && (
        <RecapAfterSecondsControl
          value={recapAfterSeconds}
          disabled={isLoading || isSaving}
          mode={recapMode}
          onCommit={setRecapAfterSeconds}
        />
      )}

      {recapMode === "side-session" && (
        <label className="settings-item model-settings-item">
          <div className="settings-item-info">
            <strong>{t("helperSideModelTitle")}</strong>
            <p>{t("helperSideModelDescription")}</p>
          </div>
          <Select
            className={styles.modelSelect}
            value={effectiveHelperSideModel}
            onChange={(event) => setHelperSideModel(event.target.value)}
            disabled={isLoading || isSaving}
          >
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </Select>
        </label>
      )}
    </Dialog>
  );
}
