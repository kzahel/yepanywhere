import recallStyles from "./ComposerRecallMenu.module.css";
import slashStyles from "./SlashCommandButton.module.css";
import { useI18n } from "../i18n";
import type { ComposerTurnRecallEntry } from "../lib/composerTurnRecall";

/**
 * The composer recall drawer's menu: one row per matched prior turn, the
 * active row highlighted, and an optional go-to control per row. State and
 * keys live in `useComposerRecallDrawer`. See topics/composer-recall-drawer.md.
 */
export function ComposerRecallMenu({
  matches,
  activeIndex,
  showGoTo,
  onHighlight,
  onAccept,
  onGoTo,
}: {
  matches: ComposerTurnRecallEntry[];
  activeIndex: number;
  showGoTo: boolean;
  onHighlight: (index: number) => void;
  onAccept: (entry: ComposerTurnRecallEntry) => void;
  onGoTo: (entry: ComposerTurnRecallEntry) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className={`${slashStyles.slashCommandMenu} ${slashStyles.composerSlashCommandMenu} composer-recall-menu`}
      role="menu"
      aria-label={t("composerRecallMenuLabel")}
    >
      {matches.map((entry, index) => (
        <div
          key={`${index}-${entry.id}`}
          className={recallStyles.composerRecallRow}
          data-composer-recall-row
        >
          <button
            type="button"
            className={`${slashStyles.slashCommandItem} ${recallStyles.composerRecallPreview}${index === activeIndex ? ` ${slashStyles.active}` : ""}`}
            data-composer-recall-preview
            data-slash-command-item
            data-composer-recall-active={index === activeIndex || undefined}
            onMouseEnter={() => onHighlight(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onAccept(entry)}
            role="menuitem"
          >
            <span>{entry.preview}</span>
          </button>
          {showGoTo && (
            // Navigation-only secondary control: scroll the transcript to
            // this turn and close the drawer (no composer/draft change).
            <button
              type="button"
              className={recallStyles.composerRecallGoto}
              data-composer-recall-goto
              onMouseEnter={() => onHighlight(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onGoTo(entry)}
              aria-label={t("composerRecallGoToTurn")}
              title={t("composerRecallGoToTurn")}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <line x1="12" y1="2" x2="12" y2="5" />
                <line x1="12" y1="19" x2="12" y2="22" />
                <line x1="2" y1="12" x2="5" y2="12" />
                <line x1="19" y1="12" x2="22" y2="12" />
              </svg>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
