import { useEffect, useRef, useState } from "react";
import type { SessionContentDiagnostic } from "@yep-anywhere/shared";
import type { GlobalSessionItem } from "../../api/client";
import { useI18n } from "../../i18n";
import { getSessionDisplayTitle } from "../../utils";
import { Button } from "../ui/Button";
import { SearchDetail } from "./SearchDetail";
import { limitTurnMatches, type SearchMatch } from "./model";
import {
  MatchPreview,
  SearchDiagnostics,
  type SearchPreviewTarget,
} from "./SearchPreviews";
import styles from "./SearchSessionMatches.module.css";

/** A live projection of retained hits; opening it never creates scan interest. */
export function SearchSessionMatches({
  session,
  matches,
  query,
  running,
  limited,
  partial,
  diagnostics,
  basePath,
  onZoom,
  onClose,
  paneTarget,
}: {
  session: GlobalSessionItem;
  matches: SearchMatch[];
  query: string;
  running: boolean;
  limited: boolean;
  partial: Map<string, string>;
  diagnostics: Map<string, SessionContentDiagnostic[]>;
  basePath: string;
  onZoom(target: SearchPreviewTarget): void;
  onClose(): void;
  paneTarget?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const turns = limitTurnMatches(matches, Infinity);
  const [window, setWindow] = useState({ query, count: 40 });
  const count = window.query === query ? window.count : 40;
  const more = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const showMore = () => setWindow({ query, count: count + 40 });
  useEffect(() => {
    if (count >= turns.length) return;
    const element = more.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting)
          setWindow((previous) => ({
            query,
            count: (previous.query === query ? previous.count : 40) + 40,
          }));
      },
      { root: scroller.current, rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [query, count, turns.length]);
  return (
    <SearchDetail
      paneTarget={paneTarget}
      title={getSessionDisplayTitle(session)}
      onClose={onClose}
      closeOnBackGesture
      contentRef={scroller}
      actions={
        <Button onClick={onClose}>← {t("sessionSearchBackToResults")}</Button>
      }
    >
      <div className={styles.matches} data-session-matches>
        <div className={styles.summary}>
          <strong>
            {t("sessionSearchRetainedMatches", { count: turns.length })}
          </strong>
          <q>{query}</q>
          {running && <span>{t("sessionSearchMatchesScanning")}</span>}
          {limited && <span>{t("sessionSearchMatchesCapped")}</span>}
        </div>
        <div className={styles.turns}>
          {turns.slice(0, count).map((match) => (
            <MatchPreview
              key={match.id}
              session={session}
              match={match}
              query={query}
              basePath={basePath}
              onZoom={onZoom}
            />
          ))}
        </div>
        {count < turns.length && (
          <Button ref={more} className={styles.more} onClick={showMore}>
            {t("sessionSearchMoreMatches")}
          </Button>
        )}
        <SearchDiagnostics
          sessions={[session]}
          partial={
            partial.has(session.id)
              ? new Map([[session.id, partial.get(session.id)!]])
              : new Map()
          }
          diagnostics={diagnostics}
          basePath={basePath}
        />
      </div>
    </SearchDetail>
  );
}
