import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import {
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import {
  SelectionActionButton,
  SelectionActionCluster,
  type SelectionActionKind,
} from "../components/ui/SelectionActionCluster";
import type { CommentAnchor } from "../lib/commentAnchors";
import { writeClipboardRichText, writeClipboardText } from "../lib/clipboard";
import { getSemanticHtmlClipboardPayload } from "../lib/semanticHtmlClipboard";
import { getSelectionPlainText } from "../lib/selectionClipboard";
import { SESSION_FILE_COMMENT_MODE_ATTR } from "../lib/sessionFileComments";
import { useI18n } from "../i18n";
import {
  pointIntersectsSelection,
  type SelectionActionSnapshot,
  selectionContextMenuBelongsToBrowser,
  useSelectionActionCapture,
} from "./useSelectionActionCapture";
import { useSelectionActionPreferences } from "./useSelectionActionPreferences";

interface UseSelectionActionPresentationOptions {
  applyQuoteAnchors: (
    anchors: readonly CommentAnchor[],
    typedPrefix?: string,
  ) => boolean;
  applyQuoteFromSelection: (typedPrefix?: string) => boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  inert: boolean;
  isInteractiveTarget: (target: EventTarget | null) => boolean;
  onQuoteSelection?: (quotedText: string) => string | null;
  onStartNewSessionFromSelection?: (prefill: string) => void;
}

export interface SelectionActionPresentation {
  dismiss: () => void;
  floatingSelectionActions: ReactNode;
  mobileSelectionActions: ReactNode;
  selectionContextMenu: ReactNode;
}

interface EnabledSelectionAction {
  kind: SelectionActionKind;
  label: string;
}

function selectionUsesSessionFileCommentMode(
  snapshot: SelectionActionSnapshot,
): boolean {
  return snapshot.snippets.some(
    (snippet) =>
      snippet.sourceElement.closest(
        `[${SESSION_FILE_COMMENT_MODE_ATTR}="true"]`,
      ) !== null,
  );
}

function selectionText(snapshot: SelectionActionSnapshot): string {
  return getSelectionPlainText(snapshot.snippets);
}

function selectionSource(snapshot: SelectionActionSnapshot): string {
  return snapshot.snippets.map((snippet) => snippet.markdown).join("\n\n");
}

function selectionHasMarkdownFormatting(
  snapshot: SelectionActionSnapshot,
): boolean {
  return snapshot.snippets.some(
    (snippet) =>
      !snippet.isLiteral && snippet.markdown !== snippet.selectedText,
  );
}

function selectionQuote(snapshot: SelectionActionSnapshot): string {
  return snapshot.anchors.map((anchor) => anchor.quotedText).join("\n\n");
}

function selectionLocationLabel(
  snapshot: SelectionActionSnapshot,
): string | null {
  const locations = snapshot.snippets.map((snippet) => snippet.sourceLocation);
  if (locations.some((location) => location === undefined)) {
    return null;
  }
  const first = locations[0];
  if (
    !first ||
    locations.some(
      (location) =>
        location?.projectId !== first.projectId ||
        location.filePath !== first.filePath,
    )
  ) {
    return null;
  }
  const lineStart = Math.min(
    ...locations.map((location) => location?.lineStart ?? first.lineStart),
  );
  const lineEnd = Math.max(
    ...locations.map((location) => location?.lineEnd ?? first.lineEnd),
  );
  return `${first.filePath}:${lineStart}${lineEnd > lineStart ? `-${lineEnd}` : ""}`;
}

function newSessionSelectionPrefill(snapshot: SelectionActionSnapshot): string {
  const quote = selectionQuote(snapshot);
  const location = selectionLocationLabel(snapshot);
  return location ? `${location}\n\n${quote}` : quote;
}

export function useSelectionActionPresentation({
  applyQuoteAnchors,
  applyQuoteFromSelection,
  containerRef,
  inert,
  isInteractiveTarget,
  onQuoteSelection,
  onStartNewSessionFromSelection,
}: UseSelectionActionPresentationOptions): SelectionActionPresentation {
  const selectionActionPointerAppliedRef = useRef<SelectionActionKind | null>(
    null,
  );
  const {
    selectionQuoteActionEnabled,
    selectionTextCopyActionEnabled,
    selectionSourceCopyActionEnabled,
    selectionRichCopyActionEnabled,
    selectionNewSessionActionEnabled,
  } = useSelectionActionPreferences();
  const { t } = useI18n();
  const { menu: selectionContextMenu, openAt: openSelectionContextMenuAt } =
    useSourceContextMenu(t, {
      menu: t("sessionSelectionActionMenu" as never),
    });

  const enabledSelectionActions = useMemo(() => {
    const actions: EnabledSelectionAction[] = [];
    if (selectionTextCopyActionEnabled) {
      actions.push({
        kind: "text",
        label: t("sessionCopySelectionText" as never),
      });
    }
    if (selectionSourceCopyActionEnabled) {
      actions.push({
        kind: "source",
        label: t("sessionCopySelectionSource"),
      });
    }
    if (selectionRichCopyActionEnabled) {
      actions.push({
        kind: "rich",
        label: t("sessionCopySelectionRich"),
      });
    }
    if (selectionQuoteActionEnabled && onQuoteSelection) {
      actions.push({
        kind: "quote",
        label: t("sessionQuoteSelection"),
      });
    }
    if (selectionNewSessionActionEnabled && onStartNewSessionFromSelection) {
      actions.push({
        kind: "newSession",
        label: t("sessionNewSessionFromSelection" as never),
      });
    }
    return actions;
  }, [
    onQuoteSelection,
    onStartNewSessionFromSelection,
    selectionNewSessionActionEnabled,
    selectionQuoteActionEnabled,
    selectionRichCopyActionEnabled,
    selectionSourceCopyActionEnabled,
    selectionTextCopyActionEnabled,
    t,
  ]);

  const actionsForSnapshot = useCallback(
    (snapshot: SelectionActionSnapshot) => {
      const hasMarkdown = selectionHasMarkdownFormatting(snapshot);
      const fileCommentMode = selectionUsesSessionFileCommentMode(snapshot);
      return enabledSelectionActions.filter(
        (action) =>
          (action.kind !== "source" || hasMarkdown) &&
          (action.kind !== "quote" || !fileCommentMode),
      );
    },
    [enabledSelectionActions],
  );
  const actionCountForSnapshot = useCallback(
    (snapshot: SelectionActionSnapshot) => actionsForSnapshot(snapshot).length,
    [actionsForSnapshot],
  );

  const capture = useSelectionActionCapture({
    actionCount: enabledSelectionActions.length,
    getActionCount: actionCountForSnapshot,
    containerRef,
    inert,
    isInteractiveTarget,
  });

  useEffect(() => {
    if (inert || !onQuoteSelection || !selectionQuoteActionEnabled) return;
    const handleSelectionTyping = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.key.length !== 1 ||
        isInteractiveTarget(event.target)
      ) {
        return;
      }
      const snapshot = capture.captureSnapshot();
      if (snapshot && selectionUsesSessionFileCommentMode(snapshot)) return;
      if (!applyQuoteFromSelection(event.key)) return;
      capture.dismiss();
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleSelectionTyping, true);
    return () =>
      window.removeEventListener("keydown", handleSelectionTyping, true);
  }, [
    applyQuoteFromSelection,
    capture.captureSnapshot,
    capture.dismiss,
    inert,
    isInteractiveTarget,
    onQuoteSelection,
    selectionQuoteActionEnabled,
  ]);

  const activateSelectionAction = useCallback(
    (kind: SelectionActionKind, snapshot: SelectionActionSnapshot): boolean => {
      if (kind === "text") {
        const text = selectionText(snapshot);
        if (!text) return false;
        void writeClipboardText(text);
        return true;
      }
      if (kind === "quote") {
        const applied = applyQuoteAnchors(snapshot.anchors);
        if (applied) capture.dismiss();
        return applied;
      }
      if (kind === "source") {
        const source = selectionSource(snapshot);
        if (!source) return false;
        void writeClipboardText(source);
        return true;
      }
      if (kind === "newSession") {
        if (!onStartNewSessionFromSelection) return false;
        onStartNewSessionFromSelection(newSessionSelectionPrefill(snapshot));
        return true;
      }

      const payload = getSemanticHtmlClipboardPayload(
        snapshot.root,
        snapshot.ranges,
      );
      if (!payload) return false;
      void writeClipboardRichText(payload.html, payload.text);
      return true;
    },
    [applyQuoteAnchors, capture.dismiss, onStartNewSessionFromSelection],
  );

  const selectionContextMenuActions = useCallback(
    (snapshot: SelectionActionSnapshot): SourceContextMenuAction[] => {
      const actions: SourceContextMenuAction[] = [
        {
          label: t("sessionCopySelectionText" as never),
          onSelect: () => {
            activateSelectionAction("text", snapshot);
          },
        },
      ];
      if (selectionHasMarkdownFormatting(snapshot))
        actions.push({
          label: t("sessionCopySelectionSource" as never),
          onSelect: () => {
            activateSelectionAction("source", snapshot);
          },
        });
      if (onQuoteSelection && !selectionUsesSessionFileCommentMode(snapshot)) {
        actions.push({
          label: t("sessionQuoteSelection" as never),
          onSelect: () => {
            activateSelectionAction("quote", snapshot);
          },
        });
      }
      if (onStartNewSessionFromSelection) {
        actions.push({
          label: t("sessionNewSessionFromSelection" as never),
          onSelect: () => {
            activateSelectionAction("newSession", snapshot);
          },
        });
      }
      return actions;
    },
    [
      activateSelectionAction,
      onQuoteSelection,
      onStartNewSessionFromSelection,
      t,
    ],
  );

  useEffect(() => {
    if (inert) return;
    const root = containerRef.current;
    const doc = root?.ownerDocument;
    if (!root || !doc) return;
    const win = doc.defaultView ?? window;

    const handleContextMenu = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        isInteractiveTarget(event.target) ||
        selectionContextMenuBelongsToBrowser(event, win)
      ) {
        return;
      }
      const snapshot = capture.captureSnapshot();
      if (
        !snapshot ||
        !pointIntersectsSelection(snapshot, event.clientX, event.clientY)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openSelectionContextMenuAt(
        event.clientX,
        event.clientY,
        doc.activeElement instanceof HTMLElement ? doc.activeElement : null,
        selectionContextMenuActions(snapshot),
      );
    };

    doc.addEventListener("contextmenu", handleContextMenu);
    return () => doc.removeEventListener("contextmenu", handleContextMenu);
  }, [
    capture.captureSnapshot,
    containerRef,
    inert,
    isInteractiveTarget,
    openSelectionContextMenuAt,
    selectionContextMenuActions,
  ]);

  const selectionActions = capture.state;
  const selectionActionsAreInPortal =
    selectionActions !== null &&
    selectionActions.snapshot.root !== containerRef.current;
  const mobileSelectionActionsTarget =
    selectionActions?.docked && typeof document !== "undefined"
      ? document.querySelector<HTMLElement>(
          "[data-selection-actions-mobile-slot]",
        )
      : null;
  const selectionActionsAreDocked =
    selectionActions?.docked === true && mobileSelectionActionsTarget !== null;
  const selectionActionCluster = selectionActions ? (
    <SelectionActionCluster
      docked={selectionActionsAreDocked}
      mobile={selectionActions.mobile}
      placement={selectionActions.side}
      style={
        selectionActionsAreDocked
          ? undefined
          : {
              top: `${selectionActions.top}px`,
              left: `${selectionActions.left}px`,
            }
      }
    >
      {actionsForSnapshot(selectionActions.snapshot).map(({ kind, label }) => (
        <SelectionActionButton
          key={kind}
          kind={kind}
          label={label}
          onPointerDown={() => {
            selectionActionPointerAppliedRef.current = null;
          }}
          onPointerUp={(event) => {
            if (selectionActions.mobile) {
              event.preventDefault();
              if (activateSelectionAction(kind, selectionActions.snapshot)) {
                selectionActionPointerAppliedRef.current = kind;
              }
            }
          }}
          onClick={() => {
            if (selectionActionPointerAppliedRef.current === kind) {
              selectionActionPointerAppliedRef.current = null;
              return;
            }
            activateSelectionAction(kind, selectionActions.snapshot);
          }}
        />
      ))}
    </SelectionActionCluster>
  ) : null;

  const mobileSelectionActions =
    selectionActionsAreDocked && selectionActionCluster
      ? createPortal(selectionActionCluster, mobileSelectionActionsTarget)
      : null;
  const floatingSelectionActions =
    selectionActions && !selectionActionsAreDocked
      ? selectionActionsAreInPortal
        ? selectionActions.snapshot.root.isConnected
          ? createPortal(selectionActionCluster, selectionActions.snapshot.root)
          : null
        : selectionActionCluster
      : null;

  return {
    dismiss: capture.dismiss,
    floatingSelectionActions,
    mobileSelectionActions,
    selectionContextMenu,
  };
}
