import type { AppContentBlock, ProviderName } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { BtwAsideTranscriptTurn } from "../components/BtwAsidePane";
import { getBtwSplitRouting, getBtwToolbarMode } from "../lib/btwAsideRouting";
import {
  buildBtwAsideParentHref,
  getBtwAsideSessionDisplayTitle,
} from "../lib/btwAsideSessions";
import { messageContentToPlainText } from "../lib/sessionMessageText";
import type { SourceApiClient } from "../lib/sourceRuntime";
import { getServerClockTimestamp } from "../lib/serverClock";
import { generateUUID } from "../lib/uuid";
import type { Message, PermissionMode } from "../types";
import type { Toast } from "./useToast";
import {
  getModelSetting,
  getShowThinkingSetting,
  getThinkingSetting,
} from "./useModelSettings";

const BTW_ASIDE_POLL_MS = 1500;
const BTW_ASIDE_MAX_POLLS = 160;
const BTW_ASIDE_PREVIEW_MAX_LENGTH = 700;
const BTW_ASIDE_PROMPT_MARKER = "[YA /btw aside]";
const BTW_ASIDE_FORK_PROVIDERS = new Set<ProviderName>([
  "claude",
  "codex",
  "codex-oss",
]);

type ShowToast = (message: string, type?: Toast["type"]) => void;

export type BtwAsideStatus =
  | "draft"
  | "starting"
  | "running"
  | "complete"
  | "failed"
  | "stopped";

export interface BtwAside {
  id: string;
  sessionId?: string;
  baseMessageCount: number;
  request: string;
  followUps: string[];
  status: BtwAsideStatus;
  error?: string;
  preview?: string;
  responses: string[];
  turns?: BtwAsideTranscriptTurn[];
  processId?: string;
  createdAt: string;
  updatedAt: string;
  historyAt?: string;
  expanded?: boolean;
}

export interface UseBtwAsidesOptions {
  basePath: string;
  projectId: string;
  sessionId: string;
  actualSessionId: string;
  locationSearch: string;
  sourceApi: SourceApiClient;
  effectiveProvider: ProviderName | undefined;
  isWideScreen: boolean;
  permissionMode: PermissionMode;
  liveModel: string | undefined;
  sessionModel: string | undefined;
  sessionExecutor: string | undefined;
  parentSessionId: string | null | undefined;
  showToast: ShowToast;
  onNavigateToParentAside: (href: string) => void;
}

export function providerSupportsBtwAsideFork(
  provider: ProviderName | undefined,
): boolean {
  return provider ? BTW_ASIDE_FORK_PROVIDERS.has(provider) : false;
}

export function messageContentToBtwLiveText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const value = block as AppContentBlock & Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") {
        return value.text;
      }
      if (value.type === "thinking" && typeof value.thinking === "string") {
        return `Thinking: ${truncateBtwPreview(value.thinking)}`;
      }
      if (value.type === "tool_use" && typeof value.name === "string") {
        const input = value.input as Record<string, unknown> | undefined;
        const detail =
          (typeof input?.command === "string" && input.command) ||
          (typeof input?.cmd === "string" && input.cmd) ||
          (typeof input?.file_path === "string" && input.file_path) ||
          (typeof input?.query === "string" && input.query) ||
          (typeof input?.url === "string" && input.url) ||
          "";
        return detail
          ? `Using ${value.name}: ${truncateBtwPreview(detail)}`
          : `Using ${value.name}`;
      }
      return typeof value.content === "string" ? value.content : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function truncateBtwPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= BTW_ASIDE_PREVIEW_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, BTW_ASIDE_PREVIEW_MAX_LENGTH - 3).trimEnd()}...`;
}

function getMessagePlainText(message: Message | undefined): string {
  return (
    messageContentToPlainText(message?.content) ||
    messageContentToPlainText(message?.message?.content)
  );
}

function isAssistantRole(message: Message | undefined): message is Message {
  return (
    message?.type === "assistant" ||
    message?.role === "assistant" ||
    message?.message?.role === "assistant"
  );
}

function isUserRole(message: Message | undefined): message is Message {
  return (
    message?.type === "user" ||
    message?.role === "user" ||
    message?.message?.role === "user"
  );
}

function getLatestAssistantText(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantRole(message)) {
      continue;
    }

    const text = getMessagePlainText(message);
    if (text.trim()) {
      return truncateBtwPreview(text);
    }
  }
  return null;
}

function findLatestBtwPromptIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (
      isUserRole(messages[index]) &&
      getBtwSideRequestFromPromptText(getMessagePlainText(messages[index])) !==
        null
    ) {
      return index;
    }
  }
  return -1;
}

function findFirstBtwPromptIndex(messages: Message[]): number {
  for (let index = 0; index < messages.length; index += 1) {
    if (
      isUserRole(messages[index]) &&
      getBtwSideRequestFromPromptText(getMessagePlainText(messages[index])) !==
        null
    ) {
      return index;
    }
  }
  return -1;
}

function getBtwSideRequestFromPromptText(text: string): string | null {
  const isQuestion = text.startsWith("[YA question aside ");
  if (!isQuestion && !text.includes(BTW_ASIDE_PROMPT_MARKER)) return null;
  const requestMarker = isQuestion ? "[Question]" : "[Side request]";
  const requestIndex = text.indexOf(requestMarker);
  if (requestIndex < 0) {
    return null;
  }
  const request = text.slice(requestIndex + requestMarker.length).trim();
  return request || null;
}

export function getBtwTranscriptTurns(
  messages: Message[],
  baseMessageCount: number,
): BtwAsideTranscriptTurn[] {
  const firstBtwPromptIndex = findFirstBtwPromptIndex(messages);
  const startIndex =
    firstBtwPromptIndex >= 0
      ? firstBtwPromptIndex
      : Math.min(Math.max(0, baseMessageCount), messages.length);

  return messages
    .slice(startIndex)
    .flatMap((message, relativeIndex): BtwAsideTranscriptTurn[] => {
      const messageId =
        typeof message.uuid === "string"
          ? message.uuid
          : typeof message.id === "string"
            ? message.id
            : `message-${startIndex + relativeIndex}`;

      if (isUserRole(message)) {
        const request = getBtwSideRequestFromPromptText(
          getMessagePlainText(message),
        );
        return request
          ? [{ id: `${messageId}-user`, role: "user", text: request }]
          : [];
      }

      if (!isAssistantRole(message)) {
        return [];
      }

      const assistantMessage = message as Message;
      const text = (
        messageContentToBtwLiveText(assistantMessage.content) ||
        messageContentToBtwLiveText(assistantMessage.message?.content)
      ).trim();
      return text
        ? [{ id: `${messageId}-assistant`, role: "assistant", text }]
        : [];
    });
}

export function getBtwRequestFromMessages(messages: Message[]): string | null {
  const promptIndex = findLatestBtwPromptIndex(messages);
  if (promptIndex < 0) {
    return null;
  }
  const text = getMessagePlainText(messages[promptIndex] ?? {});
  return getBtwSideRequestFromPromptText(text);
}

export function buildBtwAsideInitialPrompt(prompt: string): string {
  return [
    BTW_ASIDE_PROMPT_MARKER,
    "You are a forked side session running alongside a still-active parent session.",
    "The transcript above this turn was produced by that parent; call it 'Mother'.",
    "Earlier assistant turns are Mother's actions, not your own; when reasoning about or referring back to them, treat them as Mother's and attribute them in writing ('Mother said X', 'Mother edited Y') rather than using first person.",
    "Your view of Mother's work is frozen at fork time; Mother may have continued since.",
    "Mother is responsible for the main task; do not continue, take over, or report on it unless the side request below explicitly asks you to.",
    "You share Mother's working directory. Prefer read-only investigation; if writes are necessary, scope them tightly to avoid colliding with Mother's edits.",
    "Answer only the side request below. End with a short report block (1-5 lines) suitable for the user to paste back to Mother verbatim.",
    "",
    "[Side request]",
    prompt,
  ].join("\n");
}

export function buildBtwAsideFollowupPrompt(prompt: string): string {
  return [
    BTW_ASIDE_PROMPT_MARKER,
    "(Continuing the side session. Mother remains responsible for the main task; refer to Mother's prior turns as 'Mother said ...'; share working directory with care; end with a short paste-ready report.)",
    "The user is continuing this conversation; any earlier one-question-only limit no longer applies.",
    "",
    "[Side request]",
    prompt,
  ].join("\n");
}

export function useBtwAsides({
  basePath,
  projectId,
  sessionId,
  actualSessionId,
  locationSearch,
  sourceApi,
  effectiveProvider,
  isWideScreen,
  permissionMode,
  liveModel,
  sessionModel,
  sessionExecutor,
  parentSessionId,
  showToast,
  onNavigateToParentAside,
}: UseBtwAsidesOptions) {
  const supportsBtwAsides = providerSupportsBtwAsideFork(effectiveProvider);
  const [btwAsides, setBtwAsides] = useState<BtwAside[]>([]);
  const [focusedBtwAsideId, setFocusedBtwAsideId] = useState<string | null>(
    null,
  );
  const [btwSidePaneCollapsed, setBtwSidePaneCollapsed] = useState(false);
  const [asideDraft, setAsideDraft] = useState("");
  const asideComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const btwAsidesRef = useRef<BtwAside[]>([]);
  const hydratedBtwSessionIdsRef = useRef<Set<string>>(new Set());
  const btwAsidePollsRef = useRef<Map<string, AbortController>>(new Map());

  const focusedBtwAside = focusedBtwAsideId
    ? (btwAsides.find((aside) => aside.id === focusedBtwAsideId) ?? null)
    : null;
  const requestedBtwSessionId = useMemo(() => {
    const value = new URLSearchParams(locationSearch).get("btw")?.trim();
    return value || null;
  }, [locationSearch]);
  const childSessionParentHref = parentSessionId
    ? buildBtwAsideParentHref(basePath, projectId, parentSessionId, sessionId)
    : null;

  useEffect(() => {
    btwAsidesRef.current = btwAsides;
  }, [btwAsides]);

  const updateBtwAside = useCallback(
    (id: string, updater: (aside: BtwAside) => BtwAside) => {
      setBtwAsides((current) =>
        current.map((aside) => (aside.id === id ? updater(aside) : aside)),
      );
    },
    [],
  );

  const materializeBtwAside = useCallback((asideId: string) => {
    const historyAt = new Date().toISOString();
    setBtwAsides((current) =>
      current.map((aside) =>
        aside.id === asideId && !aside.historyAt
          ? { ...aside, historyAt, updatedAt: historyAt }
          : aside,
      ),
    );
  }, []);

  const stopBtwAsidePoll = useCallback((asideId: string) => {
    btwAsidePollsRef.current.get(asideId)?.abort();
    btwAsidePollsRef.current.delete(asideId);
  }, []);

  const stopAllBtwAsidePolls = useCallback(() => {
    for (const poll of btwAsidePollsRef.current.values()) {
      poll.abort();
    }
    btwAsidePollsRef.current.clear();
  }, []);

  // Polls belong to the session they were started in, so leaving it (or
  // unmounting) stops them all.
  useEffect(() => {
    void sessionId;
    return stopAllBtwAsidePolls;
  }, [sessionId, stopAllBtwAsidePolls]);

  const pollBtwAside = useCallback(
    (asideId: string, asideSessionId: string) => {
      // A follow-up turn replaces the aside's earlier poll.
      stopBtwAsidePoll(asideId);
      const owner = new AbortController();
      btwAsidePollsRef.current.set(asideId, owner);
      let timer: number | undefined;
      owner.signal.addEventListener("abort", () => {
        window.clearTimeout(timer);
      });
      const finish = () => {
        if (btwAsidePollsRef.current.get(asideId) === owner) {
          btwAsidePollsRef.current.delete(asideId);
        }
      };
      let polls = 0;

      const poll = async () => {
        polls += 1;
        try {
          const result = await sourceApi.getSession({
            projectId,
            sessionId: asideSessionId,
            fullHistory: true,
            fullHistoryReason: "/btw aside poll",
          });
          if (owner.signal.aborted) {
            return;
          }
          const nextStatus: BtwAsideStatus =
            result.ownership.owner === "none" ? "complete" : "running";
          updateBtwAside(asideId, (aside) => {
            const turns = getBtwTranscriptTurns(
              result.messages,
              aside.baseMessageCount,
            );
            const responses = turns
              .filter((turn) => turn.role === "assistant")
              .map((turn) => turn.text);
            const preview =
              responses.length > 0
                ? truncateBtwPreview(responses[responses.length - 1] ?? "")
                : getLatestAssistantText(result.messages);
            return {
              ...aside,
              status: nextStatus,
              preview: preview ?? aside.preview,
              responses: responses.length > 0 ? responses : aside.responses,
              turns: turns.length > 0 ? turns : aside.turns,
              historyAt:
                nextStatus === "complete"
                  ? (aside.historyAt ?? new Date().toISOString())
                  : aside.historyAt,
              updatedAt: new Date().toISOString(),
            };
          });
          if (nextStatus === "complete" || polls >= BTW_ASIDE_MAX_POLLS) {
            finish();
            return;
          }
        } catch (err) {
          if (owner.signal.aborted) {
            return;
          }
          if (polls >= BTW_ASIDE_MAX_POLLS) {
            updateBtwAside(asideId, (aside) => ({
              ...aside,
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
              historyAt: aside.historyAt ?? new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }));
            finish();
            return;
          }
        }
        timer = window.setTimeout(poll, BTW_ASIDE_POLL_MS);
      };

      timer = window.setTimeout(poll, BTW_ASIDE_POLL_MS);
    },
    [projectId, sourceApi, stopBtwAsidePoll, updateBtwAside],
  );

  const runBtwAsideTurn = useCallback(
    async (sourceAside: BtwAside, prompt: string, isInitialTurn: boolean) => {
      const trimmed = prompt.trim();
      if (!trimmed) {
        return;
      }

      updateBtwAside(sourceAside.id, (aside) => ({
        ...aside,
        request: isInitialTurn && !aside.request ? trimmed : aside.request,
        followUps: isInitialTurn
          ? aside.followUps
          : [...aside.followUps, trimmed],
        turns: isInitialTurn
          ? aside.turns?.length
            ? aside.turns
            : [
                {
                  id: `${sourceAside.id}-request`,
                  role: "user",
                  text: trimmed,
                },
              ]
          : [
              ...(aside.turns ?? []),
              {
                id: `${sourceAside.id}-followup-${aside.followUps.length}`,
                role: "user",
                text: trimmed,
              },
            ],
        status: aside.sessionId ? "running" : "starting",
        error: undefined,
        updatedAt: new Date().toISOString(),
      }));

      try {
        const providerName = effectiveProvider;
        if (!providerSupportsBtwAsideFork(providerName)) {
          throw new Error(
            "/btw asides are available only for providers with a wired fork path",
          );
        }
        let asideSessionId = sourceAside.sessionId;
        if (!asideSessionId) {
          const titlePreview = truncateBtwPreview(trimmed).slice(0, 80);
          const clone = await api.cloneSession(
            projectId,
            actualSessionId,
            `/btw ${titlePreview}`,
            providerName,
            actualSessionId,
          );
          asideSessionId = clone.sessionId;
          updateBtwAside(sourceAside.id, (aside) => ({
            ...aside,
            sessionId: asideSessionId,
            baseMessageCount: clone.messageCount,
            status: "starting",
            updatedAt: new Date().toISOString(),
          }));
        }

        const clientTimestamp = getServerClockTimestamp(Date.now());
        const result = await api.resumeSession(
          projectId,
          asideSessionId,
          isInitialTurn
            ? buildBtwAsideInitialPrompt(trimmed)
            : buildBtwAsideFollowupPrompt(trimmed),
          {
            mode: permissionMode,
            model: liveModel ?? sessionModel ?? getModelSetting(),
            thinking: getThinkingSetting(),
            showThinking: getShowThinkingSetting(),
            provider: providerName,
            executor: sessionExecutor,
          },
          undefined,
          generateUUID(),
          clientTimestamp,
        );

        updateBtwAside(sourceAside.id, (aside) => ({
          ...aside,
          sessionId: asideSessionId,
          status: "running",
          processId: result.processId,
          updatedAt: new Date().toISOString(),
        }));
        pollBtwAside(sourceAside.id, asideSessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        updateBtwAside(sourceAside.id, (aside) => ({
          ...aside,
          status: "failed",
          error: message,
          historyAt: aside.historyAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
        showToast(`Failed to start /btw aside: ${message}`, "error");
      }
    },
    [
      actualSessionId,
      effectiveProvider,
      liveModel,
      permissionMode,
      pollBtwAside,
      projectId,
      sessionExecutor,
      sessionModel,
      showToast,
      updateBtwAside,
    ],
  );

  const startBtwAside = useCallback(
    (text: string): boolean => {
      if (!supportsBtwAsides) {
        showToast(
          "/btw asides are available only for providers with a wired fork path.",
          "error",
        );
        return false;
      }

      const trimmed = text.trim();
      const now = new Date().toISOString();
      const asideId = generateUUID();
      const aside: BtwAside = {
        id: asideId,
        baseMessageCount: 0,
        request: trimmed,
        followUps: [],
        status: trimmed ? "starting" : "draft",
        responses: [],
        turns: trimmed
          ? [
              {
                id: `${asideId}-request`,
                role: "user",
                text: trimmed,
              },
            ]
          : [],
        createdAt: now,
        updatedAt: now,
        expanded: false,
      };

      setBtwAsides((current) => [...current, aside]);
      if (!trimmed) {
        setFocusedBtwAsideId(aside.id);
        return true;
      }

      void runBtwAsideTurn(aside, trimmed, true);
      return true;
    },
    [runBtwAsideTurn, showToast, supportsBtwAsides],
  );

  useEffect(() => {
    if (!requestedBtwSessionId || requestedBtwSessionId === sessionId) {
      return;
    }

    const existingAside = btwAsidesRef.current.find(
      (aside) => aside.sessionId === requestedBtwSessionId,
    );
    if (existingAside) {
      setFocusedBtwAsideId(existingAside.id);
      return;
    }

    if (hydratedBtwSessionIdsRef.current.has(requestedBtwSessionId)) {
      return;
    }
    hydratedBtwSessionIdsRef.current.add(requestedBtwSessionId);

    let cancelled = false;
    void (async () => {
      try {
        const result = await sourceApi.getSession({
          projectId,
          sessionId: requestedBtwSessionId,
          fullHistory: true,
          fullHistoryReason: "/btw aside hydrate",
        });
        if (cancelled) {
          return;
        }

        const request =
          getBtwRequestFromMessages(result.messages) ??
          getBtwAsideSessionDisplayTitle(
            result.session.customTitle ?? result.session.title ?? "Aside",
          );
        const turns = getBtwTranscriptTurns(result.messages, 0);
        const responses = turns
          .filter((turn) => turn.role === "assistant")
          .map((turn) => turn.text);
        const preview =
          responses.length > 0
            ? truncateBtwPreview(responses[responses.length - 1] ?? "")
            : (getLatestAssistantText(result.messages) ?? undefined);
        const now = new Date().toISOString();
        const asideId = generateUUID();
        const hydratedAside: BtwAside = {
          id: asideId,
          sessionId: requestedBtwSessionId,
          baseMessageCount: 0,
          request,
          followUps: [],
          status: result.ownership.owner === "none" ? "complete" : "running",
          preview,
          responses,
          turns,
          processId:
            result.ownership.owner === "self"
              ? result.ownership.processId
              : undefined,
          createdAt: result.session.createdAt ?? now,
          updatedAt: result.session.updatedAt ?? now,
          expanded: true,
        };

        setBtwAsides((current) =>
          current.some((aside) => aside.sessionId === requestedBtwSessionId)
            ? current
            : [...current, hydratedAside],
        );
        setFocusedBtwAsideId(asideId);
      } catch (err) {
        hydratedBtwSessionIdsRef.current.delete(requestedBtwSessionId);
        const message = err instanceof Error ? err.message : String(err);
        showToast(`Failed to load /btw aside: ${message}`, "error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, requestedBtwSessionId, sessionId, showToast, sourceApi]);

  const hideBtwAside = useCallback(
    (asideId: string) => {
      materializeBtwAside(asideId);
      setFocusedBtwAsideId((current) => (current === asideId ? null : current));
    },
    [materializeBtwAside],
  );

  const toggleBtwAsideExpanded = useCallback(
    (asideId: string) => {
      updateBtwAside(asideId, (aside) => ({
        ...aside,
        expanded: !aside.expanded,
        updatedAt: new Date().toISOString(),
      }));
    },
    [updateBtwAside],
  );

  useEffect(() => {
    void focusedBtwAsideId;
    setBtwSidePaneCollapsed(false);
    setAsideDraft("");
  }, [focusedBtwAsideId]);

  const handleStopBtwAside = useCallback(
    async (asideId: string) => {
      const aside = btwAsides.find((item) => item.id === asideId);
      if (!aside) return;
      stopBtwAsidePoll(asideId);
      if (!aside.processId) {
        hideBtwAside(asideId);
        return;
      }

      try {
        const result = await api.interruptProcess(aside.processId);
        if (!result.interrupted && !result.aborted) {
          await api.abortProcess(aside.processId);
        }
        const stoppedAt = new Date().toISOString();
        updateBtwAside(asideId, (current) => ({
          ...current,
          status: "stopped",
          historyAt: current.historyAt ?? stoppedAt,
          updatedAt: stoppedAt,
        }));
      } catch (err) {
        try {
          await api.abortProcess(aside.processId);
          const stoppedAt = new Date().toISOString();
          updateBtwAside(asideId, (current) => ({
            ...current,
            status: "stopped",
            historyAt: current.historyAt ?? stoppedAt,
            updatedAt: stoppedAt,
          }));
        } catch {
          const message = err instanceof Error ? err.message : String(err);
          updateBtwAside(asideId, (current) => ({
            ...current,
            status: "failed",
            error: message,
            historyAt: current.historyAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
        }
      }
      setFocusedBtwAsideId((current) => (current === asideId ? null : current));
    },
    [btwAsides, hideBtwAside, stopBtwAsidePoll, updateBtwAside],
  );

  const handleDoneBtwAside = useCallback(() => {
    setFocusedBtwAsideId(null);
  }, []);

  const handleStopBtwAsideFromTranscript = useCallback(
    (asideId: string) => {
      void handleStopBtwAside(asideId);
    },
    [handleStopBtwAside],
  );

  const stickyBtwAsides = useMemo(
    () => btwAsides.filter((aside) => !aside.historyAt),
    [btwAsides],
  );
  const hasFocusedBtwAside = !!focusedBtwAside;
  const {
    wantSplitLayout: wantBtwSplitLayout,
    showSidePane: showBtwSidePane,
    footerRoutesToAside: mainComposerForAside,
  } = getBtwSplitRouting({
    isWideScreen,
    hasFocusedAside: hasFocusedBtwAside,
    sidePaneCollapsed: btwSidePaneCollapsed,
  });
  const composerStickyBtwAsides = useMemo(() => {
    if (showBtwSidePane && focusedBtwAside) {
      return stickyBtwAsides.filter((aside) => aside.id !== focusedBtwAside.id);
    }
    return stickyBtwAsides;
  }, [stickyBtwAsides, showBtwSidePane, focusedBtwAside]);
  const btwToolbarMode = getBtwToolbarMode({
    hasChildParentHref: !!childSessionParentHref,
    hasFocusedAside: hasFocusedBtwAside,
    footerRoutesToAside: mainComposerForAside,
    paneComposerVisible: showBtwSidePane,
    hasAvailableAsides: stickyBtwAsides.length > 0,
  });
  const historyBtwAsides = useMemo(
    () =>
      btwAsides
        .filter((aside) => aside.historyAt)
        .map((aside) => ({
          ...aside,
          isFocused: focusedBtwAsideId === aside.id,
          canStop: aside.status === "starting" || aside.status === "running",
        })),
    [btwAsides, focusedBtwAsideId],
  );

  const handleBtwShortcut = useCallback(
    (text: string): boolean => {
      if (childSessionParentHref) {
        onNavigateToParentAside(childSessionParentHref);
        return false;
      }

      if (!supportsBtwAsides) {
        return false;
      }

      if (focusedBtwAside) {
        if (showBtwSidePane) {
          window.setTimeout(() => asideComposerRef.current?.focus(), 0);
          return false;
        }
        setFocusedBtwAsideId(null);
        return false;
      }

      if (!text.trim() && stickyBtwAsides.length > 0) {
        const latestAside = stickyBtwAsides[stickyBtwAsides.length - 1];
        setFocusedBtwAsideId(latestAside?.id ?? null);
        return false;
      }

      return startBtwAside(text);
    },
    [
      childSessionParentHref,
      focusedBtwAside,
      onNavigateToParentAside,
      showBtwSidePane,
      startBtwAside,
      stickyBtwAsides,
      supportsBtwAsides,
    ],
  );

  const resetBtwAsides = useCallback(() => {
    stopAllBtwAsidePolls();
    setBtwAsides([]);
    btwAsidesRef.current = [];
    setFocusedBtwAsideId(null);
    hydratedBtwSessionIdsRef.current.clear();
  }, [stopAllBtwAsidePolls]);

  return {
    asideComposerRef,
    asideDraft,
    btwSidePaneCollapsed,
    btwToolbarMode,
    childSessionParentHref,
    composerStickyBtwAsides,
    focusedBtwAside,
    focusedBtwAsideId,
    handleBtwShortcut,
    handleDoneBtwAside,
    handleStopBtwAside,
    handleStopBtwAsideFromTranscript,
    hasFocusedBtwAside,
    hideBtwAside,
    historyBtwAsides,
    mainComposerForAside,
    resetBtwAsides,
    runBtwAsideTurn,
    setAsideDraft,
    setBtwSidePaneCollapsed,
    setFocusedBtwAsideId,
    showBtwSidePane,
    startBtwAside,
    stickyBtwAsides,
    supportsBtwAsides,
    toggleBtwAsideExpanded,
    wantBtwSplitLayout,
  };
}
