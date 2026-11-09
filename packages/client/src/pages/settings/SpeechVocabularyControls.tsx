import type { SpeechVocabularyStatus } from "@yep-anywhere/shared";
import { useEffect, useId, useRef, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { TextInput } from "../../components/ui/Field";
import { Switch } from "../../components/ui/Switch";
import { useCurrentSourceRuntime } from "../../contexts/SourceRuntimeContext";
import { useI18n } from "../../i18n";
import styles from "./SpeechVocabularyControls.module.css";
import SpeechVocabularyChart from "./SpeechVocabularyChart";

export function SpeechVocabularyControls() {
  const { t } = useI18n();
  const { transport } = useCurrentSourceRuntime();
  const [status, setStatus] = useState<SpeechVocabularyStatus>();
  const [hours, setHours] = useState("24");
  const [multiplier, setMultiplier] = useState("5");
  const [share, setShare] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showLexicon, setShowLexicon] = useState(false);
  const includeWords = useRef(false);
  includeWords.current = showLexicon;
  const id = useId();
  const revision = useRef(0);
  const scope = useRef(transport);
  scope.current = transport;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(undefined);
    setError(undefined);
    setBusy(false);
    let first = true;
    const refresh = async () => {
      const observedRevision = revision.current;
      try {
        const next = await transport.fetch<SpeechVocabularyStatus>(
          `/speech/vocabulary${includeWords.current ? "?includeWords=1" : ""}`,
        );
        if (disposed) return;
        if (!includeWords.current) delete next.words;
        if (observedRevision === revision.current) {
          setStatus(next);
          if (first) {
            setHours(String(next.hours));
            // A server too old to report these omits them; fall back to the
            // values it behaves as, so the form stays usable and saving the
            // rest of it does not send NaN.
            setMultiplier(String(next.sessionMultiplier ?? 5));
            setShare(String(Math.round((next.sessionShare ?? 0) * 100)));
          }
          first = false;
        }
      } catch (error) {
        if (!disposed)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [transport]);

  // Zero is meaningful: collect from now on and look back at nothing. The
  // slider's extent is not the field's limit, and fractions are ordinary.
  const validHours =
    hours.trim() !== "" && Number.isFinite(Number(hours)) && Number(hours) >= 0;
  const validMultiplier =
    multiplier.trim() !== "" &&
    Number.isFinite(Number(multiplier)) &&
    Number(multiplier) >= 0;
  const validShare =
    share.trim() !== "" &&
    Number.isFinite(Number(share)) &&
    Number(share) >= 0 &&
    Number(share) <= 100;
  const action = async (
    kind: "settings" | "scan" | "reset",
    changes: Partial<Pick<SpeechVocabularyStatus, "enabled" | "biasing">> = {},
  ) => {
    if (
      !status ||
      busy ||
      (kind !== "reset" && (!validHours || !validMultiplier || !validShare))
    )
      return;
    revision.current++;
    setBusy(true);
    setError(undefined);
    try {
      let next: SpeechVocabularyStatus;
      if (kind === "reset") {
        next = await transport.fetch<SpeechVocabularyStatus>(
          "/speech/vocabulary/reset",
          { method: "POST" },
        );
      } else {
        next = await transport.fetch<SpeechVocabularyStatus>(
          "/speech/vocabulary",
          {
            method: "PUT",
            body: JSON.stringify({
              enabled: status.enabled,
              biasing: status.biasing,
              hours: Number(hours),
              sessionMultiplier: Number(multiplier),
              sessionShare: Number(share) / 100,
              ...changes,
            }),
          },
        );
        if (kind === "scan")
          next = await transport.fetch<SpeechVocabularyStatus>(
            "/speech/vocabulary/scan",
            { method: "POST" },
          );
      }
      if (scope.current === transport) setStatus(next);
    } catch (error) {
      if (scope.current === transport)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      revision.current++;
      if (scope.current === transport) setBusy(false);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t("speechVocabularyTitle")}</h3>
      <p>{t("speechVocabularyDescription")}</p>
      <Switch
        label={t("speechVocabularyLearn")}
        checked={status?.enabled ?? false}
        disabled={!status || busy || !validHours}
        onCheckedChange={(enabled) => void action("settings", { enabled })}
      />
      <div className={styles.hours}>
        <label htmlFor={`${id}-hours`}>{t("speechVocabularyHours")}</label>
        <TextInput
          id={`${id}-hours`}
          type="number"
          min="0"
          step="any"
          value={hours}
          onChange={(event) => setHours(event.target.value)}
          disabled={busy}
        />
        <input
          type="range"
          className={styles.slider}
          min="0"
          max="8760"
          step="any"
          value={validHours ? Math.min(Number(hours), 8760) : 24}
          aria-label={t("speechVocabularyHoursSlider")}
          onChange={(event) => setHours(event.target.value)}
          disabled={busy}
        />
      </div>
      <div className={styles.hours}>
        <label htmlFor={`${id}-session-share`}>
          {t("speechVocabularySessionShare")}
        </label>
        <TextInput
          id={`${id}-session-share`}
          type="number"
          min="0"
          max="100"
          step="any"
          value={share}
          onChange={(event) => setShare(event.target.value)}
          disabled={busy}
        />
        <input
          type="range"
          className={styles.slider}
          min="0"
          max="100"
          step="1"
          value={validShare ? Number(share) : 0}
          aria-label={t("speechVocabularySessionShareSlider")}
          onChange={(event) => setShare(event.target.value)}
          disabled={busy}
        />
      </div>
      <div className={styles.hours}>
        <label htmlFor={`${id}-session-multiplier`}>
          {t("speechVocabularySessionMultiplier")}
        </label>
        <TextInput
          id={`${id}-session-multiplier`}
          type="number"
          min="0"
          step="any"
          value={multiplier}
          onChange={(event) => setMultiplier(event.target.value)}
          disabled={busy}
        />
        <input
          type="range"
          className={styles.slider}
          min="0"
          max="20"
          step="any"
          value={validMultiplier ? Math.min(Number(multiplier), 20) : 5}
          aria-label={t("speechVocabularySessionMultiplierSlider")}
          onChange={(event) => setMultiplier(event.target.value)}
          disabled={busy}
        />
      </div>
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={
            !status || busy || !validHours || status.scan.state === "scanning"
          }
          onClick={() => void action("scan", { enabled: true })}
        >
          {t("speechVocabularyScan")}
        </Button>
        <Button
          variant="danger-outline"
          disabled={!status || busy}
          onClick={() => void action("reset")}
          title={t("speechVocabularyResetDescription")}
        >
          {t("speechVocabularyReset")}
        </Button>
      </div>
      <p role="status">
        {status
          ? t(
              status.scan.state === "scanning"
                ? "speechVocabularyScanning"
                : "speechVocabularyCounts",
              {
                words: status.totals.words,
                user: status.totals.user,
                assistant: status.totals.assistant,
                sessions: status.scan.sessions,
                messages: status.scan.messages,
              },
            )
          : t("speechVocabularyLoading")}
      </p>
      <Switch
        label={t("speechVocabularyBiasing")}
        checked={status?.biasing ?? false}
        disabled={!status || busy || !validHours}
        onCheckedChange={(biasing) => void action("settings", { biasing })}
      />
      {showLexicon ? (
        <div className={styles.exploration}>
          <div className={styles.viewHeader}>
            <h4>{t("speechVocabularyView")}</h4>
            <IconButton
              label={t("speechVocabularyCloseView")}
              onClick={() => {
                includeWords.current = false;
                setStatus((current) => current && { ...current, words: [] });
                setShowLexicon(false);
              }}
            >
              <span aria-hidden="true">×</span>
            </IconButton>
          </div>
          {status && <SpeechVocabularyChart status={status} />}
        </div>
      ) : (
        <div className={styles.actions}>
          <Button onClick={() => setShowLexicon(true)}>
            {t("speechVocabularyExplore")}
          </Button>
        </div>
      )}
      {(error || status?.scan.error) && (
        <p role="alert">{error || status?.scan.error}</p>
      )}
    </section>
  );
}
