import type {
  BangCommandTranscriptDisplayObject,
  TranscriptDisplayObject,
} from "@yep-anywhere/shared";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { api } from "../api/client";
import type { BangCommandHandlers } from "../components/BangCommandDisplayObject";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import {
  applyBangCommandReceipt,
  buildBangEchoText,
  collectBangHistory,
} from "../lib/bangCommands";
import { getBangCommandAnchor } from "../lib/transcriptDisplayObjects";
import type { Message } from "../types";
import type { DraftControls } from "./useDraftPersistence";

/**
 * One session page's `!!` bang commands: running a command and applying its
 * receipt, echoing a run's output to the provider, the transcript row
 * actions, and the composer's run/completion/history support. Local shell
 * runs in the project dir, never provider ingress; persisted as transcript
 * display objects (topics/bang-commands.md).
 */
export function useSessionBangCommands({
  projectId,
  sessionId,
  session,
  messages,
  updateTranscriptDisplayObjectsForSession,
  setScrollTrigger,
  handleSendRef,
  draftControlsRef,
}: {
  projectId: string;
  sessionId: string;
  session:
    | { id: string; transcriptDisplayObjects?: TranscriptDisplayObject[] }
    | null
    | undefined;
  messages: Message[];
  updateTranscriptDisplayObjectsForSession: (
    targetSessionId: string,
    updater: (objects: TranscriptDisplayObject[]) => TranscriptDisplayObject[],
  ) => void;
  setScrollTrigger: Dispatch<SetStateAction<number>>;
  handleSendRef: RefObject<(text: string) => Promise<unknown>>;
  draftControlsRef: RefObject<DraftControls | null>;
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();

  // !! bang commands: local shell runs in the project dir, never provider
  // ingress; persisted as transcript display objects (topics/bang-commands.md).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const runBangCommand = useCallback(
    async (command: string) => {
      const placementAfterMessageId = getBangCommandAnchor(messagesRef.current);
      try {
        const result = await api.runBangCommand(
          projectId,
          sessionId,
          command,
          placementAfterMessageId,
        );
        updateTranscriptDisplayObjectsForSession(sessionId, (current) =>
          applyBangCommandReceipt(current, result.displayObject),
        );
        setScrollTrigger((prev) => prev + 1);
      } catch (error) {
        showToast(t("bangRunFailed"), "error");
        throw error;
      }
    },
    [
      projectId,
      sessionId,
      updateTranscriptDisplayObjectsForSession,
      setScrollTrigger,
      showToast,
      t,
    ],
  );

  const echoBangCommand = useCallback(
    async (object: BangCommandTranscriptDisplayObject) => {
      try {
        const output = await api.fetchBangCommandOutput(
          projectId,
          sessionId,
          object.id,
        );
        await handleSendRef.current(buildBangEchoText(object, output));
      } catch {
        showToast(t("bangEchoFailed"), "error");
      }
    },
    [projectId, sessionId, handleSendRef, showToast, t],
  );

  const initialDisplayObjectsRef = useRef<{
    sessionId: string;
    ids: Set<string>;
  } | null>(null);
  if (
    session?.id === sessionId &&
    initialDisplayObjectsRef.current?.sessionId !== sessionId
  ) {
    initialDisplayObjectsRef.current = {
      sessionId,
      ids: new Set(
        session.transcriptDisplayObjects?.map((object) => object.id),
      ),
    };
  }
  const bangCommandHandlers = useMemo<BangCommandHandlers>(
    () => ({
      shouldExpandOutput: (objectId) =>
        !initialDisplayObjectsRef.current?.ids.has(objectId),
      onKill: (objectId) => {
        void api
          .killBangCommand(projectId, sessionId, objectId)
          .catch(() => {});
      },
      onDelete: (objectId) => {
        void api
          .deleteBangCommand(projectId, sessionId, objectId)
          .then((result) => {
            updateTranscriptDisplayObjectsForSession(
              sessionId,
              () => result.transcriptDisplayObjects,
            );
          })
          .catch(() => {});
      },
      onRerun: (command) => {
        void runBangCommand(command).catch(() => {});
      },
      onRecall: (command) => {
        draftControlsRef.current?.setDraft(`!!${command}`);
      },
      onEcho: (object) => {
        void echoBangCommand(object);
      },
      fetchOutput: (objectId) =>
        api.fetchBangCommandOutput(projectId, sessionId, objectId),
    }),
    [
      projectId,
      sessionId,
      runBangCommand,
      echoBangCommand,
      updateTranscriptDisplayObjectsForSession,
      draftControlsRef,
    ],
  );

  const bangHistory = useMemo(
    () => collectBangHistory(session?.transcriptDisplayObjects),
    [session?.transcriptDisplayObjects],
  );

  const composerBangSupport = useMemo(
    () => ({
      onRun: (command: string) => runBangCommand(command),
      fetchCompletions: (
        token: string,
        kind: "command" | "path",
        line: string,
      ) => api.fetchBangCompletions(projectId, token, kind, line),
      history: bangHistory,
    }),
    [projectId, runBangCommand, bangHistory],
  );

  return { bangCommandHandlers, composerBangSupport };
}
