import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { ButtonBase } from "./ui/Button";
import { Modal } from "./ui/Modal";
import styles from "./SchemaValidationSummary.module.css";

export interface SchemaValidationGap {
  code: string;
  kind: "invalid" | "missing";
  message: string;
  path: string;
  toolName: string;
}

interface SchemaValidationSummaryProps {
  gaps: SchemaValidationGap[];
  ignoredTools: string[];
}

interface GapGroup {
  gaps: SchemaValidationGap[];
  toolName: string;
}

function groupAndSortGaps(gaps: SchemaValidationGap[]): GapGroup[] {
  const grouped = new Map<string, SchemaValidationGap[]>();
  for (const gap of gaps) {
    const toolGaps = grouped.get(gap.toolName) ?? [];
    toolGaps.push(gap);
    grouped.set(gap.toolName, toolGaps);
  }

  return Array.from(grouped, ([toolName, toolGaps]) => ({
    toolName,
    gaps: [...toolGaps].sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.path.localeCompare(right.path) ||
        left.message.localeCompare(right.message),
    ),
  })).sort((left, right) => left.toolName.localeCompare(right.toolName));
}

export function SchemaValidationSummary({
  gaps,
  ignoredTools,
}: SchemaValidationSummaryProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const groups = useMemo(() => groupAndSortGaps(gaps), [gaps]);
  const tooltip = t("schemaGapSummaryTooltip", {
    count: gaps.length,
    tools: groups.length,
  });

  return (
    <>
      <ButtonBase
        className={styles.trigger}
        title={tooltip}
        aria-label={tooltip}
        onClick={() => setIsOpen(true)}
      >
        <span className={styles.icon} aria-hidden="true">
          !
        </span>
        <span className={styles.count}>{gaps.length}</span>
      </ButtonBase>
      {isOpen && (
        <Modal
          title={t("schemaGapSummaryTitle")}
          onClose={() => setIsOpen(false)}
        >
          <div className={styles.content}>
            <p className={styles.intro}>
              {t("schemaGapSummaryIntro", {
                count: gaps.length,
                tools: groups.length,
              })}
            </p>
            <div className={styles.groups}>
              {groups.map((group) => (
                <section className={styles.group} key={group.toolName}>
                  <h3 className={styles.heading}>
                    <code>{group.toolName}</code>
                    <span className={styles.groupCount}>
                      {group.gaps.length}
                    </span>
                    {ignoredTools.includes(group.toolName) && (
                      <span className={styles.ignored}>
                        {t("schemaGapSummaryIgnored")}
                      </span>
                    )}
                  </h3>
                  <ul className={styles.issueList}>
                    {group.gaps.map((gap) => (
                      <li
                        className={styles.issue}
                        key={`${gap.path}\u0000${gap.code}\u0000${gap.message}`}
                      >
                        <span className={styles.kind} data-kind={gap.kind}>
                          {gap.kind === "missing"
                            ? t("schemaWarningMissing")
                            : t("schemaWarningInvalid")}
                        </span>
                        <code className={styles.path}>{gap.path}</code>
                        <span className={styles.message}>{gap.message}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
