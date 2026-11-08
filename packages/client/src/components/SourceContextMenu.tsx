import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { beginTooltipSuppression } from "../hooks/useTooltipAppearance";
import type { TranslationFn } from "../i18n";
import { ButtonBase, IconButton } from "./ui/Button";
import styles from "./SourceContextMenu.module.css";

/**
 * Opt-in class for a row that contains a `SourceRowMenuTrigger`. The row is the
 * hover/focus surface; this menu owns what the reveal looks like, so a row owner
 * declares the relationship instead of restyling a control it does not render.
 */
export const sourceRowMenuSurface: string = styles.rowSurface ?? "";

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 8;

export interface SourceContextMenuAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export interface SourceContextMenuOpenOptions {
  contextKey?: string;
  onOpen?: () => void;
}

export interface SourceContextMenuLabels {
  dismiss: string;
  menu: string;
  heading?: string;
  touchTargets?: boolean;
}

interface OpenSourceContextMenu {
  actions: SourceContextMenuAction[];
  x: number;
  y: number;
  returnFocus: HTMLElement | null;
  contextKey?: string;
}

interface SourceMenuTargetProps {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClick: () => void;
}

export interface SourceContextMenuController {
  menu: ReactNode;
  targetProps: (
    actions: SourceContextMenuAction[],
    onActivate: () => void,
    options?: SourceContextMenuOpenOptions,
  ) => SourceMenuTargetProps;
  openAt: (
    x: number,
    y: number,
    returnFocus: HTMLElement | null,
    actions: SourceContextMenuAction[],
    options?: SourceContextMenuOpenOptions,
  ) => void;
  openFromButton: (
    event: ReactMouseEvent<HTMLElement>,
    actions: SourceContextMenuAction[],
    options?: SourceContextMenuOpenOptions,
  ) => void;
  refreshOpenActions: (
    contextKey: string,
    actions: SourceContextMenuAction[],
  ) => void;
  beginLongPressAt: (
    event: Pick<
      globalThis.PointerEvent,
      "isPrimary" | "button" | "pointerType" | "clientX" | "clientY"
    >,
    returnFocus: HTMLElement,
    actions: SourceContextMenuAction[],
    options?: SourceContextMenuOpenOptions,
  ) => void;
  moveLongPressAt: (
    event: Pick<globalThis.PointerEvent, "clientX" | "clientY">,
  ) => void;
  endLongPress: () => void;
  consumeLongPressClick: () => boolean;
}

/**
 * One gesture and keyboard contract for compact action menus. Source Control
 * established this facility; other callers supply their own actions and labels.
 */
export function useSourceContextMenu(
  t: TranslationFn,
  labels?: SourceContextMenuLabels,
): SourceContextMenuController {
  const [open, setOpen] = useState<OpenSourceContextMenu | null>(null);
  const longPressRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
  } | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressionClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const close = useCallback(() => setOpen(null), []);

  const openAt = useCallback(
    (
      x: number,
      y: number,
      returnFocus: HTMLElement | null,
      actions: SourceContextMenuAction[],
      options?: SourceContextMenuOpenOptions,
    ) => {
      setOpen({
        actions,
        x,
        y,
        returnFocus,
        ...(options?.contextKey ? { contextKey: options.contextKey } : {}),
      });
      options?.onOpen?.();
    },
    [],
  );

  const openFromButton = useCallback(
    (
      event: ReactMouseEvent<HTMLElement>,
      actions: SourceContextMenuAction[],
      options?: SourceContextMenuOpenOptions,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      openAt(
        rect.right,
        rect.bottom + 4,
        event.currentTarget,
        actions,
        options,
      );
    },
    [openAt],
  );

  const refreshOpenActions = useCallback(
    (contextKey: string, actions: SourceContextMenuAction[]) => {
      setOpen((current) =>
        current?.contextKey === contextKey ? { ...current, actions } : current,
      );
    },
    [],
  );

  const openFromContextMenu = useCallback(
    (
      event: ReactMouseEvent<HTMLElement>,
      actions: SourceContextMenuAction[],
      options?: SourceContextMenuOpenOptions,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      openAt(
        event.clientX,
        event.clientY,
        event.currentTarget,
        actions,
        options,
      );
    },
    [openAt],
  );

  const openFromKeyboard = useCallback(
    (
      event: ReactKeyboardEvent<HTMLElement>,
      actions: SourceContextMenuAction[],
      options?: SourceContextMenuOpenOptions,
    ) => {
      if (
        event.key !== "ContextMenu" &&
        !(event.shiftKey && event.key === "F10")
      ) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      openAt(
        rect.left + Math.min(32, rect.width / 2),
        rect.top + Math.min(32, rect.height),
        event.currentTarget,
        actions,
        options,
      );
      return true;
    },
    [openAt],
  );

  const endLongPress = useCallback(() => {
    if (!longPressRef.current) return;
    clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  }, []);

  const beginLongPressAt = useCallback(
    (
      event: Pick<
        globalThis.PointerEvent,
        "isPrimary" | "button" | "pointerType" | "clientX" | "clientY"
      >,
      returnFocus: HTMLElement,
      actions: SourceContextMenuAction[],
      options?: SourceContextMenuOpenOptions,
    ) => {
      endLongPress();
      if (suppressionClearTimerRef.current) {
        clearTimeout(suppressionClearTimerRef.current);
        suppressionClearTimerRef.current = null;
      }
      suppressNextClickRef.current = false;
      if (
        !event.isPrimary ||
        event.button !== 0 ||
        (event.pointerType !== "touch" && event.pointerType !== "pen")
      ) {
        return;
      }
      const x = event.clientX;
      const y = event.clientY;
      const timer = setTimeout(() => {
        suppressNextClickRef.current = true;
        longPressRef.current = null;
        openAt(x, y, returnFocus, actions, options);
      }, LONG_PRESS_MS);
      longPressRef.current = { timer, x, y };
    },
    [endLongPress, openAt],
  );

  const beginLongPress = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      actions: SourceContextMenuAction[],
      options?: SourceContextMenuOpenOptions,
    ) => {
      beginLongPressAt(
        event.nativeEvent,
        event.currentTarget,
        actions,
        options,
      );
    },
    [beginLongPressAt],
  );

  const moveLongPressAt = useCallback(
    (event: Pick<globalThis.PointerEvent, "clientX" | "clientY">) => {
      const pending = longPressRef.current;
      if (
        !pending ||
        Math.hypot(event.clientX - pending.x, event.clientY - pending.y) <=
          LONG_PRESS_MOVE_TOLERANCE_PX
      ) {
        return;
      }
      endLongPress();
    },
    [endLongPress],
  );

  const moveLongPress = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      moveLongPressAt(event.nativeEvent);
    },
    [moveLongPressAt],
  );

  const consumeLongPressClick = useCallback(() => {
    if (!suppressNextClickRef.current) return false;
    suppressNextClickRef.current = false;
    return true;
  }, []);

  const finishPointerSequence = useCallback(() => {
    endLongPress();
    if (!suppressNextClickRef.current) return;
    if (suppressionClearTimerRef.current) {
      clearTimeout(suppressionClearTimerRef.current);
    }
    // A compatibility click from this pointer sequence is dispatched after
    // pointerup in the same browser task. Keep suppression through that click,
    // then release it before any later, unrelated activation.
    suppressionClearTimerRef.current = setTimeout(() => {
      suppressNextClickRef.current = false;
      suppressionClearTimerRef.current = null;
    }, 0);
  }, [endLongPress]);

  const targetProps = useCallback(
    (
      actions: SourceContextMenuAction[],
      onActivate: () => void,
      options?: SourceContextMenuOpenOptions,
    ): SourceMenuTargetProps => ({
      onContextMenu: (event) => openFromContextMenu(event, actions, options),
      onKeyDown: (event) => {
        openFromKeyboard(event, actions, options);
      },
      onPointerDown: (event) => beginLongPress(event, actions, options),
      onPointerMove: moveLongPress,
      onPointerUp: endLongPress,
      onPointerCancel: endLongPress,
      onClick: () => {
        if (!consumeLongPressClick()) onActivate();
      },
    }),
    [
      beginLongPress,
      consumeLongPressClick,
      endLongPress,
      moveLongPress,
      openFromContextMenu,
      openFromKeyboard,
    ],
  );

  useEffect(() => {
    window.addEventListener("pointerup", finishPointerSequence);
    window.addEventListener("pointercancel", finishPointerSequence);
    return () => {
      window.removeEventListener("pointerup", finishPointerSequence);
      window.removeEventListener("pointercancel", finishPointerSequence);
      endLongPress();
      if (suppressionClearTimerRef.current) {
        clearTimeout(suppressionClearTimerRef.current);
        suppressionClearTimerRef.current = null;
      }
    };
  }, [endLongPress, finishPointerSequence]);

  return {
    menu: open ? (
      <SourceContextMenu {...open} labels={labels} onClose={close} t={t} />
    ) : null,
    targetProps,
    openAt,
    openFromButton,
    refreshOpenActions,
    beginLongPressAt,
    moveLongPressAt,
    endLongPress,
    consumeLongPressClick,
  };
}

export function SourceRowMenuTrigger({
  actions,
  label,
  onOpen,
  openOptions,
}: {
  actions: SourceContextMenuAction[];
  label: string;
  onOpen: SourceContextMenuController["openFromButton"];
  openOptions?: SourceContextMenuOpenOptions;
}) {
  return (
    <IconButton
      size="small"
      className={styles.trigger}
      label={label}
      onClick={(event) => onOpen(event, actions, openOptions)}
    >
      ⋯
    </IconButton>
  );
}

export function SourceContextMenu({
  actions,
  x,
  y,
  returnFocus,
  onClose,
  t,
  labels,
}: OpenSourceContextMenu & {
  onClose: () => void;
  t: TranslationFn;
  labels?: SourceContextMenuLabels;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // A row's hover tooltip is normally still up when its context menu opens, and
  // the pointer then holds still over the menu. See FilePathContextMenu.
  useEffect(() => beginTooltipSuppression(), []);

  useLayoutEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      )
      ?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        returnFocus?.focus();
        return;
      }
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          'button[role="menuitem"]:not(:disabled)',
        ) ?? [],
      );
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (current + 1 + items.length) % items.length
              : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, returnFocus]);

  const select = (action: SourceContextMenuAction) => {
    if (action.disabled) return;
    onClose();
    returnFocus?.focus();
    action.onSelect();
  };

  const estimatedHeight =
    actions.length * (labels?.touchTargets ? 46 : 34) +
    16 +
    (labels?.heading ? 32 : 0);
  return createPortal(
    <>
      <ButtonBase
        className={styles.overlay}
        aria-label={labels?.dismiss ?? t("sourceDismissActions")}
        onClick={() => {
          onClose();
          returnFocus?.focus();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
          returnFocus?.focus();
        }}
      />
      <div
        ref={menuRef}
        className={`${styles.menu}${labels?.touchTargets ? ` ${styles.touchTargets}` : ""}`}
        role="menu"
        aria-label={labels?.menu ?? t("sourceActionMenu")}
        style={{
          left: Math.max(8, Math.min(x, window.innerWidth - 232)),
          top: Math.max(8, Math.min(y, window.innerHeight - estimatedHeight)),
        }}
      >
        {labels?.heading && (
          <div className={styles.heading}>{labels.heading}</div>
        )}
        {actions.map((action, index) => (
          <button
            key={index}
            type="button"
            role="menuitem"
            className={
              action.separatorBefore ? styles.separatorBefore : undefined
            }
            disabled={action.disabled}
            onClick={() => select(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}
