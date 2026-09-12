import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderName } from "@yep-anywhere/shared";
import type { AgentActivity } from "../hooks/useFileActivity";
import type { SessionHoverCardAnchor } from "../hooks/useSessionHoverCardController";
import type { PendingInputType, SessionStatus } from "../types";
import { DEFAULT_HOVERCARD_MAX_HEIGHT_PX } from "../hooks/useHoverCardAppearance";
import { useQuoteableTextSource } from "../hooks/useQuoteableTextSource";
import { parseCommandTurn } from "@yep-anywhere/shared/transcript/commandTurn";
import { QUOTE_SELECTION_ROOT_ATTRIBUTES } from "../lib/markdownSelectionCopy";
import { estimateHoverCardPromptLines } from "./sessionHoverCardLines";
import { ProviderBadge } from "./ProviderBadge";
import { SessionStatusBadge } from "./StatusBadge";
import styles from "./SessionHoverCard.module.css";

const GAP_PX = 4;
const MARGIN_PX = 8;
const CURSOR_OFFSET_PX = 14;
const TARGET_INLINE_GAP_PX = 8;

export function getSessionHoverCardLeft({
  rowLeft,
  rowRight,
  cursorX,
  cardWidth,
  viewportWidth,
}: Pick<SessionHoverCardAnchor, "rowLeft" | "rowRight" | "cursorX"> & {
  cardWidth: number;
  viewportWidth: number;
}): number {
  const maxLeft = Math.max(MARGIN_PX, viewportWidth - cardWidth - MARGIN_PX);
  const rightOfTarget = rowRight + TARGET_INLINE_GAP_PX;
  if (rightOfTarget + cardWidth <= viewportWidth - MARGIN_PX) {
    return rightOfTarget;
  }

  const leftOfTarget = rowLeft - TARGET_INLINE_GAP_PX - cardWidth;
  if (leftOfTarget >= MARGIN_PX) return leftOfTarget;

  return Math.min(Math.max(cursorX + CURSOR_OFFSET_PX, MARGIN_PX), maxLeft);
}

interface SessionHoverCardProps {
  /** Stable id used by the owning row to recognize pointer transfers. */
  hoverCardId: string;
  /** Viewport-fixed row geometry + cursor x for placement fallback. */
  anchor: SessionHoverCardAnchor;
  /** The full first user turn, shown turn-styled and line-clamped to fit. */
  prompt: string;
  /**
   * Capped excerpt of the most recent regular agent turn (already trimmed to
   * its last lines server-side; "⚙ <tool>" when the latest turns are
   * tool-only). Rendered as a reply block below the meta row; omitted when
   * absent.
   */
  lastAgentText?: string;
  provider: ProviderName;
  model?: string;
  projectName?: string;
  /** Preformatted age line, e.g. "5m ago (est. 2d)"; omitted when null. */
  ageLabel: string | null;
  /** Called when the pointer leaves the card after selecting/reading it. */
  onMouseLeave?: () => void;
  status?: SessionStatus;
  pendingInputType?: PendingInputType;
  hasUnread?: boolean;
  activity?: AgentActivity;
  /**
   * Card max height in px, from the hover-card appearance setting. The single
   * source for the cap — applied via the inline `maxHeight` style below, so CSS
   * must not also set max-height.
   */
  maxHeightPx?: number;
}

interface Placement {
  top: number;
  left: number;
  maxHeight: number;
  /** Neither direction fully fits — widen so fewer lines are clipped. */
  loosened: boolean;
}

/**
 * Hover card for compact sidebar rows: the full first user turn at hover-card
 * size, line-clamped to the room in whichever direction fits, plus a
 * status line (provider+model badge, project, age, status). Portaled + fixed
 * so it never clips in the scrolling sidebar. It remains pointer-selectable so
 * copied text comes from the visible card, not from page content behind it.
 * Prefers below the row and beyond its horizontal edge, flipping above or to
 * the other side when needed and using the cursor only when neither side fits.
 */
export function SessionHoverCard({
  hoverCardId,
  anchor,
  prompt,
  lastAgentText,
  provider,
  model,
  projectName,
  ageLabel,
  onMouseLeave,
  status,
  pendingInputType,
  hasUnread,
  activity,
  maxHeightPx = DEFAULT_HOVERCARD_MAX_HEIGHT_PX,
}: SessionHoverCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const promptRef = useQuoteableTextSource<HTMLDivElement>(prompt);
  const replyRef = useQuoteableTextSource<HTMLDivElement>(lastAgentText);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const contentMeasurementKey = [
    prompt,
    lastAgentText ?? "",
    model ?? "",
    projectName ?? "",
    ageLabel,
    status,
  ].join("\0");

  // Measure the unclamped content (rendered hidden), then choose a placement
  // before paint. useLayoutEffect runs synchronously pre-paint, so no flicker.
  useLayoutEffect(() => {
    void contentMeasurementKey;
    const el = ref.current;
    if (!el) return;
    const { rowTop, rowBottom } = anchor;
    const naturalHeight = el.scrollHeight;
    const width = el.offsetWidth;
    const spaceBelow = Math.max(
      0,
      window.innerHeight - rowBottom - GAP_PX - MARGIN_PX,
    );
    const spaceAbove = Math.max(0, rowTop - GAP_PX - MARGIN_PX);
    const targetHeight = Math.min(naturalHeight, maxHeightPx);
    const spaceBelowCapped = Math.min(spaceBelow, maxHeightPx);
    const spaceAboveCapped = Math.min(spaceAbove, maxHeightPx);

    let below: boolean;
    let maxHeight: number;
    let loosened = false;
    if (targetHeight <= spaceBelowCapped) {
      below = true;
      maxHeight = spaceBelowCapped;
    } else if (targetHeight <= spaceAboveCapped) {
      below = false;
      maxHeight = spaceAboveCapped;
    } else {
      below = spaceBelow >= spaceAbove;
      maxHeight = Math.min(Math.max(spaceBelow, spaceAbove), maxHeightPx);
      loosened = true;
    }

    const usedHeight = Math.min(naturalHeight, maxHeight);
    const top = below ? rowBottom + GAP_PX : rowTop - GAP_PX - usedHeight;
    const left = getSessionHoverCardLeft({
      ...anchor,
      cardWidth: width,
      viewportWidth: window.innerWidth,
    });
    setPlacement({ top: Math.max(MARGIN_PX, top), left, maxHeight, loosened });
  }, [anchor, contentMeasurementKey, maxHeightPx]);

  const maxLines = placement
    ? estimateHoverCardPromptLines(placement.maxHeight, !!lastAgentText)
    : undefined;

  // Slash-command turns arrive wrapped in <command-name>…</command-name> tags;
  // show the command itself rather than the raw markup.
  const command = prompt ? parseCommandTurn(prompt) : null;

  return createPortal(
    <div
      ref={ref}
      data-session-hovercard-id={hoverCardId}
      {...QUOTE_SELECTION_ROOT_ATTRIBUTES}
      className={`${styles.root}${placement?.loosened ? ` ${styles.wide}` : ""}`}
      onMouseLeave={onMouseLeave}
      style={
        placement
          ? {
              top: placement.top,
              left: placement.left,
              maxHeight: placement.maxHeight,
            }
          : { top: 0, left: 0, visibility: "hidden" }
      }
      role="tooltip"
    >
      {prompt && (
        <div
          ref={promptRef}
          className={styles.turn}
          style={maxLines ? { WebkitLineClamp: maxLines } : undefined}
        >
          {command ? (
            <span className={styles.command}>
              {command.command}
              {command.args ? ` ${command.args}` : ""}
            </span>
          ) : (
            prompt
          )}
        </div>
      )}
      <div className={styles.meta}>
        <ProviderBadge provider={provider} model={model} />
        {projectName && <span className={styles.project}>{projectName}</span>}
        {ageLabel && <span className={styles.age}>{ageLabel}</span>}
        {status && (
          <SessionStatusBadge
            status={status}
            pendingInputType={pendingInputType}
            hasUnread={hasUnread}
            activity={activity}
          />
        )}
      </div>
      {lastAgentText && (
        <div ref={replyRef} className={styles.reply}>
          <span className={styles.replyMarker} aria-hidden="true">
            ↳
          </span>
          <span className={styles.replyText}>{lastAgentText}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
