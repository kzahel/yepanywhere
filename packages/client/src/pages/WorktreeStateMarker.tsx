import type { TranslationFn } from "../i18n";
import type { WorktreeState } from "./worktreeFileChanges";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import styles from "./WorktreeStateMarker.module.css";

export function WorktreeStateMarker({
  state,
  t,
}: {
  state: WorktreeState;
  t: TranslationFn;
}) {
  const label =
    state === "both"
      ? t("sourceWorktreePartialDescription")
      : state === "staged"
        ? t("sourceWorktreeStaged")
        : null;
  const tooltipAttributes = useTextTooltipAttributes(label);
  if (!label) return null;

  return (
    <span
      className={styles.state}
      role="img"
      aria-label={label}
      {...tooltipAttributes}
    >
      {state === "both" ? t("sourceWorktreePartial") : "✓"}
    </span>
  );
}
