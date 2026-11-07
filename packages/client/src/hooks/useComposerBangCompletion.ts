import { useEffect, useRef, useState } from "react";
import { getBangCompletionQuery } from "../lib/bangCommands";

/**
 * One row of the bang completion menu. Global command-history matches
 * (`history`) are ranked ahead of PATH/project/path token candidates
 * (`candidate`); selecting a history row replaces the whole `!!` body,
 * a candidate keeps the token-replacement behavior.
 */
export type BangMenuItem = { source: "history" | "candidate"; value: string };

/**
 * Opaque identity of a draft's completion query (kind, token, full body),
 * compared — never parsed — to decide whether a dismissed menu stays
 * dismissed for the current draft.
 */
export function bangCompletionQueryKey(draft: string): string | null {
  const query = getBangCompletionQuery(draft);
  return query ? `${query.kind} ${query.token}\0${draft.slice(2)}` : null;
}

/** What the composer's bang completion reads from its `bangSupport` prop. */
export interface BangCompletionSource {
  fetchCompletions: (
    token: string,
    kind: "command" | "path",
    line: string,
  ) => Promise<{ completions: string[]; history: string[] }>;
}

/**
 * The `!!` completion menu state of one composer: the draft's completion
 * query, the fetched history and token candidates, and the menu selection
 * and dismissal. The composer keeps the keyboard handling, Ctrl+↑ history
 * cycling and rendering that act on it.
 */
export function useComposerBangCompletion({
  text,
  collapsed,
  disabled,
  bangSupport,
}: {
  text: string;
  collapsed: boolean | undefined;
  disabled: boolean | undefined;
  bangSupport: BangCompletionSource | undefined;
}) {
  const [bangCandidates, setBangCandidates] = useState<string[]>([]);
  const [bangHistoryCandidates, setBangHistoryCandidates] = useState<string[]>(
    [],
  );
  const [selectedBangIndex, setSelectedBangIndex] = useState(0);
  const [dismissedBangQueryKey, setDismissedBangQueryKey] = useState<
    string | null
  >(null);
  const bangQuery =
    bangSupport && !collapsed ? getBangCompletionQuery(text) : null;
  const bangQueryKey = bangQuery ? bangCompletionQueryKey(text) : null;
  const showBangChip = !!bangSupport && !collapsed && text.startsWith("!!");
  const showBangEscapedChip =
    !!bangSupport && !collapsed && text.startsWith(" !!");
  // Global history rows first, then PATH/project/path token candidates; the
  // selection index and arrow navigation span this combined list.
  const bangMenuItems: BangMenuItem[] = [
    ...bangHistoryCandidates.map(
      (value): BangMenuItem => ({ source: "history", value }),
    ),
    ...bangCandidates.map(
      (value): BangMenuItem => ({ source: "candidate", value }),
    ),
  ];
  // A lone token candidate equal to the current token is nothing to complete;
  // suppress that (unless history offers whole-line matches).
  const hasUsefulBangCandidates =
    bangCandidates.length > 0 &&
    !(
      bangCandidates.length === 1 &&
      bangQuery !== null &&
      (bangCandidates[0] === bangQuery.token ||
        bangCandidates[0] === `${bangQuery.token}/`)
    );
  const showBangSuggestions =
    !collapsed &&
    !disabled &&
    bangQuery !== null &&
    bangQuery.token.length > 0 &&
    dismissedBangQueryKey !== bangQueryKey &&
    (bangHistoryCandidates.length > 0 || hasUsefulBangCandidates);
  const bangFetchRef = useRef(bangSupport?.fetchCompletions);
  bangFetchRef.current = bangSupport?.fetchCompletions;
  const bangFetchKind = bangQuery?.kind ?? null;
  const bangFetchToken = bangQuery?.token ?? null;
  const bangFetchLine = bangQuery ? text.slice(2) : null;
  useEffect(() => {
    const fetchCompletions = bangFetchRef.current;
    if (
      !fetchCompletions ||
      !bangFetchKind ||
      !bangFetchToken ||
      bangFetchLine === null
    ) {
      setBangCandidates([]);
      setBangHistoryCandidates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchCompletions(bangFetchToken, bangFetchKind, bangFetchLine).then(
        (result) => {
          if (!cancelled) {
            setBangCandidates(result.completions);
            setBangHistoryCandidates(result.history);
            setSelectedBangIndex(0);
          }
        },
        () => {
          if (!cancelled) {
            setBangCandidates([]);
            setBangHistoryCandidates([]);
          }
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bangFetchKind, bangFetchToken, bangFetchLine]);

  return {
    bangQuery,
    bangQueryKey,
    showBangChip,
    showBangEscapedChip,
    bangMenuItems,
    showBangSuggestions,
    selectedBangIndex,
    setSelectedBangIndex,
    setDismissedBangQueryKey,
    setBangCandidates,
    setBangHistoryCandidates,
  };
}
