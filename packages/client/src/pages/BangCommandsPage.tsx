/**
 * Top-level cross-session `!!` bang-command history: every locally run
 * command with exit status and on-demand rendered output, linking back to
 * the owning session. Contract: topics/bang-commands.md.
 */

import type { BangCommandTranscriptDisplayObject } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import {
  type BangCommandOutput,
  BangCommandDisplayObject,
} from "../components/BangCommandDisplayObject";
import { PageHeader } from "../components/PageHeader";
import { IconButton } from "../components/ui/Button";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { createSessionNavigationState } from "../lib/sessionNavigationState";
import styles from "./BangCommandsPage.module.css";

interface BangHistoryEntry {
  sessionId: string;
  projectId?: string;
  object: BangCommandTranscriptDisplayObject;
}

/**
 * Per-entry actions, all scoped to the entry's source session (which carries
 * its project cwd). See topics/bang-commands.md § Top-level history view.
 * Each navigates to the source session with navigation state consumed once by
 * SessionPage: edit prefills `!!<command>`, new focuses an empty composer,
 * jump scrolls to the bang block's render row (its `data-render-id` is the
 * transcript display object id).
 */
function BangHistoryEntryActions({
  projectId,
  sessionId,
  command,
  objectId,
  basePath,
}: {
  projectId: string;
  sessionId: string;
  command: string;
  objectId: string;
  basePath: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const sessionPath = `${basePath}/projects/${projectId}/sessions/${sessionId}`;
  return (
    <span className={styles.entryActions}>
      <IconButton
        label={t("bangHistoryActionEdit")}
        size="small"
        onClick={() =>
          navigate(sessionPath, {
            state: createSessionNavigationState({
              composerPrefill: `!!${command}`,
            }),
          })
        }
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z" />
        </svg>
      </IconButton>
      <IconButton
        label={t("bangHistoryActionNew")}
        size="small"
        onClick={() =>
          navigate(sessionPath, {
            state: createSessionNavigationState({ focusComposer: true }),
          })
        }
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8 3.5v9M3.5 8h9" />
        </svg>
      </IconButton>
      <IconButton
        label={t("bangHistoryActionJump")}
        size="small"
        onClick={() =>
          navigate(sessionPath, {
            state: createSessionNavigationState({
              scrollToRenderId: objectId,
            }),
          })
        }
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8 2.5v7M4.5 6l3.5 3.5L11.5 6M3 13h10" />
        </svg>
      </IconButton>
    </span>
  );
}

export function BangCommandsPage() {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const { isWideScreen } = useNavigationLayout();
  const [entries, setEntries] = useState<BangHistoryEntry[] | null>(null);
  const [expandedEntryKey, setExpandedEntryKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.fetchBangCommandHistory().then(
      (result) => {
        if (cancelled) return;
        setEntries(
          result.entries.filter(
            (entry): entry is BangHistoryEntry =>
              entry.object.kind === "bang-command",
          ),
        );
      },
      () => {
        if (!cancelled) setEntries([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader title={t("bangHistoryTitle")} />
      <div className={styles.page}>
        {entries !== null && entries.length === 0 && (
          <div className={styles.empty}>{t("bangHistoryEmpty")}</div>
        )}
        {entries?.map((entry) => {
          const entryKey = `${entry.sessionId}-${entry.object.id}`;
          return (
            <div className={styles.entry} key={entryKey}>
              <div className={styles.entryMeta}>
                <span>{new Date(entry.object.createdAt).toLocaleString()}</span>
                <span title={entry.object.cwd}>
                  {entry.object.cwd.split("/").pop()}
                </span>
                {entry.projectId && (
                  <Link
                    to={`${basePath}/projects/${entry.projectId}/sessions/${entry.sessionId}`}
                    className={styles.entrySession}
                  >
                    {t("bangHistoryOpenSession")}
                  </Link>
                )}
                {entry.projectId && (
                  <BangHistoryEntryActions
                    projectId={entry.projectId}
                    sessionId={entry.sessionId}
                    command={entry.object.command}
                    objectId={entry.object.id}
                    basePath={basePath}
                  />
                )}
              </div>
              <BangCommandDisplayObject
                object={entry.object}
                outputExpanded={expandedEntryKey === entryKey}
                onOutputExpandedChange={(expanded) => {
                  setExpandedEntryKey(expanded ? entryKey : null);
                }}
                handlers={
                  entry.projectId
                    ? {
                        fetchOutput: (objectId: string) =>
                          api.fetchBangCommandOutput(
                            entry.projectId as string,
                            entry.sessionId,
                            objectId,
                          ) as Promise<BangCommandOutput>,
                      }
                    : undefined
                }
              />
            </div>
          );
        })}
      </div>
    </MainContent>
  );
}
