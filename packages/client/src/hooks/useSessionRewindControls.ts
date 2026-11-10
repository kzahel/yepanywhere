import {
  parseClearloopArguments,
  parseTurnIndexArgument,
} from "@yep-anywhere/shared";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ClearloopBadgeControls } from "../components/ClearloopRemainingBadge";
import { confirmDialog } from "../components/ui/ConfirmDialog";
import type { SessionRewindContextValue } from "../contexts/SessionRewindContext";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import { activityBus } from "../lib/activityBus";
import { turnContentText } from "../lib/sessionMessageText";
import {
  getSessionTurnIndex,
  rewindThenDraftPrompt,
} from "../lib/sessionRewind";
import type { Message } from "../types";
import type { DraftControls } from "./useDraftPersistence";
import { useRemoteBasePath } from "./useRemoteBasePath";

export type SessionRewindCommand = "clear" | "fork" | "clearloop";

export interface UseSessionRewindControlsOptions {
  projectId: string;
  sessionId: string;
  messages: Message[];
  /** Server and provider support in-place rewind; gates the turn-menu entries. */
  supportsRewind: boolean;
  /** Provider and model a `/clear 0` new session starts with. */
  provider: string | undefined;
  model: string | undefined;
  /** Replace the loaded window with the server's regrouped projection. */
  refreshTranscriptTail: () => Promise<void>;
  draftControlsRef: RefObject<DraftControls | null>;
  recordCommandRecall: (commandText: string) => void;
  createDirectTurnFork: (
    sourceMessageId: string,
    forkKind: "before-user-turn" | "after-user-turn",
  ) => Promise<void>;
}

export interface SessionRewindControls {
  /** Value for `SessionRewindProvider`: turn index, Clear entries, groups. */
  contextValue: SessionRewindContextValue;
  /** Runs `/clear N`, `/fork N` or `/clearloop`; always consumes the command. */
  handleRewindCommand: (
    command: SessionRewindCommand,
    argument: string,
  ) => boolean;
  clearloopControls: ClearloopBadgeControls;
  cancelClearloop: () => Promise<void>;
}

/**
 * Same-session rewind for one session page (topics/session-rewind.md): the
 * stable turn index N, the turn-menu Clear entries, `/clear N`, `/fork N`,
 * `/clearloop`, and applying rewinds performed elsewhere.
 */
export function useSessionRewindControls({
  projectId,
  sessionId,
  messages,
  supportsRewind,
  provider,
  model,
  refreshTranscriptTail,
  draftControlsRef,
  recordCommandRecall,
  createDirectTurnFork,
}: UseSessionRewindControlsOptions): SessionRewindControls {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const basePath = useRemoteBasePath();
  const navigate = useNavigate();
  // Rewinds this view has already asked the server to project, so the
  // metadata event echoing this tab's own rewind costs no second fetch.
  const projectedRewindIdsRef = useRef(new Set<string>());
  const refreshForRewind = useCallback(
    (recordId: string) => {
      if (projectedRewindIdsRef.current.has(recordId)) return;
      projectedRewindIdsRef.current.add(recordId);
      void refreshTranscriptTail();
    },
    [refreshTranscriptTail],
  );

  const sessionTurnIndex = useMemo(
    () => getSessionTurnIndex(messages),
    [messages],
  );
  const [expandedRewoundGroups, setExpandedRewoundGroups] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const toggleRewoundGroup = useCallback((groupId: string) => {
    setExpandedRewoundGroups((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);
  const rewindToCut = useCallback(
    async (cut: {
      kind: "after-user-turn" | "before-user-turn";
      sourceMessageId: string;
    }): Promise<boolean> => {
      try {
        // The server takes the record's N from the kept turn's own stamp.
        const result = await api.rewindSession(projectId, sessionId, { cut });
        if (result.noop) {
          showToast(t("rewindNoop"), "success");
          return true;
        }
        showToast(
          t("rewindDone", {
            count: String(result.record?.droppedTurnCount ?? 0),
          }),
          "success",
        );
        // Group membership is the server's (topics/session-rewind.md); the
        // view takes its projection rather than regrouping rows itself.
        if (result.record) refreshForRewind(result.record.id);
        return true;
      } catch (error) {
        showToast(
          t("rewindFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
          "error",
        );
        return false;
      }
    },
    [projectId, refreshForRewind, sessionId, showToast, t],
  );
  const clearAfterUserMessage = useCallback(
    (messageId: string) => {
      void rewindToCut({ kind: "after-user-turn", sourceMessageId: messageId });
    },
    [rewindToCut],
  );
  const clearReplacingUserMessage = useCallback(
    (messageId: string) => {
      const index = sessionTurnIndex.indexById.get(messageId) ?? 1;
      if (index <= 1) {
        // Turn 1 has no earlier boundary; an empty prefix is the
        // new-session Clear (topics/session-rewind.md § Commands).
        showToast(t("rewindClearZero"), "error");
        return;
      }
      const source = messages.find((m) => (m.uuid ?? m.id) === messageId);
      const promptText = turnContentText(source?.message?.content).trim();
      void rewindThenDraftPrompt(
        () =>
          rewindToCut({ kind: "before-user-turn", sourceMessageId: messageId }),
        promptText,
        () => draftControlsRef.current,
      );
    },
    [draftControlsRef, messages, rewindToCut, sessionTurnIndex, showToast, t],
  );
  const startClearloop = useCallback(
    async (
      sourceMessageId: string,
      turnIndex: number,
      parsed: { total: number; prompt: string },
      commandText: string,
    ) => {
      try {
        await api.startClearloop(projectId, sessionId, {
          cut: { kind: "after-user-turn", sourceMessageId },
          prompt: parsed.prompt,
          total: parsed.total,
          commandText,
        });
        showToast(
          t("clearloopStarted", {
            total: String(parsed.total),
            index: String(turnIndex),
          }),
          "success",
        );
      } catch (error) {
        showToast(
          t("clearloopFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
          "error",
        );
      }
    },
    [projectId, sessionId, showToast, t],
  );
  // A rewind performed elsewhere (a clearloop iteration, another tab) arrives
  // on the metadata event. A refused rewind deletes its record, making its
  // grouped rows live again; either way the server's projection is current.
  useEffect(
    () =>
      activityBus.on("session-metadata-changed", (data) => {
        if (data.sessionId !== sessionId) return;
        if (data.rewindRecordRemoved) {
          void refreshTranscriptTail();
          return;
        }
        if (data.rewindRecord) refreshForRewind(data.rewindRecord.id);
      }),
    [refreshForRewind, refreshTranscriptTail, sessionId],
  );
  const cancelClearloop = useCallback(async () => {
    try {
      await api.cancelClearloop(projectId, sessionId);
    } catch (error) {
      showToast(
        t("clearloopCancelFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
    }
  }, [projectId, sessionId, showToast, t]);
  const clearloopControls = useMemo<ClearloopBadgeControls>(
    () => ({
      onCancel: async () => {
        if (
          await confirmDialog({
            title: t("clearloopCancelConfirmTitle"),
            message: t("clearloopCancelConfirm"),
            confirmLabel: t("clearloopMenuStop"),
            cancelLabel: t("clearloopCancelConfirmKeep"),
          })
        ) {
          void cancelClearloop();
        }
      },
      onSetPatient: (patient: boolean) => {
        void (async () => {
          try {
            await api.updateClearloop(projectId, sessionId, { patient });
          } catch (error) {
            showToast(
              t("clearloopPatienceFailed", {
                message: error instanceof Error ? error.message : String(error),
              }),
              "error",
            );
          }
        })();
      },
      onStartNow: () => {
        void (async () => {
          try {
            await api.updateClearloop(projectId, sessionId, {
              startNow: true,
            });
          } catch (error) {
            showToast(
              t("clearloopStartNowFailed", {
                message: error instanceof Error ? error.message : String(error),
              }),
              "error",
            );
          }
        })();
      },
    }),
    [cancelClearloop, projectId, sessionId, showToast, t],
  );
  const clearToNewSession = useCallback(() => {
    const params = new URLSearchParams({ projectId });
    if (provider) params.set("provider", provider);
    if (model) params.set("model", model);
    navigate(`${basePath}/new-session?${params.toString()}`);
  }, [basePath, model, navigate, projectId, provider]);
  const contextValue = useMemo<SessionRewindContextValue>(
    () => ({
      turnIndexById: sessionTurnIndex.indexById,
      onClearAfter: supportsRewind ? clearAfterUserMessage : undefined,
      onClearReplacing: supportsRewind ? clearReplacingUserMessage : undefined,
      expandedRewoundGroups,
      toggleRewoundGroup,
    }),
    [
      clearAfterUserMessage,
      clearReplacingUserMessage,
      expandedRewoundGroups,
      sessionTurnIndex,
      supportsRewind,
      toggleRewoundGroup,
    ],
  );
  const handleRewindCommand = useCallback(
    (command: SessionRewindCommand, argument: string): boolean => {
      const { idByIndex, clearedIds, lastLiveIndex } = sessionTurnIndex;
      const turnMissing = (index: number) => {
        showToast(
          lastLiveIndex === 0
            ? t("rewindNoTurns")
            : t("rewindTurnNotFound", { index: String(index) }),
          "error",
        );
      };
      // Turn N over the full sequence; a turn inside a cleared span is not
      // a rewind target yet (tree hops are unspecified).
      const resolveTurn = (index: number): string | null => {
        const id = idByIndex.get(index);
        if (index < 1 || !id) {
          turnMissing(index);
          return null;
        }
        if (command !== "fork" && clearedIds.has(id)) {
          showToast(t("rewindTurnCleared", { index: String(index) }), "error");
          return null;
        }
        return id;
      };
      // A malformed command is handed back to the composer rather than lost.
      const restoreDraft = () => {
        draftControlsRef.current?.setDraft(
          `/${command}${argument ? ` ${argument}` : ""}`,
        );
        showToast(t("rewindCommandSyntax"), "error");
      };
      const commandText = `/${command}${argument ? ` ${argument.trim()}` : ""}`;
      if (command === "clearloop") {
        const parsed = parseClearloopArguments(argument);
        if (!parsed) {
          restoreDraft();
          return true;
        }
        // No N means "loop from here": the last turn still in the
        // conversation, which is the N its own Clear-after entry offers. A
        // dropped turn holds a higher ordinal and is not a rewind target.
        const index = parsed.turnIndex ?? lastLiveIndex;
        const sourceMessageId = resolveTurn(index);
        if (!sourceMessageId) return true;
        recordCommandRecall(commandText);
        draftControlsRef.current?.confirmInputClear();
        void startClearloop(
          sourceMessageId,
          index,
          parsed,
          `/clearloop ${argument.trim()}`,
        );
        return true;
      }
      const index = parseTurnIndexArgument(argument, {
        allowEmpty: command === "clear",
      });
      if (index === null) {
        restoreDraft();
        return true;
      }
      if (command === "clear" && index === 0) {
        recordCommandRecall(commandText);
        draftControlsRef.current?.confirmInputClear();
        clearToNewSession();
        return true;
      }
      const sourceMessageId = resolveTurn(index);
      if (!sourceMessageId) return true;
      recordCommandRecall(commandText);
      // The command was consumed here, so the persisted draft is cleared as
      // a sent message would be; otherwise a reload restores it.
      draftControlsRef.current?.confirmInputClear();
      if (command === "fork") {
        void createDirectTurnFork(sourceMessageId, "after-user-turn");
        return true;
      }
      void rewindToCut({ kind: "after-user-turn", sourceMessageId });
      return true;
    },
    [
      clearToNewSession,
      createDirectTurnFork,
      draftControlsRef,
      recordCommandRecall,
      rewindToCut,
      sessionTurnIndex,
      showToast,
      startClearloop,
      t,
    ],
  );

  return {
    contextValue,
    handleRewindCommand,
    clearloopControls,
    cancelClearloop,
  };
}
