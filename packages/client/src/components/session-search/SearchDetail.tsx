import { useEffect, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { Modal, ModalChrome, useModalLayer } from "../ui/Modal";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import styles from "./SearchDetail.module.css";

/** Search detail shares modal chrome in the optional right column. */
export function SearchDetail({
  paneTarget,
  ...props
}: ComponentProps<typeof Modal> & { paneTarget?: HTMLElement | null }) {
  const wide = useMediaQuery("(min-width: 1100px)");
  useModalLayer(props.onClose, !!paneTarget && !wide);
  useEffect(() => {
    if (!paneTarget) return;
    paneTarget.querySelector<HTMLButtonElement>("[data-modal-close]")?.focus();
  }, [paneTarget]);
  if (!paneTarget) return <Modal {...props} />;
  return createPortal(
    <section
      className={styles.panel}
      role="dialog"
      aria-label={typeof props.title === "string" ? props.title : undefined}
      onKeyDown={(event) => {
        if (wide && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <ModalChrome
        title={props.title}
        actions={props.actions}
        onClose={props.onClose}
        contentRef={props.contentRef}
      >
        {props.children}
      </ModalChrome>
    </section>,
    paneTarget,
  );
}
