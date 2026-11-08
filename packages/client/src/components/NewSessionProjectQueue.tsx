import type {
  ProjectQueueItemStatus,
  ProjectQueueItemSummary,
} from "@yep-anywhere/shared";
import { useId } from "react";
import { useI18n } from "../i18n";
import { ProviderBadge } from "./ProviderBadge";
import styles from "./NewSessionProjectQueue.module.css";
import { projectQueueRouterLabel } from "../lib/projectQueueRouterLabel";

type Translate = ReturnType<typeof useI18n>["t"];

const STATUS_CLASS: Record<ProjectQueueItemStatus, string | undefined> = {
  queued: undefined,
  dispatching: styles.statusDispatching,
  failed: styles.statusFailed,
};

function statusLabel(status: ProjectQueueItemStatus, t: Translate): string {
  switch (status) {
    case "dispatching":
      return t("projectQueueStatusDispatching");
    case "failed":
      return t("projectQueueStatusFailed");
    case "queued":
      return t("projectQueueStatusQueued");
  }
}

function targetLabel(item: ProjectQueueItemSummary, t: Translate): string {
  if (item.target.type === "new-session") {
    return t("projectQueueTargetNewSession");
  }
  return (
    item.targetFullTitle?.trim() ||
    item.targetTitle?.trim() ||
    t("projectQueueTargetSession", {
      sessionId: item.target.sessionId.slice(0, 8),
    })
  );
}

function itemTitle(item: ProjectQueueItemSummary, t: Translate): string {
  const preview = item.messagePreview.trim();
  if (item.target.type === "new-session") {
    return (
      item.target.title?.trim() || preview || t("projectQueueAttachmentOnly")
    );
  }
  return preview || t("projectQueueAttachmentOnly");
}

interface NewSessionProjectQueueProps {
  items: readonly ProjectQueueItemSummary[];
  loading: boolean;
  error: Error | null;
  onOpenItem: (itemId: string) => void;
}

/** Compact selected-project queue status attached to the project selector. */
export function NewSessionProjectQueue({
  items,
  loading,
  error,
  onOpenItem,
}: NewSessionProjectQueueProps) {
  const { t } = useI18n();
  const titleId = useId();

  if (items.length === 0 && !error) return null;

  return (
    <section
      className={styles.section}
      aria-labelledby={titleId}
      data-new-session-project-queue="true"
    >
      <div className={styles.header}>
        <h3 id={titleId}>{t("projectQueueTitle")}</h3>
        <span className={styles.count}>
          {loading
            ? t("projectQueueRefreshing")
            : t("projectQueueCount", { count: items.length })}
        </span>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {t("projectQueueLoadError", { message: error.message })}
        </p>
      )}

      <ul className={styles.list}>
        {items.map((item) => {
          const title = itemTitle(item, t);
          const routerLabel = projectQueueRouterLabel(item.target, t);
          return (
            <li
              key={item.id}
              className={styles.item}
              data-new-session-project-queue-item-id={item.id}
            >
              <button
                type="button"
                className={styles.itemButton}
                onClick={() => onOpenItem(item.id)}
                title={title}
              >
                <span className={styles.itemHeading}>
                  <strong className={styles.itemTitle}>{title}</strong>
                  <span
                    className={`${styles.status} ${STATUS_CLASS[item.status] ?? ""}`}
                  >
                    {statusLabel(item.status, t)}
                  </span>
                </span>
                <span className={styles.targetRow}>
                  <span className={styles.target}>{targetLabel(item, t)}</span>
                  {item.target.provider && (
                    <ProviderBadge
                      provider={item.target.provider}
                      model={item.target.model}
                      className={styles.provider}
                    />
                  )}
                  {routerLabel && (
                    <span className={styles.provider} title={routerLabel.title}>
                      {routerLabel.label}
                    </span>
                  )}
                </span>
                {item.lastError && (
                  <span className={styles.itemError}>{item.lastError}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
