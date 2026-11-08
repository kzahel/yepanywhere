import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import {
  ButtonBase,
  type ButtonBaseProps,
  IconButton,
} from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import styles from "./SettingsCollection.module.css";

/** A collection row's expand toggle: the row's name as one button. */
export function SettingsCollectionToggle({
  className,
  ...props
}: ButtonBaseProps) {
  return (
    <ButtonBase
      {...props}
      className={className ? `${styles.toggle} ${className}` : styles.toggle}
    />
  );
}

/**
 * Props that make a whole table row the click target for its expand toggle.
 * The row's `aria-expanded` button stays the keyboard and accessibility
 * control; a click anywhere else in the row does the same thing, except on
 * the row's own controls and at the end of a text selection.
 */
export function expandableRowProps(onToggle: () => void) {
  return {
    "data-expandable": "",
    onClick(event: MouseEvent<HTMLTableRowElement>) {
      const control = (event.target as Element).closest(
        "a, button, input, select, textarea, label, summary",
      );
      if (control && event.currentTarget.contains(control)) return;
      if (window.getSelection()?.toString()) return;
      onToggle();
    },
  };
}

/** A settings table with one selected item's options in a neighboring pane. */
export function SettingsCollection({
  children,
  selectedKey,
  title,
  detail,
  onClose,
  actions,
}: {
  children: ReactNode;
  selectedKey: string | number | null;
  title: string;
  detail: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const close = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (selectedKey === null) return;
    trigger.current = document.activeElement as HTMLElement | null;
    close.current?.focus();
  }, [selectedKey]);
  function dismiss() {
    onClose();
    requestAnimationFrame(() => trigger.current?.focus());
  }
  return (
    <div className={styles.root}>
      <div
        className={`${styles.collection} ${selectedKey !== null ? styles.open : ""}`}
      >
        <div className={styles.list}>{children}</div>
        {selectedKey !== null && (
          <section className={styles.detail} aria-labelledby={titleId}>
            <div className={styles.heading}>
              <h4 id={titleId}>{title}</h4>
              {actions}
              <IconButton
                ref={close}
                onClick={dismiss}
                label={t("settingsCollectionMinimize")}
              >
                <span aria-hidden="true">_</span>
              </IconButton>
            </div>
            {detail}
          </section>
        )}
      </div>
    </div>
  );
}
