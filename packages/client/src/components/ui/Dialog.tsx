/**
 * The shared dialog pattern (plan 182, family 7; topics/ui-design.md,
 * "Dialogs").
 *
 * A form, choice or confirmation over the page, on top of Modal (which
 * owns the overlay, Escape, Android back, the focus trap and focus
 * return). Dialog adds what every such box repeats: a width from `size`,
 * a padded body that stacks its children, an optional `description` that
 * names what the dialog is about (`aria-describedby`), and a `footer`
 * action row below the scrolling body.
 *
 * The footer applies the button variant rule: at most one `primary`
 * action, last (right-most); Cancel is the default `secondary` and comes
 * before it; a destructive confirmation is `danger` instead of primary.
 * `footerStart` holds an action that belongs at the other end (Back,
 * Skip, a link). A form's submit button in the footer names the form with
 * the `form` attribute, so Enter in a field still submits it.
 *
 * Sizes: `small` (24rem) for a confirmation or one field, `medium` (32rem)
 * for a short form, `large` (48rem) for a long form or a list. On phones
 * every size is a full-width card near the top, as tall as its content
 * (clear of the keyboard); content that needs the whole screen sets its
 * own height.
 *
 * Viewers (files, diffs, media, logs) stay on Modal itself.
 */
import { type ReactNode, type RefObject, useId } from "react";
import styles from "./Dialog.module.css";
import { Modal, type ModalAnchorRect } from "./Modal";

export type DialogSize = "small" | "medium" | "large";

export interface DialogProps {
  title: ReactNode;
  /** A sentence under the title that says what the dialog is about. */
  description?: ReactNode;
  children?: ReactNode;
  /** The action row: Cancel (secondary) first, the one primary last. */
  footer?: ReactNode;
  /** Actions at the start of the footer (Back, Skip). */
  footerStart?: ReactNode;
  size?: DialogSize;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Header actions beside the close button. */
  headerActions?: ReactNode;
  closeOnBackGesture?: boolean;
  closeOnBackspace?: boolean;
  role?: "dialog" | "alertdialog";
  /** No body padding or gap, for a list or editor that fills the body. */
  flush?: boolean;
  /** Layout of the body (a grid, a gap); not its look. */
  bodyClassName?: string;
  contentRef?: RefObject<HTMLDivElement | null>;
  /** Open beside this rectangle on wide screens (a share button's menu). */
  anchorRect?: ModalAnchorRect | null;
  anchorAtAnyWidth?: boolean;
  /**
   * `confirm` draws above every full-screen surface (the source editor),
   * for a question one of them asks (ConfirmDialog).
   */
  layer?: "modal" | "confirm";
  "data-testid"?: string;
}

const SIZE_CLASS: Record<DialogSize, string | undefined> = {
  small: styles.small,
  medium: styles.medium,
  large: styles.large,
};

export function Dialog({
  title,
  description,
  children,
  footer,
  footerStart,
  size = "medium",
  onClose,
  initialFocusRef,
  headerActions,
  closeOnBackGesture,
  closeOnBackspace,
  role,
  flush = false,
  bodyClassName,
  contentRef,
  anchorRect,
  anchorAtAnyWidth,
  layer = "modal",
  "data-testid": testId,
}: DialogProps) {
  const descriptionId = useId();
  const hasFooter = Boolean(footer || footerStart);
  return (
    <Modal
      title={title}
      onClose={onClose}
      initialFocusRef={initialFocusRef}
      actions={headerActions}
      closeOnBackGesture={closeOnBackGesture}
      closeOnBackspace={closeOnBackspace}
      role={role}
      describedBy={description ? descriptionId : undefined}
      className={[styles.dialog, SIZE_CLASS[size]].filter(Boolean).join(" ")}
      overlayClassName={[
        styles.cardOverlay,
        layer === "confirm" && styles.confirmLayer,
      ]
        .filter(Boolean)
        .join(" ")}
      contentRef={contentRef}
      anchorRect={anchorRect}
      anchorAtAnyWidth={anchorAtAnyWidth}
      footer={
        hasFooter ? (
          <div className={styles.footer}>
            {footerStart ? (
              <div className={styles.footerStart}>{footerStart}</div>
            ) : null}
            {footer}
          </div>
        ) : null
      }
    >
      <div
        className={[styles.body, flush && styles.flush, bodyClassName]
          .filter(Boolean)
          .join(" ")}
        data-testid={testId}
      >
        {description ? (
          <p id={descriptionId} className={styles.description}>
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </Modal>
  );
}
