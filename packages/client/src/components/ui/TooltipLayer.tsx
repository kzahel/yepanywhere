import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  areTooltipsSuppressed,
  beginTooltipVisibility,
  cancelTooltipIntent,
  COMPOSER_TYPING_TOOLTIP_SUPPRESSION_MS,
  endTooltipVisibility,
  exceedsTooltipPointerJitter,
  getEffectiveTooltipDelayMs,
  getTooltipDelayMs,
  hasCurrentPointerIntent,
  scheduleTooltipIntent,
  subscribeTooltipSuppression,
  suppressTooltipsFor,
  TOOLTIP_CLOSE_DELAY_MULTIPLIER,
  useTooltipMode,
} from "../../hooks/useTooltipAppearance";
import { writeClipboardText } from "../../lib/clipboard";
import { isElementFullyScrollVisible } from "../../lib/tooltipVisibility";
import styles from "./TooltipLayer.module.css";

const TOOLTIP_ID = "ya-global-tooltip";
const VIEWPORT_MARGIN_PX = 8;
const POINTER_OFFSET_PX = 14;
const DEFAULT_WHEEL_LINE_HEIGHT_PX = 16;

interface VisibleTooltip {
  text: string;
  anchorX: number;
  anchorY: number;
  forcedThemed: boolean;
  glossary: boolean;
  zoomHeadline: string | null;
  zoomDetail: string | null;
}

interface PointerPosition {
  x: number;
  y: number;
}

interface PendingTooltipHandoff {
  target: Element;
  anchorX: number;
  anchorY: number;
}

interface DetachedTitle {
  value: string;
  injectedDataTooltip: boolean;
}

interface DetachedSvgTitle extends DetachedTitle {
  parent: Element;
  nextSibling: Node | null;
}

interface SavedDescription {
  target: Element;
  value: string | null;
}

interface BlockedPointerActivation {
  button: number;
}

function pointerCanHover(event: PointerEvent): boolean {
  return event.pointerType !== "touch";
}

function finiteCoordinate(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * An iframe's `title` names the embedded document for assistive technology;
 * it is not a hover hint. The pointer crosses the frame edge on its way into
 * the content, so treating it as one pops the file name over the preview.
 */
const HINT_TITLE_SELECTOR = "[title]:not(iframe)";

function tooltipTargetFromNode(
  node: EventTarget | null,
  activeTarget: Element | null,
): Element | null {
  if (!(node instanceof Element)) return null;
  if (activeTarget && node.closest(`#${TOOLTIP_ID}`)) return activeTarget;
  return (
    node.closest(`[data-tooltip], ${HINT_TITLE_SELECTOR}`) ??
    (activeTarget?.contains(node) ? activeTarget : null)
  );
}

function isNestedTooltipTarget(
  target: Element,
  activeTarget: Element | null,
): boolean {
  return (
    !!activeTarget && activeTarget !== target && activeTarget.contains(target)
  );
}

function isPointerJitter(
  event: PointerEvent,
  position: PointerPosition | null,
): boolean {
  return !exceedsTooltipPointerJitter(position, event.clientX, event.clientY);
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function repeatsFullyVisibleContent(target: Element, text: string): boolean {
  const normalizedText = normalizeVisibleText(text);
  const exactOwners: HTMLElement[] = [];
  if (
    target instanceof HTMLElement &&
    normalizeVisibleText(target.textContent ?? "") === normalizedText
  ) {
    exactOwners.push(target);
  }
  for (const descendant of target.querySelectorAll<HTMLElement>("*")) {
    if (normalizeVisibleText(descendant.textContent ?? "") === normalizedText) {
      exactOwners.push(descendant);
    }
  }
  return (
    exactOwners.length > 0 && exactOwners.every(isElementFullyScrollVisible)
  );
}

function descriptionRepeatsAccessibleName(
  target: Element,
  text: string,
): boolean {
  const normalizedText = normalizeVisibleText(text);
  const ariaLabel = normalizeVisibleText(
    target.getAttribute("aria-label") ?? "",
  );
  if (ariaLabel === normalizedText) return true;

  const labelledBy = target.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelledText = normalizeVisibleText(
      labelledBy
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
    if (labelledText === normalizedText) return true;
  }

  return normalizeVisibleText(target.textContent ?? "") === normalizedText;
}

function appendDescriptionId(
  target: Element,
  text: string,
): SavedDescription | null {
  if (descriptionRepeatsAccessibleName(target, text)) return null;
  const value = target.getAttribute("aria-describedby");
  const ids = new Set(value?.split(/\s+/).filter(Boolean) ?? []);
  ids.add(TOOLTIP_ID);
  target.setAttribute("aria-describedby", [...ids].join(" "));
  return { target, value };
}

function restoreDescription(saved: SavedDescription | null): void {
  if (!saved?.target.isConnected) return;
  if (saved.value === null) {
    saved.target.removeAttribute("aria-describedby");
  } else {
    saved.target.setAttribute("aria-describedby", saved.value);
  }
}

function hasSelectedText(): boolean {
  const selection = document.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString() !== "";
}

function isContextMenuOperable(event: MouseEvent): boolean {
  if (event.defaultPrevented || hasSelectedText()) return true;
  if (!(event.target instanceof Element)) return false;
  return (
    event.target.closest(
      'a[href], input, textarea, select, [contenteditable="true"], img, video, audio, [data-context-menu]',
    ) !== null
  );
}

function wheelDeltaYPixels(event: WheelEvent, tooltip: HTMLElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * tooltip.clientHeight;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    const computedLineHeight = Number.parseFloat(
      getComputedStyle(tooltip).lineHeight,
    );
    const lineHeight =
      Number.isFinite(computedLineHeight) && computedLineHeight >= 4
        ? computedLineHeight
        : DEFAULT_WHEEL_LINE_HEIGHT_PX;
    return event.deltaY * lineHeight;
  }
  return event.deltaY;
}

function clipboardTextForTooltip(tooltip: VisibleTooltip): string {
  return tooltip.zoomHeadline && tooltip.zoomDetail
    ? `${tooltip.zoomHeadline}\n${tooltip.zoomDetail}`
    : tooltip.text;
}

/**
 * One delegated text-tooltip layer covers existing `title=` affordances and
 * explicit `data-tooltip` targets without forcing every renderer to own
 * positioning, dwell, adjacency, and accessibility state.
 */
export function TooltipLayer() {
  const tooltipMode = useTooltipMode();
  const [visible, setVisible] = useState<VisibleTooltip | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const activeTargetRef = useRef<Element | null>(null);
  const movementDismissedTargetRef = useRef<Element | null>(null);
  const detachedTitlesRef = useRef(new Map<Element, DetachedTitle>());
  const detachedSvgTitlesRef = useRef(new Map<Element, DetachedSvgTitle>());
  const savedDescriptionRef = useRef<SavedDescription | null>(null);
  const intentOwnerRef = useRef(Symbol("delegated-tooltip-intent"));
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blockedActivationTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const blockedPointerActivationRef = useRef<BlockedPointerActivation | null>(
    null,
  );
  const visibilityTokenRef = useRef<symbol | null>(null);
  const lastPointerPositionRef = useRef<PointerPosition | null>(null);
  const pendingHandoffRef = useRef<PendingTooltipHandoff | null>(null);
  const visibleTargetRef = useRef<Element | null>(null);
  const visibleRef = useRef(false);
  const visibleTooltipRef = useRef<VisibleTooltip | null>(visible);
  visibleRef.current = visible !== null;
  visibleTooltipRef.current = visible;

  const clearShowTimer = useCallback(() => {
    cancelTooltipIntent(intentOwnerRef.current);
  }, []);

  const clearHideTimer = useCallback(() => {
    if (!hideTimerRef.current) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const clearBlockedPointerActivation = useCallback(() => {
    if (blockedActivationTimerRef.current) {
      clearTimeout(blockedActivationTimerRef.current);
      blockedActivationTimerRef.current = null;
    }
    blockedPointerActivationRef.current = null;
  }, []);

  const pointIsInsidePassiveTooltip = useCallback(
    (clientX: number, clientY: number): boolean => {
      const currentTooltip = visibleTooltipRef.current;
      const tooltip = tooltipRef.current;
      if (!currentTooltip || currentTooltip.forcedThemed || !tooltip) {
        return false;
      }
      const rect = tooltip.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return false;
      return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      );
    },
    [],
  );

  const restoreDetachedTitles = useCallback(() => {
    for (const [target, saved] of detachedTitlesRef.current) {
      if (!target.isConnected) continue;
      if (!target.getAttribute("title")) {
        target.setAttribute("title", saved.value);
      }
      if (
        saved.injectedDataTooltip &&
        target.getAttribute("data-tooltip") === saved.value
      ) {
        target.removeAttribute("data-tooltip");
      }
    }
    detachedTitlesRef.current.clear();
    for (const [title, saved] of detachedSvgTitlesRef.current) {
      if (!saved.parent.isConnected) continue;
      if (!saved.parent.querySelector(":scope > title")) {
        const nextSibling =
          saved.nextSibling?.parentNode === saved.parent
            ? saved.nextSibling
            : null;
        saved.parent.insertBefore(title, nextSibling);
      }
      if (
        saved.injectedDataTooltip &&
        saved.parent.getAttribute("data-tooltip") === saved.value
      ) {
        saved.parent.removeAttribute("data-tooltip");
      }
    }
    detachedSvgTitlesRef.current.clear();
  }, []);

  const detachTitle = useCallback((target: Element): string => {
    if (!target.matches(HINT_TITLE_SELECTOR)) return "";
    const liveTitle = target.getAttribute("title");
    if (liveTitle === null) {
      return detachedTitlesRef.current.get(target)?.value ?? "";
    }
    const existing = detachedTitlesRef.current.get(target);
    if (liveTitle === "") {
      return existing?.value ?? "";
    }
    const injectedDataTooltip =
      existing?.injectedDataTooltip ?? !target.hasAttribute("data-tooltip");
    detachedTitlesRef.current.set(target, {
      value: liveTitle,
      injectedDataTooltip,
    });
    if (injectedDataTooltip) {
      target.setAttribute("data-tooltip", liveTitle);
    }
    target.setAttribute("title", "");
    return liveTitle;
  }, []);

  const detachSvgTitle = useCallback((title: Element): void => {
    const parent = title.parentElement;
    const value = title.textContent?.trim() ?? "";
    if (parent?.localName !== "svg" || !value) return;
    const injectedDataTooltip = !parent.hasAttribute("data-tooltip");
    detachedSvgTitlesRef.current.set(title, {
      parent,
      nextSibling: title.nextSibling,
      value,
      injectedDataTooltip,
    });
    if (injectedDataTooltip) {
      parent.setAttribute("data-tooltip", value);
    }
    title.remove();
  }, []);

  const releaseVisibility = useCallback(() => {
    const token = visibilityTokenRef.current;
    visibilityTokenRef.current = null;
    if (token) endTooltipVisibility(token);
    restoreDescription(savedDescriptionRef.current);
    savedDescriptionRef.current = null;
  }, []);

  const clearActive = useCallback(() => {
    clearShowTimer();
    clearHideTimer();
    releaseVisibility();
    activeTargetRef.current = null;
    visibleTargetRef.current = null;
    visibleRef.current = false;
    visibleTooltipRef.current = null;
    setEnlarged(false);
    setVisible(null);
  }, [clearHideTimer, clearShowTimer, releaseVisibility]);

  const hide = clearActive;
  const dismissUntilDeparture = clearActive;

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) return;
    const delayMs = getTooltipDelayMs() * TOOLTIP_CLOSE_DELAY_MULTIPLIER;
    if (delayMs === 0) {
      hide();
      return;
    }
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      hide();
    }, delayMs);
  }, [hide]);

  const show = useCallback(
    (
      target: Element,
      anchorX: number,
      anchorY: number,
      forcedThemed = false,
    ) => {
      if (activeTargetRef.current !== target || !target.isConnected) return;
      const currentText =
        target.getAttribute("data-tooltip") ??
        (forcedThemed
          ? (target.getAttribute("title") ?? "")
          : detachTitle(target));
      if (!currentText.trim()) return;
      if (repeatsFullyVisibleContent(target, currentText)) {
        movementDismissedTargetRef.current = target;
        dismissUntilDeparture();
        return;
      }
      visibilityTokenRef.current ??= beginTooltipVisibility(hide);
      restoreDescription(savedDescriptionRef.current);
      savedDescriptionRef.current = appendDescriptionId(target, currentText);
      visibleTargetRef.current = target;
      visibleRef.current = true;
      const resolvedAnchorX = finiteCoordinate(anchorX);
      const resolvedAnchorY = finiteCoordinate(anchorY);
      setPosition({
        left: resolvedAnchorX + POINTER_OFFSET_PX,
        top: resolvedAnchorY + POINTER_OFFSET_PX,
      });
      const zoomHeadline = target
        .getAttribute("data-tooltip-zoom-headline")
        ?.trim();
      const zoomDetail = target
        .getAttribute("data-tooltip-zoom-detail")
        ?.trim();
      setVisible({
        text: currentText,
        anchorX: resolvedAnchorX,
        anchorY: resolvedAnchorY,
        forcedThemed,
        glossary: target.matches("[data-glossary-term]"),
        zoomHeadline: zoomHeadline || null,
        zoomDetail: zoomDetail || null,
      });
    },
    [detachTitle, dismissUntilDeparture, hide],
  );

  const scheduleWithDelay = useCallback(
    (target: Element, anchorX: number, anchorY: number, delayMs: number) => {
      const pending = { target, anchorX, anchorY };
      pendingHandoffRef.current = pending;
      scheduleTooltipIntent(
        intentOwnerRef.current,
        delayMs,
        () => {
          if (pendingHandoffRef.current !== pending) return;
          pendingHandoffRef.current = null;
          if (
            !hasCurrentPointerIntent(target) &&
            !target.matches(":focus-visible")
          ) {
            activeTargetRef.current = visibleTargetRef.current;
            return;
          }
          show(target, anchorX, anchorY);
        },
        (replacementOwner) => {
          if (pendingHandoffRef.current !== pending) return;
          pendingHandoffRef.current = null;
          if (replacementOwner !== intentOwnerRef.current) {
            activeTargetRef.current = visibleTargetRef.current;
          }
        },
      );
    },
    [show],
  );

  const schedule = useCallback(
    (target: Element, anchorX: number, anchorY: number) => {
      scheduleWithDelay(target, anchorX, anchorY, getEffectiveTooltipDelayMs());
    },
    [scheduleWithDelay],
  );

  const scheduleVisibleHandoff = useCallback(
    (target: Element, anchorX: number, anchorY: number) => {
      scheduleWithDelay(target, anchorX, anchorY, 0);
    },
    [scheduleWithDelay],
  );

  const activate = useCallback(
    (target: Element, anchorX: number, anchorY: number) => {
      if (areTooltipsSuppressed()) {
        hide();
        return;
      }
      clearHideTimer();
      const changesTarget = target !== activeTargetRef.current;
      const switchesVisibleTooltip = changesTarget && visibleRef.current;
      if (changesTarget) {
        if (switchesVisibleTooltip) {
          clearShowTimer();
          setEnlarged(false);
        } else {
          hide();
        }
        activeTargetRef.current = target;
      }
      const title = detachTitle(target);
      const text = target.getAttribute("data-tooltip") ?? title;
      if (!text.trim()) {
        hide();
        return;
      }
      if (repeatsFullyVisibleContent(target, text)) {
        movementDismissedTargetRef.current = target;
        dismissUntilDeparture();
        return;
      }
      if (switchesVisibleTooltip) {
        scheduleVisibleHandoff(target, anchorX, anchorY);
        return;
      }
      if (!visibleRef.current) schedule(target, anchorX, anchorY);
    },
    [
      clearHideTimer,
      clearShowTimer,
      detachTitle,
      dismissUntilDeparture,
      hide,
      schedule,
      scheduleVisibleHandoff,
    ],
  );

  useEffect(() => subscribeTooltipSuppression(hide), [hide]);

  useEffect(() => {
    const glossaryTarget = (node: EventTarget | null): HTMLElement | null => {
      if (!(node instanceof Element)) return null;
      const target = node.closest<HTMLElement>("[data-glossary-term]");
      return target?.dataset.tooltip || target?.title ? target : null;
    };
    const revealAndCopy = (
      target: HTMLElement,
      anchorX: number,
      anchorY: number,
    ) => {
      if (hasSelectedText()) return;
      hide();
      activeTargetRef.current = target;
      show(target, anchorX, anchorY, true);
      // Explicit glossary activation is reading intent, so use the existing
      // enlarged tooltip treatment immediately. Pointer hover stays compact.
      setEnlarged(true);
      void writeClipboardText(target.dataset.tooltip ?? target.title);
    };
    const onPointerActivate = (event: MouseEvent) => {
      const target = glossaryTarget(event.target);
      if (!target || hasSelectedText()) return;
      event.preventDefault();
      event.stopPropagation();
      revealAndCopy(target, event.clientX, event.clientY);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && visibleTooltipRef.current?.forcedThemed) {
        hide();
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = glossaryTarget(event.target);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = target.getBoundingClientRect();
      revealAndCopy(target, rect.left + rect.width / 2, rect.bottom);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!visibleTooltipRef.current?.forcedThemed) return;
      const activeTarget = activeTargetRef.current;
      if (
        event.target instanceof Node &&
        (activeTarget?.contains(event.target) ||
          tooltipRef.current?.contains(event.target))
      ) {
        return;
      }
      hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (tooltipMode !== "native") return;
      const target = glossaryTarget(event.target);
      if (!target?.matches(":focus-visible")) return;
      hide();
      activeTargetRef.current = target;
      const rect = target.getBoundingClientRect();
      show(target, rect.left + rect.width / 2, rect.bottom, true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const activeTarget = activeTargetRef.current;
      if (
        !visibleTooltipRef.current?.forcedThemed ||
        !activeTarget ||
        !(event.target instanceof Node) ||
        !activeTarget.contains(event.target)
      ) {
        return;
      }
      if (
        event.relatedTarget instanceof Node &&
        activeTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      hide();
    };

    // Glossary terms also appear inside dialogs whose click boundaries stop
    // bubbling. Capture activation so the same term interaction works in
    // file-viewer modals and ordinary rendered prose.
    document.addEventListener("click", onPointerActivate, true);
    document.addEventListener("contextmenu", onPointerActivate, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("click", onPointerActivate, true);
      document.removeEventListener("contextmenu", onPointerActivate, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [hide, show, tooltipMode]);

  useEffect(() => {
    const onComposerInput = (event: Event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.matches("[data-composer-input]")
      ) {
        return;
      }
      suppressTooltipsFor(COMPOSER_TYPING_TOOLTIP_SUPPRESSION_MS);
    };

    document.addEventListener("beforeinput", onComposerInput, true);
    document.addEventListener("input", onComposerInput, true);
    return () => {
      document.removeEventListener("beforeinput", onComposerInput, true);
      document.removeEventListener("input", onComposerInput, true);
    };
  }, []);

  useEffect(() => {
    if (tooltipMode !== "themed") {
      movementDismissedTargetRef.current = null;
      hide();
      return;
    }

    const detachTitlesWithin = (node: Node) => {
      if (node instanceof Element && node.hasAttribute("title")) {
        detachTitle(node);
      }
      if (node instanceof Element || node instanceof Document) {
        for (const target of node.querySelectorAll("[title]")) {
          detachTitle(target);
        }
        if (
          node instanceof Element &&
          node.localName === "title" &&
          node.parentElement?.localName === "svg"
        ) {
          detachSvgTitle(node);
        }
        for (const title of node.querySelectorAll("svg > title")) {
          detachSvgTitle(title);
        }
      }
    };
    const forgetDetachedTitlesWithin = (node: Node) => {
      if (node instanceof Element) {
        detachedTitlesRef.current.delete(node);
        for (const target of node.querySelectorAll("*")) {
          detachedTitlesRef.current.delete(target);
        }
        for (const [title, saved] of detachedSvgTitlesRef.current) {
          if (node === saved.parent || node.contains(saved.parent)) {
            detachedSvgTitlesRef.current.delete(title);
          }
        }
      }
    };
    const forgetRemovedTitle = (target: Element) => {
      const saved = detachedTitlesRef.current.get(target);
      if (!saved) return;
      detachedTitlesRef.current.delete(target);
      if (
        saved.injectedDataTooltip &&
        target.getAttribute("data-tooltip") === saved.value
      ) {
        target.removeAttribute("data-tooltip");
      }
      if (activeTargetRef.current === target) {
        hide();
      }
    };
    detachTitlesWithin(document);
    const titleObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          if (mutation.target instanceof Element) {
            if (mutation.target.hasAttribute("title")) {
              if (
                mutation.target.getAttribute("title") === "" &&
                mutation.oldValue === ""
              ) {
                forgetRemovedTitle(mutation.target);
              } else {
                detachTitle(mutation.target);
              }
            } else {
              forgetRemovedTitle(mutation.target);
            }
          }
          continue;
        }
        for (const node of mutation.removedNodes) {
          forgetDetachedTitlesWithin(node);
        }
        for (const node of mutation.addedNodes) {
          detachTitlesWithin(node);
        }
      }
    });
    titleObserver.observe(document.documentElement, {
      attributeFilter: ["title"],
      attributeOldValue: true,
      attributes: true,
      childList: true,
      subtree: true,
    });

    const onPointerOver = (event: PointerEvent) => {
      if (!pointerCanHover(event)) return;
      if (event.buttons !== 0) {
        hide();
        return;
      }
      const dismissedTarget = movementDismissedTargetRef.current;
      if (
        dismissedTarget &&
        event.target instanceof Node &&
        dismissedTarget.contains(event.target)
      ) {
        return;
      }
      movementDismissedTargetRef.current = null;
      const target = pointIsInsidePassiveTooltip(event.clientX, event.clientY)
        ? activeTargetRef.current
        : tooltipTargetFromNode(event.target, activeTargetRef.current);
      if (!target) return;
      if (
        visibleRef.current &&
        target !== activeTargetRef.current &&
        !isNestedTooltipTarget(target, activeTargetRef.current) &&
        isPointerJitter(event, lastPointerPositionRef.current)
      ) {
        return;
      }
      lastPointerPositionRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      activate(target, event.clientX, event.clientY);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pointerCanHover(event)) return;
      if (event.buttons !== 0) {
        hide();
        return;
      }
      const dismissedTarget = movementDismissedTargetRef.current;
      if (
        dismissedTarget &&
        event.target instanceof Node &&
        dismissedTarget.contains(event.target)
      ) {
        return;
      }
      const target = pointIsInsidePassiveTooltip(event.clientX, event.clientY)
        ? activeTargetRef.current
        : tooltipTargetFromNode(event.target, activeTargetRef.current);
      if (!target) {
        clearShowTimer();
        if (visibleRef.current) {
          if (isPointerJitter(event, lastPointerPositionRef.current)) {
            return;
          }
          scheduleHide();
        } else {
          hide();
        }
        return;
      }
      if (
        visibleRef.current &&
        target !== activeTargetRef.current &&
        !isNestedTooltipTarget(target, activeTargetRef.current) &&
        isPointerJitter(event, lastPointerPositionRef.current)
      ) {
        return;
      }
      lastPointerPositionRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      clearHideTimer();
      if (movementDismissedTargetRef.current === target) return;
      activate(target, event.clientX, event.clientY);
    };
    const onPointerOut = (event: PointerEvent) => {
      const pendingTarget = pendingHandoffRef.current?.target;
      if (
        pendingTarget &&
        event.target instanceof Node &&
        pendingTarget.contains(event.target) &&
        !(
          event.relatedTarget instanceof Node &&
          pendingTarget.contains(event.relatedTarget)
        )
      ) {
        clearShowTimer();
      }
      const activeTarget = activeTargetRef.current;
      const dismissedTarget = movementDismissedTargetRef.current;
      if (
        dismissedTarget &&
        !(
          event.relatedTarget instanceof Node &&
          dismissedTarget.contains(event.relatedTarget)
        )
      ) {
        movementDismissedTargetRef.current = null;
      }
      if (!activeTarget) return;
      if (pointIsInsidePassiveTooltip(event.clientX, event.clientY)) {
        clearHideTimer();
        return;
      }
      const eventTarget = event.target instanceof Node ? event.target : null;
      const tooltip = tooltipRef.current;
      const leftActiveRegion =
        !!eventTarget &&
        (activeTarget.contains(eventTarget) ||
          !!tooltip?.contains(eventTarget));
      if (!leftActiveRegion) return;
      if (
        event.relatedTarget instanceof Node &&
        (activeTarget.contains(event.relatedTarget) ||
          !!tooltip?.contains(event.relatedTarget))
      ) {
        clearHideTimer();
        return;
      }
      if (
        visibleRef.current &&
        isPointerJitter(event, lastPointerPositionRef.current)
      ) {
        return;
      }
      if (visibleRef.current) scheduleHide();
      else hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTargetFromNode(
        event.target,
        activeTargetRef.current,
      );
      if (!target?.matches(":focus-visible")) return;
      const rect = target.getBoundingClientRect();
      activate(target, rect.left + rect.width / 2, rect.bottom);
    };
    const onFocusOut = (event: FocusEvent) => {
      const activeTarget = activeTargetRef.current;
      if (
        !activeTarget ||
        !(event.target instanceof Node) ||
        !activeTarget.contains(event.target)
      ) {
        return;
      }
      if (
        event.relatedTarget instanceof Node &&
        activeTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      movementDismissedTargetRef.current = null;
      hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const activeTarget = activeTargetRef.current;
      if (!activeTarget) return;
      movementDismissedTargetRef.current = activeTarget;
      dismissUntilDeparture();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 2) return;
      const activeTarget = activeTargetRef.current;
      if (pointIsInsidePassiveTooltip(event.clientX, event.clientY)) {
        if (
          event.target instanceof Node &&
          activeTarget?.contains(event.target)
        ) {
          movementDismissedTargetRef.current = activeTarget;
          dismissUntilDeparture();
          return;
        }
        clearBlockedPointerActivation();
        blockedPointerActivationRef.current = { button: event.button };
        event.preventDefault();
        event.stopImmediatePropagation();
        movementDismissedTargetRef.current = activeTarget;
        dismissUntilDeparture();
        return;
      }
      if (
        event.target instanceof Node &&
        tooltipRef.current?.contains(event.target)
      ) {
        return;
      }
      movementDismissedTargetRef.current = activeTarget;
      dismissUntilDeparture();
    };
    const onPointerUp = (event: PointerEvent) => {
      const blocked = blockedPointerActivationRef.current;
      if (!blocked || event.button !== blocked.button) return;
      if (blockedActivationTimerRef.current) {
        clearTimeout(blockedActivationTimerRef.current);
      }
      blockedActivationTimerRef.current = setTimeout(() => {
        blockedActivationTimerRef.current = null;
        blockedPointerActivationRef.current = null;
      }, 0);
    };
    const onPointerCancel = () => {
      clearBlockedPointerActivation();
    };
    const onBlockedClick = (event: MouseEvent) => {
      const blocked = blockedPointerActivationRef.current;
      if (!blocked || event.detail === 0 || event.button !== blocked.button) {
        return;
      }
      clearBlockedPointerActivation();
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onPassiveTooltipContextMenu = (event: MouseEvent) => {
      const currentTooltip = visibleTooltipRef.current;
      if (
        !currentTooltip ||
        currentTooltip.forcedThemed ||
        !pointIsInsidePassiveTooltip(event.clientX, event.clientY) ||
        hasSelectedText() ||
        (event.target instanceof Element &&
          event.target.closest("[data-context-menu]"))
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      setEnlarged(true);
      void writeClipboardText(clipboardTextForTooltip(currentTooltip));
    };
    const onContextMenu = (event: MouseEvent) => {
      const currentTooltip = visibleTooltipRef.current;
      const activeTarget = activeTargetRef.current;
      const tooltip = tooltipRef.current;
      if (
        !currentTooltip ||
        !activeTarget ||
        !(event.target instanceof Node) ||
        (!activeTarget.contains(event.target) &&
          !tooltip?.contains(event.target))
      ) {
        return;
      }
      // Glossary activation already copied and enlarged the definition. Keep
      // its context menu native so touch long-press can establish selection.
      if (currentTooltip.forcedThemed || isContextMenuOperable(event)) {
        // Right-clicking the definition itself acts on the tooltip, so that
        // one stays. Everywhere else some other menu — the browser's, or an
        // app menu such as the file link's "Copy path" — is taking this
        // position, and a hover hint must not cover it. The pointer then
        // holds still over the menu, so nothing else would clear the tooltip
        // until it travelled past the jitter tolerance.
        if (tooltip?.contains(event.target)) return;
        movementDismissedTargetRef.current = activeTarget;
        dismissUntilDeparture();
        return;
      }
      event.preventDefault();
      setEnlarged(true);
      void writeClipboardText(clipboardTextForTooltip(currentTooltip));
    };
    const onWheel = (event: WheelEvent) => {
      const tooltip = tooltipRef.current;
      if (
        !tooltip ||
        !pointIsInsidePassiveTooltip(event.clientX, event.clientY) ||
        tooltip.scrollHeight <= tooltip.clientHeight
      ) {
        return;
      }
      const deltaY = wheelDeltaYPixels(event, tooltip);
      if (!Number.isFinite(deltaY) || deltaY === 0) return;
      const maxScrollTop = tooltip.scrollHeight - tooltip.clientHeight;
      tooltip.scrollTop = Math.min(
        maxScrollTop,
        Math.max(0, tooltip.scrollTop + deltaY),
      );
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const handleScroll = (event: Event) => {
      const activeTarget = activeTargetRef.current;
      if (visibleRef.current || !activeTarget) return;
      // A streaming transcript scrolls under a resting pointer; that does not
      // move a header control, so only a scroll that carries the target away
      // cancels its pending tooltip.
      if (event.target instanceof Node && !event.target.contains(activeTarget))
        return;
      hide();
    };
    const handleResize = () => {
      if (!visibleRef.current) {
        if (activeTargetRef.current) hide();
        return;
      }
      setVisible((current) => (current ? { ...current } : current));
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    document.addEventListener("click", onBlockedClick, true);
    document.addEventListener("auxclick", onBlockedClick, true);
    document.addEventListener("contextmenu", onPassiveTooltipContextMenu, true);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    window.addEventListener("blur", hide);
    return () => {
      titleObserver.disconnect();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
      document.removeEventListener("click", onBlockedClick, true);
      document.removeEventListener("auxclick", onBlockedClick, true);
      document.removeEventListener(
        "contextmenu",
        onPassiveTooltipContextMenu,
        true,
      );
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("blur", hide);
      clearBlockedPointerActivation();
      hide();
      restoreDetachedTitles();
    };
  }, [
    activate,
    clearBlockedPointerActivation,
    clearHideTimer,
    clearShowTimer,
    detachTitle,
    detachSvgTitle,
    dismissUntilDeparture,
    hide,
    pointIsInsidePassiveTooltip,
    restoreDetachedTitles,
    scheduleHide,
    tooltipMode,
  ]);

  useLayoutEffect(() => {
    const element = tooltipRef.current;
    if (!element || !visible) return;
    const rect = element.getBoundingClientRect();
    if (enlarged) {
      setPosition((current) => {
        const maxLeft = Math.max(
          VIEWPORT_MARGIN_PX,
          window.innerWidth - VIEWPORT_MARGIN_PX - rect.width,
        );
        const maxTop = Math.max(
          VIEWPORT_MARGIN_PX,
          window.innerHeight - VIEWPORT_MARGIN_PX - rect.height,
        );
        const next = {
          left: Math.min(maxLeft, Math.max(VIEWPORT_MARGIN_PX, current.left)),
          top: Math.min(maxTop, Math.max(VIEWPORT_MARGIN_PX, current.top)),
        };
        return next.left === current.left && next.top === current.top
          ? current
          : next;
      });
      return;
    }
    let left = visible.anchorX + POINTER_OFFSET_PX;
    let top = visible.anchorY + POINTER_OFFSET_PX;
    if (left + rect.width > window.innerWidth - VIEWPORT_MARGIN_PX) {
      left = visible.anchorX - rect.width - POINTER_OFFSET_PX;
    }
    if (top + rect.height > window.innerHeight - VIEWPORT_MARGIN_PX) {
      top = visible.anchorY - rect.height - POINTER_OFFSET_PX;
    }
    setPosition({
      left: Math.max(VIEWPORT_MARGIN_PX, left),
      top: Math.max(VIEWPORT_MARGIN_PX, top),
    });
  }, [enlarged, visible]);

  if ((!visible?.forcedThemed && tooltipMode !== "themed") || !visible) {
    return null;
  }
  return createPortal(
    <div
      ref={tooltipRef}
      id={TOOLTIP_ID}
      className={`${styles.root}${
        visible.glossary ? ` ${styles.glossary}` : ""
      }${visible.forcedThemed ? ` ${styles.interactive}` : ""}${
        enlarged ? ` ${styles.enlarged}` : ""
      }`}
      role="tooltip"
      style={{ left: position.left, top: position.top }}
    >
      {enlarged && visible.zoomHeadline && visible.zoomDetail ? (
        <>
          <span className={styles.zoomHeadline}>{visible.zoomHeadline}</span>
          <span className={styles.zoomDetail}>{visible.zoomDetail}</span>
        </>
      ) : (
        visible.text
      )}
    </div>,
    document.body,
  );
}
