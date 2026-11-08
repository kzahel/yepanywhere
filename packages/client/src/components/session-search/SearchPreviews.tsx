import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { SessionContentDiagnostic } from "@yep-anywhere/shared";
import {
  getMessageId,
  type Message,
} from "@yep-anywhere/shared/transcript/message";
import type { GlobalSessionItem, PaginationInfo } from "../../api/client";
import { useCurrentSourceRuntime } from "../../contexts/SourceRuntimeContext";
import { useI18n } from "../../i18n";
import { getSessionDisplayTitle } from "../../utils";
import { SearchDetail } from "./SearchDetail";
import { renderHighlightedText } from "../SearchPreview";
import { IconButton } from "../ui/Button";
import previewStyles from "../UserTurnNavigator.module.css";
import { limitTurnMatches, type SearchMatch } from "./model";
import styles from "./SearchPreviews.module.css";
import searchStyles from "./SessionSearch.module.css";

function sessionHref(
  session: GlobalSessionItem,
  basePath: string,
  messageId?: string,
) {
  return `${basePath}/projects/${session.projectId}/sessions/${session.id}${messageId ? `?searchMatch=${encodeURIComponent(messageId)}` : ""}`;
}

export function SearchDiagnostics({
  sessions,
  partial,
  diagnostics,
  basePath,
}: {
  sessions: GlobalSessionItem[];
  partial: Map<string, string>;
  diagnostics: Map<string, SessionContentDiagnostic[]>;
  basePath: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!partial.size) return null;
  return (
    <details
      className={searchStyles.diagnostics}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t("sessionSearchPartial", { count: partial.size })}</summary>
      {[...partial].map(([id, reason]) => {
        const session = sessions.find((session) => session.id === id);
        const details = diagnostics.get(id) ?? [];
        if (!reason && !details.length) return null;
        const title = <q>{session ? getSessionDisplayTitle(session) : id}</q>;
        return (
          <div key={id}>
            {session ? (
              <Link to={sessionHref(session, basePath)}>{title}</Link>
            ) : (
              title
            )}
            {details.length ? (
              details.map((detail) => {
                const file = detail.sourcePath?.split(/[/\\]/).at(-1);
                const location = file
                  ? `${file}${detail.byteOffset === undefined ? "" : ` at byte ${detail.byteOffset}`}`
                  : undefined;
                const reason =
                  location && detail.message.startsWith(`${location}: `)
                    ? detail.message.slice(location.length + 2)
                    : detail.message;
                return (
                  <div key={detail.id}>
                    {session && location ? (
                      <>
                        <Link
                          to={sessionHref(session, basePath, detail.messageId)}
                          title={detail.sourcePath}
                        >
                          {file}
                        </Link>
                        {detail.byteOffset === undefined
                          ? ""
                          : ` at byte ${detail.byteOffset}`}
                        {": "}
                      </>
                    ) : (
                      location && `${location}: `
                    )}
                    {reason}
                  </div>
                );
              })
            ) : (
              <>: {reason}</>
            )}
          </div>
        );
      })}
    </details>
  );
}

interface TurnText {
  id: string;
  role: "user" | "assistant";
  text: string;
}
function visibleText(message: Message): TurnText | null {
  if (
    (message.type !== "user" && message.type !== "assistant") ||
    message.isMeta ||
    message.isSynthetic
  )
    return null;
  const content = message.message?.content ?? message.content;
  const text =
    typeof content === "string"
      ? content
      : content
          ?.flatMap((block) =>
            block.type === "text" && typeof block.text === "string"
              ? [block.text]
              : [],
          )
          .join("\n");
  if (
    !text ||
    /^(?:# AGENTS\.md instructions|<environment_context>|<INSTRUCTIONS>)/.test(
      text.trim(),
    )
  )
    return null;
  return { id: getMessageId(message), role: message.type, text };
}

export interface SearchPreviewTarget {
  session: GlobalSessionItem;
  match: SearchMatch;
}

function matchHref({ session, match }: SearchPreviewTarget, basePath: string) {
  return sessionHref(
    session,
    basePath,
    match.role === "title" ? undefined : match.id,
  );
}

export function SearchPreviews({
  session,
  matches,
  query,
  basePath,
  onZoom,
  streamingRows = 0,
  limit,
  onAdjustLimit,
  onExpand,
}: {
  session: GlobalSessionItem;
  matches: SearchMatch[];
  query: string;
  basePath: string;
  onZoom(target: SearchPreviewTarget): void;
  streamingRows?: number;
  limit: number;
  onAdjustLimit(delta: number, shown: number, anchor: HTMLElement): void;
  onExpand(): void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const shown = limitTurnMatches(matches, streamingRows ? 1 : limit);
  if (!shown.length && !streamingRows) return null;
  const shownPerRole = Math.max(
    shown.filter((m) => m.role === "user").length,
    shown.filter((m) => m.role === "assistant").length,
  );
  const availablePerRole = Math.max(
    matches.filter((m) => m.role === "user").length,
    matches.filter((m) => m.role === "assistant").length,
  );
  const currentLimit = Number.isFinite(limit) ? limit : shownPerRole;
  const canDecrease = Math.max(1, currentLimit - 1) < shownPerRole;
  const canIncrease =
    Math.min(availablePerRole, currentLimit + 1) > shownPerRole;
  return (
    <div
      ref={root}
      data-search-previews
      className={`${styles.previews} ${streamingRows ? styles.streaming : ""}`}
      style={streamingRows ? { minHeight: 44 * streamingRows } : undefined}
    >
      {!!shown.length && (
        <>
          <IconButton
            size="small"
            className={styles.expand}
            label={t("sessionSearchAllMatches")}
            onClick={onExpand}
          >
            ↗
          </IconButton>
          <div className={styles.adjustLimit} data-search-limit-controls>
            {canDecrease && (
              <IconButton
                size="small"
                className={styles.decrease}
                label={t("sessionSearchDecreaseLimit")}
                onClick={() => onAdjustLimit(-1, shownPerRole, root.current!)}
              >
                −
              </IconButton>
            )}
            {canIncrease && (
              <IconButton
                size="small"
                className={styles.increase}
                label={t("sessionSearchIncreaseLimit")}
                onClick={() => onAdjustLimit(1, shownPerRole, root.current!)}
              >
                +
              </IconButton>
            )}
          </div>
        </>
      )}
      {shown.map((match) => (
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
  );
}

function useTurnContext(
  { session, match }: SearchPreviewTarget,
  active: boolean,
  delay: number,
) {
  const { t } = useI18n();
  const runtime = useCurrentSourceRuntime();
  const [context, setContext] = useState<{
    text: string;
    neighbor?: TurnText;
  }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!active || context || match.role === "title") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        let before: string | undefined;
        let target: TurnText | undefined;
        let nextAssistant: TurnText | undefined;
        const cursors = new Set<string>();
        do {
          const params = new URLSearchParams({
            tailCompactions: "1",
            tailTurns: "64",
          });
          if (before) params.set("beforeMessageId", before);
          const page = await runtime.transport.fetch<{
            messages: Message[];
            pagination?: PaginationInfo;
          }>(
            `/projects/${session.projectId}/sessions/${session.id}?${params}`,
            { signal: controller.signal },
          );
          controller.signal.throwIfAborted();
          const turns = page.messages.flatMap((message) => {
            const text = visibleText(message);
            return text ? [text] : [];
          });
          const index = turns.findIndex((turn) => turn.id === match.id);
          if (index >= 0) {
            target = turns[index];
            const neighbor =
              match.role === "user"
                ? (turns
                    .slice(index + 1)
                    .find((turn) => turn.role === "assistant") ?? nextAssistant)
                : turns
                    .slice(0, index)
                    .reverse()
                    .find((turn) => turn.role === "user");
            if (
              neighbor ||
              match.role === "user" ||
              !page.pagination?.hasOlderMessages
            ) {
              setContext({ text: target!.text, neighbor });
              return;
            }
          } else if (target) {
            const neighbor = [...turns]
              .reverse()
              .find((turn) => turn.role === "user");
            if (neighbor || !page.pagination?.hasOlderMessages) {
              setContext({ text: target.text, neighbor });
              return;
            }
          }
          nextAssistant =
            turns.find((turn) => turn.role === "assistant") ?? nextAssistant;
          before = page.pagination?.hasOlderMessages
            ? page.pagination.truncatedBeforeMessageId
            : undefined;
          if (before && cursors.has(before))
            throw new Error(t("sessionSearchTurnUnavailable"));
          if (before) cursors.add(before);
        } while (before);
        throw new Error(t("sessionSearchTurnUnavailable"));
      })().catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    active,
    delay,
    context,
    match.id,
    match.role,
    runtime,
    session.id,
    session.projectId,
    t,
  ]);
  return { context, error };
}

export function MatchPreview({
  session,
  match,
  query,
  basePath,
  onZoom,
}: SearchPreviewTarget & {
  query: string;
  basePath: string;
  onZoom(target: SearchPreviewTarget): void;
}) {
  const { t } = useI18n();
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    root.current
      ?.querySelector<HTMLButtonElement>("[role='menuitem']")
      ?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setMenu(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setMenu(false);
      menuButton.current?.focus();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("focusin", outside, true);
    window.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("focusin", outside, true);
      window.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, [menu]);
  const { context } = useTurnContext(
    { session, match },
    hover && (match.role === "title" || match.searchText === undefined),
    400,
  );
  const href = matchHref({ session, match }, basePath);
  const text =
    match.role === "title"
      ? match.fullText
      : (match.searchText ?? context?.text);
  const label = t(`sessionSearchField_${match.role}`);
  return (
    <div ref={root} className={styles.match}>
      <Link
        to={href}
        title={menu ? undefined : (text ?? match.preview)}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          setMenu(false);
          onZoom({ session, match });
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu(true);
        }}
      >
        <span className={`${previewStyles.facsimileTag} ${styles.chip}`}>
          {label}
          {match.role !== "title" && `·${match.ordinal}`}
        </span>
        <span className={styles.snippet}>
          {renderHighlightedText(match.preview, query)}
        </span>
      </Link>
      <IconButton
        ref={menuButton}
        size="small"
        label={t("sessionSearchMatchMenu")}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((value) => !value)}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="4" cy="9" r="1.4" />
          <circle cx="9" cy="9" r="1.4" />
          <circle cx="14" cy="9" r="1.4" />
        </svg>
      </IconButton>
      {menu && (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              onZoom({ session, match });
            }}
          >
            {t("sessionSearchZoom")}
          </button>
          <Link role="menuitem" to={href}>
            {t("sessionSearchOpenTurn")}
          </Link>
        </div>
      )}
    </div>
  );
}

/** The page owns the opened preview; result revalidation must not dismiss it. */
export function SearchZoomPreview({
  target,
  query,
  basePath,
  onClose,
  paneTarget,
}: {
  target: SearchPreviewTarget;
  query: string;
  basePath: string;
  onClose(): void;
  paneTarget?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const { context, error } = useTurnContext(target, true, 0);
  const { session, match } = target;
  const text =
    match.role === "title"
      ? match.fullText
      : (match.searchText ?? context?.text);
  const turn = useRef<HTMLParagraphElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!text || !query.trim()) return;
    const mark = turn.current?.querySelector("mark");
    const container = scroller.current;
    if (!mark || !container || container.scrollHeight <= container.clientHeight)
      return;
    const target =
      container.getBoundingClientRect().top + container.clientHeight / 3;
    const below = mark.getBoundingClientRect().top - target;
    if (below > 0) {
      const content = turn.current!.parentElement!;
      const missingSpace =
        container.scrollTop +
        below -
        (container.scrollHeight - container.clientHeight);
      if (missingSpace > 0) content.style.paddingBottom = `${missingSpace}px`;
      container.scrollTop += below;
    }
  }, [text, query]);
  return (
    <SearchDetail
      paneTarget={paneTarget}
      title={getSessionDisplayTitle(session)}
      onClose={onClose}
      closeOnBackGesture
      contentRef={scroller}
      actions={
        <Link to={matchHref(target, basePath)}>
          {t("sessionSearchOpenTurn")}
        </Link>
      }
    >
      <div className={styles.zoom}>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p ref={turn}>
            {text === undefined
              ? t("gitStatusLoading")
              : renderHighlightedText(text, query)}
          </p>
        )}
        {context?.neighbor && (
          <>
            <hr />
            <span>{t(`sessionSearchField_${context.neighbor.role}`)}</span>
            <p className={styles.neighbor} title={context.neighbor.text}>
              {context.neighbor.text}
            </p>
          </>
        )}
      </div>
    </SearchDetail>
  );
}
