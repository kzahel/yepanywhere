import {
  Fragment,
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ComposerOverflowTier } from "../hooks/useMessageInputToolbarLayout";
import { useAsyncQuestions } from "../contexts/AsyncQuestionsContext";
import { isQuestionAnswered } from "../lib/asyncQuestionRecords";
import { useI18n } from "../i18n";
import {
  getQuestionReminderStage,
  type AsyncQuestion,
} from "../lib/asyncQuestions";
import styles from "./AsyncQuestions.module.css";
import { Button, ButtonBase, IconButton } from "./ui/Button";

function QuestionIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M21 11a9 9 0 0 1-9 9 10 10 0 0 1-4-.9L3 21l1.8-5A9 9 0 1 1 21 11Z" />
      <path d="M9.6 8a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 1.7-2.4 3.5M12 15h.01" />
    </svg>
  );
}

export type AsyncQuestionsMenuState = Pick<
  NonNullable<ReturnType<typeof useAsyncQuestions>>,
  | "questions"
  | "records"
  | "reminderTurns"
  | "open"
  | "update"
  | "menuOpen"
  | "setMenuOpen"
>;

function QuestionMenuRow({
  question,
  showDismissed,
  state,
}: {
  question: AsyncQuestion;
  showDismissed: boolean;
  state: AsyncQuestionsMenuState;
}) {
  const { t } = useI18n();
  const [contextOpen, setContextOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const dismissed = state.records[question.id]?.dismissed === true;
  const dismiss = () => {
    state.update(question.id, { dismissed: !dismissed });
    setContextOpen(false);
  };
  return (
    <li className={styles.menuRow}>
      <span
        className={styles.turnAge}
        role="img"
        aria-label={t("asyncQuestionTurnsAgo", { count: question.age })}
      >
        {question.age}
      </span>
      <div className={styles.previewBox}>
        <ButtonBase
          className={styles.preview}
          title={question.title}
          aria-label={question.title}
          onClick={() => {
            if (held.current) {
              held.current = false;
              return;
            }
            state.open(question);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            clearTimer();
            setContextOpen(true);
          }}
          onTouchStart={() => {
            held.current = false;
            clearTimer();
            timer.current = setTimeout(() => {
              held.current = true;
              setContextOpen(true);
            }, 450);
          }}
          onTouchMove={clearTimer}
          onTouchEnd={clearTimer}
          onTouchCancel={clearTimer}
        >
          <span className={styles.previewText}>{question.title}</span>
          {!state.records[question.id]?.seen && (
            <span
              className={styles.unseen}
              role="img"
              aria-label={t("asyncQuestionUnseen")}
            />
          )}
        </ButtonBase>
        <IconButton
          size="small"
          className={styles.dismiss}
          onClick={dismiss}
          label={t(
            dismissed ? "asyncQuestionRestore" : "asyncQuestionDismiss",
            { question: question.title },
          )}
        >
          {dismissed && showDismissed ? "↶" : "×"}
        </IconButton>
        {contextOpen && (
          <div className={styles.rowMenu} role="menu">
            <button type="button" role="menuitem" onClick={dismiss}>
              {t(
                dismissed
                  ? "asyncQuestionRestoreShort"
                  : "asyncQuestionDismissShort",
              )}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export function AsyncQuestionsButton({
  overflow = false,
  compact = "none",
  inventory,
  groupTitles,
  omitted = false,
}: {
  overflow?: boolean;
  compact?: ComposerOverflowTier;
  inventory?: AsyncQuestionsMenuState;
  groupTitles?: ReadonlyMap<string, { id: string; title: string }>;
  omitted?: boolean;
}) {
  const context = useAsyncQuestions();
  const state = inventory ?? context;
  const { t } = useI18n();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({
    left: 8,
    bottom: 0,
    width: 360,
    maxHeight: 400,
  });
  const pending =
    state?.questions.filter(
      (question) => !isQuestionAnswered(state.records[question.id]),
    ) ?? [];
  const visible = pending.filter(
    (question) => showDismissed || !state?.records[question.id]?.dismissed,
  );
  const reminders = pending.filter(
    (question) => !state?.records[question.id]?.dismissed,
  );
  const recent = reminders.filter(
    (question) =>
      getQuestionReminderStage(
        question.age,
        state?.records[question.id]?.edits ?? 0,
        state?.reminderTurns,
      ) === "recent",
  );
  const retired = reminders.every(
    (question) =>
      getQuestionReminderStage(
        question.age,
        state?.records[question.id]?.edits ?? 0,
        state?.reminderTurns,
      ) === "retired",
  );
  const newest = recent.reduce<AsyncQuestion | undefined>(
    (youngest, question) =>
      !youngest || question.age <= youngest.age ? question : youngest,
    undefined,
  );
  const setMenuOpen = state?.setMenuOpen;
  const close = () => {
    setOpen(false);
    setMenuOpen?.(false);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(520, window.innerWidth - 16);
      const below =
        Boolean(inventory) &&
        window.innerHeight - rect.bottom > Math.min(280, rect.top);
      const available = below
        ? window.innerHeight - rect.bottom - 14
        : rect.top - 16;
      setPosition({
        left: Math.max(
          8,
          Math.min(rect.right - width, window.innerWidth - width - 8),
        ),
        ...(below
          ? { top: rect.bottom + 6 }
          : { bottom: window.innerHeight - rect.top + 6 }),
        width,
        maxHeight: Math.max(100, Math.min(400, available)),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, inventory]);

  useLayoutEffect(() => {
    if (!open) return;
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
    const previews = panel.current?.querySelectorAll<HTMLButtonElement>(
      `button.${styles.preview}`,
    );
    previews?.[previews.length - 1]?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        panel.current?.contains(event.target) ||
        button.current?.contains(event.target)
      )
        return;
      setOpen(false);
      setMenuOpen?.(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      setMenuOpen?.(false);
      button.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, setMenuOpen]);

  useEffect(() => {
    if (state?.menuOpen === false) setOpen(false);
  }, [state?.menuOpen]);
  if (
    !state ||
    state.reminderTurns === 0 ||
    state.questions.length === 0 ||
    (!overflow && retired && !open && !focused)
  )
    return null;
  const label = newest
    ? `${t(recent.length === 1 ? "asyncQuestionSingle" : "asyncQuestionCount", { count: recent.length })} · ${t(newest.age === 1 ? "asyncQuestionOneTurnAgo" : "asyncQuestionTurnsAgo", { count: newest.age })}`
    : t("asyncQuestionsTitle");
  return (
    <>
      <ButtonBase
        ref={button}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`${styles.indicator} ${recent.length ? styles.recent : ""} ${overflow ? styles.overflowEntry : ""}`}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        role={overflow ? "menuitem" : undefined}
        onClick={() => {
          setOpen(!open);
          setMenuOpen?.(!open);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
          setMenuOpen?.(true);
        }}
      >
        <QuestionIcon />
        {newest && !overflow ? (
          <>
            <span>{recent.length}</span>
            {compact !== "late" && (
              <span>
                {t(
                  recent.length === 1
                    ? "asyncQuestionWord"
                    : "asyncQuestionsWord",
                )}
              </span>
            )}
            {compact === "none" && (
              <span>
                ·{" "}
                {t(
                  newest.age === 1
                    ? "asyncQuestionOneTurnAgo"
                    : "asyncQuestionTurnsAgo",
                  { count: newest.age },
                )}
              </span>
            )}
          </>
        ) : (
          // The tightest tier (sidebar rows, the Inbox entry, a crowded
          // composer) keeps the icon alone. Spelling out "Questions" there
          // costs ~100px and squeezes the session title it sits beside; the
          // accessible name and tooltip still carry the wording.
          compact !== "late" && <span>{t("asyncQuestionsTitle")}</span>
        )}
      </ButtonBase>
      {open &&
        createPortal(
          <div
            ref={panel}
            className={styles.menu}
            style={position}
            role="dialog"
            aria-label={t("asyncQuestionsTitle")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              const targets = [
                ...(panel.current?.querySelectorAll<HTMLButtonElement>(
                  `button.${styles.preview}`,
                ) ?? []),
              ];
              const current = targets.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (!targets.length) return;
              event.preventDefault();
              targets[
                (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  targets.length) %
                  targets.length
              ]?.focus();
            }}
          >
            <div className={styles.menuHeading}>
              <strong>{t("asyncQuestionsTitle")}</strong>
              <IconButton
                size="small"
                className={styles.dismiss}
                label={t("asyncQuestionCloseMenu")}
                onClick={close}
              >
                ×
              </IconButton>
            </div>
            <ul ref={list} className={styles.questionList}>
              {visible.map((question, index) => (
                <Fragment key={question.id}>
                  {groupTitles?.has(question.id) &&
                    (index === 0 ||
                      groupTitles.get(visible[index - 1]!.id)?.id !==
                        groupTitles.get(question.id)?.id) && (
                      <li className={styles.groupHeading}>
                        {groupTitles.get(question.id)?.title}
                      </li>
                    )}
                  <QuestionMenuRow
                    question={question}
                    showDismissed={showDismissed}
                    state={{
                      ...state,
                      open: (selected) => {
                        close();
                        state.open(selected);
                      },
                    }}
                  />
                </Fragment>
              ))}
            </ul>
            {visible.length === 0 && <p>{t("asyncQuestionsNone")}</p>}
            {omitted && (
              <p className={styles.hint}>{t("asyncQuestionsEarlierOmitted")}</p>
            )}
            <Button
              variant="ghost"
              size="small"
              className={styles.showDismissed}
              onClick={() => setShowDismissed(!showDismissed)}
            >
              {t(
                showDismissed
                  ? "asyncQuestionHideDismissed"
                  : "asyncQuestionShowDismissed",
              )}
            </Button>
          </div>,
          document.body,
        )}
    </>
  );
}
