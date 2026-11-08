import type {
  PatchHunk,
  PatchLineLocation,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewNewSessionOptions,
  ReviewSourceProjection,
} from "@yep-anywhere/shared";
import { type ReactNode, useCallback, useLayoutEffect, useState } from "react";
import {
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import { writeClipboardText } from "../lib/clipboard";
import { useReviewCommentDraft } from "../hooks/useReviewCommentDraft";
import { ReviewCommentWindow } from "./ReviewCommentWindow";
import styles from "./DiffCommentLayer.module.css";
import {
  type DiffCommentRevisions,
  type DiffLineTarget,
  type ResolvedDiffLineTarget,
  useDiffLineInteractions,
} from "./useDiffLineInteractions";
import type { TranslationFn } from "../i18n";
import { reviewNewSessionFromDefault } from "../lib/sourceControlNavigationState";

/**
 * Source-review commenting over a rendered diff (topic:
 * source-review-to-session). A single delegated listener on the diff container
 * maps a click on a server-emitted `[data-diff-line]` node to an anchor via
 * `anchorFromPatch` — never from the DOM's text — and hands it to the render
 * controller. This layer owns only line interaction and pending-comment tint.
 */

export interface OpenDiffComment {
  anchor: ReviewCommentAnchor;
  flatIndex: number;
}

export function DiffCommentController({
  projectId,
  filePath,
  structuredPatch,
  revisions,
  projections,
  container,
  onOpenChange,
  renderSource,
  t,
}: {
  projectId: string;
  filePath: string;
  structuredPatch: PatchHunk[];
  revisions?: DiffCommentRevisions;
  projections?: Partial<Record<"old" | "new", ReviewSourceProjection>>;
  container: HTMLElement;
  onOpenChange?: (open: boolean) => void;
  renderSource: (state: {
    openComment: OpenDiffComment | null;
    editor: ReactNode;
  }) => ReactNode;
  t: TranslationFn;
}) {
  const [openComment, setOpenComment] = useState<OpenDiffComment | null>(null);
  const {
    pending,
    defaultSession,
    busy,
    error,
    setError,
    addToReview,
    submitNow,
  } = useReviewCommentDraft(projectId, filePath, projections !== undefined);

  useLayoutEffect(() => {
    onOpenChange?.(openComment !== null);
    return () => {
      if (openComment) onOpenChange?.(false);
    };
  }, [onOpenChange, openComment]);

  const handleOpenComment = useCallback(
    (comment: OpenDiffComment) => {
      setError(null);
      setOpenComment(comment);
    },
    [setError],
  );

  const handleAddToReview = useCallback(
    async (text: string) => {
      if (!openComment) return;
      if (await addToReview(openComment.anchor, text)) setOpenComment(null);
    },
    [addToReview, openComment],
  );

  const handleSubmit = useCallback(
    async (
      text: string,
      target: "new" | string,
      newSession?: ReviewNewSessionOptions,
    ) => {
      if (!openComment) return;
      const outcome = await submitNow(
        openComment.anchor,
        text,
        target,
        t("sourceReviewSubmitQueued"),
        newSession,
      );
      if (outcome === "navigated") setOpenComment(null);
    },
    [openComment, submitNow, t],
  );

  const editor = openComment ? (
    <ReviewCommentWindow
      key={`${openComment.anchor.side}:${openComment.flatIndex}`}
      projectId={projectId}
      anchorLabel={`${filePath}:${
        openComment.anchor.newLine ?? openComment.anchor.oldLine ?? "?"
      }`}
      snippet={openComment.anchor.snippet}
      busy={busy}
      error={error}
      onCancel={() => setOpenComment(null)}
      onAddToReview={handleAddToReview}
      defaultSession={defaultSession}
      onSubmit={(text, target) =>
        handleSubmit(
          text,
          target,
          target === "new"
            ? reviewNewSessionFromDefault(defaultSession)
            : undefined,
        )
      }
      t={t}
    />
  ) : null;

  return (
    <>
      {renderSource({ openComment, editor })}
      <DiffCommentLayer
        filePath={filePath}
        structuredPatch={structuredPatch}
        revisions={revisions}
        projections={projections}
        container={container}
        pending={pending}
        onOpenComment={handleOpenComment}
        t={t}
      />
    </>
  );
}

function DiffCommentLayer({
  filePath,
  structuredPatch,
  revisions,
  projections,
  container,
  pending,
  onOpenComment,
  t,
}: {
  filePath: string;
  structuredPatch: PatchHunk[];
  /** Revision containing each projection side; omitted means working tree. */
  revisions?: DiffCommentRevisions;
  /** Exact rendered source object for each projection side. */
  projections?: Partial<Record<"old" | "new", ReviewSourceProjection>>;
  container: HTMLElement;
  pending: readonly ReviewComment[];
  onOpenComment: (comment: OpenDiffComment) => void;
  t: TranslationFn;
}) {
  const {
    menu: lineMenu,
    openAt: openLineMenuAt,
    openFromButton: openLineMenuFromButton,
    beginLongPressAt: beginLineLongPressAt,
    moveLongPressAt: moveLineLongPressAt,
    endLongPress: endLineLongPress,
    consumeLongPressClick,
  } = useSourceContextMenu(t);
  const buildAnchor = useCallback(
    (location: PatchLineLocation): ReviewCommentAnchor => ({
      path: filePath,
      // Comparison sides cite their respective endpoints. A working-tree diff
      // mints a fresh `uncommitted` anchor timestamped at click time.
      revision: revisions?.[location.side] ?? {
        kind: "uncommitted",
        savedAt: new Date().toISOString(),
      },
      side: location.side,
      oldLine: location.oldLine,
      newLine: location.newLine,
      snippet: location.snippet,
      snippetAnchorOffset: location.snippetAnchorOffset,
      ...(projections?.[location.side]
        ? { projection: projections[location.side] }
        : {}),
    }),
    [filePath, projections, revisions],
  );

  const openComment = useCallback(
    ({ location, target }: ResolvedDiffLineTarget) => {
      onOpenComment({
        anchor: buildAnchor(location),
        flatIndex: target.flatIndex,
      });
    },
    [buildAnchor, onOpenComment],
  );

  const lineMenuActions = useCallback(
    (
      target: DiffLineTarget,
      location: PatchLineLocation,
      node: HTMLElement,
    ): SourceContextMenuAction[] => {
      const clickedLine =
        location.snippet.split("\n")[location.snippetAnchorOffset] ?? "";
      const lineNumber = location.newLine ?? location.oldLine;
      return [
        {
          label: t("sourceCommentOnLine"),
          onSelect: () => openComment({ target, location, node }),
        },
        {
          label: t("sourceCopyLine"),
          separatorBefore: true,
          onSelect: () => {
            void writeClipboardText(clickedLine);
          },
        },
        {
          label: t("sourceCopyPathLine"),
          onSelect: () => {
            void writeClipboardText(
              lineNumber ? `${filePath}:${lineNumber}` : filePath,
            );
          },
        },
      ];
    },
    [filePath, openComment, t],
  );

  const openLineMenu = useCallback(
    (resolved: ResolvedDiffLineTarget, point: { x: number; y: number }) => {
      openLineMenuAt(
        point.x,
        point.y,
        resolved.node,
        lineMenuActions(resolved.target, resolved.location, resolved.node),
      );
    },
    [lineMenuActions, openLineMenuAt],
  );

  const beginLineLongPress = useCallback(
    (resolved: ResolvedDiffLineTarget, event: globalThis.PointerEvent) => {
      beginLineLongPressAt(
        event,
        resolved.node,
        lineMenuActions(resolved.target, resolved.location, resolved.node),
      );
    },
    [beginLineLongPressAt, lineMenuActions],
  );

  const { activeLine, resolveActiveLine } = useDiffLineInteractions({
    container,
    structuredPatch,
    pending,
    revisions,
    consumeLongPressClick,
    onOpenComment: openComment,
    onOpenMenu: openLineMenu,
    onBeginLongPress: beginLineLongPress,
    onMoveLongPress: moveLineLongPressAt,
    onEndLongPress: endLineLongPress,
    t,
  });

  return (
    <>
      {activeLine && (
        <button
          type="button"
          className={styles.menuTrigger}
          style={{ top: activeLine.top }}
          aria-label={t("sourceMoreActions")}
          title={t("sourceMoreActions")}
          onClick={(event) => {
            const resolved = resolveActiveLine();
            if (!resolved) return;
            openLineMenuFromButton(
              event,
              lineMenuActions(
                resolved.target,
                resolved.location,
                resolved.node,
              ),
            );
          }}
        >
          ⋯
        </button>
      )}
      {lineMenu}
    </>
  );
}
