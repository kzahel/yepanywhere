import {
  Fragment,
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
import { beginTooltipSuppression } from "../hooks/useTooltipAppearance";
import type { TranslationFn } from "../i18n";
import { IconButton } from "./ui/Button";
import {
  Menu,
  type MenuCloseReason,
  MenuGroup,
  MenuItem,
  MenuSeparator,
} from "./ui/Menu";
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
  menu: string;
  heading?: string;
}

interface OpenSourceContextMenu {
  actions: SourceContextMenuAction[];
  x: number;
  y: number;
  returnFocus: HTMLElement | null;
  contextKey?: string;
  /** Opened from a trigger button: anchored to it rather than at x/y. */
  fromButton?: boolean;
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
  const [open, setOpen] = useState<
    (OpenSourceContextMenu & { sequence: number }) | null
  >(null);
  const openRef = useRef(open);
  openRef.current = open;
  const openSequenceRef = useRef(0);
  const longPressRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
  } | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressionClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const closeFromMenu = useCallback((reason?: MenuCloseReason) => {
    // A touch hold opens the menu under the finger; that same pointer
    // sequence's compatibility press must not count as one outside it.
    if (reason === "outside" && suppressNextClickRef.current) return;
    setOpen(null);
  }, []);

  const openMenu = useCallback(
    (
      x: number,
      y: number,
      returnFocus: HTMLElement | null,
      actions: SourceContextMenuAction[],
      options: SourceContextMenuOpenOptions | undefined,
      fromButton: boolean,
    ) => {
      openSequenceRef.current += 1;
      setOpen({
        actions,
        x,
        y,
        returnFocus,
        sequence: openSequenceRef.current,
        ...(fromButton ? { fromButton } : {}),
        ...(options?.contextKey ? { contextKey: options.contextKey } : {}),
      });
      options?.onOpen?.();
    },
    [],
  );

  const openAt = useCallback(
    (
      x: number,
      y: number,
      returnFocus: HTMLElement | null,
      actions: SourceContextMenuAction[],
      options?: SourceContextMenuOpenOptions,
    ) => openMenu(x, y, returnFocus, actions, options, false),
    [openMenu],
  );

  const openFromButton = useCallback(
    (
      event: ReactMouseEvent<HTMLElement>,
      actions: SourceContextMenuAction[],
      options?: SourceContextMenuOpenOptions,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      // The trigger toggles: pressing it is not outside its open menu.
      const current = openRef.current;
      if (current?.fromButton && current.returnFocus === event.currentTarget) {
        setOpen(null);
        return;
      }
      openMenu(0, 0, event.currentTarget, actions, options, true);
    },
    [openMenu],
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
      <SourceContextMenu
        // Each open is a fresh menu (focus, layer); a refresh keeps it.
        key={open.sequence}
        {...open}
        labels={labels}
        onClose={closeFromMenu}
        t={t}
      />
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
      aria-haspopup="menu"
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
  fromButton = false,
  onClose,
  t,
  labels,
}: OpenSourceContextMenu & {
  onClose: (reason?: MenuCloseReason) => void;
  t: TranslationFn;
  labels?: SourceContextMenuLabels;
}) {
  const anchorRef = useRef<HTMLElement | null>(returnFocus);
  anchorRef.current = returnFocus;
  // Whether focus is inside the menu, read when it closes: removing a
  // focused element moves focus to <body> without a blur event.
  const focusInsideRef = useRef(false);

  // A row's hover tooltip is normally still up when its context menu opens, and
  // the pointer then holds still over the menu. See FilePathContextMenu.
  useEffect(() => beginTooltipSuppression(), []);

  // A pointer-opened menu has no trigger for the menu to return focus to, so
  // focus inside it at close goes back to the element it acted on here.
  useLayoutEffect(
    () => () => {
      const target = anchorRef.current;
      if (focusInsideRef.current && target?.isConnected) {
        target.focus({ preventScroll: true });
      }
    },
    [],
  );

  const items = actions.map((action, index) => (
    <Fragment key={index}>
      {action.separatorBefore ? <MenuSeparator /> : null}
      <MenuItem
        disabled={action.disabled}
        onSelect={(event) => {
          // Close and return focus first, so the action can move focus on.
          event.preventDefault();
          onClose("select");
          returnFocus?.focus();
          action.onSelect();
        }}
      >
        {action.label}
      </MenuItem>
    </Fragment>
  ));
  return (
    <Menu
      open
      onClose={(reason) => onClose(reason)}
      // A trigger button anchors the menu; a pointer or key opens it there.
      {...(fromButton
        ? { anchorRef, placement: "bottom-end" as const }
        : { anchorPoint: { x, y }, placement: "bottom-start" as const })}
      returnFocus={false}
      aria-label={labels?.menu ?? t("sourceActionMenu")}
      onFocus={() => {
        focusInsideRef.current = true;
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        focusInsideRef.current =
          next instanceof Node && event.currentTarget.contains(next);
      }}
    >
      {labels?.heading ? (
        <MenuGroup label={labels.heading}>{items}</MenuGroup>
      ) : (
        items
      )}
    </Menu>
  );
}
