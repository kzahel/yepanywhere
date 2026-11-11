import type { InboxItem } from "../api/inbox";
import { useI18n } from "../i18n";
import { formatSessionRelativeTime } from "../lib/sessionAge";
import { ProviderBadge } from "./ProviderBadge";
import { SessionProviderPhasePill } from "./SessionProviderPhase";
import { Badge, type BadgeTone } from "./ui/Badge";
import styles from "./InboxSessionMetadata.module.css";

export function InboxSessionMetadata({
  item,
  showProjectName,
  showActivity,
  badge,
}: {
  item: InboxItem;
  showProjectName: boolean;
  showActivity: boolean;
  badge?: { label: string; tone: BadgeTone } | null;
}) {
  const { t } = useI18n();
  const config = item.modelConfig;
  return (
    <span className={styles.root} data-inbox-session-meta>
      <span className={styles.details}>
        {showProjectName && (
          <span className={styles.project} title={item.projectName}>
            {item.projectName}
          </span>
        )}
        <span className={styles.age}>
          {formatSessionRelativeTime(item.updatedAt)}
        </span>
        {badge && (
          <Badge tone={badge.tone} size="small">
            {t(badge.label as never)}
          </Badge>
        )}
        {showActivity && item.providerPhase && (
          <span className={styles.activity}>
            <SessionProviderPhasePill providerPhase={item.providerPhase} />
          </span>
        )}
      </span>
      {config && (config.model || config.thinking || config.effort) && (
        <span className={styles.model} data-inbox-model>
          <span className={styles.fullModel}>
            <ProviderBadge {...config} showThinking />
          </span>
          <span className={styles.shortModel}>
            <ProviderBadge {...config} showThinking condensed />
          </span>
        </span>
      )}
    </span>
  );
}
