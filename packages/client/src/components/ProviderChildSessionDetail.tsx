import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api/client";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import { useI18n } from "../i18n";
import type { AgentSession } from "../types";
import { TaskNestedContent } from "./renderers/tools/TaskNestedContent";
import styles from "./ProviderChildSessionDetail.module.css";

interface ProviderChildSessionDetailProps {
  projectId: string;
  sessionId: string;
  agentId: string;
  fallbackTitle?: string;
  actions?: ReactNode;
  headingLevel?: 1 | 2;
}

export function ProviderChildSessionDetail({
  projectId,
  sessionId,
  agentId,
  fallbackTitle,
  actions,
  headingLevel = 2,
}: ProviderChildSessionDetailProps) {
  const { t } = useI18n();
  const [content, setContent] = useState<AgentSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    void api
      .getAgentSession(projectId, sessionId, agentId)
      .then((data) => {
        if (!cancelled) setContent(data);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : t("providerChildPageNotFound"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, projectId, sessionId, t]);

  const title =
    content?.description ||
    content?.agentType ||
    fallbackTitle ||
    t("providerChildFallback");
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <section className={styles.root}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <Heading className={styles.title}>{title}</Heading>
          <div className={styles.meta}>
            {content?.agentType && content.agentType !== title && (
              <span>{content.agentType}</span>
            )}
            {content?.status && (
              <span>
                {t(
                  content.status === "running"
                    ? "providerChildStatusRunning"
                    : content.status === "completed"
                      ? "providerChildStatusCompleted"
                      : content.status === "failed"
                        ? "providerChildStatusFailed"
                        : "providerChildStatusPending",
                )}
              </span>
            )}
            {content?.spawnDepth !== undefined && (
              <span>
                {t("providerChildSpawnDepth", { count: content.spawnDepth })}
              </span>
            )}
          </div>
        </div>
        <p className={styles.readonly}>{t("providerChildPageReadOnly")}</p>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      <div className={styles.content}>
        {loading && (
          <p className={styles.status}>{t("providerChildPageLoading")}</p>
        )}
        {!loading && error && <p className={styles.status}>{error}</p>}
        {!loading && !error && content && (
          <SessionMetadataProvider
            projectId={projectId}
            projectPath={null}
            sessionId={sessionId}
          >
            {content.messages.length > 0 ? (
              <TaskNestedContent
                messages={content.messages}
                isStreaming={content.status === "running"}
              />
            ) : (
              <p className={styles.status}>{t("providerChildPageEmpty")}</p>
            )}
          </SessionMetadataProvider>
        )}
      </div>
    </section>
  );
}
