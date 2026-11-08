import type {
  FileViewSearchEntry,
  FileViewSearchTier,
} from "@yep-anywhere/shared";
import type { useFileViewCompletion } from "../hooks/useFileViewCompletion";
import { type MessageKey, useI18n } from "../i18n";
import styles from "./FileViewCompletionSheet.module.css";
import { ProjectFileCompletionMenu } from "./ProjectFileCompletionMenu";
import { ButtonBase, IconButton } from "./ui/Button";

const TIER_LABELS: Record<FileViewSearchTier, MessageKey> = {
  path: "fileViewGroupPath",
  tracked: "fileViewGroupTracked",
  untracked: "fileViewGroupUntracked",
  ignored: "fileViewGroupIgnored",
  outside: "fileViewGroupOutside",
};

/**
 * The `/v` finder: the shared path sheet grouped by tier with matched parts
 * highlighted, a jump to the turn that mentioned a file, a preview of the
 * highlighted file, and an explicit ignored-file search when nothing else
 * matched. See `topics/view-command.md`.
 */
export function FileViewCompletionSheet({
  completion,
  onGoToTurn,
}: {
  completion: ReturnType<typeof useFileViewCompletion>;
  onGoToTurn?: (itemId: string) => void;
}) {
  const { t } = useI18n();
  const { preview } = completion;
  return (
    <ProjectFileCompletionMenu<FileViewSearchEntry>
      completion={completion}
      group={(entry) => t(TIER_LABELS[entry.tier])}
      spans={(entry) => entry.spans}
      badge={(entry) =>
        completion.mentionOf(entry.path) ? t("fileViewMentioned") : ""
      }
      rowAction={(entry) => {
        const itemId = completion.mentionOf(entry.path);
        if (!itemId || !onGoToTurn) return null;
        return (
          <IconButton
            size="small"
            className={styles.jump}
            label={t("fileViewGoToMention")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onGoToTurn(itemId)}
          >
            ↪
          </IconButton>
        );
      }}
      emptyLabel={
        completion.ignoredSearched
          ? t("fileViewNoMatchIncludingIgnored")
          : t("fileViewCompletionEmpty")
      }
      footer={
        completion.canSearchIgnored ? (
          <ButtonBase
            className={styles.footerAction}
            onMouseDown={(event) => event.preventDefault()}
            onClick={completion.searchIgnored}
          >
            {t("fileViewSearchIgnored")}
          </ButtonBase>
        ) : undefined
      }
      preview={
        preview && completion.selected ? (
          <div className={styles.preview} aria-live="polite">
            <div className={styles.previewPath}>{completion.selected}</div>
            {preview.status === "ready" ? (
              <pre className={styles.lines}>
                {preview.preview.lines.map((line, index) => {
                  const number = preview.preview.startLine + index;
                  const cited = preview.preview.cited;
                  const inCited =
                    !!cited &&
                    number >= cited.lineNumber &&
                    number <= (cited.lineEnd ?? cited.lineNumber);
                  return (
                    <div
                      key={number}
                      className={styles.line}
                      data-cited={inCited ? "" : undefined}
                    >
                      <span className={styles.lineNumber}>{number}</span>
                      <span className={styles.lineText}>{line || " "}</span>
                    </div>
                  );
                })}
                {preview.preview.more && (
                  <div className={styles.more} aria-hidden="true">
                    …
                  </div>
                )}
              </pre>
            ) : (
              <div className={styles.previewStatus}>
                {preview.status === "loading"
                  ? t("fileViewPreviewLoading")
                  : t("fileViewPreviewUnavailable")}
              </div>
            )}
          </div>
        ) : undefined
      }
    />
  );
}
