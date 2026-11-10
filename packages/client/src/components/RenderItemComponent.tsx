import { ConversationActivitySummary } from "./ConversationActivity";
import promptStyles from "./blocks/UserPromptBlock.module.css";
import collapsibleStyles from "./Collapsible.module.css";
import { memo, useCallback, useRef } from "react";
import { useSessionRewind } from "../contexts/SessionRewindContext";
import { useI18n } from "../i18n";
import { getRenderItemRewoundGroupId } from "../lib/sessionDetail/renderItems";
import { ButtonBase } from "./ui/Button";
import { CopyTextButton } from "./ui/CopyTextButton";
import { AsyncQuestionMessage } from "./AsyncQuestions";
import {
  MESSAGE_STALE_THRESHOLD_MS,
  getEarliestMessageTimestampMs,
  getLatestMessageTimestampMs,
} from "../lib/messageAge";
import {
  getCancellableUnconfirmedSteerTempId,
  getUserPromptDeliveryState,
} from "../lib/deliveryState";
import { useQuoteableTextSource } from "../hooks/useQuoteableTextSource";
import type { CommentAnchor } from "../lib/commentAnchors";
import type { ContentBlock } from "../types";
import type {
  ConversationThinkingPreviewSlot,
  RenderItem,
} from "@yep-anywhere/shared/transcript/items";
import { MessageAge } from "./MessageAge";
import {
  BangCommandDisplayObject,
  type BangCommandHandlers,
} from "./BangCommandDisplayObject";
import { ForkSummaryDisplayObject } from "./ForkSummaryDisplayObject";
import { GoalNotice } from "./GoalNotice";
import { SessionSetupBlock } from "./blocks/SessionSetupBlock";
import { TaskNotificationBlock } from "./blocks/TaskNotificationBlock";
import { TextBlock } from "./blocks/TextBlock";
import { ThinkingBlock } from "./blocks/ThinkingBlock";
import { ToolCallRow } from "./blocks/ToolCallRow";
import { UserPromptBlock } from "./blocks/UserPromptBlock";
import { LinkifiedText } from "./ui/LinkifiedText";
import { Spinner } from "./ui/Spinner";
import styles from "./RenderItemComponent.module.css";
import { WorkflowContext } from "./WorkflowOutput";
import { WorkflowAssistantOutput } from "./WorkflowAssistantOutput";
import { SessionAppLinks } from "./SessionAppLinks";
interface Props {
  item: RenderItem;
  isStreaming: boolean;
  thinkingExpanded: boolean;
  toggleThinkingExpanded: () => void;
  sessionProvider?: string;
  onCorrectUserPrompt?: () => void;
  onCancelUnconfirmedUserPrompt?: (tempId: string) => void;
  onTrimBeforeUserPrompt?: () => void;
  onForkBeforeUserPrompt?: () => void;
  onForkAfterUserPrompt?: () => void;
  onForkAfterSummaryUserPrompt?: () => void;
  forkAfterUserPromptDisabled?: boolean;
  forkUnavailableMessage?: string;
  onQuoteTextBlock?: (anchor: CommentAnchor) => void;
  alwaysShowQuoteCircle?: boolean;
  paragraphQuoteCirclesEnabled?: boolean;
  staleNowMs?: number;
  thinkingDurationMs?: number;
  getForkSummaryTargetHref?: (targetSessionId: string) => string;
  onCancelForkSummary?: (objectId: string) => void;
  onToggleForkSummaryAutoOpen?: (objectId: string, value: boolean) => void;
  onFollowForkSummary?: (objectId: string) => void;
  bangCommandHandlers?: BangCommandHandlers;
  onToggleConversationActivity?: (itemId: string) => void;
  widerConversationActivityPreviews?: boolean;
  collapsedConversationThinkingPreviewSlots?: ReadonlySet<ConversationThinkingPreviewSlot>;
  onToggleConversationThinkingPreview?: (
    slot: ConversationThinkingPreviewSlot,
  ) => void;
  onDismissConversationThinkingPreview?: (
    slot: ConversationThinkingPreviewSlot,
  ) => void;
}

function getMessageIdLike(message: Record<string, unknown>): string {
  if (typeof message.uuid === "string" && message.uuid.length > 0) {
    return message.uuid;
  }
  if (typeof message.id === "string" && message.id.length > 0) {
    return message.id;
  }
  return "<missing>";
}

function summarizeSourceMessages(messages: RenderItem["sourceMessages"]) {
  const bySource: Record<string, number> = {
    sdk: 0,
    jsonl: 0,
    unknown: 0,
  };
  const byType: Record<string, number> = {};
  const ids: string[] = [];
  let streamEventCount = 0;
  let streamingPlaceholderCount = 0;

  for (const message of messages) {
    const source =
      message._source === "sdk" || message._source === "jsonl"
        ? message._source
        : "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;

    const type = typeof message.type === "string" ? message.type : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    if (type === "stream_event") {
      streamEventCount++;
    }
    if (message._isStreaming) {
      streamingPlaceholderCount++;
    }

    ids.push(getMessageIdLike(message as Record<string, unknown>));
  }

  return {
    total: messages.length,
    bySource,
    byType,
    streamEventCount,
    streamingPlaceholderCount,
    ids,
  };
}

function buildDebugSnapshot(
  item: RenderItem,
  props: {
    isStreaming: boolean;
    thinkingExpanded: boolean;
    sessionProvider?: string;
  },
) {
  const sourceSummary = summarizeSourceMessages(item.sourceMessages);

  return {
    render: {
      id: item.id,
      type: item.type,
      isSubagent: item.isSubagent ?? false,
    },
    uiContext: {
      sessionProvider: props.sessionProvider ?? "unknown",
      sessionIsStreaming: props.isStreaming,
      thinkingExpanded: props.thinkingExpanded,
    },
    itemContext:
      item.type === "tool_call"
        ? {
            toolName: item.toolName,
            status: item.status,
            hasToolResult: Boolean(item.toolResult),
            hasStructuredResult: item.toolResult?.structured !== undefined,
            toolUseId: item.id,
          }
        : item.type === "text"
          ? {
              isStreamingTextBlock: item.isStreaming ?? false,
              hasAugmentHtml: Boolean(item.augmentHtml),
            }
          : item.type === "thinking"
            ? {
                status: item.status,
                thinkingLength: item.thinking.length,
              }
            : item.type === "system"
              ? {
                  subtype: item.subtype,
                  status: item.status ?? null,
                }
              : item.type === "session_setup"
                ? {
                    promptCount: item.prompts.length,
                  }
                : null,
    sourceSummary,
    sourceMessages: item.sourceMessages,
    renderItem: item,
  };
}

function systemDetailToText(detail: string | ContentBlock[]): string {
  if (typeof detail === "string") {
    return detail;
  }

  return detail
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "tool_result" && typeof block.content === "string") {
        return block.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const COMPACT_EMPTY_DETAIL =
  "No provider summary was retained for this compaction.";

/**
 * The local-command marker is itself a slash, so a row whose text already
 * starts with the command's own slash would read as a stray "/ /command".
 * Drop the marker there; the command name carries it.
 */
function systemIconForText(icon: string, text: string): string {
  return icon === "/" && text.trimStart().startsWith("/") ? "" : icon;
}

interface RewoundGroupDetails {
  reason?: string;
  cutTurnIndex?: number;
  droppedTurnCount?: number;
  rowCount?: number;
  clearloopIteration?: number;
  clearloopTotal?: number;
  clearloopPrompt?: string;
}

/**
 * Header row of a rewound group (topics/session-rewind.md § Durable
 * history). The group's body rows are shown or hidden by the display filter
 * through the shared rewind context; this row only owns the toggle.
 */
function RewoundGroupHeader({
  item,
}: {
  item: Extract<RenderItem, { type: "system" }>;
}) {
  const { t } = useI18n();
  const rewind = useSessionRewind();
  const groupId = getRenderItemRewoundGroupId(item);
  const source = item.sourceMessages[0] as
    | { rewoundGroup?: RewoundGroupDetails }
    | undefined;
  const details = source?.rewoundGroup ?? {};
  const expanded = groupId ? rewind.expandedRewoundGroups.has(groupId) : false;
  const count = String(details.droppedTurnCount ?? details.rowCount ?? 0);
  const index = String(details.cutTurnIndex ?? 0);
  // Reads as the command that produced it: `/clear N`, or for a clearloop
  // iteration `/clear N [#m/M: prompt]` (topics/session-rewind.md).
  const label =
    details.clearloopIteration !== undefined
      ? t("rewoundGroupClearloopLabel", {
          iteration: String(details.clearloopIteration),
          total: String(details.clearloopTotal ?? "?"),
          prompt: details.clearloopPrompt ?? "",
          index,
        })
      : t("rewoundGroupLabel", { index });
  const tooltip = t("rewoundGroupTooltip", { count });
  // A clearloop iteration's header copies the command that would resume the
  // loop from here: the iterations still to run after this one.
  const relaunchCommand =
    details.clearloopIteration !== undefined &&
    details.clearloopTotal !== undefined &&
    details.clearloopPrompt
      ? `/clearloop ${index} ${Math.max(0, details.clearloopTotal - details.clearloopIteration)}: ${details.clearloopPrompt}`
      : null;
  return (
    <div
      className={`${styles.systemMessage} ${styles.systemMessageLocalCommand} ${styles.rewoundGroupHeader}`}
      data-system-message
      data-system-message-local-command
    >
      <ButtonBase
        className={styles.rewoundGroupToggleButton}
        aria-expanded={expanded}
        title={`${tooltip} — ${expanded ? t("rewoundGroupCollapse") : t("rewoundGroupExpand")}`}
        onClick={() => groupId && rewind.toggleRewoundGroup(groupId)}
      >
        <span className={styles.rewoundGroupToggle} aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
        <span className={styles.systemMessageIcon} data-system-message-icon>
          ↶
        </span>
        <span className={styles.systemMessageText} data-system-message-text>
          {label}
        </span>
      </ButtonBase>
      {relaunchCommand && (
        <CopyTextButton
          text={relaunchCommand}
          label={t("rewoundGroupCopyRelaunch")}
          className={`${promptStyles.userPromptAction} user-prompt-action-copy ${styles.rewoundGroupCopy}`}
          data-user-prompt-action
        />
      )}
    </div>
  );
}

/**
 * A provider response blocked by its content filter, with the recovery
 * guidance the provider gave the agent before retrying. The guidance is the
 * only record of what happened, so it is always shown.
 */
function ContentFilterBlockNotice({ guidance }: { guidance: string }) {
  const { t } = useI18n();
  return (
    <div
      className={`${styles.systemMessage} ${styles.systemMessageWarning} ${styles.contentFilterBlock}`}
      data-system-message
      data-system-message-warning
    >
      <div className={styles.contentFilterBlockTitle}>
        <span
          className={styles.systemMessageIcon}
          data-system-message-icon
          aria-hidden="true"
        >
          !
        </span>
        <span>{t("contentFilterBlockTitle")}</span>
      </div>
      {guidance && (
        <p className={styles.contentFilterBlockGuidance}>
          <span className={styles.contentFilterBlockLabel}>
            {t("contentFilterBlockGuidanceLabel")}
          </span>{" "}
          {guidance}
        </p>
      )}
    </div>
  );
}

function CollapsibleSystemMessage({
  item,
  icon,
  label,
}: {
  item: Extract<RenderItem, { type: "system" }>;
  icon: string;
  label?: string;
}) {
  const details = (item.details ?? [])
    .map((detail) => ({ detail, text: systemDetailToText(detail).trim() }))
    .filter(({ text }) => Boolean(text));
  const isCompactBoundary = item.subtype === "compact_boundary";
  const isToolOutput = item.subtype === "tool_output";
  const variantClass = isCompactBoundary
    ? styles.systemMessageCompactBoundary
    : styles.systemMessageLocalCommand;
  const summaryClass = isCompactBoundary
    ? `${styles.systemMessageSummary} system-message-compact-summary`
    : `${styles.systemMessageSummary} system-message-local-command-summary`;
  const text = label ?? item.content;
  const resolvedIcon = systemIconForText(icon, text);

  // All compact boundaries stay outline-expandable so users can inspect what
  // was kept/summarized; local-command rows still collapse to a flat chip when
  // they have no detail body.
  if (!isCompactBoundary && details.length === 0) {
    return (
      <div
        className={`${styles.systemMessage} ${variantClass}`}
        data-system-message
        data-system-message-compact-boundary={isCompactBoundary || undefined}
        data-system-message-local-command={!isCompactBoundary || undefined}
      >
        {resolvedIcon && (
          <span className={styles.systemMessageIcon} data-system-message-icon>
            {resolvedIcon}
          </span>
        )}
        <span className={styles.systemMessageText} data-system-message-text>
          <LinkifiedText text={text} />
        </span>
      </div>
    );
  }

  const resolvedDetails =
    details.length > 0
      ? details
      : [{ detail: COMPACT_EMPTY_DETAIL, text: COMPACT_EMPTY_DETAIL }];

  return (
    <details
      className={`${styles.systemMessage} ${variantClass} ${variantClass}--details ${styles.systemMessageDetails}${
        isCompactBoundary ? ` ${styles.compactBoundaryOutline}` : ""
      }`}
      data-system-message
      data-system-message-compact-boundary={isCompactBoundary || undefined}
      data-system-message-local-command={!isCompactBoundary || undefined}
      data-system-message--details
      open={item.detailsOpen === true ? true : undefined}
    >
      <summary
        className={summaryClass}
        data-system-message-summary={
          isCompactBoundary || !isCompactBoundary || undefined
        }
      >
        <span
          className={collapsibleStyles.collapsibleIcon}
          data-collapsible__icon
          aria-hidden="true"
        >
          ▸
        </span>
        {resolvedIcon && (
          <span className={styles.systemMessageIcon} data-system-message-icon>
            {resolvedIcon}
          </span>
        )}
        <span className={styles.systemMessageText} data-system-message-text>
          <LinkifiedText text={text} />
        </span>
      </summary>
      <div
        className={`${styles.systemDetails}${
          isToolOutput ? ` ${styles.toolOutputDetails}` : ""
        }`}
      >
        {resolvedDetails.map(({ detail, text }, index) =>
          isCompactBoundary &&
          Array.isArray(detail) &&
          detail.every((block) => block.type === "text") ? (
            <div
              className={styles.compactSummaryMarkdown}
              key={`${item.id}-system-detail-${index}`}
            >
              {detail.map((block, blockIndex) =>
                block.type === "text" ? (
                  <TextBlock
                    key={`${item.id}-system-detail-${index}-${blockIndex}`}
                    text={block.text ?? ""}
                    augmentHtml={
                      typeof block._html === "string" ? block._html : undefined
                    }
                    paragraphQuoteCirclesEnabled={false}
                  />
                ) : null,
              )}
            </div>
          ) : (
            <pre
              className={styles.systemDetail}
              key={`${item.id}-system-detail-${index}`}
            >
              {text}
            </pre>
          ),
        )}
      </div>
    </details>
  );
}

export const RenderItemComponent = memo(function RenderItemComponent({
  item,
  isStreaming,
  thinkingExpanded,
  toggleThinkingExpanded,
  sessionProvider,
  onCorrectUserPrompt,
  onCancelUnconfirmedUserPrompt,
  onTrimBeforeUserPrompt,
  onForkBeforeUserPrompt,
  onForkAfterUserPrompt,
  onForkAfterSummaryUserPrompt,
  forkAfterUserPromptDisabled,
  forkUnavailableMessage,
  onQuoteTextBlock,
  alwaysShowQuoteCircle,
  paragraphQuoteCirclesEnabled,
  staleNowMs,
  thinkingDurationMs,
  getForkSummaryTargetHref,
  onCancelForkSummary,
  onToggleForkSummaryAutoOpen,
  onFollowForkSummary,
  bangCommandHandlers,
  onToggleConversationActivity,
  widerConversationActivityPreviews = false,
  collapsedConversationThinkingPreviewSlots = new Set<ConversationThinkingPreviewSlot>(),
  onToggleConversationThinkingPreview,
  onDismissConversationThinkingPreview,
}: Props) {
  const { t } = useI18n();
  const staticAgeNowMsRef = useRef(Date.now());
  const timestampMs = getLatestMessageTimestampMs(item.sourceMessages);
  const hasTimestamp =
    item.type !== "conversation_activity" && timestampMs !== null;
  const isLatestVisibleTimestamp = hasTimestamp && staleNowMs !== undefined;
  const ageNowMs = isLatestVisibleTimestamp
    ? (staleNowMs ?? Date.now())
    : staticAgeNowMsRef.current;
  const showAgeByDefault =
    isLatestVisibleTimestamp &&
    ageNowMs !== null &&
    ageNowMs - timestampMs >= MESSAGE_STALE_THRESHOLD_MS;
  const recapQuoteRef = useQuoteableTextSource<HTMLSpanElement>(
    item.type === "system" && item.subtype === "away_summary"
      ? item.content
      : "",
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't interfere with text selection (important for mobile long-press)
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return;
      }

      // Shift+click to debug (not Cmd/Ctrl+click, which opens links in new tabs)
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        console.log(
          "[DEBUG] Render snapshot",
          buildDebugSnapshot(item, {
            isStreaming,
            thinkingExpanded,
            sessionProvider,
          }),
        );
      }
    },
    [item, isStreaming, thinkingExpanded, sessionProvider],
  );

  const renderContent = () => {
    switch (item.type) {
      case "text":
        return (
          <AsyncQuestionMessage
            renderId={item.id}
            projectPathLinks={item.projectPathLinks}
            fallback={
              <TextBlock
                text={item.text}
                isStreaming={item.isStreaming}
                abortedMidStream={item.abortedMidStream}
                augmentHtml={item.augmentHtml}
                projectPathLinks={item.projectPathLinks}
                renderItemId={item.id}
                onQuoteBlock={onQuoteTextBlock}
                alwaysShowQuoteCircle={alwaysShowQuoteCircle}
                paragraphQuoteCirclesEnabled={paragraphQuoteCirclesEnabled}
              />
            }
          />
        );

      case "thinking":
        return (
          <ThinkingBlock
            thinking={item.thinking}
            status={item.status}
            isExpanded={thinkingExpanded}
            onToggle={toggleThinkingExpanded}
            durationMs={thinkingDurationMs}
          />
        );

      case "tool_call":
        return (
          <ToolCallRow
            id={item.id}
            toolName={item.toolName}
            toolInput={item.toolInput}
            toolResult={item.toolResult}
            workflow={item.workflow}
            status={item.status}
            sessionProvider={sessionProvider}
            startTimestampMs={getEarliestMessageTimestampMs(
              item.sourceMessages,
            )}
            resultTimestampMs={
              item.sourceMessages.length > 1 ? timestampMs : null
            }
            mcpApp={item.mcpApp}
          />
        );

      case "user_prompt": {
        const deliveryState = getUserPromptDeliveryState(item.sourceMessages);
        const cancellableTempId = getCancellableUnconfirmedSteerTempId(
          item.sourceMessages,
        );
        return (
          <UserPromptBlock
            content={item.content}
            messageId={item.id}
            projectPathLinks={item.projectPathLinks}
            onCorrect={onCorrectUserPrompt}
            onCancelUnconfirmed={
              cancellableTempId && onCancelUnconfirmedUserPrompt
                ? () => onCancelUnconfirmedUserPrompt(cancellableTempId)
                : undefined
            }
            onTrimBefore={onTrimBeforeUserPrompt}
            onForkBefore={onForkBeforeUserPrompt}
            onForkAfter={onForkAfterUserPrompt}
            onForkAfterSummary={onForkAfterSummaryUserPrompt}
            forkAfterDisabled={forkAfterUserPromptDisabled}
            forkUnavailableMessage={forkUnavailableMessage}
            deliveryState={deliveryState}
          />
        );
      }

      case "session_setup":
        return <SessionSetupBlock title={item.title} prompts={item.prompts} />;

      case "transcript_display_object": {
        const displayObject = item.object;
        if (displayObject.kind === "bang-command") {
          return (
            <BangCommandDisplayObject
              object={displayObject}
              handlers={bangCommandHandlers}
            />
          );
        }
        return (
          <ForkSummaryDisplayObject
            object={displayObject}
            targetHref={
              displayObject.targetSessionId
                ? getForkSummaryTargetHref?.(displayObject.targetSessionId)
                : undefined
            }
            onCancel={() => onCancelForkSummary?.(displayObject.id)}
            onToggleAutoOpen={(value) =>
              onToggleForkSummaryAutoOpen?.(displayObject.id, value)
            }
            onFollow={() => onFollowForkSummary?.(displayObject.id)}
          />
        );
      }

      case "task_notification":
        return <TaskNotificationBlock item={item} />;

      case "conversation_activity":
        return (
          <ConversationActivitySummary
            item={item}
            onToggle={onToggleConversationActivity}
            collapsedThinkingPreviewSlots={
              collapsedConversationThinkingPreviewSlots
            }
            onToggleThinkingPreview={onToggleConversationThinkingPreview}
            onDismissThinkingPreview={onDismissConversationThinkingPreview}
            widerActivityPreviews={widerConversationActivityPreviews}
          />
        );

      case "system": {
        if (item.subtype === "rewound_group") {
          return <RewoundGroupHeader item={item} />;
        }
        if (item.subtype === "local_command" && item.content === "/goal") {
          const [objective = "", ...status] = (item.details ?? []).map(
            systemDetailToText,
          );
          return (
            <GoalNotice objective={objective} status={status.join("\n")} />
          );
        }
        if (item.subtype === "away_summary") {
          return (
            <div
              className={styles.systemMessageRecap}
              data-system-message-recap
            >
              <span
                className={styles.systemMessageRecapMark}
                data-system-message-recap-mark
              >
                ※
              </span>
              <span
                ref={recapQuoteRef}
                className={styles.systemMessageRecapBody}
                data-system-message-recap-body
              >
                <LinkifiedText text={item.content} />
              </span>
            </div>
          );
        }
        if (item.subtype === "content_filter_block") {
          return <ContentFilterBlockNotice guidance={item.content} />;
        }

        // Different styling for compacting vs completed compaction
        const isCompacting =
          item.subtype === "status" && item.status === "compacting";
        const isError = item.subtype === "error";
        const isWarning = item.subtype === "warning";
        const isInformational = item.subtype === "informational";
        const isConfigAck = item.subtype === "config_ack";
        const isLocalCommand = item.subtype === "local_command";
        const isToolOutput = item.subtype === "tool_output";
        const isSubagentActivity = item.subtype === "subagent_activity";
        const isNoModelTurn = item.subtype === "no_model_turn";
        const isHistorySearchGap = item.subtype === "history_search_gap";
        const isHighlightedConfigAck =
          isConfigAck && item.configChanged !== false;
        const icon =
          isError || isWarning
            ? "!"
            : isInformational
              ? "i"
              : isConfigAck
                ? "✓"
                : isLocalCommand
                  ? "/"
                  : isToolOutput
                    ? "<"
                    : isSubagentActivity
                      ? "↳"
                      : isNoModelTurn
                        ? "∅"
                        : isHistorySearchGap
                          ? "⋯"
                          : "⟳";
        if (
          item.subtype === "compact_boundary" ||
          isLocalCommand ||
          isToolOutput
        ) {
          return (
            <CollapsibleSystemMessage
              item={item}
              icon={icon}
              label={
                isToolOutput
                  ? item.content
                    ? t("toolOutputFrom", { tool: item.content })
                    : t("toolOutput")
                  : undefined
              }
            />
          );
        }
        return (
          <div
            className={`${styles.systemMessage} ${isCompacting ? styles.systemMessageCompacting : ""} ${isError ? styles.systemMessageError : ""} ${isWarning ? styles.systemMessageWarning : ""} ${isHighlightedConfigAck ? styles.systemMessageConfigAck : ""} ${isLocalCommand ? styles.systemMessageLocalCommand : ""}`}
            data-system-message
            data-system-message-compacting={isCompacting || undefined}
            data-system-message-error={isError || undefined}
            data-system-message-warning={isWarning || undefined}
            data-system-message-config-ack={isHighlightedConfigAck || undefined}
            data-system-message-local-command={isLocalCommand || undefined}
          >
            {isCompacting && <Spinner size="small" />}
            {!isCompacting && systemIconForText(icon, item.content) && (
              <span
                className={styles.systemMessageIcon}
                data-system-message-icon
              >
                {systemIconForText(icon, item.content)}
              </span>
            )}
            <span className={styles.systemMessageText} data-system-message-text>
              <LinkifiedText text={item.content} />
            </span>
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: debug shift-click uses row-level event metadata
    // biome-ignore lint/a11y/useKeyWithClickEvents: debug feature, shift+click only
    <div
      className={[
        styles.messageRenderRow,
        hasTimestamp ? `${styles["has-message-age"]}` : "",
        showAgeByDefault ? `${styles["is-message-age-visible"]}` : "",
        item.isSubagent ? styles.subagentItem : "",
        // Rewound rows reuse the nested (subagent) presentation.
        getRenderItemRewoundGroupId(item) &&
        !(item.type === "system" && item.subtype === "rewound_group")
          ? `${styles.subagentItem} ${styles.rewoundItem}`
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-message-render-row
      data-has-message-age={hasTimestamp || undefined}
      data-is-message-age-visible={showAgeByDefault || undefined}
      data-subagent-item={
        item.isSubagent ||
        (getRenderItemRewoundGroupId(item) &&
          !(item.type === "system" && item.subtype === "rewound_group")) ||
        undefined
      }
      data-render-type={item.type}
      data-render-id={item.id}
      data-rewound-group={
        item.type === "system" && item.subtype === "rewound_group"
          ? undefined
          : getRenderItemRewoundGroupId(item)
      }
      onClick={handleClick}
    >
      <div className={styles.messageRenderContent} data-message-render-content>
        {item.type === "tool_call" && item.workflow ? (
          <WorkflowContext workflow={item.workflow} />
        ) : null}
        {item.type === "text" && item.workflow?.markers.length ? (
          <WorkflowAssistantOutput
            text={item.text}
            workflow={item.workflow}
            isStreaming={item.isStreaming}
            original={renderContent()}
            renderText={(text, html) => (
              <TextBlock
                text={text}
                augmentHtml={html}
                projectPathLinks={item.projectPathLinks}
                renderItemId={item.id}
                onQuoteBlock={onQuoteTextBlock}
                alwaysShowQuoteCircle={alwaysShowQuoteCircle}
                paragraphQuoteCirclesEnabled={paragraphQuoteCirclesEnabled}
              />
            )}
          />
        ) : (
          renderContent()
        )}
        {(item.type === "tool_call" ||
          item.type === "conversation_activity") && (
          <SessionAppLinks messages={item.sourceMessages} />
        )}
      </div>
      <MessageAge timestampMs={timestampMs} nowMs={ageNowMs ?? Date.now()} />
    </div>
  );
});
