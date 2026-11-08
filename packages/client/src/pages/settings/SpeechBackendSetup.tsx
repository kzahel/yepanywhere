import {
  SPEECH_BACKEND_SETUP_CAPABILITY,
  serverHasCapability,
  type LocalSpeechBackendId,
  type SpeechBackendSetupRow,
  type SpeechBackendSetupStatus,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ButtonBase } from "../../components/ui/Button";
import { useCurrentSourceRuntime } from "../../contexts/SourceRuntimeContext";
import { useI18n } from "../../i18n";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import {
  ENGLISH_WER_SOURCE,
  englishModelWer,
} from "../../lib/speechProviders/englishModelWer";
import { SettingsItem } from "./SettingsItem";
import styles from "./SpeechBackendSetup.module.css";

const INSTALL_POLL_MS = 800;

const BACKEND_LABEL_KEYS = {
  "ya-whisper": "speechBackendSetupLabel_ya_whisper",
  "ya-parakeet": "speechBackendSetupLabel_ya_parakeet",
  "ya-nemo": "speechBackendSetupLabel_ya_nemo",
  "ya-granite": "speechBackendSetupLabel_ya_granite",
  "ya-qwen": "speechBackendSetupLabel_ya_qwen",
} as const satisfies Record<LocalSpeechBackendId, string>;

export function SpeechBackendSetup() {
  const { t } = useI18n();
  const { version, refetch: refreshVersion } = useVersion();
  const { transport } = useCurrentSourceRuntime();
  const { settings, updateSettings } = useServerSettings();
  const [status, setStatus] = useState<SpeechBackendSetupStatus>();
  const [error, setError] = useState<string>();
  const [restarting, setRestarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingWhisperGpu, setPendingWhisperGpu] = useState<boolean>();
  const [pendingToggle, setPendingToggle] = useState<{
    id: string;
    enabled: boolean;
  }>();
  const [modelPage, setModelPage] = useState<string>();
  const supported = serverHasCapability(
    version,
    SPEECH_BACKEND_SETUP_CAPABILITY,
  );
  const running = status?.install.running === true;
  const scope = useRef(transport);
  scope.current = transport;

  const refresh = useCallback(async () => {
    try {
      const next =
        await transport.fetch<SpeechBackendSetupStatus>("/speech/backends");
      if (scope.current !== transport) return;
      setStatus(next);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [transport]);

  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
    setSaving(false);
    setPendingWhisperGpu(undefined);
    if (supported) void refresh();
  }, [refresh, supported]);

  useEffect(() => {
    if (
      !supported ||
      (!status?.install.running &&
        !status?.catalog.some((row) => row.validationStatus === "pending"))
    )
      return;
    const timer = setTimeout(() => {
      void refresh();
    }, INSTALL_POLL_MS);
    return () => clearTimeout(timer);
  }, [refresh, supported, status]);

  const catalogKey = status?.catalog
    .map((row) => `${row.id}:${row.advertised}:${row.validationStatus}`)
    .join(",");
  useEffect(() => {
    if (catalogKey) void refreshVersion();
  }, [catalogKey, refreshVersion]);

  if (!supported) {
    return null;
  }

  const toggle = async (row: SpeechBackendSetupRow, enabled: boolean) => {
    if (row.enabledByEnv || saving) return;
    const current =
      settings?.speechVoiceBackends ?? status?.settingsBackends ?? [];
    const next = enabled
      ? [...new Set([...current, row.id])]
      : current.filter((id) => id !== row.id);
    try {
      setSaving(true);
      setPendingToggle({ id: row.id, enabled });
      if (enabled && row.id === "ya-granite" && row.modelFilesPresent !== true)
        setModelPage(row.defaultModel);
      await updateSettings({ speechVoiceBackends: next });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
      setPendingToggle(undefined);
    }
  };

  const install = async (id: string) => {
    try {
      setError(undefined);
      const installStatus = await transport.fetch<
        SpeechBackendSetupStatus["install"]
      >(`/speech/backends/${id}/install`, {
        method: "POST",
      });
      setStatus((current) =>
        current ? { ...current, install: installStatus } : current,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const setWhisperGpu = async (enabled: boolean) => {
    const target = transport;
    setPendingWhisperGpu(enabled);
    setSaving(true);
    setError(undefined);
    try {
      const next = await target.fetch<SpeechBackendSetupStatus>(
        "/speech/backends/ya-whisper/gpu",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      if (scope.current === target) setStatus(next);
    } catch (err) {
      if (scope.current !== target) return;
      await refresh();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (scope.current === target) {
        setSaving(false);
        setPendingWhisperGpu(undefined);
      }
    }
  };

  const restart = async () => {
    try {
      setRestarting(true);
      setError(undefined);
      await transport.fetch("/speech/backends/restart", { method: "POST" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRestarting(false);
    }
  };

  return (
    <SettingsItem
      id="speech-backend-setup"
      label={t("speechBackendSetupTitle")}
      description={t(
        status?.liveEnablement
          ? "speechBackendSetupLiveDescription"
          : "speechBackendSetupDescription",
      )}
      keywords={[
        "YEP_VOICE_BACKENDS",
        "pixi",
        "huggingface",
        "ya-whisper",
        "ya-parakeet",
        "ya-nemo",
        "ya-granite",
        "ya-qwen",
        "install",
        "restart",
      ]}
      className="model-settings-item"
    >
      <div className={styles.wrap}>
        <p className="settings-hint">
          {t("speechBackendSetupModelAdvice")}{" "}
          <a href={ENGLISH_WER_SOURCE} target="_blank" rel="noreferrer">
            {t("speechBackendSetupWerSource")}
          </a>
          {" · "}
          <a
            href="https://huggingface.co/nvidia/parakeet-unified-en-0.6b#asr-performance-wo-pnc"
            target="_blank"
            rel="noreferrer"
          >
            NVIDIA
          </a>
          {" · "}
          <a
            href="https://x.ai/news/grok-stt-and-tts-apis"
            target="_blank"
            rel="noreferrer"
          >
            xAI
          </a>
        </p>
        {error && (
          <p className="settings-hint" role="alert">
            {error}
          </p>
        )}
        <div className={styles.catalog}>
          {(status?.catalog ?? []).map((row) => (
            <section
              className={styles.backend}
              key={row.id}
              aria-label={t(BACKEND_LABEL_KEYS[row.id])}
            >
              <label
                className={styles.enable}
                data-locked={row.enabledByEnv || undefined}
              >
                <input
                  type="checkbox"
                  checked={
                    pendingToggle?.id === row.id
                      ? pendingToggle.enabled
                      : row.enabled
                  }
                  disabled={row.enabledByEnv || saving}
                  aria-describedby={
                    row.enabledByEnv ? `${row.id}-environment-lock` : undefined
                  }
                  onChange={(event) =>
                    void toggle(row, event.currentTarget.checked)
                  }
                  aria-label={t(
                    status?.liveEnablement
                      ? "speechBackendSetupEnableNowLabel"
                      : "speechBackendSetupEnableLabel",
                    {
                      backend: t(BACKEND_LABEL_KEYS[row.id]),
                    },
                  )}
                />
                <strong>{t(BACKEND_LABEL_KEYS[row.id])}</strong>
              </label>
              {row.enabledByEnv && (
                <p
                  className={styles.environmentLock}
                  id={`${row.id}-environment-lock`}
                >
                  <strong>{t("speechBackendSetupEnvironmentLock")}</strong>{" "}
                  {t("speechBackendSetupEnvironmentHelp")}
                </p>
              )}
              <code className={styles.model}>{row.defaultModel}</code>
              {row.id === "ya-whisper" && (
                <span className="settings-hint">
                  {t("speechBackendSetupWhisperPerformance")}
                </span>
              )}
              {row.id === "ya-whisper" &&
                typeof status?.whisperGpu === "boolean" && (
                  <div>
                    <label className={styles.enable}>
                      <input
                        type="checkbox"
                        checked={pendingWhisperGpu ?? status.whisperGpu}
                        disabled={saving || (!row.enabled && !row.advertised)}
                        onChange={(event) =>
                          void setWhisperGpu(event.currentTarget.checked)
                        }
                      />
                      <span>{t("speechBackendSetupWhisperGpu")}</span>
                    </label>
                    <p className="settings-hint">
                      {t("speechBackendSetupWhisperGpuHelp")}
                    </p>
                  </div>
                )}
              {row.defaultModel === "distil-large-v3.5" && (
                <span className="settings-hint">756M parameters</span>
              )}
              {row.id === "ya-nemo" && (
                <p className="settings-hint">
                  {t("speechBackendSetupStreamingAdvice")}
                </p>
              )}
              {row.id === "ya-nemo" && (
                <span className="settings-hint">
                  {t("speechBackendSetupNemoSize")}
                </span>
              )}
              <span className="settings-hint">
                {englishModelWer(row.defaultModel)}
              </span>
              <div className={styles.backendActions}>
                <Button disabled={running} onClick={() => void install(row.id)}>
                  {t("speechBackendSetupInstall")}
                </Button>
                <ButtonBase
                  className={styles.modelLink}
                  onClick={() =>
                    setModelPage(
                      row.id === "ya-whisper"
                        ? "distil-whisper/distil-large-v3.5-ct2"
                        : row.defaultModel,
                    )
                  }
                >
                  {t("speechBackendSetupModelAccess")}
                </ButtonBase>
              </div>
              <p className={styles.meta}>
                {row.enabledByEnv
                  ? t("speechBackendSetupFromEnv")
                  : row.enabledBySettings
                    ? t("speechBackendSetupFromSettings")
                    : t("speechBackendSetupDisabled")}
                {row.advertised
                  ? ` · ${t("speechBackendSetupLive")}`
                  : row.enabled
                    ? ` · ${t(row.validationStatus === "pending" ? "speechBackendSetupValidating" : row.validationStatus === "disabled" ? "speechBackendSetupUnavailable" : "speechBackendSetupNeedsRestart")}`
                    : ""}
                {!row.enabled &&
                  row.advertised &&
                  ` · ${t("speechBackendSetupDisableRestart")}`}
              </p>
              {row.disabledReason && (
                <p className={styles.meta} role="alert">
                  {row.disabledReason}
                </p>
              )}
            </section>
          ))}
        </div>
        {modelPage && (
          <section
            className={styles.access}
            aria-label={t("speechBackendSetupModelAccess")}
          >
            <p>{t("speechBackendSetupAccessHelp")}</p>
            <a
              href={`https://huggingface.co/${modelPage}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {modelPage} — {t("speechBackendSetupOpenBrowser")}
            </a>
            <code>
              {status?.workingDirectory &&
                `cd '${status.workingDirectory.replaceAll("'", "'\\''")}' && `}
              pixi run --frozen -e{" "}
              {status?.catalog.find((row) => row.defaultModel === modelPage)
                ?.pixiEnvironment ?? "stt"}{" "}
              hf auth login
            </code>
            <Button onClick={() => setModelPage(undefined)}>
              {t("speechBackendSetupCloseModel")}
            </Button>
          </section>
        )}
        <label
          className={styles.consoleLabel}
          htmlFor="speech-backend-install-log"
        >
          {t("speechBackendSetupConsole")}
        </label>
        <pre
          id="speech-backend-install-log"
          className={styles.console}
          role="region"
          aria-label={t("speechBackendSetupConsole")}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need focus to scroll the install log.
          tabIndex={0}
        >
          {(status?.install.lines ?? []).join("\n") ||
            t("speechBackendSetupConsoleEmpty")}
        </pre>
        <div className={styles.actions}>
          <Button
            disabled={
              restarting || running || status?.restartAvailable !== true
            }
            onClick={() => void restart()}
          >
            {t(
              restarting
                ? "speechBackendSetupRestartScheduled"
                : "speechBackendSetupRestart",
            )}
          </Button>
          {status?.liveEnablement && (
            <p className="settings-hint">
              {t("speechBackendSetupRestartOnlyDisable")}
            </p>
          )}
          {status?.restartAvailable === false && (
            <p className="settings-hint">
              {t("speechBackendSetupRestartHint")}
            </p>
          )}
        </div>
      </div>
    </SettingsItem>
  );
}
