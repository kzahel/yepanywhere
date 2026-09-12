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
import { useI18n } from "../i18n";
import { useSessionPerformanceSettings } from "./useSessionPerformanceSettings";
import {
  dispatchSessionIsearchGuideState,
  type SessionIsearchScope,
} from "../lib/sessionIsearchGuide";
import {
  getActiveSearchAnchors,
  getAllTurnSearchAnchors,
  getFullSessionSearchAnchors,
  getSearchMatchProjection,
  getSearchNavigatorStateProjection,
  getSearchPanelProjection,
  getSearchReady,
  getSearchSelectionProjection,
  getSearchVisibleTurnGroups,
  getUserTurnNavAnchors,
  getUserTurnSearchAnchors,
  hasSearchableUserTurn,
  type RenderTurnGroup,
} from "../lib/sessionDetail/renderSelectors";
import {
  searchSessionHistoryPage,
  type SessionHistorySearchPageInput,
  type SessionHistorySearchPageResult,
  type SessionHistorySearchWorkerResponse,
} from "../lib/sessionHistorySearch";
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
  searchPanel: ReactNode;
  closeSearch: (restoreScroll: boolean) => void;
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
  };
}

export function useMessageListIsearch({
  containerRef,
  conversationViewEnabled,
  displayRenderItems,
  hasOlderMessages = false,
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
  const searchInputRef = useRef<HTMLInputElement>(null);
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

  const hasUserSearchableTurn = useMemo(
    () => hasSearchableUserTurn(displayRenderItems),
    [displayRenderItems],
  );
  const getUserTurnNavAnchorList = useCallback(
    (): UserTurnNavAnchor[] => getUserTurnNavAnchors(displayRenderItems),
    [displayRenderItems],
  );
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
  const loadedSearchAnchors = getActiveSearchAnchors({
    allAnchors: sessionTurnNavAnchors,
    fullAnchors: fullSessionSearchAnchors,
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
      committedSearchTargetIdRef.current = null;
      cancelSearchTargetPreparation();
      const currentIndex = selectedSearchAnchorIdRef.current
        ? userTurnSearchMatches.findIndex(
            (anchor) => anchor.id === selectedSearchAnchorIdRef.current,
          )
        : -1;
      if (
        direction === "previous" &&
        (userTurnSearchMatches.length === 0 || currentIndex === 0)
      ) {
        void searchOlder(reverseSearchMaxPagesPerAttempt, true);
        return;
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
  useEffect(
    () => () => {
      stopSearchArrowRepeat();
    },
    [stopSearchArrowRepeat],
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
        moveSearchSelection(direction);
        searchArrowRepeatIntervalRef.current = setInterval(() => {
          moveSearchSelection(direction);
        }, SEARCH_ARROW_REPEAT_INTERVAL_MS);
      }, SEARCH_ARROW_REPEAT_DELAY_MS);
    },
    [moveSearchSelection, stopSearchArrowRepeat],
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
    [cancelSearchTargetPreparation, containerRef, disposeHistorySearchWorker],
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
      requestAnimationFrame(() => {
        searchInputRef.current?.focus({ preventScroll: true });
        searchInputRef.current?.select();
      });
    },
    [
      containerRef,
      displayRenderItems.length,
      hasOlderMessages,
      hasUserSearchableTurn,
    ],
  );
  const handleQueryChange = useCallback((query: string) => {
    committedSearchTargetIdRef.current = null;
    setUserTurnSearch((previous) => ({
      ...previous,
      query,
      selectedId: null,
    }));
  }, []);
  const toggleCaseSensitive = useCallback(() => {
    committedSearchTargetIdRef.current = null;
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

  useLayoutEffect(() => {
    if (!userTurnSearch.active || !committedSearchTargetIdRef.current) {
      return;
    }
    const retainedTargetIds = new Set(
      userTurnSearchMatches.map((anchor) => anchor.targetId ?? anchor.id),
    );
    if (!retainedTargetIds.has(committedSearchTargetIdRef.current)) {
      committedSearchTargetIdRef.current = null;
    }
  }, [userTurnSearch.active, userTurnSearchMatches]);

  useEffect(() => {
    if (inert) {
      stopSearchArrowRepeat();
    }
  }, [inert, stopSearchArrowRepeat]);

  const searchPanelTarget =
    userTurnSearch.active && typeof document !== "undefined"
      ? document.querySelector<HTMLElement>(".session-input-inner")
      : null;
  const searchPanel = userTurnSearch.active ? (
    <div className={styles.panel} role="search">
      <div className={styles.main}>
        <span className={styles.label}>{searchPanelProjection.scopeLabel}</span>
        <input
          ref={searchInputRef}
          className={styles.input}
          value={userTurnSearch.query}
          onChange={(event) => handleQueryChange(event.target.value)}
          placeholder="reverse search"
          aria-label={searchPanelProjection.scopeAriaLabel}
        />
        <button
          type="button"
          className={[
            styles.caseToggle,
            userTurnSearch.caseSensitive ? styles.active : "",
          ]
            .filter(Boolean)
            .join(" ")}
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
        </button>
        <span className={styles.count}>{searchPanelProjection.countLabel}</span>
      </div>
      {selectedOlderSearchMatch && (
        <div className={styles.olderPreview} role="status">
          <span className={styles.olderPreviewLabel}>
            {hydratingSearchId === selectedOlderSearchMatch.id
              ? t("sessionSearchLoadingResult")
              : t("sessionSearchOlderResult")}
          </span>
          <span className={styles.olderPreviewText}>
            {selectedOlderSearchMatch.preview}
          </span>
        </div>
      )}
      {searchReady && onReadOlderSearchPage && (
        <div className={styles.olderControls}>
          {effectiveOlderSearchState.hasOlder &&
            !effectiveOlderSearchState.limitReached && (
              <button
                type="button"
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
              </button>
            )}
          {(effectiveOlderSearchState.error ||
            effectiveOlderSearchState.pagesScanned > 0) && (
            <span className={styles.olderStatus}>
              {effectiveOlderSearchState.error
                ? t("sessionSearchOlderError")
                : effectiveOlderSearchState.limitReached
                  ? t("sessionSearchOlderLimit")
                  : !effectiveOlderSearchState.hasOlder
                    ? t("sessionSearchStartReached")
                    : t("sessionSearchOlderPages", {
                        count: effectiveOlderSearchState.pagesScanned,
                      })}
            </span>
          )}
        </div>
      )}
      <div className={styles.help}>
        <span>
          {t("sessionSearchHelpNavigate", {
            shortcutKeys: searchPanelProjection.shortcutKeys,
          })}
        </span>
        <span>{t("sessionSearchHelpClose")}</span>
      </div>
    </div>
  ) : null;
  const portaledSearchPanel =
    searchPanelTarget && searchPanel
      ? createPortal(searchPanel, searchPanelTarget)
      : searchPanel;

  return {
    active: userTurnSearch.active,
    scope: userTurnSearch.scope,
    visibleTurnGroups,
    cancelSearchTargetPreparation,
    getNavigatorAnchors,
    searchState,
    searchPanel: portaledSearchPanel,
    closeSearch,
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
