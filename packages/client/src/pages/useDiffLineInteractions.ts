import {
  type PatchHunk,
  type PatchLineLocation,
  type ReviewComment,
  type ReviewCommentAnchor,
  type ReviewCommentRevision,
  type ReviewCommentSide,
  anchorFromPatch,
} from "@yep-anywhere/shared";
import { useCallback, useLayoutEffect, useState } from "react";
import type { TranslationFn } from "../i18n";

export type DiffCommentRevisions = Partial<
  Record<ReviewCommentSide, ReviewCommentRevision>
>;

export interface DiffLineTarget {
  flatIndex: number;
  contextSide: ReviewCommentSide;
  top: number;
}

export interface ResolvedDiffLineTarget {
  node: HTMLElement;
  target: DiffLineTarget;
  location: PatchLineLocation;
}

interface DiffLineInteractionOptions {
  container: HTMLElement;
  structuredPatch: PatchHunk[];
  pending: readonly ReviewComment[];
  revisions?: DiffCommentRevisions;
  consumeLongPressClick: () => boolean;
  onOpenComment: (resolved: ResolvedDiffLineTarget) => void;
  onOpenMenu: (
    resolved: ResolvedDiffLineTarget,
    point: { x: number; y: number },
  ) => void;
  onBeginLongPress: (
    resolved: ResolvedDiffLineTarget,
    event: globalThis.PointerEvent,
  ) => void;
  onMoveLongPress: (event: globalThis.PointerEvent) => void;
  onEndLongPress: () => void;
  t: TranslationFn;
}

/**
 * Own the DOM-facing interaction boundary for server-rendered diff lines.
 * The editor component supplies semantic actions; this hook owns line
 * resolution, pre-paint listener readiness, keyboard traversal, active-line
 * identity, and revision-aware pending decoration.
 */
export function useDiffLineInteractions({
  container,
  structuredPatch,
  pending,
  revisions,
  consumeLongPressClick,
  onOpenComment,
  onOpenMenu,
  onBeginLongPress,
  onMoveLongPress,
  onEndLongPress,
  t,
}: DiffLineInteractionOptions): {
  activeLine: DiffLineTarget | null;
  resolveActiveLine: () => ResolvedDiffLineTarget | null;
} {
  const [activeLine, setActiveLine] = useState<DiffLineTarget | null>(null);

  const resolveLineTarget = useCallback(
    (target: EventTarget | null): ResolvedDiffLineTarget | null => {
      if (!(target instanceof HTMLElement)) return null;
      const node = target.closest<HTMLElement>("[data-diff-line]");
      if (!node || !container.contains(node)) return null;
      return resolveDiffLineTarget(container, node, structuredPatch);
    },
    [container, structuredPatch],
  );

  const activateLine = useCallback((target: DiffLineTarget) => {
    setActiveLine((current) =>
      current?.flatIndex === target.flatIndex &&
      current.contextSide === target.contextSide &&
      current.top === target.top
        ? current
        : target,
    );
  }, []);

  const resolveActiveLine = useCallback(() => {
    if (!activeLine) return null;
    const nodes = container.querySelectorAll<HTMLElement>(
      `[data-diff-line="${activeLine.flatIndex}"]`,
    );
    const node =
      Array.from(nodes).find(
        (candidate) =>
          diffNodeContextSide(candidate) === activeLine.contextSide,
      ) ?? nodes[0];
    return node
      ? resolveDiffLineTarget(container, node, structuredPatch)
      : null;
  }, [activeLine, container, structuredPatch]);

  useLayoutEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (consumeLongPressClick()) return;
      if (!(window.getSelection()?.isCollapsed ?? true)) return;
      const resolved = resolveLineTarget(event.target);
      if (resolved) onOpenComment(resolved);
    };
    const onContextMenu = (event: MouseEvent) => {
      const resolved = resolveLineTarget(event.target);
      if (!resolved) return;
      event.preventDefault();
      event.stopPropagation();
      activateLine(resolved.target);
      onOpenMenu(resolved, { x: event.clientX, y: event.clientY });
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const resolved = resolveLineTarget(event.target);
      if (!resolved) return;
      activateLine(resolved.target);
      onBeginLongPress(resolved, event);
    };
    const onPointerMove = (event: globalThis.PointerEvent) => {
      onMoveLongPress(event);
      const resolved = resolveLineTarget(event.target);
      if (resolved) activateLine(resolved.target);
    };
    const onPointerEnd = () => onEndLongPress();
    const onPointerLeave = () => {
      onEndLongPress();
      setActiveLine(null);
    };
    const onFocusIn = (event: FocusEvent) => {
      const resolved = resolveLineTarget(event.target);
      if (resolved) activateLine(resolved.target);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const resolved = resolveLineTarget(event.target);
      if (!resolved) return;
      if (
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")
      ) {
        event.preventDefault();
        event.stopPropagation();
        const rect = resolved.node.getBoundingClientRect();
        onOpenMenu(resolved, {
          x: rect.left + Math.min(32, rect.width / 2),
          y: rect.bottom,
        });
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpenComment(resolved);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const nodes = Array.from(
        container.querySelectorAll<HTMLElement>("[data-diff-line]"),
      );
      const index = nodes.indexOf(resolved.node);
      const next = nodes[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      next.focus();
    };

    container.addEventListener("click", onClick);
    container.addEventListener("contextmenu", onContextMenu);
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerEnd);
    container.addEventListener("pointercancel", onPointerEnd);
    container.addEventListener("pointerleave", onPointerLeave);
    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("click", onClick);
      container.removeEventListener("contextmenu", onContextMenu);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerEnd);
      container.removeEventListener("pointercancel", onPointerEnd);
      container.removeEventListener("pointerleave", onPointerLeave);
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("keydown", onKeyDown);
    };
  }, [
    activateLine,
    consumeLongPressClick,
    container,
    onBeginLongPress,
    onEndLongPress,
    onMoveLongPress,
    onOpenComment,
    onOpenMenu,
    resolveLineTarget,
  ]);

  useLayoutEffect(() => {
    const pendingKeys = new Set(
      pending.map((comment) => anchorTintKey(comment.anchor)),
    );
    const decorate = () => {
      const nodes = container.querySelectorAll<HTMLElement>("[data-diff-line]");
      for (const node of nodes) {
        const resolved = resolveDiffLineTarget(
          container,
          node,
          structuredPatch,
        );
        const revision = resolved
          ? revisions?.[resolved.location.side]
          : undefined;
        node.toggleAttribute(
          "data-has-review-comment",
          !!resolved &&
            pendingKeys.has(locationTintKey(resolved.location, revision)),
        );
        node.tabIndex = 0;
        node.setAttribute("aria-label", t("sourceDiffLineActions"));
      }
    };
    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [container, pending, revisions, structuredPatch, t]);

  return { activeLine, resolveActiveLine };
}

function resolveDiffLineTarget(
  container: HTMLElement,
  node: HTMLElement,
  structuredPatch: PatchHunk[],
): ResolvedDiffLineTarget | null {
  const flatIndex = Number(node.getAttribute("data-diff-line"));
  const contextSide = diffNodeContextSide(node);
  const location = anchorFromPatch(
    structuredPatch,
    flatIndex,
    undefined,
    contextSide,
  );
  if (!location) return null;
  const nodeRect = node.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return {
    node,
    target: {
      flatIndex,
      contextSide,
      top: nodeRect.top - containerRect.top + container.scrollTop,
    },
    location,
  };
}

function diffNodeContextSide(node: HTMLElement): ReviewCommentSide {
  return node.closest("[data-diff-col]")?.getAttribute("data-diff-col") ===
    "old"
    ? "old"
    : "new";
}

function revisionTintKey(revision: ReviewCommentRevision | undefined): string {
  return revision?.kind === "sha" ? `sha:${revision.sha}` : "uncommitted";
}

function locationTintKey(
  location: Pick<ReviewCommentAnchor, "side" | "oldLine" | "newLine">,
  revision: ReviewCommentRevision | undefined,
): string {
  return `${revisionTintKey(revision)}:${location.side}:${location.oldLine}:${location.newLine}`;
}

function anchorTintKey(anchor: ReviewCommentAnchor): string {
  return locationTintKey(anchor, anchor.revision);
}
