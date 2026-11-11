import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { Menu, MenuItem } from "./ui/Menu";
import { Popover, type PopoverPoint } from "./ui/Popover";

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
      {/* The mark is drawn heavier than the bubble so it survives 18px. */}
      <path
        d="M9 8.3a3.1 3.1 0 0 1 6.1.8c0 2.1-3.1 2.3-3.1 4.4M12 16.4h.01"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
  const [contextPoint, setContextPoint] = useState<PopoverPoint | null>(null);
  const previewRef = useRef<HTMLButtonElement>(null);
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
    setContextPoint(null);
  };
  const age =
    question.age > 0
      ? t(
          question.age === 1
            ? "asyncQuestionOneTurnAgo"
            : "asyncQuestionTurnsAgo",
          { count: question.age },
        )
      : null;
  return (
    <li className={styles.menuRow}>
      <div className={styles.previewBox}>
        <ButtonBase
          ref={previewRef}
          className={styles.preview}
          data-question-preview
          title={age ? `${question.title}\n${age}` : question.title}
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
            setContextPoint({ x: event.clientX, y: event.clientY });
          }}
          onTouchStart={(event) => {
            held.current = false;
            clearTimer();
            const touch = event.touches[0];
            if (!touch) return;
            const point = { x: touch.clientX, y: touch.clientY };
            timer.current = setTimeout(() => {
              held.current = true;
              setContextPoint(point);
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
        <Button
          variant="ghost"
          size="small"
          className={styles.dismiss}
          onClick={dismiss}
          aria-label={t(
            dismissed ? "asyncQuestionRestore" : "asyncQuestionDismiss",
            { question: question.title },
          )}
        >
          {t(
            dismissed && showDismissed
              ? "asyncQuestionRestoreShort"
              : "asyncQuestionDismissShort",
          )}
        </Button>
        <Menu
          open={contextPoint !== null}
          onClose={() => setContextPoint(null)}
          anchorRef={previewRef}
          anchorPoint={contextPoint}
          placement="bottom-start"
          aria-label={question.title}
        >
          <MenuItem onSelect={dismiss}>
            {t(
              dismissed
                ? "asyncQuestionRestoreShort"
                : "asyncQuestionDismissShort",
            )}
          </MenuItem>
        </Menu>
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
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
    const previews = panel.current?.querySelectorAll<HTMLButtonElement>(
      "button[data-question-preview]",
    );
    previews?.[previews.length - 1]?.focus({ preventScroll: true });
  }, [open]);

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
  // A question asked in the current turn has no age worth stating.
  const newestAge =
    newest && newest.age > 0
      ? t(
          newest.age === 1
            ? "asyncQuestionOneTurnAgo"
            : "asyncQuestionTurnsAgo",
          { count: newest.age },
        )
      : null;
  const count = t(
    recent.length === 1 ? "asyncQuestionSingle" : "asyncQuestionCount",
    { count: recent.length },
  );
  const label = newest
    ? newestAge
      ? `${count} · ${newestAge}`
      : count
    : t("asyncQuestionsTitle");
  return (
    <>
      <Button
        variant={recent.length ? "attention-outline" : "secondary"}
        touchTarget="large"
        size="small"
        ref={button}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`${styles.indicator} ${overflow ? styles.overflowEntry : ""}`}
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
            {compact === "none" && newestAge && <span>· {newestAge}</span>}
          </>
        ) : (
          // The tightest tier (sidebar rows, the Inbox entry, a crowded
          // composer) keeps the icon alone. Spelling out "Questions" there
          // costs ~100px and squeezes the session title it sits beside; the
          // accessible name and tooltip still carry the wording.
          compact !== "late" && <span>{t("asyncQuestionsTitle")}</span>
        )}
      </Button>
      <Popover
        open={open}
        onClose={close}
        anchorRef={button}
        // The composer sits at the bottom, so its panel rises above it; the
        // sidebar and inbox rows open below. Either flips when short of room.
        placement={inventory ? "bottom-end" : "top-end"}
        offset={6}
        ref={panel}
        surface="card"
        className={styles.menu}
        style={{ maxHeight: "min(400px, var(--popover-available-height))" }}
        role="dialog"
        aria-label={t("asyncQuestionsTitle")}
        onKeyDown={(event) => {
          // A row's context menu (a nested portal) handles its own arrows.
          if (event.defaultPrevented) return;
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const targets = [
            ...(panel.current?.querySelectorAll<HTMLButtonElement>(
              "button[data-question-preview]",
            ) ?? []),
          ];
          const current = targets.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (!targets.length) return;
          event.preventDefault();
          targets[
            (current + (event.key === "ArrowDown" ? 1 : -1) + targets.length) %
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
        <div className={styles.menuFooter}>
          <Button
            variant="ghost"
            size="small"
            onClick={() => setShowDismissed(!showDismissed)}
          >
            {t(
              showDismissed
                ? "asyncQuestionHideDismissed"
                : "asyncQuestionShowDismissed",
            )}
          </Button>
          {reminders.length > 1 && (
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                for (const question of reminders)
                  state.update(question.id, { dismissed: true });
              }}
            >
              {t("asyncQuestionDismissAll")}
            </Button>
          )}
        </div>
      </Popover>
    </>
  );
}
