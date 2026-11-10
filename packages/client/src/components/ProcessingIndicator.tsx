import styles from "./ProcessingIndicator.module.css";
import {
  type KeyboardEvent,
  type MouseEvent,
  type TouchEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSessionLiveness } from "../contexts/SessionLivenessContext";
import { getFunPhrasesEnabled } from "../hooks/useFunPhrases";
import { useI18n } from "../i18n";
import { observeViewportActivityAnimation } from "../lib/viewportActivityAnimation";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ButtonBase } from "./ui/Button";

const PROCESSING_PHRASES = [
  "Thinking...",
  "Processing...",
  "Cooking...",
  "Analyzing...",
  "Working on it...",
  "Pondering...",
  "Computing...",
  "Crafting...",
  "Mulling it over...",
  "On it...",
  "Crunching...",
  "Brewing...",
  "Conjuring...",
  "Synthesizing...",
  "Deliberating...",
  "Ruminating...",
  "Contemplating...",
  "Percolating...",
  "Cogitating...",
  "Noodling...",
];

const ROTATION_INTERVAL_MS = 2000;
const TYPEWRITER_SPEED_MS = 25; // ~40 chars/second = ~240 WPM
/**
 * After this long without new output, rotating phrases would read as
 * progress that is not happening, so the indicator states the silence
 * instead. See topics/session-liveness.md.
 */
const QUIET_STATUS_AFTER_MS = 30_000;
const QUIET_TICK_MS = 1000;

function parseMs(timestamp: string | null | undefined): number | null {
  const ms = Date.parse(timestamp ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function formatSilence(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

interface ProcessingAnimationState {
  phraseIndex: number;
  displayedText: string;
  isTyping: boolean;
}

const INITIAL_ANIMATION_STATE: ProcessingAnimationState = {
  phraseIndex: 0,
  displayedText: "",
  isTyping: true,
};

type AnimationFrameAction = (
  state: ProcessingAnimationState,
) => ProcessingAnimationState;

/** Fisher-Yates shuffle */
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i];
    result[i] = result[j] as T;
    result[j] = temp as T;
  }
  return result;
}

interface Props {
  isProcessing: boolean;
  thinkingItemsVisible?: boolean;
  hasThinkingItems?: boolean;
  onToggleThinkingItemsVisible?: () => void;
  /** Auto-expand policy: true = only the latest block, false = every new one. */
  thinkingLatestOnly?: boolean;
  /**
   * Right-click / long-press: from hidden or latest-only, show thinking and
   * expand the full history; from everything-expanded, back to latest-only.
   */
  onToggleThinkingLatestOnly?: () => void;
  /** Timestamp of the newest transcript message, as user-visible output. */
  lastMessageAtMs?: number | null;
}

function ThoughtTranscriptIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      className={styles.processingThinkingToggleIcon}
      data-processing-thinking-toggle-icon
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11.5c0 4-3.8 7.25-8.5 7.25-1.1 0-2.2-.18-3.15-.52L4 20l1.2-3.25C3.85 15.42 3 13.58 3 11.5 3 7.5 6.8 4.25 11.5 4.25S20 7.5 20 11.5Z" />
      <path d="M8.5 11.5h.01" />
      <path d="M11.5 11.5h.01" />
      <path d="M14.5 11.5h.01" />
      {muted && (
        <path
          className={styles.processingThinkingToggleSlash}
          data-processing-thinking-toggle-slash
          d="M4 20 20 4"
        />
      )}
    </svg>
  );
}

export const ProcessingIndicator = memo(function ProcessingIndicator({
  isProcessing,
  thinkingItemsVisible = true,
  hasThinkingItems = false,
  onToggleThinkingItemsVisible,
  thinkingLatestOnly = false,
  onToggleThinkingLatestOnly,
  lastMessageAtMs = null,
}: Props) {
  const { t } = useI18n();
  const liveness = useSessionLiveness();
  const [processingStartedAtMs, setProcessingStartedAtMs] = useState<
    number | null
  >(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [animationState, setAnimationState] = useState(INITIAL_ANIMATION_STATE);
  const [isAnimationPaused, setIsAnimationPaused] = useState(false);
  const [isInViewport, setIsInViewport] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const queuedFrameActionsRef = useRef<AnimationFrameAction[]>([]);
  const { phraseIndex, displayedText, isTyping } = animationState;
  const showThinkingToggle = Boolean(
    onToggleThinkingItemsVisible && (isProcessing || hasThinkingItems),
  );
  const isRendered = isProcessing || showThinkingToggle;

  const cancelQueuedFrame = useCallback(() => {
    queuedFrameActionsRef.current = [];
    if (animationFrameRef.current === null) return;
    window.cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
  }, []);

  const queueFrameAction = useCallback((action: AnimationFrameAction) => {
    queuedFrameActionsRef.current.push(action);
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      const actions = queuedFrameActionsRef.current;
      queuedFrameActionsRef.current = [];
      setAnimationState((current) =>
        actions.reduce((next, applyAction) => applyAction(next), current),
      );
    });
  }, []);

  // Right-click (desktop) / long-press (touch) flips the auto-expand policy;
  // left-click still toggles visibility. suppressTouchClickRef stops a
  // completed long-press from also firing the click handler.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressTouchClickRef = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (!onToggleThinkingLatestOnly) return;
      event.preventDefault();
      onToggleThinkingLatestOnly();
    },
    [onToggleThinkingLatestOnly],
  );

  const handleTouchStart = useCallback(() => {
    if (!onToggleThinkingLatestOnly) return;
    clearLongPress();
    suppressTouchClickRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      suppressTouchClickRef.current = true;
      longPressTimerRef.current = null;
      onToggleThinkingLatestOnly();
    }, 450);
  }, [clearLongPress, onToggleThinkingLatestOnly]);

  const handleTouchEnd = useCallback(
    (event: TouchEvent<HTMLButtonElement>) => {
      if (suppressTouchClickRef.current) {
        event.preventDefault();
      }
      clearLongPress();
    },
    [clearLongPress],
  );

  const handleToggleClick = useCallback(() => {
    if (suppressTouchClickRef.current) {
      suppressTouchClickRef.current = false;
      return;
    }
    onToggleThinkingItemsVisible?.();
  }, [onToggleThinkingItemsVisible]);

  const toggleAnimationPaused = useCallback(() => {
    setIsAnimationPaused((paused) => !paused);
  }, []);

  const handleAnimationKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleAnimationPaused();
    },
    [toggleAnimationPaused],
  );

  // Check setting and shuffle phrases when processing starts
  const phrases = useMemo(() => {
    if (!isProcessing) return ["Thinking..."];
    const funEnabled = getFunPhrasesEnabled();
    if (!funEnabled) return ["Thinking..."];
    return shuffle(PROCESSING_PHRASES);
  }, [isProcessing]);

  useEffect(() => {
    if (!isRendered) {
      setIsInViewport(false);
      return;
    }
    const root = rootRef.current;
    if (!root) {
      setIsInViewport(false);
      return;
    }
    return observeViewportActivityAnimation(root, setIsInViewport);
  }, [isRendered]);

  useEffect(() => {
    setProcessingStartedAtMs(isProcessing ? Date.now() : null);
  }, [isProcessing]);

  useEffect(() => {
    if (!isProcessing || !isInViewport) return;
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), QUIET_TICK_MS);
    return () => clearInterval(interval);
  }, [isInViewport, isProcessing]);

  // Newest evidence of user-visible output: a transcript message, streamed
  // content, or a provider message the server saw. The turn's start floors it
  // so a fresh turn is never reported as silent since an earlier one.
  const turnStartedAtMs =
    liveness?.state === "in-turn"
      ? parseMs(liveness.lastStateChangeAt)
      : processingStartedAtMs;
  const outputCandidates = [
    turnStartedAtMs,
    lastMessageAtMs,
    parseMs(liveness?.lastVerifiedProgressAt),
    parseMs(liveness?.lastProviderMessageAt),
  ].filter((ms): ms is number => ms !== null);
  const lastOutputAtMs =
    outputCandidates.length > 0 ? Math.max(...outputCandidates) : null;
  const silenceMs =
    isProcessing && lastOutputAtMs !== null ? nowMs - lastOutputAtMs : 0;
  const isQuiet = silenceMs >= QUIET_STATUS_AFTER_MS;
  const providerActiveCheckedAtMs =
    liveness?.lastLivenessProbeStatus === "active"
      ? parseMs(liveness.lastLivenessProbeAt)
      : null;
  const quietText = !isQuiet
    ? null
    : providerActiveCheckedAtMs !== null &&
        lastOutputAtMs !== null &&
        providerActiveCheckedAtMs >= lastOutputAtMs
      ? t("processingQuietProviderActive", {
          silence: formatSilence(silenceMs),
          checked: formatSilence(nowMs - providerActiveCheckedAtMs),
        })
      : t("processingQuietNoOutput", { silence: formatSilence(silenceMs) });

  const shouldAnimateText =
    isProcessing && isInViewport && !isAnimationPaused && !isQuiet;

  useEffect(() => {
    if (shouldAnimateText) return;
    cancelQueuedFrame();
  }, [cancelQueuedFrame, shouldAnimateText]);

  useEffect(() => cancelQueuedFrame, [cancelQueuedFrame]);

  // Rotate phrases
  useEffect(() => {
    if (!isProcessing) {
      setAnimationState(INITIAL_ANIMATION_STATE);
      setIsAnimationPaused(false);
      return;
    }

    if (!shouldAnimateText) return;

    const scheduledPhraseIndex = phraseIndex;
    const timeout = setTimeout(() => {
      queueFrameAction((current) =>
        current.phraseIndex === scheduledPhraseIndex
          ? {
              phraseIndex: (scheduledPhraseIndex + 1) % phrases.length,
              displayedText: "",
              isTyping: true,
            }
          : current,
      );
    }, ROTATION_INTERVAL_MS);

    return () => clearTimeout(timeout);
  }, [
    isProcessing,
    phraseIndex,
    phrases.length,
    queueFrameAction,
    shouldAnimateText,
  ]);

  // Typewriter effect
  useEffect(() => {
    if (!shouldAnimateText || !isTyping) return;

    const phrase = phrases[phraseIndex] ?? "";
    if (displayedText.length >= phrase.length) return;

    const timeout = setTimeout(() => {
      queueFrameAction((current) => {
        if (current.phraseIndex !== phraseIndex) return current;
        const nextText = phrase.slice(0, current.displayedText.length + 1);
        return {
          ...current,
          displayedText: nextText,
          isTyping: nextText.length < phrase.length,
        };
      });
    }, TYPEWRITER_SPEED_MS);

    return () => clearTimeout(timeout);
  }, [
    isTyping,
    phraseIndex,
    displayedText,
    phrases,
    queueFrameAction,
    shouldAnimateText,
  ]);

  if (!isRendered) {
    return null;
  }

  const visibilityTitle = thinkingItemsVisible
    ? t("processingThinkingTranscriptHide")
    : hasThinkingItems
      ? t("processingThinkingTranscriptShowHidden")
      : t("processingThinkingTranscriptShowWhenAvailable");
  // Describe what right-click / long-press does from the current state.
  const modeHint = onToggleThinkingLatestOnly
    ? !thinkingItemsVisible
      ? t("processingThinkingRightClickShowExpandAll")
      : thinkingLatestOnly
        ? t("processingThinkingRightClickExpandAll")
        : t("processingThinkingRightClickLatestOnly")
    : null;
  const thinkingToggleTitle = modeHint
    ? `${visibilityTitle}\n${modeHint}`
    : visibilityTitle;
  const animationToggleLabel = isAnimationPaused
    ? t("processingAnimationResume")
    : t("processingAnimationPause");

  return (
    <div
      ref={rootRef}
      className={`${styles.processingIndicator} ${
        !isProcessing ? styles.processingIndicatorControlOnly : ""
      } ${!thinkingItemsVisible && hasThinkingItems ? "processing-indicator--thinking-hidden" : ""}`}
      data-processing-indicator
      data-processing-indicator--control-only={!isProcessing || undefined}
    >
      {showThinkingToggle && (
        <ButtonBase
          className={`${styles.processingThinkingToggle} ${
            thinkingItemsVisible
              ? `${styles["is-visible"]}`
              : `${styles["is-muted"]}`
          } ${thinkingLatestOnly ? `${styles["is-latest-only"]}` : ""}`.trim()}
          data-processing-thinking-toggle
          data-is-visible={thinkingItemsVisible || undefined}
          data-is-muted={!thinkingItemsVisible || undefined}
          data-is-latest-only={thinkingLatestOnly || undefined}
          onClick={handleToggleClick}
          onContextMenu={handleContextMenu}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={clearLongPress}
          onTouchMove={clearLongPress}
          aria-pressed={thinkingItemsVisible}
          aria-label={visibilityTitle}
          title={thinkingToggleTitle}
        >
          <ThoughtTranscriptIcon muted={!thinkingItemsVisible} />
        </ButtonBase>
      )}
      {isProcessing && (
        <>
          <div
            className={styles.processingDotContainer}
            data-processing-dot-container
          >
            <ThinkingIndicator animationVisibilityManaged />
          </div>
          {quietText !== null ? (
            <span
              className={styles.processingText}
              data-processing-text
              role="status"
            >
              {quietText}
            </span>
          ) : (
            <span
              className={styles.processingText}
              data-processing-text
              role="button"
              tabIndex={0}
              aria-pressed={isAnimationPaused}
              aria-label={animationToggleLabel}
              title={animationToggleLabel}
              onClick={toggleAnimationPaused}
              onKeyDown={handleAnimationKeyDown}
            >
              {displayedText}
            </span>
          )}
        </>
      )}
    </div>
  );
});
