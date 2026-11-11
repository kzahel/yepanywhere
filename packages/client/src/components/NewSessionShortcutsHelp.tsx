import { useI18n } from "../i18n";
import styles from "./NewSessionShortcutsHelp.module.css";

export function NewSessionShortcutsHelp({
  compact,
  fullPane,
  backgroundLabel,
}: {
  compact: boolean;
  fullPane: boolean;
  backgroundLabel: string;
}) {
  const { t } = useI18n();
  return (
    <details
      className={styles.shortcutsHelp}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          event.currentTarget.open = false;
      }}
    >
      <summary
        role="button"
        className={styles.shortcutsTrigger}
        aria-label={t("newSessionKeyboardShortcuts")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            const details = event.currentTarget
              .parentElement as HTMLDetailsElement;
            details.open = false;
          }
        }}
      >
        <span className={styles.shortcutsQuestion}>?</span>
      </summary>
      <div className={styles.shortcutsPopover}>
        <strong>{t("newSessionKeyboardShortcuts")}</strong>
        <div className={styles.shortcutsRow}>
          <kbd>⌘ Enter</kbd>
          <span>{backgroundLabel}</span>
        </div>
        {!compact && (
          <div className={styles.shortcutsRow}>
            <kbd>Ctrl U</kbd>
            <span>
              {t(
                fullPane ? "composerFullPaneRestore" : "composerFullPaneExpand",
              )}
            </span>
          </div>
        )}
      </div>
    </details>
  );
}
