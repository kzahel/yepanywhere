import { SelectableCard } from "./ui/SelectableCard";
import type { ProviderChildSessionSummary } from "@yep-anywhere/shared";
import { useEffect, useId, useMemo, useState } from "react";
import { useProcesses } from "../hooks/useProcesses";
import { useRelativeNow } from "../hooks/useRelativeNow";
import { useI18n } from "../i18n";
import { toBrowserAppHref } from "../lib/appHref";
import {
  countRecentlyActiveProviderChildren,
  firstDefinedProviderChildren,
  providerChildSessionHref,
  providerChildTitle,
} from "../lib/providerChildSessions";
import {
  clearSessionViewer,
  restoreSessionViewer,
} from "../lib/sessionViewerController";
import { ProviderChildSessionDetail } from "./ProviderChildSessionDetail";
import { SessionManagedPanel } from "./SessionManagedViewer";
import { buttonClassName, Button } from "./ui/Button";
import styles from "./ProviderChildSessionControl.module.css";

function latestChildId(
  children: readonly ProviderChildSessionSummary[],
): string | null {
  let latest = children[0];
  let latestMs = latest
    ? Date.parse(latest.updatedAt)
    : Number.NEGATIVE_INFINITY;
  for (const child of children.slice(1)) {
    const updatedAtMs = Date.parse(child.updatedAt);
    if (Number.isFinite(updatedAtMs) && updatedAtMs > latestMs) {
      latest = child;
      latestMs = updatedAtMs;
    }
  }
  return latest?.id ?? null;
}

function ProviderChildSessionViewer({
  projectId,
  sessionId,
  basePath,
  providerChildren,
}: {
  projectId: string;
  sessionId: string;
  basePath: string;
  providerChildren: readonly ProviderChildSessionSummary[];
}) {
  const { t } = useI18n();
  const fallback = t("providerChildFallback");
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    latestChildId(providerChildren),
  );
  const selected =
    providerChildren.find((child) => child.id === selectedId) ??
    providerChildren[0] ??
    null;

  useEffect(() => {
    if (
      !selectedId ||
      !providerChildren.some((child) => child.id === selectedId)
    ) {
      setSelectedId(latestChildId(providerChildren));
    }
  }, [providerChildren, selectedId]);

  if (!selected) return null;

  const selectedTitle = providerChildTitle(selected, fallback);
  const selectedHref = providerChildSessionHref(
    basePath,
    projectId,
    sessionId,
    selected.id,
  );

  return (
    <div className={styles.viewer}>
      <nav className={styles.selector} aria-label={t("providerChildSelector")}>
        <ul className={styles.selectorList}>
          {providerChildren.map((child) => {
            const title = providerChildTitle(child, fallback);
            const isSelected = child.id === selected.id;
            return (
              <li key={child.id}>
                <SelectableCard
                  size="compact"
                  className={styles.selectorItem}
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() => setSelectedId(child.id)}
                >
                  <span className={styles.selectorTitle}>{title}</span>
                  {child.agentType && child.agentType !== title && (
                    <span className={styles.selectorType}>
                      {child.agentType}
                    </span>
                  )}
                </SelectableCard>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className={styles.detail}>
        <ProviderChildSessionDetail
          key={selected.id}
          projectId={projectId}
          sessionId={sessionId}
          agentId={selected.id}
          fallbackTitle={selectedTitle}
          actions={
            <a
              className={buttonClassName({ size: "small" })}
              href={toBrowserAppHref(selectedHref)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("providerChildOpenNewTab")}
            </a>
          }
        />
      </div>
    </div>
  );
}

export function ProviderChildSessionControl({
  projectId,
  sessionId,
  basePath,
  childrenFromSession,
  processState,
}: {
  projectId: string;
  sessionId: string;
  basePath: string;
  childrenFromSession?: ProviderChildSessionSummary[];
  processState?: string | null;
}) {
  const { t } = useI18n();
  const { processes, terminatedProcesses } = useProcesses();
  const viewerId = useId();
  const [open, setOpen] = useState(false);
  const nowMs = useRelativeNow(60_000);
  const processChildren = useMemo(
    () =>
      [...processes, ...terminatedProcesses].find(
        (process) => process.sessionId === sessionId,
      )?.providerChildren,
    [processes, sessionId, terminatedProcesses],
  );
  const children = firstDefinedProviderChildren(
    processChildren,
    childrenFromSession,
  );
  const activeCount = countRecentlyActiveProviderChildren(
    children,
    processState,
    nowMs,
  );
  const countLabel = t(
    children.length === 1
      ? "providerChildrenCountOne"
      : "providerChildrenCountMany",
    { count: children.length },
  );
  const activityLabel =
    activeCount > 0
      ? t(
          children.length === 1
            ? "providerChildrenActiveSummaryOne"
            : "providerChildrenActiveSummaryMany",
          {
            active: activeCount,
            total: children.length,
          },
        )
      : countLabel;

  useEffect(() => {
    if (children.length > 0 || !open) return;
    clearSessionViewer(viewerId);
    setOpen(false);
  }, [children.length, open, viewerId]);

  if (children.length === 0) return null;

  return (
    <>
      <Button
        variant="secondary"
        size="dense"
        className={styles.trigger}
        title={activityLabel}
        aria-label={activityLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-selected={open}
        onClick={() => {
          if (open) {
            restoreSessionViewer(viewerId);
          } else {
            setOpen(true);
          }
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="4" cy="4" r="1.5" />
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <path d="M5.5 4h1.25A2.25 2.25 0 0 1 9 6.25v3.5A2.25 2.25 0 0 0 11.25 12h.25M9 7.5h2.5" />
        </svg>
        <span>
          {activeCount > 0
            ? `${activeCount}/${children.length}`
            : children.length}
        </span>
      </Button>
      {open && (
        <SessionManagedPanel
          viewerId={viewerId}
          sessionId={sessionId}
          title={t("providerChildViewerTitle")}
          label={countLabel}
          briefLabel={t("providerChildViewerBriefLabel")}
          onClose={() => setOpen(false)}
        >
          <ProviderChildSessionViewer
            projectId={projectId}
            sessionId={sessionId}
            basePath={basePath}
            providerChildren={children}
          />
        </SessionManagedPanel>
      )}
    </>
  );
}
