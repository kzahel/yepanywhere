import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { QUOTE_SELECTION_ROOT_ATTRIBUTES } from "../../lib/markdownSelectionCopy";
import { programmaticFocus } from "../../lib/programmaticFocus";
import { IconButton } from "./Button";
import { computePopoverPosition } from "./Popover";

const ANCHORED_MODAL_MARGIN_PX = 8;
const ANCHORED_MODAL_MIN_VIEWPORT_WIDTH_PX = 600;
let modalHistoryEntrySequence = 0;
let modalBackspaceOwnerSequence = 0;
let modalLayerOwnerSequence = 0;
const modalBackspaceOwners: Array<{
  id: number;
  close: () => void;
}> = [];
const modalLayerOwners: Array<{
  id: number;
  close: (event: KeyboardEvent) => boolean | undefined;
}> = [];
let bodyScrollOwners = 0;
let bodyOverflowBeforeModal: string | null = null;

export interface ModalAnchorRect {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

interface ModalProps {
  title: ReactNode;
  /** An editor can take focus in its mounting commit without a later close-button focus. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  actions?: ReactNode;
  headerActionsClassName?: string;
  headerClassName?: string;
  children: ReactNode;
  onClose: () => void;
  onMinimize?: () => void;
  minimized?: boolean;
  anchorRect?: ModalAnchorRect | null;
  anchorAtAnyWidth?: boolean;
  variant?: "image-viewer";
  contentRef?: RefObject<HTMLDivElement | null>;
  /**
   * When true, opening pushes a history entry so a browser "back" — the mobile
   * OS back-swipe — dismisses the modal, keeping history balanced. Used by the
   * mobile-only diff/blame viewers so a back-swipe closes them
   * (topic: source-review-to-session).
   */
  closeOnBackGesture?: boolean;
  /** Close only the topmost opted-in modal when Backspace is not editing text. */
  closeOnBackspace?: boolean;
  /**
   * Below the scrolling content, outside it: Dialog's action row. A form's
   * submit button there names its form with the `form` attribute.
   */
  footer?: ReactNode;
  /** `alertdialog` for a confirmation that interrupts (ConfirmDialog). */
  role?: "dialog" | "alertdialog";
  /** Id of the element describing the dialog (Dialog's description). */
  describedBy?: string;
  /** Size and placement classes on the dialog box and overlay (Dialog). */
  className?: string;
  overlayClassName?: string;
}

const TABBABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),iframe,summary,[contenteditable]:not([contenteditable="false"]),[tabindex]';

function tabbablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.closest("[inert],[hidden]") &&
      (typeof element.checkVisibility !== "function" ||
        element.checkVisibility()),
  );
}

/** Open, unminimized modal boxes, the topmost last. */
const openModalBoxes: HTMLElement[] = [];

/**
 * Tab while focus is on nothing (the focused control was removed or
 * disabled) or outside every modal box goes back into the topmost box,
 * rather than into the page behind it. Focus inside another modal surface
 * (the source editor, a goal panel) is that surface's own.
 */
function handleStrayTab(event: KeyboardEvent) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const top = openModalBoxes.at(-1);
  const active = document.activeElement;
  if (!top || (active && top.contains(active))) return;
  if (active && active !== document.body && active.closest("[aria-modal]"))
    return;
  const stops = tabbablesIn(top);
  const target = event.shiftKey ? stops.at(-1) : stops[0];
  if (!target) return;
  event.preventDefault();
  target.focus();
}

function trackModalBox(box: HTMLElement): () => void {
  if (openModalBoxes.length === 0)
    document.addEventListener("keydown", handleStrayTab);
  openModalBoxes.push(box);
  return () => {
    const index = openModalBoxes.lastIndexOf(box);
    if (index >= 0) openModalBoxes.splice(index, 1);
    if (openModalBoxes.length === 0)
      document.removeEventListener("keydown", handleStrayTab);
  };
}

/**
 * Keep Tab inside the dialog: from its last tabbable stop to its first and
 * back. Keys from a nested dialog (portaled elsewhere, bubbling through
 * React) are that dialog's own.
 */
function containTab(event: React.KeyboardEvent, root: HTMLElement | null) {
  if (event.key !== "Tab" || event.defaultPrevented || !root) return;
  if (!(event.target instanceof Node) || !root.contains(event.target)) return;
  const stops = tabbablesIn(root);
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function isEditableBackspaceTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
    ),
  );
}

function handleModalBackspace(event: KeyboardEvent): void {
  if (
    event.key !== "Backspace" ||
    event.repeat ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableBackspaceTarget(event.target)
  ) {
    return;
  }
  const owner = latestModalOwner(modalBackspaceOwners);
  if (!owner) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  owner.close();
}

function handleModalEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  const owner = latestModalOwner(modalLayerOwners);
  if (!owner) return;
  // A layer that declines (a popover whose field handles Escape itself)
  // lets the key reach its target and closes nothing beneath it.
  if (owner.close(event) === false) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function latestModalOwner<T extends { id: number }>(
  owners: readonly T[],
): T | undefined {
  let latest: T | undefined;
  for (const owner of owners) {
    if (!latest || owner.id > latest.id) latest = owner;
  }
  return latest;
}

/**
 * Own topmost Escape dismissal and one share of the document scroll lock.
 * A control layered inside a viewer, such as its find field or a popover,
 * can take the Escape slot without the scroll lock (`lockScroll: false`).
 * `onClose` returning `false` declines this Escape: nothing closes and the
 * key reaches its target.
 */
export function useModalLayer(
  // biome-ignore lint/suspicious/noConfusingVoidType: callers pass plain () => void closers
  onClose: (event: KeyboardEvent) => boolean | void,
  enabled = true,
  { lockScroll = true }: { lockScroll?: boolean } = {},
): void {
  const onCloseRef = useRef(onClose);
  const ownerIdRef = useRef<number | null>(null);
  onCloseRef.current = onClose;
  // The place in the Escape order is taken when the layer opens, not when
  // its component mounts: a menu mounted early but opened later is on top.
  // Taken during render, so a parent opening with its child stays below it.
  if (enabled && ownerIdRef.current === null) {
    modalLayerOwnerSequence += 1;
    ownerIdRef.current = modalLayerOwnerSequence;
  } else if (!enabled) {
    ownerIdRef.current = null;
  }

  useEffect(() => {
    if (!enabled) return;
    const ownerId = ownerIdRef.current;
    if (ownerId === null) return;
    const owner = {
      id: ownerId,
      close: (event: KeyboardEvent) =>
        onCloseRef.current(event) === false ? false : undefined,
    };
    const needsEscapeListener = modalLayerOwners.length === 0;
    modalLayerOwners.push(owner);
    if (needsEscapeListener) {
      document.addEventListener("keydown", handleModalEscape, true);
    }
    if (lockScroll) {
      if (bodyScrollOwners === 0) {
        bodyOverflowBeforeModal = document.body.style.overflow;
        document.body.style.overflow = "hidden";
      }
      bodyScrollOwners += 1;
    }

    return () => {
      const ownerIndex = modalLayerOwners.findIndex(
        (candidate) => candidate.id === owner.id,
      );
      if (ownerIndex >= 0) modalLayerOwners.splice(ownerIndex, 1);
      if (modalLayerOwners.length === 0) {
        document.removeEventListener("keydown", handleModalEscape, true);
      }
      if (!lockScroll) return;
      bodyScrollOwners -= 1;
      if (bodyScrollOwners === 0) {
        document.body.style.overflow = bodyOverflowBeforeModal ?? "";
        bodyOverflowBeforeModal = null;
      }
    };
  }, [enabled, lockScroll]);
}

/** Own the topmost Backspace dismissal slot while a viewer is visible. */
export function useModalBackspace(onClose: () => void, enabled = true): void {
  const onCloseRef = useRef(onClose);
  const ownerIdRef = useRef<number | null>(null);
  onCloseRef.current = onClose;
  if (ownerIdRef.current === null) {
    modalBackspaceOwnerSequence += 1;
    ownerIdRef.current = modalBackspaceOwnerSequence;
  }

  useEffect(() => {
    if (!enabled) return;
    const ownerId = ownerIdRef.current;
    if (ownerId === null) return;
    const owner = {
      id: ownerId,
      close: () => onCloseRef.current(),
    };
    const needsListener = modalBackspaceOwners.length === 0;
    modalBackspaceOwners.push(owner);
    if (needsListener) {
      document.addEventListener("keydown", handleModalBackspace, true);
    }
    return () => {
      const ownerIndex = modalBackspaceOwners.findIndex(
        (candidate) => candidate.id === owner.id,
      );
      if (ownerIndex >= 0) modalBackspaceOwners.splice(ownerIndex, 1);
      if (modalBackspaceOwners.length === 0) {
        document.removeEventListener("keydown", handleModalBackspace, true);
      }
    };
  }, [enabled]);
}

function getHistoryState(): Record<string, unknown> {
  return window.history.state &&
    typeof window.history.state === "object" &&
    !Array.isArray(window.history.state)
    ? window.history.state
    : {};
}

/**
 * Own one same-URL history entry while a modal is open.
 *
 * Cleanup is deferred by a microtask so React Strict Mode's development-only
 * effect replay can cancel it during the immediate re-setup. A real unmount
 * still removes the entry, while a browser Back that already popped it only
 * closes the modal.
 *
 * Ownership is the pushed entry's id *and* the address it was pushed at. A
 * navigation away while the modal is open pushes a new entry that can inherit
 * the previous entry's state object, id included; without the address check
 * the unmounting modal would read that new entry as its own and send the
 * browser Back off the page the navigation just opened.
 */
export function useModalBackGesture(
  onClose: () => void,
  enabled = true,
  stateKey = "yaModal",
) {
  const onCloseRef = useRef(onClose);
  const ownsHistoryEntryRef = useRef(false);
  const cleanupGenerationRef = useRef(0);
  const historyEntryIdRef = useRef<string | null>(null);
  const historyEntryHrefRef = useRef<string | null>(null);
  onCloseRef.current = onClose;
  if (historyEntryIdRef.current === null) {
    modalHistoryEntrySequence += 1;
    historyEntryIdRef.current = `${stateKey}-${modalHistoryEntrySequence}`;
  }

  useEffect(() => {
    if (!enabled) return;

    cleanupGenerationRef.current += 1;
    const historyEntryId = historyEntryIdRef.current;
    if (!ownsHistoryEntryRef.current) {
      window.history.pushState(
        { ...getHistoryState(), [stateKey]: historyEntryId },
        "",
      );
      historyEntryHrefRef.current = window.location.href;
      ownsHistoryEntryRef.current = true;
    }

    const ownsCurrentEntry = () =>
      window.history.state?.[stateKey] === historyEntryId &&
      window.location.href === historyEntryHrefRef.current;

    const onPopState = () => {
      if (ownsCurrentEntry()) {
        return;
      }
      ownsHistoryEntryRef.current = false;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      const cleanupGeneration = cleanupGenerationRef.current + 1;
      cleanupGenerationRef.current = cleanupGeneration;
      queueMicrotask(() => {
        if (
          cleanupGenerationRef.current !== cleanupGeneration ||
          !ownsHistoryEntryRef.current
        ) {
          return;
        }
        ownsHistoryEntryRef.current = false;
        if (ownsCurrentEntry()) {
          window.history.back();
        }
      });
    };
  }, [enabled, stateKey]);
}

/**
 * Modal header and content: title, the caller's actions, minimize and close,
 * then the scrolling content. The covering modal and the session detail panel
 * docked in the right pane both render it, so a panel looks the same in either.
 */
export function ModalChrome({
  title,
  actions,
  headerClassName,
  identityClassName,
  headerActionsClassName,
  onMinimize,
  onClose,
  closeButtonRef,
  contentRef,
  titleId,
  footer,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  headerClassName?: string;
  /** Wraps the title, for a header layout that gives it a column of its own. */
  identityClassName?: string;
  headerActionsClassName?: string;
  onMinimize?: () => void;
  onClose: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
  contentRef?: RefObject<HTMLDivElement | null>;
  titleId?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const titleElement = (
    <span className="modal-title" id={titleId}>
      {title}
    </span>
  );
  return (
    <>
      <div
        className={`modal-header${headerClassName ? ` ${headerClassName}` : ""}`}
      >
        {identityClassName ? (
          <span className={identityClassName}>{titleElement}</span>
        ) : (
          titleElement
        )}
        <span
          className={`modal-header-actions${
            headerActionsClassName ? ` ${headerActionsClassName}` : ""
          }`}
          style={
            headerActionsClassName
              ? undefined
              : {
                  display: "flex",
                  alignItems: "center",
                  gap: "0.375rem",
                  marginLeft: "auto",
                  flexShrink: 0,
                }
          }
        >
          {actions}
          {onMinimize && (
            <IconButton
              variant="ghost"
              size="small"
              className="modal-close"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onMinimize();
              }}
              label={t("modalMinimize")}
            >
              −
            </IconButton>
          )}
          <IconButton
            variant="ghost"
            size="small"
            ref={closeButtonRef}
            className="modal-close"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
            label={t("modalClose")}
          >
            ×
          </IconButton>
        </span>
      </div>
      <div className="modal-content" ref={contentRef}>
        {children}
      </div>
      {footer}
    </>
  );
}

/**
 * Reusable modal component with overlay, header, and scrollable content area.
 * Renders via portal to avoid event bubbling issues.
 * Closes on Escape key or clicking the overlay.
 *
 * It stays a portaled `div` rather than a `<dialog>` in the top layer: the
 * tooltip layer, hover cards and selection actions portal into the body,
 * and a modal `<dialog>` would draw over them and make them inert. Instead
 * the box keeps Tab inside itself, is named by its title, and returns focus
 * to the element that opened it when it closes. Forms and confirmations use
 * Dialog (title, description, body, footer) on top of it.
 */
export function Modal({
  title,
  initialFocusRef,
  actions,
  headerActionsClassName,
  headerClassName,
  children,
  onClose,
  onMinimize,
  minimized = false,
  anchorRect,
  anchorAtAnyWidth = false,
  closeOnBackGesture,
  closeOnBackspace,
  contentRef,
  variant,
  footer,
  role = "dialog",
  describedBy,
  className,
  overlayClassName,
}: ModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Taken while rendering the opening commit, before an autofocused field
  // inside the box moves focus.
  const [openerAtRender] = useState(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );
  const openerRef = useRef(openerAtRender);
  const overlayPointerStartedOnOverlayRef = useRef(false);
  useModalBackGesture(onClose, Boolean(closeOnBackGesture && !minimized));
  useModalBackspace(onClose, Boolean(closeOnBackspace && !minimized));
  useModalLayer(onClose, !minimized);
  const isAnchored =
    !!anchorRect &&
    typeof window !== "undefined" &&
    (anchorAtAnyWidth ||
      window.innerWidth > ANCHORED_MODAL_MIN_VIEWPORT_WIDTH_PX);
  const [anchorStyle, setAnchorStyle] = useState<CSSProperties | null>(null);

  // Focus the close button on mount for accessibility. A modal that opens
  // by itself while the user is in an embedded app leaves its focus alone.
  useEffect(() => {
    if (minimized) return;
    // A menu item that opened the dialog unmounts with its menu, whose
    // focus return has run by now: the menu's trigger is the opener.
    const active = document.activeElement;
    if (
      !openerRef.current?.isConnected &&
      active &&
      !modalRef.current?.contains(active)
    )
      openerRef.current = active;
    const opener = openerRef.current;
    const untrack = modalRef.current
      ? trackModalBox(modalRef.current)
      : undefined;
    programmaticFocus(initialFocusRef?.current ?? closeButtonRef.current);
    return () => {
      untrack?.();
      // Back to the opener, unless focus already moved somewhere on purpose
      // (it is on the body once the focused box is gone or hidden).
      const active = document.activeElement;
      if (
        opener instanceof HTMLElement &&
        opener !== document.body &&
        opener.isConnected &&
        (!active ||
          active === document.body ||
          modalRef.current?.contains(active))
      )
        programmaticFocus(opener, { preventScroll: true });
    };
  }, [minimized, initialFocusRef]);

  useLayoutEffect(() => {
    if (!isAnchored || !anchorRect) {
      setAnchorStyle(null);
      return;
    }

    const updateAnchorPosition = () => {
      const modal = modalRef.current;
      if (!modal) return;

      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight =
        window.visualViewport?.height ?? window.innerHeight;
      // Below the anchor, right edges aligned; above when there is more room.
      const height = Math.min(
        modal.offsetHeight,
        viewportHeight - ANCHORED_MODAL_MARGIN_PX * 2,
      );
      const position = computePopoverPosition({
        anchor: anchorRect,
        size: {
          width: Math.min(
            modal.offsetWidth,
            viewportWidth - ANCHORED_MODAL_MARGIN_PX * 2,
          ),
          height,
        },
        viewport: { width: viewportWidth, height: viewportHeight },
        placement: "bottom-end",
        offset: ANCHORED_MODAL_MARGIN_PX,
      });
      // The whole dialog stays on screen, over its anchor if it must.
      const top = Math.max(
        ANCHORED_MODAL_MARGIN_PX,
        Math.min(
          position.top,
          viewportHeight - height - ANCHORED_MODAL_MARGIN_PX,
        ),
      );

      setAnchorStyle({
        left: position.left,
        maxHeight: viewportHeight - ANCHORED_MODAL_MARGIN_PX * 2,
        top,
        visibility: "visible",
      });
    };

    updateAnchorPosition();
    window.addEventListener("resize", updateAnchorPosition);
    window.visualViewport?.addEventListener("resize", updateAnchorPosition);
    return () => {
      window.removeEventListener("resize", updateAnchorPosition);
      window.visualViewport?.removeEventListener(
        "resize",
        updateAnchorPosition,
      );
    };
  }, [anchorRect, isAnchored]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    // Only close if the whole click started and ended on the overlay.
    // Text selection can start inside the dialog and release outside it.
    if (
      e.target === e.currentTarget &&
      overlayPointerStartedOnOverlayRef.current
    ) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    overlayPointerStartedOnOverlayRef.current = false;
  };

  const handleModalClick = (e: React.MouseEvent) => {
    // Stop propagation to prevent overlay click handler
    e.stopPropagation();
  };

  const modalContent = (
    <div
      className={`modal-overlay${isAnchored ? " modal-overlay--anchored" : ""}${
        variant ? ` modal-overlay--${variant}` : ""
      }${overlayClassName ? ` ${overlayClassName}` : ""}`}
      aria-hidden={minimized || undefined}
      style={minimized ? { display: "none" } : undefined}
      onClick={handleOverlayClick}
      onMouseDown={(e) => {
        overlayPointerStartedOnOverlayRef.current =
          e.target === e.currentTarget;
        e.stopPropagation();
      }}
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is dialog or alertdialog, both modal */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the dialog box keeps Tab inside itself */}
      <div
        ref={modalRef}
        className={`modal${isAnchored ? " modal--anchored" : ""}${
          variant ? ` modal--${variant}` : ""
        }${className ? ` ${className}` : ""}`}
        {...QUOTE_SELECTION_ROOT_ATTRIBUTES}
        role={role === "alertdialog" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        onClick={handleModalClick}
        onKeyDown={(event) => containTab(event, modalRef.current)}
        style={
          isAnchored ? (anchorStyle ?? { visibility: "hidden" }) : undefined
        }
      >
        <ModalChrome
          title={title}
          actions={actions}
          headerClassName={headerClassName}
          headerActionsClassName={headerActionsClassName}
          onMinimize={onMinimize}
          onClose={onClose}
          closeButtonRef={closeButtonRef}
          contentRef={contentRef}
          titleId={titleId}
          footer={footer}
        >
          {children}
        </ModalChrome>
      </div>
    </div>
  );

  // Use portal to render at document body level
  return createPortal(modalContent, document.body);
}
