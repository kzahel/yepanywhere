import { useId, useRef, useState } from "react";
import { useI18n } from "../i18n";
import styles from "./QuestionAsideCard.module.css";
import { Button, IconButton } from "./ui/Button";
import { Popover } from "./ui/Popover";

export interface QuestionAsideCardProps {
  question: string;
  answers: readonly string[];
  status:
    | "starting"
    | "running"
    | "complete"
    | "failed"
    | "saving"
    | "sending"
    | "moving";
  error?: string;
  onSave: () => void;
  onDiscard: () => void;
  onSteer: () => void;
  onContinueAsBtw: () => void;
}

export function QuestionAsideHint({ mobile }: { mobile: boolean }) {
  const { t } = useI18n();
  return (
    <div className={styles.hint} role="status">
      {t(mobile ? "questionAsideHintMobile" : "questionAsideHintDesktop")}
    </div>
  );
}

export function QuestionAsideCard({
  question,
  answers,
  status,
  error,
  onSave,
  onDiscard,
  onSteer,
  onContinueAsBtw,
}: QuestionAsideCardProps) {
  const { t } = useI18n();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();
  const helpButton = useRef<HTMLButtonElement>(null);
  const complete = status === "complete" && answers.length > 0;
  const saving = status === "saving";
  const sending = status === "sending";
  const moving = status === "moving";
  const showSteer = status === "failed" || sending;
  return (
    <section
      className={styles.card}
      aria-label={t("questionAsideTitle")}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setHelpOpen(false);
      }}
    >
      <div className={styles.content}>
        <div className={styles.question}>{question}</div>
        {answers.map((text, index) => (
          <div key={`${index}:${text.length}`} className={styles.answer}>
            {text}
          </div>
        ))}
        {(status === "starting" || status === "running") && (
          <div className={styles.status} role="status">
            {t("questionAsideAnswering")}
          </div>
        )}
        {error && (
          <div className={styles.status} role="alert">
            {error}
          </div>
        )}
      </div>
      <footer className={styles.actions}>
        {showSteer ? (
          <Button
            variant="primary"
            disabled={sending}
            onClick={onSteer}
            title={t("toolbarShortcutSteerCurrentTurn")}
          >
            {t(sending ? "asyncQuestionSending" : "toolbarSteerShortLabel")}
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              aria-label={t(
                saving ? "questionAsideSaving" : "questionAsideSave",
              )}
              disabled={!complete || saving}
              onClick={onSave}
              title={t("questionAsideSaveShortcut")}
            >
              {t(saving ? "questionAsideSaving" : "questionAsideSave")}
            </Button>
            <kbd title={t("questionAsideSaveShortcut")}>↵</kbd>
          </>
        )}
        <Button
          disabled={!complete || moving}
          onClick={onContinueAsBtw}
          title={t("questionAsideContinueDescription")}
        >
          {t(moving ? "questionAsideContinuing" : "questionAsideContinue")}
        </Button>
        <Button
          variant="danger-outline"
          aria-label={t("questionAsideDiscard")}
          disabled={saving || sending || moving}
          onClick={onDiscard}
        >
          {t("questionAsideDiscard")}
          <kbd>Esc</kbd>
        </Button>
        <IconButton
          ref={helpButton}
          className={styles.help}
          label={t("questionAsideTitle")}
          tooltip={
            helpOpen
              ? t("questionAsideTitle")
              : `${t("questionAsideTitle")}. ${t("questionAsideMainComposer")}. ${t("questionAsideSaveDescription")}`
          }
          aria-expanded={helpOpen}
          aria-controls={helpId}
          onClick={() => setHelpOpen(!helpOpen)}
        >
          ?
        </IconButton>
        {/* Escape with the help open closes only the help (the popover
            takes the topmost Escape); with it closed, Escape reaches the
            composer and discards the aside. */}
        <Popover
          open={helpOpen}
          onClose={() => setHelpOpen(false)}
          anchorRef={helpButton}
          placement="top-end"
          offset={8}
          id={helpId}
          surface="card"
          className={styles.helpContent}
          role="tooltip"
        >
          <strong>{t("questionAsideTitle")}</strong>
          <p>
            {t("questionAsideMainComposer")}.{" "}
            {t("questionAsideSaveDescription")}
          </p>
          <p>{t("questionAsideSaveShortcut")}</p>
        </Popover>
      </footer>
    </section>
  );
}
