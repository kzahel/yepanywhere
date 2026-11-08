import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NavigateFunction } from "react-router-dom";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import {
  type ComposerTurnRecallCache,
  createComposerTurnRecallCache,
  mergeCommandRecallEntries,
} from "../lib/composerTurnRecall";
import {
  type EarlyTypingHandoff,
  startEarlyTypingHandoff,
} from "../lib/earlyTypingHandoff";
import { useSessionCommandRecall } from "../lib/sessionCommandRecall";
import {
  createSessionNavigationState,
  type parseSessionNavigationState,
} from "../lib/sessionNavigationState";
import type { Message } from "../types";
import { useNonHumanUserTurnNavigation } from "./useNonHumanUserTurnNavigation";
import type { useSession } from "./useSession";
import { useSessionMessageNavigation } from "./useSessionMessageNavigation";

type SessionNavigationState = ReturnType<typeof parseSessionNavigationState>;
type SessionState = ReturnType<typeof useSession>;

/**
 * One session page's transcript jumps and recall wiring: the composer's turn
 * and command recall entries, the scroll-to-turn request the recall drawer,
 * search matches and non-human turn navigation hand to the transcript, and
 * the bang-history actions that arrive as navigation state (prefill, focus,
 * scroll), with the early-typing hold that keeps keys struck before the
 * composer appears. Moved verbatim from `SessionPage.tsx`
 * (docs/tactical/181-session-page-feature-hooks.md slice 5).
 */
export function useSessionTranscriptJumps({
  sessionId,
  actualSessionId,
  messages,
  location,
  navigate,
  loading,
  loadingOlder,
  isDomLingerParked,
  pagination,
  loadOlderMessages,
  navState,
  initialStatus,
  initialTitle,
  initialModel,
  initialProvider,
  earlyComposerTypingRef,
  earlyComposerTypingKeyRef,
  pendingEarlyComposerPrefillRef,
  flushEarlyComposerTyping,
}: {
  sessionId: string;
  actualSessionId: string;
  messages: Message[];
  location: { pathname: string; search: string; key?: string };
  navigate: NavigateFunction;
  loading: boolean;
  loadingOlder: SessionState["loadingOlder"];
  isDomLingerParked: boolean;
  pagination: SessionState["pagination"];
  loadOlderMessages: SessionState["loadOlderMessages"];
  navState: SessionNavigationState;
  initialStatus: SessionNavigationState["initialStatus"];
  initialTitle: SessionNavigationState["initialTitle"];
  initialModel: SessionNavigationState["initialModel"];
  initialProvider: SessionNavigationState["initialProvider"];
  earlyComposerTypingRef: RefObject<EarlyTypingHandoff | null>;
  earlyComposerTypingKeyRef: RefObject<string | null>;
  pendingEarlyComposerPrefillRef: RefObject<string | null | undefined>;
  flushEarlyComposerTyping: () => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();

  // Incremental across renders: streaming ticks that only churn the assistant
  // tail cost a pointer-compare walk and return the same entries array.
  const composerTurnRecallCacheRef = useRef<ComposerTurnRecallCache | null>(
    null,
  );
  if (composerTurnRecallCacheRef.current === null) {
    composerTurnRecallCacheRef.current = createComposerTurnRecallCache();
  }
  const composerTurnRecallCache = composerTurnRecallCacheRef.current;
  // Accepted YA commands never become turns; they are recalled ahead of them.
  const { entries: commandRecallEntries, record: recordCommandRecall } =
    useSessionCommandRecall(actualSessionId);
  const composerTurnRecallEntries = useMemo(
    () =>
      mergeCommandRecallEntries(
        commandRecallEntries,
        composerTurnRecallCache.derive(messages),
      ),
    [commandRecallEntries, composerTurnRecallCache, messages],
  );
  // Go-to-turn: the recall drawer row asks to scroll the transcript to a prior
  // user turn by its render id. Mirror the isearch jump path (which reaches
  // MessageList.scrollToRenderId) by handing MessageList a bumped request; it
  // resolves the id via findRenderRow. Token makes repeat jumps to the same id
  // distinct so the effect re-fires. See topics/composer-recall-drawer.md.
  const [scrollToTurnRequest, setScrollToTurnRequest] = useState<{
    id: string;
    token: number;
    onResolved?: (found: boolean) => void;
  } | null>(null);
  const handleGoToRecallTurn = useCallback(
    (id: string, onResolved?: (found: boolean) => void) => {
      if (!id) {
        return;
      }
      setScrollToTurnRequest((previous) => ({
        id,
        token: (previous?.token ?? 0) + 1,
        onResolved,
      }));
    },
    [],
  );
  useSessionMessageNavigation({
    sessionId,
    target: new URLSearchParams(location.search).get("searchMatch"),
    enabled: true,
    messages,
    loading: loading || isDomLingerParked,
    loadingOlder,
    hasOlder: pagination?.hasOlderMessages ?? false,
    olderCursor: pagination?.truncatedBeforeMessageId,
    loadOlder: loadOlderMessages,
    jump: handleGoToRecallTurn,
    onError: () => showToast(t("sessionSearchTurnUnavailable"), "error"),
  });
  useNonHumanUserTurnNavigation({
    sessionId,
    messages,
    loading: loading || isDomLingerParked,
    loadingOlder,
    hasOlder: pagination?.hasOlderMessages ?? false,
    olderCursor: pagination?.truncatedBeforeMessageId,
    loadOlder: loadOlderMessages,
    jump: handleGoToRecallTurn,
    onError: (kind) =>
      showToast(
        t(
          kind === "unavailable"
            ? "nonHumanUserTurnUnavailable"
            : "nonHumanUserTurnAcknowledgeFailed",
        ),
        "error",
      ),
  });
  const composerTurnRecall = useMemo(
    () => ({
      entries: composerTurnRecallEntries,
      onGoToTurn: handleGoToRecallTurn,
    }),
    [composerTurnRecallEntries, handleGoToRecallTurn],
  );

  // Bang-history per-entry actions arrive as navigation state (edit →
  // composerPrefill, new → focusComposer, jump → scrollToRenderId; see
  // topics/bang-commands.md § Top-level history view). Read off navState like
  // initialStatus/initialTitle, but these drive side effects: consumption is
  // keyed on location.key — one navigation consumes once, while a fresh
  // navigation to a still-mounted page (route retention) consumes again — and
  // we clear the consumed fields from history state so Back/refresh does not
  // replay them. Gated on !loading so the jump target row and the footer
  // composer are mounted before we act (draftControlsRef is populated during
  // commit, before this passive effect).
  const navComposerPrefill = navState?.composerPrefill;
  const navFocusComposer = navState?.focusComposer;
  const navScrollToRenderId = navState?.scrollToRenderId;
  const navActionsConsumedKeyRef = useRef<string | null>(null);
  // A navigation that asks for the composer means the user may type at once,
  // but the composer only appears when the session has loaded. Start holding
  // keys here — before and regardless of loading — so they land in the draft
  // in the order they were struck rather than in the transcript's shortcuts.
  useEffect(() => {
    if (!navComposerPrefill && !navFocusComposer) return;
    const navigationKey = location.key ?? "keyless";
    if (earlyComposerTypingKeyRef.current === navigationKey) return;
    earlyComposerTypingKeyRef.current = navigationKey;
    earlyComposerTypingRef.current?.cancel();
    earlyComposerTypingRef.current = startEarlyTypingHandoff();
  }, [
    earlyComposerTypingRef,
    earlyComposerTypingKeyRef,
    location.key,
    navComposerPrefill,
    navFocusComposer,
  ]);
  useEffect(
    () => () => {
      earlyComposerTypingRef.current?.cancel();
      earlyComposerTypingRef.current = null;
    },
    [earlyComposerTypingRef],
  );
  useEffect(() => {
    const navigationKey = location.key ?? "keyless";
    if (navActionsConsumedKeyRef.current === navigationKey || loading) {
      return;
    }
    if (!navComposerPrefill && !navFocusComposer && !navScrollToRenderId) {
      return;
    }
    navActionsConsumedKeyRef.current = navigationKey;

    if (navComposerPrefill || navFocusComposer) {
      pendingEarlyComposerPrefillRef.current = navComposerPrefill ?? null;
      flushEarlyComposerTyping();
    }

    if (navScrollToRenderId) {
      setScrollToTurnRequest((previous) => ({
        id: navScrollToRenderId,
        token: (previous?.token ?? 0) + 1,
      }));
    }

    // Drop the consumed action fields; preserve the seed fields (status/title/
    // model/provider) so an optimistic first render is unaffected.
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: createSessionNavigationState({
        ...(initialStatus ? { initialStatus } : {}),
        ...(initialTitle ? { initialTitle } : {}),
        ...(initialModel ? { initialModel } : {}),
        ...(initialProvider ? { initialProvider } : {}),
      }),
    });
  }, [
    pendingEarlyComposerPrefillRef,
    loading,
    navComposerPrefill,
    navFocusComposer,
    navScrollToRenderId,
    navigate,
    location.key,
    location.pathname,
    location.search,
    initialStatus,
    initialTitle,
    initialModel,
    initialProvider,
    flushEarlyComposerTyping,
  ]);

  return { composerTurnRecall, recordCommandRecall, scrollToTurnRequest };
}
