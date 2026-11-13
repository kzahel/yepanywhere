import {
  SESSION_ASYNC_QUESTIONS_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuestionReminderTurns } from "../hooks/useQuestionReminderTurns";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import type { AsyncQuestion } from "../lib/asyncQuestions";
import { parseTimestampMs } from "../lib/messageAge";
import {
  type AsyncQuestionRecord,
  getQuestionRecords,
  questionStorageKey,
  updateQuestionRecord,
  useQuestionReminderRevision,
} from "../lib/asyncQuestionRecords";
import {
  useClientSummarySourceKey,
  useClientSummaryState,
  useSessionCollectionRecord,
} from "../lib/clientSummaryStore";
import type { SessionCollectionRecord } from "../lib/clientSummaryCollections";
import {
  AsyncQuestionsButton,
  type AsyncQuestionsMenuState,
} from "./AsyncQuestionsButton";

const setMenuOpen = () => {};

interface QuestionButtonProps {
  sessionId?: string;
  projectId?: string;
  basePath?: string;
  onNavigate?(): void;
}

export function SessionAsyncQuestionsButton(props: QuestionButtonProps) {
  const { version } = useVersion();
  if (!serverHasCapability(version, SESSION_ASYNC_QUESTIONS_CAPABILITY))
    return null;
  return props.sessionId ? (
    <SingleSessionQuestions {...props} sessionId={props.sessionId} />
  ) : (
    <CollectedSessionQuestions {...props} />
  );
}

function SingleSessionQuestions(
  props: QuestionButtonProps & { sessionId: string },
) {
  const row = useSessionCollectionRecord(props.sessionId);
  const rows = useMemo(() => (row ? [row] : []), [row]);
  return <QuestionButton {...props} rows={rows} />;
}

function CollectedSessionQuestions(props: QuestionButtonProps) {
  const state = useClientSummaryState();
  const rows = useMemo(
    () => [...state.sessions.entities.values()],
    [state.sessions.entities],
  );
  return <QuestionButton {...props} rows={rows} />;
}

function QuestionButton({
  rows: sourceRows,
  sessionId,
  projectId,
  basePath = "",
  onNavigate,
}: QuestionButtonProps & { rows: readonly SessionCollectionRecord[] }) {
  const sourceKey = useClientSummarySourceKey();
  const revision = useQuestionReminderRevision();
  const reminderTurns = useQuestionReminderTurns();
  const navigate = useNavigate();
  const { t } = useI18n();
  const data = useMemo(() => {
    void revision;
    const questions: AsyncQuestion[] = [];
    const records: Record<string, AsyncQuestionRecord> = {};
    const groupTitles = new Map<
      string,
      { id: string; title: string; activityMs?: number }
    >();
    const targets = new Map<
      string,
      {
        sessionId: string;
        projectId: string;
        localId: string;
        storageKey: string;
      }
    >();
    let omitted = false;
    const rows = sourceRows
      .filter(
        (row) =>
          row.projectId &&
          !row.isArchived &&
          (!projectId || row.projectId === projectId) &&
          Boolean(row.asyncQuestions?.questions.length),
      )
      .sort(
        (a, b) =>
          (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "") ||
          a.id.localeCompare(b.id),
      );
    for (const row of rows) {
      const storageKey = questionStorageKey(sourceKey, row.id);
      const local = getQuestionRecords(storageKey);
      omitted ||= row.asyncQuestions?.omitted ?? false;
      const activityMs = parseTimestampMs(row.updatedAt) ?? undefined;
      for (const { askedAt, ...preview } of row.asyncQuestions?.questions ??
        []) {
        const localId = JSON.stringify([preview.messageId, preview.index]);
        const id = JSON.stringify([row.id, preview.messageId, preview.index]);
        const askedAtMs = parseTimestampMs(askedAt);
        questions.push({
          ...preview,
          id,
          renderId: preview.messageId,
          options: [],
          ...(askedAtMs === null ? {} : { askedAtMs }),
          ...(activityMs === undefined
            ? {}
            : { sessionActivityMs: activityMs }),
        });
        if (local[localId]) records[id] = local[localId]!;
        groupTitles.set(id, {
          id: row.id,
          title:
            row.customTitle || row.title || t("asyncQuestionSessionFallback"),
          ...(activityMs === undefined ? {} : { activityMs }),
        });
        targets.set(id, {
          sessionId: row.id,
          projectId: row.projectId!,
          localId,
          storageKey,
        });
      }
    }
    const inventory: AsyncQuestionsMenuState = {
      questions,
      records,
      reminderTurns,
      menuOpen: true,
      setMenuOpen,
      open(question) {
        const target = targets.get(question.id)!;
        navigate(
          `${basePath}/projects/${target.projectId}/sessions/${target.sessionId}?tailTurns=32`,
          {
            state: {
              asyncQuestion: {
                messageId: question.messageId,
                index: question.index,
              },
            },
          },
        );
        onNavigate?.();
      },
      update(id, patch) {
        const target = targets.get(id)!;
        updateQuestionRecord(target.storageKey, target.localId, patch);
      },
    };
    return {
      inventory,
      groupTitles: sessionId ? undefined : groupTitles,
      omitted,
    };
  }, [
    sourceRows,
    projectId,
    sourceKey,
    revision,
    reminderTurns,
    navigate,
    basePath,
    onNavigate,
    sessionId,
    t,
  ]);
  return <AsyncQuestionsButton {...data} compact="late" />;
}
