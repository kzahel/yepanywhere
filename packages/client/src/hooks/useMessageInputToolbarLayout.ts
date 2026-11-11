import toolbarStyles from "../components/MessageInputToolbar.module.css";
import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type {
  SessionToolbarVisibilityKey,
  ToolbarNarrowingPriority,
} from "./useSessionToolbarPresence";

export type ComposerOverflowTier = "none" | "early" | "medium" | "late";

const COMPOSER_OVERFLOW_TIERS: ComposerOverflowTier[] = [
  "none",
  "early",
  "medium",
  "late",
];

// Configured priority wins; this fixed order breaks ties, first hidden first.
export const COMPOSER_OVERFLOW_ORDER: readonly SessionToolbarVisibilityKey[] = [
  "transcriptSearch",
  "shortcutsHelp",
  "syntheticDone",
  "renderMode",
  "conversationView",
  "sessionStatus",
  "attachments",
  "modeSelector",
  "slashMenu",
  "thinkingToggle",
  "contextUsage",
  "btw",
  "steerNow",
  "topicShift",
  "projectQueueNewSessionShortcut",
  "projectQueue",
  "browserDebug",
  "microphone",
  "waveform",
  "composerRecall",
];

export interface MessageInputToolbarLayoutRefs {
  toolbar?: RefObject<HTMLDivElement | null>;
  left?: RefObject<HTMLDivElement | null>;
  status?: RefObject<HTMLDivElement | null>;
  actions?: RefObject<HTMLDivElement | null>;
}

function getFlexGapPx(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return Number.parseFloat(style.columnGap || style.gap) || 0;
}

function getVisibleControlWidth(element: HTMLElement): number {
  if (element.dataset.composerElastic === "true") {
    return 0;
  }
  const style = getComputedStyle(element);
  if (style.display === "none" || style.position === "absolute") {
    return 0;
  }
  return element.getBoundingClientRect().width;
}

function getControlListWidth(element: HTMLElement): number {
  const childWidths = Array.from(element.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement)
    .map(getVisibleControlWidth)
    .filter((width) => width > 0);
  if (childWidths.length === 0) {
    return 0;
  }
  const gap = getFlexGapPx(element);
  return (
    childWidths.reduce((total, width) => total + width, 0) +
    gap * (childWidths.length - 1)
  );
}

type ComposerToolbarOverflowPriorityInput = ToolbarNarrowingPriority | "off";

export interface ComposerToolbarOverflowLayoutSignatureInput {
  modeSelector: ComposerToolbarOverflowPriorityInput;
  attachments: ComposerToolbarOverflowPriorityInput;
  slashMenu: ComposerToolbarOverflowPriorityInput;
  thinkingToggle: ComposerToolbarOverflowPriorityInput;
  renderMode: ComposerToolbarOverflowPriorityInput;
  conversationView: ComposerToolbarOverflowPriorityInput;
  browserDebug: ComposerToolbarOverflowPriorityInput;
  syntheticDone: ComposerToolbarOverflowPriorityInput;
  sessionStatus: ComposerToolbarOverflowPriorityInput;
  shortcutsHelp: ComposerToolbarOverflowPriorityInput;
  transcriptSearch: ComposerToolbarOverflowPriorityInput;
  contextUsage: ComposerToolbarOverflowPriorityInput;
  btw: ComposerToolbarOverflowPriorityInput;
  steerNow: ComposerToolbarOverflowPriorityInput;
  topicShift: ComposerToolbarOverflowPriorityInput;
  projectQueue: ComposerToolbarOverflowPriorityInput;
  projectQueueNewSessionShortcut: ComposerToolbarOverflowPriorityInput;
  microphone: "live" | "preview" | "off";
  waveform: boolean;
  send: "send" | "steer" | "queue" | "off" | undefined;
  queue: string;
  alternate: boolean;
  stop: boolean;
  pending: "tool-approval" | "user-question" | "off";
}

export function getComposerToolbarOverflowLayoutSignature(
  input: ComposerToolbarOverflowLayoutSignatureInput,
): string {
  return [
    `modeSelector:${input.modeSelector}`,
    `attachments:${input.attachments}`,
    `slashMenu:${input.slashMenu}`,
    `thinkingToggle:${input.thinkingToggle}`,
    `renderMode:${input.renderMode}`,
    `conversationView:${input.conversationView}`,
    `browserDebug:${input.browserDebug}`,
    `syntheticDone:${input.syntheticDone}`,
    `sessionStatus:${input.sessionStatus}`,
    `shortcutsHelp:${input.shortcutsHelp}`,
    `transcriptSearch:${input.transcriptSearch}`,
    `contextUsage:${input.contextUsage}`,
    `btw:${input.btw}`,
    `steerNow:${input.steerNow}`,
    `topicShift:${input.topicShift}`,
    `projectQueue:${input.projectQueue}`,
    `projectQueueNewSessionShortcut:${input.projectQueueNewSessionShortcut}`,
    `microphone:${input.microphone}`,
    `waveform:${input.waveform}`,
    `send:${input.send}`,
    `queue:${input.queue}`,
    `alternate:${input.alternate}`,
    `stop:${input.stop}`,
    `pending:${input.pending}`,
  ].join("|");
}

export function useMeasuredComposerOverflow({
  layoutKey,
  hasControls,
  priority,
  pinOnlyMicrophone,
  refs,
}: {
  layoutKey: string;
  hasControls: boolean;
  priority: Record<SessionToolbarVisibilityKey, ToolbarNarrowingPriority>;
  pinOnlyMicrophone: boolean;
  refs?: MessageInputToolbarLayoutRefs;
}): {
  tier: ComposerOverflowTier;
  hiddenControls: ReadonlySet<string>;
  setToolbarRef: (node: HTMLDivElement | null) => void;
} {
  const [hiddenControls, setHiddenControls] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [tier, setTier] = useState<ComposerOverflowTier>(() =>
    typeof ResizeObserver === "undefined" ? "late" : "none",
  );
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const lastToolbarWidthRef = useRef(0);
  const lastLayoutKeyRef = useRef(layoutKey);
  const setToolbarRef = useCallback(
    (node: HTMLDivElement | null) => {
      toolbarRef.current = node;
      if (refs?.toolbar) {
        refs.toolbar.current = node;
      }
    },
    [refs?.toolbar],
  );

  useLayoutEffect(() => {
    if (lastLayoutKeyRef.current !== layoutKey) {
      lastLayoutKeyRef.current = layoutKey;
      const resetTier = typeof ResizeObserver === "undefined" ? "late" : "none";
      if (tier !== resetTier || hiddenControls.size) {
        setHiddenControls(new Set());
        setTier(resetTier);
        return;
      }
    }
    const toolbar = toolbarRef.current;
    if (!toolbar || !hasControls) {
      if (tier !== "none") {
        setTier("none");
      }
      return;
    }

    let frameId: number | null = null;
    const measure = () => {
      frameId = null;
      const left =
        refs?.left?.current ??
        toolbar.querySelector("[data-message-input-left]");
      const actions =
        refs?.actions?.current ??
        toolbar.querySelector("[data-message-input-actions]");
      if (!(left instanceof HTMLElement) || !(actions instanceof HTMLElement)) {
        return;
      }
      const leftRect = left.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      if (leftRect.width === 0 && actionsRect.width === 0) {
        setTier("late");
        return;
      }
      const leftWidth = getControlListWidth(left);
      const actionsWidth = getControlListWidth(actions);
      const status =
        refs?.status?.current ??
        toolbar.querySelector(":scope > [data-composer-status-ages]");
      const statusWidth =
        status instanceof HTMLElement ? getVisibleControlWidth(status) : 0;
      const overflow = toolbar.querySelector("[data-composer-bottom-overflow]");
      const overflowWidth =
        overflow instanceof HTMLElement ? getVisibleControlWidth(overflow) : 0;
      const fileViewerSlot = toolbar.querySelector(
        '[data-file-viewer-controller-slot="true"]',
      );
      const fileViewerMinWidth =
        fileViewerSlot instanceof HTMLElement
          ? Number.parseFloat(getComputedStyle(fileViewerSlot).minWidth) || 0
          : 0;
      const visibleSectionCount = [
        leftWidth,
        statusWidth,
        fileViewerMinWidth,
        overflowWidth,
        actionsWidth,
      ].filter((width) => width > 0).length;
      const totalWidth =
        leftWidth +
        statusWidth +
        fileViewerMinWidth +
        overflowWidth +
        actionsWidth +
        getFlexGapPx(toolbar) * Math.max(0, visibleSectionCount - 1);
      const availableWidth = toolbar.getBoundingClientRect().width;
      if (totalWidth <= availableWidth + 0.5) {
        return;
      }
      const candidates = Array.from(
        toolbar.querySelectorAll<HTMLElement>(
          `.${toolbarStyles.composerBottomOverflowInline}`,
        ),
      )
        .map((element) => {
          const marker = element.matches("[data-session-toolbar-control]")
            ? element
            : element.querySelector<HTMLElement>(
                "[data-session-toolbar-control]",
              );
          const key = marker?.dataset.sessionToolbarControl;
          const configured = key
            ? priority[key as SessionToolbarVisibilityKey]
            : "pin";
          const effective =
            pinOnlyMicrophone && key !== "microphone" && configured === "pin"
              ? "last"
              : configured;
          const tier = { first: 1, mid: 2, last: 3, pin: -1 }[effective];
          return { element, key, priority: tier };
        })
        .filter(
          (item): item is typeof item & { key: SessionToolbarVisibilityKey } =>
            !!item.key &&
            item.priority > 0 &&
            !hiddenControls.has(item.key) &&
            getVisibleControlWidth(item.element) > 0,
        )
        .sort(
          (a, b) =>
            a.priority - b.priority ||
            COMPOSER_OVERFLOW_ORDER.indexOf(a.key) -
              COMPOSER_OVERFLOW_ORDER.indexOf(b.key),
        );
      const next = candidates[0];
      if (next) {
        setHiddenControls(new Set([...hiddenControls, next.key]));
        setTier(COMPOSER_OVERFLOW_TIERS[next.priority] ?? "late");
      }
    };
    const scheduleMeasure = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(measure);
    };
    const handleResize: ResizeObserverCallback = (entries) => {
      const toolbarEntry = entries.find((entry) => entry.target === toolbar);
      if (toolbarEntry) {
        const nextWidth = toolbarEntry.contentRect.width;
        if (nextWidth > lastToolbarWidthRef.current + 1) {
          setHiddenControls(new Set());
          setTier("none");
        }
        lastToolbarWidthRef.current = nextWidth;
      }
      scheduleMeasure();
    };

    measure();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(toolbar);
      if (refs?.left?.current) {
        resizeObserver.observe(refs.left.current);
      }
      if (refs?.actions?.current) {
        resizeObserver.observe(refs.actions.current);
      }
    }
    return () => {
      resizeObserver?.disconnect();
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    tier,
    hiddenControls,
    layoutKey,
    hasControls,
    priority,
    pinOnlyMicrophone,
    refs?.actions,
    refs?.left,
    refs?.status,
  ]);

  return { tier, hiddenControls, setToolbarRef };
}
