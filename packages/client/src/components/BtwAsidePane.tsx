import styles from "./BtwAsidePane.module.css";
import btwStyles from "./BtwAsideTranscript.module.css";
import listStyles from "./MessageList.module.css";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { useI18n } from "../i18n";
import { parseComposerSlashCommand } from "../lib/slashCommands";
import { TextBlock } from "./blocks/TextBlock";
import { UserPromptBlock } from "./blocks/UserPromptBlock";
import { Banner } from "./ui/Banner";
import { Button, IconButton } from "./ui/Button";

export type BtwAsidePaneStatus =
  | "draft"
  | "starting"
  | "running"
  | "complete"
  | "failed"
  | "stopped";

export interface BtwAsidePaneItem {
  id: string;
  request: string;
  followUps: string[];
  status: BtwAsidePaneStatus;
  error?: string;
  responses: string[];
  turns?: BtwAsideTranscriptTurn[];
}

export interface BtwAsideTranscriptTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface BtwAsidePaneProps {
  aside: BtwAsidePaneItem;
  draft: string;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (draft: string) => void;
  onSendFollowup: (text: string) => void;
  onHide: () => void;
  onDone: () => void;
  onStop?: () => void;
  onTransferToComposer?: (text: string) => void;
}

export function getBtwAsideTranscriptTurns(
  aside: BtwAsidePaneItem,
): BtwAsideTranscriptTurn[] {
  if (aside.turns?.length) {
    return aside.turns;
  }

  const turns: BtwAsideTranscriptTurn[] = [];
  if (aside.request) {
    turns.push({
      id: `${aside.id}-request`,
      role: "user",
      text: aside.request,
    });
  }

  const turnCount = Math.max(aside.responses.length, aside.followUps.length);
  for (let index = 0; index < turnCount; index += 1) {
    const response = aside.responses[index]?.trim();
    if (response) {
      turns.push({
        id: `${aside.id}-response-${index}`,
        role: "assistant",
        text: response,
      });
    }
    const followUp = aside.followUps[index]?.trim();
    if (followUp) {
      turns.push({
        id: `${aside.id}-followup-${index}`,
        role: "user",
        text: followUp,
      });
    }
  }

  return turns;
}

export function BtwAsideTranscript({
  aside,
  autoScrollLatest = false,
  onTransferToComposer,
}: {
  aside: BtwAsidePaneItem;
  autoScrollLatest?: boolean;
  onTransferToComposer?: (text: string) => void;
}) {
  const { t } = useI18n();
  const turns = useMemo(() => getBtwAsideTranscriptTurns(aside), [aside]);
  const latestAssistantTurn =
    [...turns].reverse().find((turn) => turn.role === "assistant") ?? null;
  const latestAssistantTurnRef = useRef<HTMLElement | null>(null);
  const latestAssistantSignature = latestAssistantTurn
    ? `${latestAssistantTurn.id}:${latestAssistantTurn.text.length}`
    : "";

  useEffect(() => {
    if (
      !autoScrollLatest ||
      !latestAssistantSignature ||
      !latestAssistantTurnRef.current
    ) {
      return;
    }
    latestAssistantTurnRef.current.scrollIntoView?.({
      block: "center",
      inline: "nearest",
    });
  }, [autoScrollLatest, latestAssistantSignature]);

  if (turns.length === 0) {
    return (
      <div
        className={styles["session-btw-pane-empty"]}
        data-session-btw-pane-empty
      >
        {t("btwAsideEmpty")}
      </div>
    );
  }

  return (
    <section
      className={btwStyles.btwAsideTranscript}
      data-btw-aside-transcript
      aria-label="/btw transcript"
    >
      {turns.map((turn) => {
        const isLatestAssistant = turn.id === latestAssistantTurn?.id;
        return (
          <article
            key={turn.id}
            ref={
              isLatestAssistant
                ? (element) => {
                    latestAssistantTurnRef.current = element;
                  }
                : undefined
            }
            className={`${btwStyles.btwAsideTurn} ${turn.role === "user" ? btwStyles.btwAsideTurnUser : btwStyles.btwAsideTurnAssistant} ${
              turn.role === "assistant" ? listStyles.assistantTurn : ""
            } ${isLatestAssistant ? `${btwStyles["is-latest-agent-turn"]}` : ""}`}
            data-btw-aside-turn
            data-btw-aside-turn-user={turn.role === "user" || undefined}
            data-btw-aside-turn-assistant={!(turn.role === "user") || undefined}
            data-assistant-turn={turn.role === "assistant" || undefined}
            data-is-latest-agent-turn={isLatestAssistant || undefined}
            data-btw-turn-role={turn.role}
          >
            {turn.role === "assistant" ? (
              <>
                <TextBlock text={turn.text} />
                {onTransferToComposer && (
                  <div
                    className={btwStyles.btwAsideTurnExtraActions}
                    data-btw-aside-turn-extra-actions
                  >
                    <TransferTurnButton
                      text={turn.text}
                      role={turn.role}
                      onTransferToComposer={onTransferToComposer}
                    />
                  </div>
                )}
              </>
            ) : (
              <UserPromptBlock
                content={turn.text}
                extraActions={
                  onTransferToComposer ? (
                    <TransferTurnButton
                      text={turn.text}
                      role={turn.role}
                      onTransferToComposer={onTransferToComposer}
                    />
                  ) : undefined
                }
              />
            )}
          </article>
        );
      })}
    </section>
  );
}

function TransferTurnButton({
  text,
  role,
  onTransferToComposer,
}: {
  text: string;
  role: BtwAsideTranscriptTurn["role"];
  onTransferToComposer: (text: string) => void;
}) {
  const label =
    role === "assistant"
      ? "Insert assistant /btw turn into Mother composer"
      : "Insert user /btw turn into Mother composer";

  return (
    <IconButton
      size="small"
      label={label}
      onClick={() => onTransferToComposer(text)}
    >
      <ArrowDownIntoComposerIcon />
    </IconButton>
  );
}

function ArrowDownIntoComposerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function BtwAsidePane({
  aside,
  draft,
  composerRef,
  onDraftChange,
  onSendFollowup,
  onHide,
  onDone,
  onStop,
  onTransferToComposer,
}: BtwAsidePaneProps) {
  const { t } = useI18n();
  const canStop = aside.status === "starting" || aside.status === "running";

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;

    onDraftChange("");
    const parsed = parseComposerSlashCommand(text);
    if (parsed?.kind === "custom" && parsed.command === "done") {
      onDone();
      return;
    }

    onSendFollowup(text);
  };

  return (
    <aside
      className={`${styles["session-btw-pane"]} ${({ failed: styles["is-failed"], stopped: styles["is-stopped"], complete: styles["is-complete"] } as Record<string, string>)[aside.status] ?? ""}`}
      data-session-btw-pane
      aria-label="/btw aside (Mother session continues alongside)"
    >
      <header
        className={styles["session-btw-pane-header"]}
        data-session-btw-pane-header
      >
        <div
          className={styles["session-btw-pane-meta"]}
          data-session-btw-pane-meta
        >
          <span className={btwStyles.btwAsideMeta} data-btw-aside-meta>
            /btw {aside.status}
          </span>
          <span
            className={styles["session-btw-pane-title"]}
            data-session-btw-pane-title
          >
            {aside.request || "New aside"}
          </span>
        </div>
        <div
          className={styles["session-btw-pane-actions"]}
          data-session-btw-pane-actions
        >
          <Button
            size="small"
            className={btwStyles.btwAsideAction}
            data-btw-aside-action
            onClick={onHide}
            title={t("btwAsideMinimizeTitle")}
          >
            Min
          </Button>
          {canStop && onStop && (
            <Button
              size="small"
              className={btwStyles.btwAsideAction}
              data-btw-aside-action
              onClick={onStop}
              title="Stop this /btw aside"
            >
              Stop
            </Button>
          )}
          <Button
            size="small"
            className={btwStyles.btwAsideAction}
            data-btw-aside-action
            onClick={() => onDone()}
            title={t("btwAsideDoneTitle")}
          >
            Done
          </Button>
        </div>
      </header>
      <div
        className={styles["session-btw-pane-body"]}
        data-session-btw-pane-body
      >
        <BtwAsideTranscript
          aside={aside}
          autoScrollLatest
          onTransferToComposer={onTransferToComposer}
        />
        {aside.error && (
          <Banner tone="error" compact>
            {aside.error}
          </Banner>
        )}
      </div>
      <form
        className={styles["session-btw-pane-composer"]}
        data-session-btw-pane-composer
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <textarea
          ref={composerRef}
          className={styles["session-btw-pane-composer-textarea"]}
          data-session-btw-pane-composer-textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submitDraft();
            }
          }}
          placeholder="/btw follow-up - Enter to send, /done closes"
          rows={2}
          aria-label="/btw aside composer"
        />
        <Button variant="primary" type="submit" disabled={!draft.trim()}>
          Send
        </Button>
      </form>
    </aside>
  );
}
