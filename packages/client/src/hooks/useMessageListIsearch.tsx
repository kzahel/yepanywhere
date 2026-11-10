import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button, ButtonBase, IconButton } from "../components/ui/Button";
import { TextInput } from "../components/ui/Field";
import {
  type EarlyTypingHandoff,
  startEarlyTypingHandoff,
} from "../lib/earlyTypingHandoff";
import { useI18n } from "../i18n";
import { useSessionPerformanceSettings } from "./useSessionPerformanceSettings";
import {
  dispatchSessionIsearchGuideState,
  type SessionIsearchScope,
} from "../lib/sessionIsearchGuide";
import type { RenderTurnGroup } from "../lib/sessionDetail/renderItems";
import {
  getActiveSearchAnchors,
  getAllTurnSearchAnchors,
  getFullSessionSearchAnchors,
  getLinkSearchAnchors,
  getSearchMatchProjection,
  getSearchNavigatorStateProjection,
  getSearchPanelProjection,
  getSearchReady,
  getSearchScopeLabel,
  getSearchSelectionProjection,
  getSearchVisibleTurnGroups,
  getUserTurnNavAnchors,
  getUserTurnSearchAnchors,
  hasSearchableUserTurn,
} from "../lib/sessionDetail/search";
import {
  searchSessionHistoryPage,
  type SessionHistorySearchPageInput,
  type SessionHistorySearchPageResult,
  type SessionHistorySearchWorkerResponse,
} from "../lib/sessionHistorySearch";
import { querySessionRouteLayerElement } from "../lib/sessionRouteLayer";
import type { GetSessionResult } from "../lib/sourceRuntime";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import type {
  UserTurnNavAnchor,
  UserTurnNavSearchState,
} from "../components/UserTurnNavigator";
import styles from "./useMessageListIsearch.module.css";

const SEARCH_ARROW_REPEAT_DELAY_MS = 150;
const SEARCH_ARROW_REPEAT_INTERVAL_MS = 42;
const HISTORY_SEARCH_RESULT_LIMIT = 512;
const SEARCH_SCOPES: readonly SessionIsearchScope[] = [
  "user",
  "all",
  "full",
  "links",
];

interface UserTurnSearchSession {
  active: boolean;
  scope: SessionIsearchScope;
  query: string;
  caseSensitive: boolean;
  selectedId: string | null;
  originalScrollTop: number | null;
}

interface UseMessageListIsearchOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  conversationViewEnabled: boolean;
  displayRenderItems: readonly RenderItem[];
  hasOlderMessages?: boolean;
  loadedMessageCount: number;
  totalMessageCount?: number;
  historySearchCursor?: string | null;
  historySearchContextKey?: string;
  hydratedHistoryCursor?: string | null;
  inert: boolean;
  onHydrateHistorySearchPage?: (cursor: string, page: GetSessionResult) => void;
  onReadOlderSearchPage?: (
    beforeMessageId: string,
  ) => Promise<GetSessionResult>;
  provider?: string;
  recentProjectPathLinksEnabled: boolean;
  thinkingItemsVisible: boolean;
  turnGroups: readonly RenderTurnGroup[];
}

interface UseMessageListIsearchResult {
  active: boolean;
  scope: SessionIsearchScope;
  visibleTurnGroups: readonly RenderTurnGroup[];
  cancelSearchTargetPreparation: () => void;
  getNavigatorAnchors: () => UserTurnNavAnchor[];
  searchState: UserTurnNavSearchState | null;
  renderSearchPanel: (
    activate: (id: string, targetId: string, close: boolean) => void,
  ) => ReactNode;
  closeSearch: (restoreScroll: boolean) => void;
  getCommittedSearchTargetId: () => string | null;
  getSelectedSearchAnchorId: () => string | null;
  getSelectedSearchTargetId: () => string | null;
  handleSearchArrowKey: (
    direction: "previous" | "next",
    repeat: boolean,
  ) => void;
  moveSearchSelection: (direction: "previous" | "next") => void;
  openSearch: (scope: SessionIsearchScope) => void;
  prepareSearchTarget: (id: string) => string | null | Promise<string | null>;
  selectSearchMatch: (id: string, targetId?: string) => void;
  stopSearchArrowRepeat: () => void;
}

interface OlderSearchMatch extends UserTurnNavAnchor {
  pageCursor: string;
}

interface OlderSearchState {
  cursor: string | null;
  error: boolean;
  hasOlder: boolean;
  key: string;
  limitReached: boolean;
  loading: boolean;
  matches: OlderSearchMatch[];
  pagesScanned: number;
  checkedMessageCount: number;
  totalMessageCount: number;
}

interface PendingWorkerRequest {
  reject: (error: Error) => void;
  resolve: (result: SessionHistorySearchPageResult) => void;
}

function createOlderSearchState(
  key: string,
  cursor: string | null,
  hasOlder: boolean,
): OlderSearchState {
  return {
    cursor,
    error: false,
    hasOlder: hasOlder && cursor !== null,
    key,
    limitReached: false,
    loading: false,
    matches: [],
    pagesScanned: 0,
    checkedMessageCount: 0,
    totalMessageCount: 0,
  };
}

export function useMessageListIsearch({
  containerRef,
  conversationViewEnabled,
  displayRenderItems,
  hasOlderMessages = false,
  loadedMessageCount,
  totalMessageCount = 0,
  historySearchCursor = null,
  historySearchContextKey = "",
  hydratedHistoryCursor = null,
  inert,
  onHydrateHistorySearchPage,
  onReadOlderSearchPage,
  provider,
  recentProjectPathLinksEnabled,
  thinkingItemsVisible,
  turnGroups,
}: UseMessageListIsearchOptions): UseMessageListIsearchResult {
  const { t } = useI18n();
  const [boundary, setBoundary] = useState<
    "start" | "previous" | "next" | null
  >(null);
  const [boundaryPulse, setBoundaryPulse] = useState(0);
  // Narrow screens hide the key help until asked, to keep the row usable.
  const [helpShown, setHelpShown] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchInputWantsFocusRef = useRef(false);
  const searchQueryRef = useRef("");
  const earlySearchHandoffRef = useRef<EarlyTypingHandoff | null>(null);
  const searchRestoreFocusRef = useRef<HTMLElement | null>(null);
  const searchOriginalScrollTopRef = useRef<number | null>(null);
  const committedSearchTargetIdRef = useRef<string | null>(null);
  const selectedSearchTargetIdRef = useRef<string | null>(null);
  const selectedSearchAnchorIdRef = useRef<string | null>(null);
  const historySearchKeyRef = useRef("");
  const historySearchAttemptKeyRef = useRef<string | null>(null);
  const historySearchHydrationGenerationRef = useRef(0);
  const appliedHistorySearchKeyRef = useRef("");
  const historySearchWorkerRef = useRef<Worker | null>(null);
  const historySearchWorkerRequestIdRef = useRef(0);
  const pendingHistorySearchWorkerRequestsRef = useRef(
    new Map<number, PendingWorkerRequest>(),
  );
  const searchArrowRepeatTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const searchArrowRepeatIntervalRef = useRef<ReturnType<
    typeof setInterval
  > | null>(null);
  const searchArrowRepeatDirectionRef = useRef<"previous" | "next" | null>(
    null,
  );
  const [userTurnSearch, setUserTurnSearch] = useState<UserTurnSearchSession>({
    active: false,
    scope: "user",
    query: "",
    caseSensitive: false,
    selectedId: null,
    originalScrollTop: null,
  });
  const [olderSearchState, setOlderSearchState] = useState<OlderSearchState>(
    () => createOlderSearchState("", null, false),
  );
  const olderSearchStateRef = useRef(olderSearchState);
  const [hydratingSearchId, setHydratingSearchId] = useState<string | null>(
    null,
  );
  const { reverseSearchMaxPagesPerAttempt } = useSessionPerformanceSettings();
  const cancelSearchTargetPreparation = useCallback(() => {
    historySearchHydrationGenerationRef.current += 1;
    setHydratingSearchId(null);
  }, []);

  // Reverse search is typeable from the keystroke that opens it, which is
  // before the panel exists, so the handoff holds those keys and writes them
  // into the query state the input will render. Retirement, its evidence and
  // its bound live in the shared mechanism; see lib/earlyTypingHandoff.
  const stopEarlySearchKeys = useCallback(() => {
    earlySearchHandoffRef.current?.cancel();
    earlySearchHandoffRef.current = null;
  }, []);
  const startEarlySearchKeys = useCallback(() => {
    stopEarlySearchKeys();
    earlySearchHandoffRef.current = startEarlyTypingHandoff({
      hasFocus: () =>
        searchInputRef.current !== null &&
        document.activeElement === searchInputRef.current,
      shows: () => searchInputRef.current?.value ?? "",
      expects: () => searchQueryRef.current,
      applyKey: (key) => {
        setBoundary(null);
        setUserTurnSearch((previous) =>
          previous.active
            ? {
                ...previous,
                query:
                  "backspace" in key
                    ? previous.query.slice(0, -1)
                    : previous.query + key.insert,
                selectedId: null,
              }
            : previous,
        );
      },
      repairCaret: () => {
        const input = searchInputRef.current;
        if (!input) return;
        const caret = input.value.length;
        input.setSelectionRange(caret, caret);
      },
    });
  }, [stopEarlySearchKeys]);
  // Focus lands in the commit that creates the input, not a frame later. The
  // focus event fires inside focus() below, so the handoff retires in that
  // same call rather than waiting for a key to prove focus arrived; without
  // it, a click elsewhere would leave the handoff still intercepting. A focus
  // this call cannot land keeps it armed, and its per-key check retires it.
  const attachSearchInput = useCallback((input: HTMLInputElement | null) => {
    searchInputRef.current = input;
    if (!input || !searchInputWantsFocusRef.current) return;
    searchInputWantsFocusRef.current = false;
    input.addEventListener("focus", () =>
      earlySearchHandoffRef.current?.retireWhenReady(),
    );
    input.focus({ preventScroll: true });
    const caret = input.value.length;
    input.setSelectionRange(caret, caret);
  }, []);

  const hasUserSearchableTurn = useMemo(
    () => hasSearchableUserTurn(displayRenderItems),
    [displayRenderItems],
  );
  const getUserTurnNavAnchorList = useCallback(
    (): UserTurnNavAnchor[] => getUserTurnNavAnchors(displayRenderItems),
    [displayRenderItems],
  );
  // What the input is expected to show; the early-key receiver compares
  // against it to know whether the input has caught up with what was typed
  // before it existed.
  searchQueryRef.current = userTurnSearch.query;
  const searchReady = getSearchReady({
    active: userTurnSearch.active,
    query: userTurnSearch.query,
  });
  const historySearchKey = searchReady
    ? JSON.stringify([
        userTurnSearch.scope,
        userTurnSearch.query,
        userTurnSearch.caseSensitive,
        thinkingItemsVisible,
        conversationViewEnabled,
        recentProjectPathLinksEnabled,
        historySearchContextKey,
        provider,
      ])
    : "";
  historySearchKeyRef.current = historySearchKey;
  const effectiveOlderSearchState =
    olderSearchState.key === historySearchKey
      ? olderSearchState
      : createOlderSearchState(
          historySearchKey,
          historySearchCursor,
          hasOlderMessages,
        );
  olderSearchStateRef.current = effectiveOlderSearchState;

  const disposeHistorySearchWorker = useCallback(() => {
    historySearchWorkerRef.current?.terminate();
    historySearchWorkerRef.current = null;
    const cancelled = new Error("History search cancelled");
    for (const pending of pendingHistorySearchWorkerRequestsRef.current.values()) {
      pending.reject(cancelled);
    }
    pendingHistorySearchWorkerRequestsRef.current.clear();
  }, []);

  const runHistorySearchPage = useCallback(
    (input: SessionHistorySearchPageInput) => {
      if (typeof Worker === "undefined") {
        return new Promise<SessionHistorySearchPageResult>((resolve) => {
          setTimeout(() => resolve(searchSessionHistoryPage(input)), 0);
        });
      }

      let worker = historySearchWorkerRef.current;
      if (!worker) {
        worker = new Worker(
          new URL("../workers/sessionHistorySearch.worker.ts", import.meta.url),
          { type: "module" },
        );
        worker.addEventListener(
          "message",
          (event: MessageEvent<SessionHistorySearchWorkerResponse>) => {
            const pending = pendingHistorySearchWorkerRequestsRef.current.get(
              event.data.requestId,
            );
            if (!pending) return;
            pendingHistorySearchWorkerRequestsRef.current.delete(
              event.data.requestId,
            );
            pending.resolve(event.data);
          },
        );
        worker.addEventListener("error", () => {
          const error = new Error("History search worker failed");
          for (const pending of pendingHistorySearchWorkerRequestsRef.current.values()) {
            pending.reject(error);
          }
          pendingHistorySearchWorkerRequestsRef.current.clear();
          historySearchWorkerRef.current?.terminate();
          historySearchWorkerRef.current = null;
        });
        historySearchWorkerRef.current = worker;
      }

      const requestId = historySearchWorkerRequestIdRef.current + 1;
      historySearchWorkerRequestIdRef.current = requestId;
      return new Promise<SessionHistorySearchPageResult>((resolve, reject) => {
        pendingHistorySearchWorkerRequestsRef.current.set(requestId, {
          reject,
          resolve,
        });
        worker.postMessage({ requestId, ...input });
      });
    },
    [],
  );

  useEffect(() => {
    cancelSearchTargetPreparation();
    if (!searchReady) return;
    if (appliedHistorySearchKeyRef.current !== historySearchKey) {
      appliedHistorySearchKeyRef.current = historySearchKey;
      disposeHistorySearchWorker();
    }
    setOlderSearchState((previous) => {
      if (previous.key !== historySearchKey) {
        return createOlderSearchState(
          historySearchKey,
          historySearchCursor,
          hasOlderMessages,
        );
      }
      if (
        previous.pagesScanned === 0 &&
        !previous.loading &&
        previous.matches.length === 0
      ) {
        const hasOlder = hasOlderMessages && historySearchCursor !== null;
        if (
          previous.cursor !== historySearchCursor ||
          previous.hasOlder !== hasOlder
        ) {
          return {
            ...previous,
            cursor: historySearchCursor,
            hasOlder,
          };
        }
      }
      return previous;
    });
  }, [
    cancelSearchTargetPreparation,
    disposeHistorySearchWorker,
    hasOlderMessages,
    historySearchCursor,
    historySearchKey,
    searchReady,
  ]);

  useEffect(() => {
    if (userTurnSearch.active && !inert) return;
    cancelSearchTargetPreparation();
    appliedHistorySearchKeyRef.current = "";
    disposeHistorySearchWorker();
  }, [
    cancelSearchTargetPreparation,
    disposeHistorySearchWorker,
    inert,
    userTurnSearch.active,
  ]);

  useEffect(
    () => () => {
      disposeHistorySearchWorker();
    },
    [disposeHistorySearchWorker],
  );
  const includeUserTurnSearchAnchors =
    searchReady && userTurnSearch.scope === "user";
  const userTurnSearchAnchors = useMemo<UserTurnNavAnchor[]>(() => {
    if (!includeUserTurnSearchAnchors) {
      return [];
    }
    return getUserTurnSearchAnchors(displayRenderItems);
  }, [includeUserTurnSearchAnchors, displayRenderItems]);
  const includeAllTurnSearchAnchors =
    searchReady && userTurnSearch.scope === "all";
  const sessionTurnNavAnchors = useMemo<UserTurnNavAnchor[]>(() => {
    if (!includeAllTurnSearchAnchors) {
      return [];
    }
    return getAllTurnSearchAnchors(displayRenderItems);
  }, [includeAllTurnSearchAnchors, displayRenderItems]);
  const includeFullSessionSearchAnchors =
    searchReady && userTurnSearch.scope === "full";
  const fullSessionSearchAnchors = useMemo<UserTurnNavAnchor[]>(() => {
    if (!includeFullSessionSearchAnchors) {
      return [];
    }
    return getFullSessionSearchAnchors(turnGroups);
  }, [includeFullSessionSearchAnchors, turnGroups]);
  const includeLinkSearchAnchors =
    searchReady && userTurnSearch.scope === "links";
  const linkSearchAnchors = useMemo<UserTurnNavAnchor[]>(() => {
    if (!includeLinkSearchAnchors) {
      return [];
    }
    return getLinkSearchAnchors(turnGroups);
  }, [includeLinkSearchAnchors, turnGroups]);
  const loadedSearchAnchors = getActiveSearchAnchors({
    allAnchors: sessionTurnNavAnchors,
    fullAnchors: fullSessionSearchAnchors,
    linkAnchors: linkSearchAnchors,
    scope: userTurnSearch.scope,
    userAnchors: userTurnSearchAnchors,
  });
  let olderSearchMatches: OlderSearchMatch[] = [];
  if (effectiveOlderSearchState.matches.length > 0) {
    const loadedSearchAnchorIds = new Set(
      loadedSearchAnchors.map((anchor) => anchor.id),
    );
    olderSearchMatches = effectiveOlderSearchState.matches.filter(
      (anchor) => !loadedSearchAnchorIds.has(anchor.id),
    );
  }
  const activeSearchAnchors =
    olderSearchMatches.length > 0
      ? [...olderSearchMatches, ...loadedSearchAnchors]
      : loadedSearchAnchors;

  const searchOlder = useCallback(
    async (maxPages = 1, selectClosestNewMatch = false) => {
      let state = olderSearchStateRef.current;
      const requestKey = historySearchKey;
      if (
        !searchReady ||
        !state.cursor ||
        !state.hasOlder ||
        state.loading ||
        state.limitReached ||
        historySearchAttemptKeyRef.current === requestKey ||
        !onReadOlderSearchPage
      ) {
        return;
      }

      // A fast click can precede the effect that records the newly typed query.
      // Claim the key before starting the worker so that effect cannot dispose
      // this first explicit page scan as stale.
      appliedHistorySearchKeyRef.current = requestKey;
      historySearchAttemptKeyRef.current = requestKey;
      state = {
        ...state,
        checkedMessageCount:
          state.pagesScanned === 0
            ? loadedMessageCount
            : state.checkedMessageCount,
        error: false,
        key: requestKey,
        loading: true,
      };
      olderSearchStateRef.current = state;
      setOlderSearchState(state);

      try {
        let selectedId: string | null = null;
        for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
          const cursor = state.cursor;
          if (!cursor || !state.hasOlder || state.limitReached) break;

          const page = await onReadOlderSearchPage(cursor);
          if (historySearchKeyRef.current !== requestKey) return;
          const pageMessageIds = new Set(
            page.messages.flatMap((message) =>
              [message.uuid, message.id].filter(
                (id): id is string => typeof id === "string" && id.length > 0,
              ),
            ),
          );
          const transcriptDisplayObjects =
            page.session.transcriptDisplayObjects?.filter((object) =>
              object.placementAfterMessageId === ""
                ? page.pagination?.hasOlderMessages === false
                : pageMessageIds.has(object.placementAfterMessageId),
            ) ?? [];
          const result = await runHistorySearchPage({
            caseSensitive: userTurnSearch.caseSensitive,
            conversationViewEnabled,
            messages: page.messages,
            provider,
            query: userTurnSearch.query,
            recentProjectPathLinksEnabled,
            scope: userTurnSearch.scope,
            thinkingItemsVisible,
            transcriptDisplayObjects,
          });
          if (historySearchKeyRef.current !== requestKey) return;

          const nextCursor = page.pagination?.hasOlderMessages
            ? (page.pagination.truncatedBeforeMessageId ?? null)
            : null;
          const pageMatches: OlderSearchMatch[] = result.matches.map(
            (match) => ({
              ...match,
              pageCursor: cursor,
            }),
          );
          const retainedIds = new Set(state.matches.map((match) => match.id));
          const newPageMatches = pageMatches.filter(
            (match) => !retainedIds.has(match.id),
          );
          const byId = new Map<string, OlderSearchMatch>();
          for (const match of [...pageMatches, ...state.matches]) {
            if (!byId.has(match.id)) byId.set(match.id, match);
          }
          const combined = [...byId.values()];
          const limitReached =
            result.matchesTruncated ||
            combined.length >= HISTORY_SEARCH_RESULT_LIMIT;
          state = {
            ...state,
            cursor: nextCursor,
            error: false,
            hasOlder: nextCursor !== null,
            limitReached,
            matches:
              combined.length > HISTORY_SEARCH_RESULT_LIMIT
                ? combined.slice(-HISTORY_SEARCH_RESULT_LIMIT)
                : combined,
            pagesScanned: state.pagesScanned + 1,
            checkedMessageCount:
              state.checkedMessageCount + page.messages.length,
            totalMessageCount:
              page.pagination?.totalMessageCount ?? state.totalMessageCount,
          };
          olderSearchStateRef.current = state;
          setOlderSearchState(state);

          if (selectClosestNewMatch && newPageMatches.length > 0) {
            selectedId = newPageMatches[newPageMatches.length - 1]?.id ?? null;
            break;
          }
        }

        if (historySearchKeyRef.current !== requestKey) return;
        state = { ...state, loading: false };
        olderSearchStateRef.current = state;
        setOlderSearchState(state);
        if (
          selectedId &&
          state.matches.some((match) => match.id === selectedId)
        ) {
          setUserTurnSearch((previous) =>
            previous.active ? { ...previous, selectedId } : previous,
          );
        }
      } catch {
        if (historySearchKeyRef.current !== requestKey) return;
        state = { ...state, error: true, loading: false };
        olderSearchStateRef.current = state;
        setOlderSearchState(state);
      } finally {
        if (historySearchAttemptKeyRef.current === requestKey) {
          historySearchAttemptKeyRef.current = null;
        }
      }
    },
    [
      conversationViewEnabled,
      historySearchKey,
      loadedMessageCount,
      onReadOlderSearchPage,
      provider,
      recentProjectPathLinksEnabled,
      runHistorySearchPage,
      searchReady,
      thinkingItemsVisible,
      userTurnSearch.caseSensitive,
      userTurnSearch.query,
      userTurnSearch.scope,
    ],
  );
  const userTurnSearchProjection = useMemo(
    () =>
      getSearchMatchProjection({
        anchors: activeSearchAnchors,
        caseSensitive: userTurnSearch.caseSensitive,
        query: userTurnSearch.query,
        searchReady,
      }),
    [
      activeSearchAnchors,
      searchReady,
      userTurnSearch.caseSensitive,
      userTurnSearch.query,
    ],
  );
  const userTurnSearchMatches = userTurnSearchProjection.matches;
  const userTurnSearchMatchIds = userTurnSearchProjection.matchIds;
  const userTurnSearchMatchTargetIds = userTurnSearchProjection.matchTargetIds;
  const userTurnSearchPreviewsById = userTurnSearchProjection.previewsById;
  const userTurnSearchSelectionProjection = useMemo(
    () =>
      getSearchSelectionProjection({
        anchors: activeSearchAnchors,
        previewsById: userTurnSearchPreviewsById,
        searchReady,
        selectedId: userTurnSearch.selectedId,
      }),
    [
      activeSearchAnchors,
      searchReady,
      userTurnSearch.selectedId,
      userTurnSearchPreviewsById,
    ],
  );
  const selectedSearchAnchor = userTurnSearchSelectionProjection.selectedAnchor;
  useEffect(() => {
    if (
      searchReady &&
      !effectiveOlderSearchState.hasOlder &&
      !effectiveOlderSearchState.limitReached &&
      selectedSearchAnchor?.id === userTurnSearchMatches[0]?.id &&
      selectedSearchAnchor?.id
    ) {
      setBoundary("start");
      setBoundaryPulse((pulse) => pulse + 1);
    }
  }, [
    searchReady,
    effectiveOlderSearchState.hasOlder,
    effectiveOlderSearchState.limitReached,
    selectedSearchAnchor?.id,
    userTurnSearchMatches[0]?.id,
  ]);
  selectedSearchAnchorIdRef.current = selectedSearchAnchor?.id ?? null;
  const selectedSearchTargetId =
    userTurnSearchSelectionProjection.selectedTargetId;
  selectedSearchTargetIdRef.current = selectedSearchTargetId;
  const userTurnSearchPreview =
    userTurnSearchSelectionProjection.selectedPreview;
  const selectedAnchorIsLoaded = selectedSearchAnchor
    ? loadedSearchAnchors.some(
        (anchor) => anchor.id === selectedSearchAnchor.id,
      )
    : false;
  const selectedOlderSearchMatch =
    selectedSearchAnchor && !selectedAnchorIsLoaded
      ? (effectiveOlderSearchState.matches.find(
          (match) => match.id === selectedSearchAnchor.id,
        ) ?? null)
      : null;
  const searchPanelProjection = useMemo(
    () =>
      getSearchPanelProjection({
        matches: userTurnSearchMatches,
        scope: userTurnSearch.scope,
        searchReady,
        selectedId: userTurnSearch.selectedId,
      }),
    [
      searchReady,
      userTurnSearch.scope,
      userTurnSearch.selectedId,
      userTurnSearchMatches,
    ],
  );
  const getNavigatorAnchors = useCallback(
    () =>
      searchReady
        ? userTurnSearchMatches
        : userTurnSearch.active
          ? []
          : getUserTurnNavAnchorList(),
    [
      getUserTurnNavAnchorList,
      searchReady,
      userTurnSearch.active,
      userTurnSearchMatches,
    ],
  );
  const searchState = useMemo<UserTurnNavSearchState | null>(
    () =>
      getSearchNavigatorStateProjection({
        caseSensitive: userTurnSearch.caseSensitive,
        matchIds: userTurnSearchMatchIds,
        preview: userTurnSearchPreview,
        previewsById: userTurnSearchPreviewsById,
        query: userTurnSearch.query,
        searchReady,
        selectedAnchorId: selectedSearchAnchor?.id,
      }),
    [
      searchReady,
      selectedSearchAnchor?.id,
      userTurnSearch.caseSensitive,
      userTurnSearch.query,
      userTurnSearchPreviewsById,
      userTurnSearchMatchIds,
      userTurnSearchPreview,
    ],
  );
  const visibleTurnGroups = useMemo(() => {
    return getSearchVisibleTurnGroups({
      matchIds: userTurnSearchMatchIds,
      matchTargetIds: userTurnSearchMatchTargetIds,
      scope: userTurnSearch.scope,
      searchReady,
      turnGroups,
    });
  }, [
    searchReady,
    turnGroups,
    userTurnSearch.scope,
    userTurnSearchMatchIds,
    userTurnSearchMatchTargetIds,
  ]);

  useEffect(() => {
    dispatchSessionIsearchGuideState({
      active: userTurnSearch.active,
      scope: userTurnSearch.scope,
    });
  }, [userTurnSearch.active, userTurnSearch.scope]);

  useEffect(
    () => () => {
      dispatchSessionIsearchGuideState({ active: false, scope: "user" });
    },
    [],
  );

  const moveSearchSelection = useCallback(
    (direction: "previous" | "next") => {
      cancelSearchTargetPreparation();
      const currentIndex = selectedSearchAnchorIdRef.current
        ? userTurnSearchMatches.findIndex(
            (anchor) => anchor.id === selectedSearchAnchorIdRef.current,
          )
        : -1;
      if (
        direction === "previous" &&
        (userTurnSearchMatches.length === 0 || currentIndex === 0) &&
        olderSearchStateRef.current.hasOlder
      ) {
        setBoundary(null);
        void searchOlder(reverseSearchMaxPagesPerAttempt, true);
        return;
      }
      const atBoundary =
        direction === "previous"
          ? currentIndex === 0
          : currentIndex === userTurnSearchMatches.length - 1;
      if (atBoundary) {
        setBoundary(direction);
        setBoundaryPulse((pulse) => pulse + 1);
      } else {
        setBoundary(null);
      }
      setUserTurnSearch((previous) => {
        if (!previous.active || userTurnSearchMatches.length === 0) {
          return previous;
        }
        const currentIndex = previous.selectedId
          ? userTurnSearchMatches.findIndex(
              (anchor) => anchor.id === previous.selectedId,
            )
          : -1;
        const step = direction === "previous" ? -1 : 1;
        const fallbackIndex =
          direction === "previous" ? userTurnSearchMatches.length - 1 : 0;
        const nextIndex =
          currentIndex >= 0
            ? (currentIndex + step + userTurnSearchMatches.length) %
              userTurnSearchMatches.length
            : fallbackIndex;
        const nextSelectedId = userTurnSearchMatches[nextIndex]?.id ?? null;
        return { ...previous, selectedId: nextSelectedId };
      });
    },
    [
      cancelSearchTargetPreparation,
      reverseSearchMaxPagesPerAttempt,
      searchOlder,
      userTurnSearchMatches,
    ],
  );
  const stopSearchArrowRepeat = useCallback(() => {
    if (searchArrowRepeatTimeoutRef.current !== null) {
      clearTimeout(searchArrowRepeatTimeoutRef.current);
      searchArrowRepeatTimeoutRef.current = null;
    }
    if (searchArrowRepeatIntervalRef.current !== null) {
      clearInterval(searchArrowRepeatIntervalRef.current);
      searchArrowRepeatIntervalRef.current = null;
    }
    searchArrowRepeatDirectionRef.current = null;
  }, []);
  const moveSearchSelectionRef = useRef(moveSearchSelection);
  moveSearchSelectionRef.current = moveSearchSelection;
  useEffect(
    () => () => {
      stopSearchArrowRepeat();
      stopEarlySearchKeys();
    },
    [stopEarlySearchKeys, stopSearchArrowRepeat],
  );
  const startSearchArrowRepeat = useCallback(
    (direction: "previous" | "next") => {
      if (
        searchArrowRepeatDirectionRef.current === direction &&
        (searchArrowRepeatTimeoutRef.current !== null ||
          searchArrowRepeatIntervalRef.current !== null)
      ) {
        return;
      }
      stopSearchArrowRepeat();
      searchArrowRepeatDirectionRef.current = direction;
      searchArrowRepeatTimeoutRef.current = setTimeout(() => {
        searchArrowRepeatTimeoutRef.current = null;
        moveSearchSelectionRef.current(direction);
        searchArrowRepeatIntervalRef.current = setInterval(() => {
          moveSearchSelectionRef.current(direction);
        }, SEARCH_ARROW_REPEAT_INTERVAL_MS);
      }, SEARCH_ARROW_REPEAT_DELAY_MS);
    },
    [stopSearchArrowRepeat],
  );
  const handleSearchArrowKey = useCallback(
    (direction: "previous" | "next", repeat: boolean) => {
      if (!repeat || searchArrowRepeatDirectionRef.current !== direction) {
        moveSearchSelection(direction);
        startSearchArrowRepeat(direction);
      }
    },
    [moveSearchSelection, startSearchArrowRepeat],
  );
  const selectSearchMatch = useCallback(
    (id: string, targetId?: string) => {
      cancelSearchTargetPreparation();
      committedSearchTargetIdRef.current = targetId ?? id;
      setUserTurnSearch((previous) =>
        previous.active ? { ...previous, selectedId: id } : previous,
      );
      requestAnimationFrame(() => {
        searchInputRef.current?.focus({ preventScroll: true });
      });
    },
    [cancelSearchTargetPreparation],
  );
  const prepareSearchTarget = useCallback(
    (id: string): string | null | Promise<string | null> => {
      const anchor = activeSearchAnchors.find(
        (candidate) => candidate.id === id,
      );
      if (!anchor) return null;
      const targetId = anchor.targetId ?? anchor.id;
      const olderMatch = effectiveOlderSearchState.matches.find(
        (candidate) => candidate.id === id,
      );
      const anchorIsLoaded = loadedSearchAnchors.some(
        (candidate) => candidate.id === id,
      );
      if (
        !olderMatch ||
        anchorIsLoaded ||
        olderMatch.pageCursor === hydratedHistoryCursor
      ) {
        return targetId;
      }
      if (!onReadOlderSearchPage || !onHydrateHistorySearchPage) {
        return null;
      }

      const requestKey = historySearchKey;
      const requestGeneration = historySearchHydrationGenerationRef.current;
      setHydratingSearchId(id);
      return onReadOlderSearchPage(olderMatch.pageCursor)
        .then((page) => {
          if (
            historySearchKeyRef.current !== requestKey ||
            historySearchHydrationGenerationRef.current !== requestGeneration
          ) {
            return null;
          }
          onHydrateHistorySearchPage(olderMatch.pageCursor, page);
          return targetId;
        })
        .catch(() => {
          if (
            historySearchKeyRef.current === requestKey &&
            historySearchHydrationGenerationRef.current === requestGeneration
          ) {
            setOlderSearchState((previous) =>
              previous.key === requestKey
                ? { ...previous, error: true }
                : previous,
            );
          }
          return null;
        })
        .finally(() => {
          if (
            historySearchKeyRef.current === requestKey &&
            historySearchHydrationGenerationRef.current === requestGeneration
          ) {
            setHydratingSearchId(null);
          }
        });
    },
    [
      activeSearchAnchors,
      effectiveOlderSearchState.matches,
      historySearchKey,
      hydratedHistoryCursor,
      loadedSearchAnchors,
      onHydrateHistorySearchPage,
      onReadOlderSearchPage,
    ],
  );
  const closeSearch = useCallback(
    (restoreScroll: boolean) => {
      searchInputWantsFocusRef.current = false;
      stopEarlySearchKeys();
      setBoundary(null);
      const committedTargetId = committedSearchTargetIdRef.current;
      committedSearchTargetIdRef.current = null;
      const restoreOriginalPosition = restoreScroll && !committedTargetId;
      const scrollTopToRestore = restoreOriginalPosition
        ? searchOriginalScrollTopRef.current
        : null;
      const focusTarget = restoreOriginalPosition
        ? searchRestoreFocusRef.current
        : null;
      searchOriginalScrollTopRef.current = null;
      searchRestoreFocusRef.current = null;
      cancelSearchTargetPreparation();
      disposeHistorySearchWorker();
      setOlderSearchState(createOlderSearchState("", null, false));

      if (restoreOriginalPosition || focusTarget) {
        requestAnimationFrame(() => {
          const scrollContainer = containerRef.current?.parentElement;
          if (scrollContainer && scrollTopToRestore !== null) {
            scrollContainer.scrollTop = scrollTopToRestore;
          }
          if (focusTarget?.isConnected) {
            focusTarget.focus({ preventScroll: true });
          }
        });
      }

      setUserTurnSearch((previous) => {
        return {
          active: false,
          scope: previous.scope,
          query: "",
          caseSensitive: false,
          selectedId: null,
          originalScrollTop: null,
        };
      });
    },
    [
      cancelSearchTargetPreparation,
      containerRef,
      disposeHistorySearchWorker,
      stopEarlySearchKeys,
    ],
  );
  const openSearch = useCallback(
    (scope: SessionIsearchScope) => {
      const canSearch =
        scope === "user"
          ? hasUserSearchableTurn || hasOlderMessages
          : displayRenderItems.length > 0 || hasOlderMessages;
      if (!canSearch) {
        return;
      }
      if (userTurnSearch.active) {
        setBoundary(null);
        setUserTurnSearch((previous) => ({ ...previous, scope }));
        searchInputRef.current?.focus({ preventScroll: true });
        return;
      }
      const activeElement = document.activeElement;
      searchRestoreFocusRef.current =
        activeElement instanceof HTMLElement && activeElement !== document.body
          ? activeElement
          : null;
      const scrollContainer = containerRef.current?.parentElement;
      searchOriginalScrollTopRef.current = scrollContainer?.scrollTop ?? null;
      committedSearchTargetIdRef.current = null;
      setUserTurnSearch({
        active: true,
        scope,
        query: "",
        caseSensitive: false,
        selectedId: null,
        originalScrollTop: searchOriginalScrollTopRef.current,
      });
      // The panel mounts with focus (attachSearchInput), so no frame passes
      // before the input can take keys. Until that mount happens the query
      // still has nowhere to land, so collect keystrokes at the window and
      // let the input render what was typed while it did not exist.
      searchInputWantsFocusRef.current = true;
      startEarlySearchKeys();
    },
    [
      containerRef,
      displayRenderItems.length,
      hasOlderMessages,
      hasUserSearchableTurn,
      startEarlySearchKeys,
      userTurnSearch.active,
    ],
  );
  const handleQueryChange = useCallback((query: string) => {
    setBoundary(null);
    setUserTurnSearch((previous) => ({
      ...previous,
      query,
      selectedId: null,
    }));
  }, []);
  const toggleCaseSensitive = useCallback(() => {
    setBoundary(null);
    setUserTurnSearch((previous) =>
      previous.active
        ? {
            ...previous,
            caseSensitive: !previous.caseSensitive,
            selectedId: null,
          }
        : previous,
    );
  }, []);
  const getSelectedSearchTargetId = useCallback(
    () => selectedSearchTargetIdRef.current,
    [],
  );
  const getCommittedSearchTargetId = useCallback(
    () => committedSearchTargetIdRef.current,
    [],
  );
  const getSelectedSearchAnchorId = useCallback(
    () => selectedSearchAnchorIdRef.current,
    [],
  );

  useLayoutEffect(() => {
    if (!userTurnSearch.active) {
      stopSearchArrowRepeat();
      return;
    }
    setUserTurnSearch((previous) => {
      if (!previous.active) {
        return previous;
      }
      let nextSelectedId: string | null = null;
      if (searchReady && userTurnSearchMatches.length > 0) {
        nextSelectedId =
          previous.selectedId && userTurnSearchMatchIds.has(previous.selectedId)
            ? previous.selectedId
            : (userTurnSearchMatches[userTurnSearchMatches.length - 1]?.id ??
              null);
      }
      if (previous.selectedId === nextSelectedId) {
        return previous;
      }
      return { ...previous, selectedId: nextSelectedId };
    });
  }, [
    searchReady,
    stopSearchArrowRepeat,
    userTurnSearch.active,
    userTurnSearchMatches,
    userTurnSearchMatchIds,
  ]);

  useEffect(() => {
    if (inert) {
      stopSearchArrowRepeat();
    }
  }, [inert, stopSearchArrowRepeat]);

  const searchPanelTarget =
    userTurnSearch.active && typeof document !== "undefined"
      ? querySessionRouteLayerElement<HTMLElement>(
          ".session-input-inner",
          containerRef.current,
        )
      : null;
  const checkedTotal = Math.max(
    totalMessageCount,
    effectiveOlderSearchState.totalMessageCount,
  );
  const checkedPercent =
    !effectiveOlderSearchState.hasOlder &&
    !effectiveOlderSearchState.limitReached
      ? 100
      : checkedTotal > 0
        ? Math.min(
            99,
            Math.floor(
              (100 *
                Math.max(
                  loadedMessageCount,
                  effectiveOlderSearchState.checkedMessageCount,
                )) /
                checkedTotal,
            ),
          )
        : null;
  const renderSearchPanel = (
    activate: (id: string, targetId: string, close: boolean) => void,
  ) => {
    const activateSelected = (close: boolean) => {
      if (selectedSearchAnchor && selectedSearchTargetId) {
        activate(selectedSearchAnchor.id, selectedSearchTargetId, close);
      }
    };
    const searchPanel = userTurnSearch.active ? (
      <div className={styles.panel} role="search">
        <div className={styles.main}>
          <div className={styles.queryRow}>
            <select
              className={styles.label}
              value={userTurnSearch.scope}
              aria-label={t("sessionSearchScopePicker")}
              onChange={(event) =>
                openSearch(event.target.value as SessionIsearchScope)
              }
            >
              {SEARCH_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {getSearchScopeLabel(scope)}
                </option>
              ))}
            </select>
            <TextInput
              ref={attachSearchInput}
              size="small"
              className={styles.input}
              value={userTurnSearch.query}
              onChange={(event) => handleQueryChange(event.target.value)}
              placeholder="reverse search"
              aria-label={searchPanelProjection.scopeAriaLabel}
            />
          </div>
          <Button
            variant="ghost"
            size="small"
            aria-label="Case-sensitive search"
            aria-pressed={userTurnSearch.caseSensitive}
            title={
              userTurnSearch.caseSensitive
                ? "Case-sensitive search on"
                : "Case-sensitive search off"
            }
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleCaseSensitive}
          >
            Aa
          </Button>
          <span
            className={styles.coverage}
            role="status"
            title={t("sessionSearchCoverage")}
            aria-label={t("sessionSearchCoverage")}
          >
            {checkedPercent === null ? "—" : `${checkedPercent}%`}
          </span>
          <div className={styles.navigation}>
            <IconButton
              size="small"
              className={styles.previous}
              label={t("sessionSearchPrevious")}
              disabled={
                !searchReady ||
                effectiveOlderSearchState.loading ||
                (userTurnSearchMatches.length === 0 &&
                  !effectiveOlderSearchState.hasOlder)
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => moveSearchSelection("previous")}
            >
              ↑
            </IconButton>
            <IconButton
              size="small"
              className={styles.next}
              label={t("sessionSearchNext")}
              disabled={
                userTurnSearchMatches.length === 0 ||
                effectiveOlderSearchState.loading
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => moveSearchSelection("next")}
            >
              ↓
            </IconButton>
            <Button
              size="small"
              className={styles.go}
              aria-label={t("sessionSearchGoLabel")}
              disabled={!selectedSearchAnchor || hydratingSearchId !== null}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => activateSelected(true)}
            >
              {t("sessionSearchGo")}
            </Button>
          </div>
          <span className={styles.count}>
            {searchPanelProjection.countLabel}
          </span>
          <IconButton
            size="small"
            label={t("sessionSearchCloseHere")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() =>
              selectedSearchAnchor && selectedSearchTargetId
                ? activateSelected(true)
                : closeSearch(false)
            }
          >
            ×
          </IconButton>
        </div>
        {boundary && (
          <div key={boundaryPulse} className={styles.boundary} role="status">
            {t(
              boundary === "start"
                ? "sessionSearchStartReached"
                : boundary === "previous"
                  ? "sessionSearchStartWrap"
                  : "sessionSearchEndWrap",
            )}
          </div>
        )}
        {selectedOlderSearchMatch && (
          <ButtonBase
            className={styles.olderPreview}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => activateSelected(false)}
          >
            <span className={styles.olderPreviewLabel}>
              {hydratingSearchId === selectedOlderSearchMatch.id
                ? t("sessionSearchLoadingResult")
                : t("sessionSearchOlderResult")}
            </span>
            <span className={styles.olderPreviewText}>
              {selectedOlderSearchMatch.preview}
            </span>
          </ButtonBase>
        )}
        {searchReady && onReadOlderSearchPage && (
          <div className={styles.olderControls}>
            {effectiveOlderSearchState.hasOlder &&
              !effectiveOlderSearchState.limitReached && (
                <Button
                  variant="ghost"
                  size="small"
                  className={styles.olderButton}
                  disabled={effectiveOlderSearchState.loading}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void searchOlder()}
                >
                  {effectiveOlderSearchState.loading
                    ? t("sessionSearchSearchingOlder")
                    : effectiveOlderSearchState.pagesScanned > 0
                      ? t("sessionSearchMoreOlder")
                      : t("sessionSearchOlder")}
                </Button>
              )}
            {(effectiveOlderSearchState.error ||
              effectiveOlderSearchState.pagesScanned > 0) && (
              <span className={styles.olderStatus}>
                {effectiveOlderSearchState.error
                  ? t("sessionSearchOlderError")
                  : effectiveOlderSearchState.limitReached
                    ? t("sessionSearchOlderLimit")
                    : !effectiveOlderSearchState.hasOlder &&
                        boundary !== "start"
                      ? t("sessionSearchStartReached")
                      : !effectiveOlderSearchState.hasOlder
                        ? null
                        : t("sessionSearchOlderPages", {
                            count: effectiveOlderSearchState.pagesScanned,
                          })}
              </span>
            )}
          </div>
        )}
        <IconButton
          variant="outline"
          size="dense"
          className={styles.helpToggle}
          label={t("sessionSearchShowKeys")}
          aria-expanded={helpShown}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setHelpShown((shown) => !shown)}
        >
          ?
        </IconButton>
        <div
          className={[styles.help, helpShown ? styles.helpShown : ""]
            .filter(Boolean)
            .join(" ")}
        >
          <span>
            {t("sessionSearchHelpNavigate", {
              shortcutKeys: searchPanelProjection.shortcutKeys,
            })}
          </span>
          <span>{t("sessionSearchHelpClose")}</span>
        </div>
      </div>
    ) : null;
    return searchPanelTarget && searchPanel
      ? createPortal(searchPanel, searchPanelTarget)
      : searchPanel;
  };

  return {
    active: userTurnSearch.active,
    scope: userTurnSearch.scope,
    visibleTurnGroups,
    cancelSearchTargetPreparation,
    getNavigatorAnchors,
    searchState,
    renderSearchPanel,
    closeSearch,
    getCommittedSearchTargetId,
    getSelectedSearchAnchorId,
    getSelectedSearchTargetId,
    handleSearchArrowKey,
    moveSearchSelection,
    openSearch,
    prepareSearchTarget,
    selectSearchMatch,
    stopSearchArrowRepeat,
  };
}
