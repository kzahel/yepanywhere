import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useSpeechCaptureSettings } from "../hooks/useSpeechCaptureSettings";
import { useAudioMemoTranscriptionPlan } from "../hooks/useAudioMemoTranscriptionPlan";
import { AudioMemoRecording } from "../lib/audioMemoRecording";
import { AudioMemoTranscript } from "../lib/audioMemoTranscript";
import {
  clearSpeechWaveform,
  publishSpeechWaveformSamples,
} from "../lib/speechWaveform";
import { SpeechWaveform } from "./SpeechWaveform";
import { Banner } from "./ui/Banner";
import { Button, ButtonBase } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import styles from "./AudioMemoPanel.module.css";

const TRANSCRIPT_KEY = "yep-anywhere-audio-memo-transcript";

interface Props {
  projectId?: string;
  sessionId?: string;
  onCancel: () => void;
  onCommit: (file: File, transcript: string) => Promise<void>;
  commitLabel?: string;
}

/** Audio memo panel: the surrounding recording surface commits the take. */
export function AudioMemoPanel({
  projectId,
  sessionId,
  onCancel,
  onCommit,
  commitLabel,
}: Props) {
  const { t } = useI18n();
  const { micDeviceId, reducePlayback } = useSpeechCaptureSettings();
  const plan = useAudioMemoTranscriptionPlan({ projectId, sessionId });
  const [includeTranscript, setIncludeTranscript] = useState(
    () => sessionStorage.getItem(TRANSCRIPT_KEY) !== "false",
  );
  const enabled = useRef(includeTranscript);
  const [take, setTake] = useState(0);
  const [status, setStatus] = useState<
    "starting" | "recording" | "processing" | "sending" | "error"
  >("starting");
  const [seconds, setSeconds] = useState(0);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [transcriptError, setTranscriptError] = useState("");
  const recorder = useRef<AudioMemoRecording | null>(null);
  const asr = useRef<AudioMemoTranscript | null>(null);
  const savedFile = useRef<File | null>(null);
  const savedTranscript = useRef<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(false);
  const startOptions = useRef({ micDeviceId, reducePlayback, plan });
  startOptions.current = { micDeviceId, reducePlayback, plan };

  // biome-ignore lint/correctness/useExhaustiveDependencies: take is the Restart action's generation; changing it must dispose the old recording and start a new one.
  useEffect(() => {
    alive.current = true;
    busy.current = false;
    savedFile.current = null;
    savedTranscript.current = null;
    setStatus("starting");
    setSeconds(0);
    setError("");
    setTranscriptError("");
    setPreview("");
    const capture = new AudioMemoRecording();
    recorder.current = capture;
    let cancelled = false;
    let heardAudio = false;
    const watchdog = setTimeout(() => {
      if (!heardAudio && !cancelled) {
        capture.cancel();
        setError(t("audioMemoNoAudio"));
        setStatus("error");
      }
    }, 10_000);
    const options = startOptions.current;
    void capture
      .start({
        ...options,
        onSamples: (samples, duration) => {
          if (cancelled) return;
          if (!heardAudio) {
            heardAudio = true;
            clearTimeout(watchdog);
            setStatus("recording");
          }
          publishSpeechWaveformSamples(samples);
          setSeconds((previous) =>
            Math.floor(duration) === previous ? previous : Math.floor(duration),
          );
        },
        onInterrupted: () => {
          if (cancelled || busy.current) return;
          busy.current = true;
          setStatus("processing");
          asr.current?.dispose();
          asr.current = null;
          void capture
            .finish()
            .then((file) => {
              if (cancelled) return;
              savedFile.current = file;
              busy.current = false;
              asr.current =
                enabled.current && options.plan
                  ? new AudioMemoTranscript(options.plan)
                  : null;
              setStatus("error");
              setError(t("audioMemoInterrupted"));
            })
            .catch((failure: unknown) => {
              if (cancelled) return;
              busy.current = false;
              setStatus("error");
              setError(
                failure instanceof Error ? failure.message : String(failure),
              );
            });
        },
      })
      .then((stream) => {
        // Backend metadata can settle while microphone permission/startup is
        // pending. Choose the take's ASR plan when its stream is ready rather
        // than freezing an incomplete capability snapshot before acquisition.
        const readyPlan = startOptions.current.plan;
        if (cancelled || !enabled.current || !readyPlan) return;
        const subscriber = new AudioMemoTranscript(readyPlan);
        asr.current = subscriber;
        subscriber.startPreview(stream, setPreview, setTranscriptError);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        clearTimeout(watchdog);
        setError(failure instanceof Error ? failure.message : String(failure));
        setStatus("error");
      });
    return () => {
      cancelled = true;
      alive.current = false;
      clearTimeout(watchdog);
      capture.cancel();
      asr.current?.dispose();
      asr.current = null;
      clearSpeechWaveform();
    };
  }, [take, t]);

  const toggleTranscript = () => {
    const next = !enabled.current;
    enabled.current = next;
    setIncludeTranscript(next);
    sessionStorage.setItem(TRANSCRIPT_KEY, String(next));
    asr.current?.dispose();
    asr.current = next && plan ? new AudioMemoTranscript(plan) : null;
    savedTranscript.current = null;
    setPreview("");
    setTranscriptError("");
  };

  const commit = async () => {
    if (
      busy.current ||
      status === "starting" ||
      (status === "error" && !savedFile.current)
    )
      return;
    busy.current = true;
    setStatus("processing");
    setError("");
    try {
      const filePromise = savedFile.current
        ? Promise.resolve(savedFile.current)
        : recorder.current!.finish();
      const file = await filePromise;
      savedFile.current = file;
      let transcript = savedTranscript.current ?? "";
      while (enabled.current && savedTranscript.current === null) {
        const subscriber = asr.current;
        if (!subscriber) throw new Error(t("audioMemoNoTranscription"));
        transcript = await subscriber.finish(file);
        if (!alive.current) return;
        if (asr.current !== subscriber) continue;
        savedTranscript.current = transcript;
      }
      if (!alive.current) return;
      setStatus("sending");
      await onCommit(file, enabled.current ? transcript : "");
    } catch (failure) {
      if (!alive.current) return;
      asr.current?.dispose();
      asr.current =
        enabled.current && plan ? new AudioMemoTranscript(plan) : null;
      setStatus("error");
      setError(failure instanceof Error ? failure.message : String(failure));
      busy.current = false;
    }
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.code === "Space" &&
        !event.repeat
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void commitRef.current();
      }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, []);

  return (
    <section className={styles.panel} aria-label={t("audioMemoTitle")}>
      <ButtonBase
        className={styles.surface}
        onClick={() => void commit()}
        disabled={
          status === "starting" ||
          status === "processing" ||
          status === "sending" ||
          (status === "error" && !savedFile.current)
        }
      >
        <span className={styles.heading}>
          <span>{t("audioMemoTitle")}</span>
          <time>
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          </time>
        </span>
        {preview && includeTranscript && (
          <span className={styles.preview}>{preview}</span>
        )}
        <span className={styles.waveform}>
          <SpeechWaveform />
        </span>
        <strong>
          {status === "sending" || status === "processing"
            ? t("audioMemoSending")
            : status === "starting"
              ? t("audioMemoStarting")
              : status === "error"
                ? t("audioMemoRetry")
                : (commitLabel ?? t("audioMemoStopSend"))}
        </strong>
        <span className={styles.detail}>{t("audioMemoFormat")}</span>
      </ButtonBase>
      <div className={styles.options}>
        <Checkbox
          className={styles.transcript}
          label={t("audioMemoTranscript")}
          checked={includeTranscript}
          disabled={status === "sending"}
          onCheckedChange={toggleTranscript}
        />
        {includeTranscript && (
          <span className={styles.detail}>
            {transcriptError ||
              (!plan
                ? t("audioMemoNoTranscription")
                : !preview
                  ? t("audioMemoTranscriptDeferred")
                  : t("audioMemoTranscriptDraft"))}
          </span>
        )}
      </div>
      {error && (
        <Banner tone="error" compact className={styles.failure}>
          {error}
        </Banner>
      )}
      <div className={styles.actions}>
        <Button
          className={styles.action}
          disabled={status === "sending" || status === "processing"}
          onClick={() => setTake((value) => value + 1)}
        >
          {t("audioMemoRestart")}
        </Button>
        <Button
          className={styles.action}
          disabled={status === "sending" || status === "processing"}
          onClick={onCancel}
        >
          {t("audioMemoCancel")}
        </Button>
      </div>
    </section>
  );
}
