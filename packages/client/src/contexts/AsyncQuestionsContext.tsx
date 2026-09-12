import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  type AsyncQuestionRecord,
  emptyQuestionRecord as emptyRecord,
  isQuestionAnswered,
  updateQuestionRecord,
  useQuestionRecords,
} from "../lib/asyncQuestionRecords";
import { useQuestionReminderTurns } from "../hooks/useQuestionReminderTurns";
import {
  collectAsyncQuestions,
  getQuestionReminderStage,
  type AsyncQuestion,
} from "../lib/asyncQuestions";
import { quoteMarkdown } from "../lib/commentAnchors";
import type { ComposerDraftSignal } from "../lib/composerDraftSignal";
import type { SessionRouteScrollSnapshot } from "../lib/sessionRouteSnapshots";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";

export type { AsyncQuestionRecord } from "../lib/asyncQuestionRecords";

export interface QuestionNavigation {
  capture(): SessionRouteScrollSnapshot | null;
  jump(renderId: string, questionId: string): void;
  restore(snapshot: SessionRouteScrollSnapshot): void;
}

interface AsyncQuestionsState {
  reminderTurns: number;
  questions: readonly AsyncQuestion[];
  records: Readonly<Record<string, AsyncQuestionRecord>>;
  activeId: string | null;
  navigationTarget: {
    renderId: string;
    questionId: string;
    token: number;
  } | null;
  submittingId: string | null;
  menuOpen: boolean;
  setMenuOpen(open: boolean): void;
  observe(items: readonly RenderItem[]): void;
  navigation: { current: QuestionNavigation | null };
  retainedRenderIds: readonly string[];
  open(question: AsyncQuestion): void;
  returnToPrevious(): void;
  update(id: string, patch: Partial<AsyncQuestionRecord>): void;
  submit(question: AsyncQuestion, answer: string): Promise<boolean>;
  quote(question: AsyncQuestion): void;
}

const AsyncQuestionsContext = createContext<AsyncQuestionsState | null>(null);
export const useAsyncQuestions = () => useContext(AsyncQuestionsContext);

export function AsyncQuestionsProvider({
  storageKey,
  draftSignal,
  send,
  quote,
  focusComposer,
  target,
  children,
}: {
  storageKey: string;
  draftSignal: ComposerDraftSignal;
  send(text: string): Promise<boolean>;
  quote(text: string): unknown;
  focusComposer(): void;
  target?: { messageId: string; index: number; token: string };
  children: ReactNode;
}) {
  const reminderTurns = useQuestionReminderTurns();
  const [questions, setQuestions] = useState<readonly AsyncQuestion[]>([]);
  const records = useQuestionRecords(storageKey);
  const recordsRef = useRef(records);
  useEffect(() => {
    const next = { ...records };
    for (const id of dirtyEditIds.current) {
      next[id] = {
        ...(next[id] ?? emptyRecord),
        edits: Math.max(
          next[id]?.edits ?? 0,
          recordsRef.current[id]?.edits ?? 0,
        ),
      };
    }
    recordsRef.current = next;
  }, [records]);
  const questionsRef = useRef(questions);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [navigationTarget, setNavigationTarget] =
    useState<AsyncQuestionsState["navigationTarget"]>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const submitting = useRef(false);
  const visit = useRef(0);
  const dirtyEditIds = useRef(new Set<string>());
  const [menuOpen, setMenuOpen] = useState(false);
  const navigation = useRef<QuestionNavigation | null>(null);
  const returnPosition = useRef<SessionRouteScrollSnapshot | null>(null);
  const [returnAnchorId, setReturnAnchorId] = useState<string | null>(null);
  const callbacks = useRef({ send, quote, focusComposer });
  callbacks.current = { send, quote, focusComposer };

  const persistRecord = useCallback(
    (id: string, patch: Partial<AsyncQuestionRecord>) => {
      const persisted = updateQuestionRecord(storageKey, id, {
        ...patch,
        edits: Math.max(recordsRef.current[id]?.edits ?? 0, patch.edits ?? 0),
      });
      recordsRef.current = { ...recordsRef.current, [id]: persisted[id]! };
      dirtyEditIds.current.delete(id);
    },
    [storageKey],
  );

  const persist = useCallback(() => {
    for (const id of dirtyEditIds.current)
      persistRecord(id, { edits: recordsRef.current[id]!.edits });
  }, [persistRecord]);

  const update = useCallback(
    (id: string, patch: Partial<AsyncQuestionRecord>) => {
      persistRecord(id, patch);
    },
    [persistRecord],
  );

  const observe = useCallback((items: readonly RenderItem[]) => {
    const next = collectAsyncQuestions(items);
    if (JSON.stringify(next) === JSON.stringify(questionsRef.current)) return;
    questionsRef.current = next;
    setQuestions(next);
  }, []);

  useEffect(() => {
    let previous = draftSignal.getDraft();
    return draftSignal.subscribeDraftChanges(({ text }) => {
      const changed = text !== previous;
      previous = text;
      if (!changed || !text) return;
      let stageChanged = false;
      const next = { ...recordsRef.current };
      for (const question of questionsRef.current) {
        const record = next[question.id] ?? emptyRecord;
        if (record.dismissed || isQuestionAnswered(record)) continue;
        const edits = Math.min(2400, record.edits + 1);
        if (edits === record.edits) continue;
        dirtyEditIds.current.add(question.id);
        stageChanged ||=
          getQuestionReminderStage(question.age, edits, reminderTurns) !==
          getQuestionReminderStage(question.age, record.edits, reminderTurns);
        next[question.id] = { ...record, edits };
      }
      recordsRef.current = next;
      if (stageChanged) {
        persist();
      }
    });
  }, [draftSignal, persist, reminderTurns]);

  useEffect(() => {
    // A threshold change must publish edits accumulated since the last stage.
    void reminderTurns;
    persist();
  }, [reminderTurns, persist]);

  useEffect(() => {
    const saveWhenHidden = () => {
      if (document.hidden) persist();
    };
    document.addEventListener("visibilitychange", saveWhenHidden);
    window.addEventListener("pagehide", persist);
    return () => {
      persist();
      document.removeEventListener("visibilitychange", saveWhenHidden);
      window.removeEventListener("pagehide", persist);
    };
  }, [persist]);

  const open = useCallback((question: AsyncQuestion) => {
    visit.current++;
    returnPosition.current ??= navigation.current?.capture() ?? null;
    setReturnAnchorId(returnPosition.current?.anchor?.id ?? null);
    setMenuOpen(false);
    setActiveId(question.id);
    setNavigationTarget({
      renderId: question.renderId,
      questionId: question.id,
      token: visit.current,
    });
  }, []);

  const consumedTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!target || consumedTarget.current === target.token) return;
    const question = questions.find(
      (item) =>
        item.messageId === target.messageId && item.index === target.index,
    );
    if (!question) return;
    consumedTarget.current = target.token;
    returnPosition.current = {
      atBottom: true,
      following: true,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      updatedAtMs: Date.now(),
    };
    open(question);
  }, [target, questions, open]);

  const returnToPrevious = useCallback(() => {
    visit.current++;
    setActiveId(null);
    setNavigationTarget(null);
    const position = returnPosition.current;
    returnPosition.current = null;
    setReturnAnchorId(null);
    if (position) navigation.current?.restore(position);
    callbacks.current.focusComposer();
  }, []);

  const submit = useCallback(
    async (question: AsyncQuestion, answer: string) => {
      if (!answer.trim() || submitting.current) return false;
      const submittedVisit = visit.current;
      returnPosition.current ??= navigation.current?.capture() ?? null;
      submitting.current = true;
      setSubmittingId(question.id);
      let moved = false;
      const noteMovement = (event: Event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          event.type !== "wheel" &&
          target.closest<HTMLElement>("[data-async-question-reply]")?.dataset
            .asyncQuestionReply === question.id
        )
          return;
        moved = true;
      };
      document.addEventListener("pointerdown", noteMovement, true);
      document.addEventListener("focusin", noteMovement, true);
      document.addEventListener("wheel", noteMovement, {
        capture: true,
        passive: true,
      });
      try {
        const sent = await callbacks.current.send(
          `${quoteMarkdown(question.title)}\n\n${answer}`,
        );
        if (sent) {
          update(question.id, { answer, draft: "", seen: true });
          if (!moved && submittedVisit === visit.current) returnToPrevious();
          else if (submittedVisit === visit.current) {
            setActiveId(null);
            setNavigationTarget(null);
            setReturnAnchorId(null);
            returnPosition.current = null;
          }
        }
        return sent;
      } finally {
        submitting.current = false;
        setSubmittingId(null);
        document.removeEventListener("pointerdown", noteMovement, true);
        document.removeEventListener("focusin", noteMovement, true);
        document.removeEventListener("wheel", noteMovement, true);
      }
    },
    [returnToPrevious, update],
  );

  const quoteQuestion = useCallback(
    (question: AsyncQuestion) => {
      open(question);
      setActiveId(null);
      setReturnAnchorId(null);
      returnPosition.current = null;
      callbacks.current.quote(`${quoteMarkdown(question.title)}\n\n`);
      update(question.id, { quoted: true, seen: true });
    },
    [open, update],
  );

  const retainedRenderIds = useMemo(() => {
    const active = questions.find((question) => question.id === activeId);
    return [
      ...(active ? [active.renderId] : []),
      ...(returnAnchorId ? [returnAnchorId] : []),
    ];
  }, [questions, activeId, returnAnchorId]);
  const value = useMemo(
    () => ({
      reminderTurns,
      questions,
      records,
      activeId,
      navigationTarget,
      submittingId,
      menuOpen,
      retainedRenderIds,
      setMenuOpen,
      observe,
      navigation,
      open,
      returnToPrevious,
      update,
      submit,
      quote: quoteQuestion,
    }),
    [
      reminderTurns,
      questions,
      records,
      activeId,
      navigationTarget,
      submittingId,
      menuOpen,
      retainedRenderIds,
      observe,
      open,
      returnToPrevious,
      update,
      submit,
      quoteQuestion,
    ],
  );
  return (
    <AsyncQuestionsContext.Provider value={value}>
      {children}
    </AsyncQuestionsContext.Provider>
  );
}
