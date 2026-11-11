import { thinkingToolbarControlStateClasses } from "./composerStateClasses";
import thinkingToolbarStyles from "./ThinkingToolbarControl.module.css";
import type { ShowThinking } from "@yep-anywhere/shared";
import type { MouseEvent, TouchEvent } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { EffortLevel, ThinkingMode } from "../hooks/useModelSettings";
import type { useI18n } from "../i18n";
import {
  type EffortLevelOption,
  getEffortLevelLabel,
} from "../lib/effortLevels";
import toolbarModuleStyles from "./MessageInputToolbar.module.css";
import { ThinkingControlsPanel, ThinkingIcon } from "./ThinkingControls";

type ToolbarTranslate = ReturnType<typeof useI18n>["t"];

export interface ToolbarThinkingControl {
  mode: ThinkingMode;
  modeOptions?: readonly ThinkingMode[];
  level: EffortLevel;
  effortOptions: EffortLevelOption[];
  onSetMode: (mode: ThinkingMode) => void;
  onSetEffort: (level: EffortLevel) => void;
  onSetEffortMode?: (level: EffortLevel) => void;
  onToggleEnabled: () => void;
  /** "Show thinking" preference (default/on/off); all providers. */
  showThinking: ShowThinking;
  onSetShowThinking: (value: ShowThinking) => void;
  /** Provider for resolving the inherited "default" show-thinking cue. */
  provider?: string | null;
}

function getToolbarThinkingLabel(
  t: ToolbarTranslate,
  control: ToolbarThinkingControl,
): string {
  if (control.mode === "off") return t("modelSettingsThinkingOffLabel");
  if (control.mode === "auto") return t("modelSettingsThinkingAutoLabel");
  if (control.level === "xhigh") return t("effortLevelExtraHighShortLabel");
  return (
    control.effortOptions.find((option) => option.value === control.level)
      ?.label ?? getEffortLevelLabel(control.level, undefined, t)
  );
}

function getToolbarThinkingTitle(
  t: ToolbarTranslate,
  control: ToolbarThinkingControl,
): string {
  const current =
    control.mode === "off"
      ? t("newSessionThinkingOff")
      : control.mode === "auto"
        ? t("newSessionThinkingAuto")
        : t("newSessionThinkingOn", {
            level:
              control.effortOptions.find(
                (option) => option.value === control.level,
              )?.label ?? getEffortLevelLabel(control.level, undefined, t),
          });
  return t("toolbarThinkingTitle", { current });
}

const THINKING_MENU_VIEWPORT_GUTTER_PX = 12;

export function ThinkingToolbarControl({
  control,
  t,
}: {
  control: ToolbarThinkingControl;
  t: ToolbarTranslate;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressTouchClickRef = useRef(false);
  const title = getToolbarThinkingTitle(t, control);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [close, open]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const menu = menuRef.current;
    if (!open || !root || !menu || typeof window === "undefined") return;

    let frameId = 0;
    const updateInlinePosition = () => {
      frameId = 0;
      menu.style.setProperty("--thinking-menu-inline-shift", "0px");
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      menu.style.setProperty(
        "--thinking-menu-max-inline-size",
        `${Math.max(0, viewportWidth - THINKING_MENU_VIEWPORT_GUTTER_PX * 2)}px`,
      );

      const rect = menu.getBoundingClientRect();
      const minLeft = viewportLeft + THINKING_MENU_VIEWPORT_GUTTER_PX;
      const maxLeft =
        viewportLeft +
        viewportWidth -
        THINKING_MENU_VIEWPORT_GUTTER_PX -
        rect.width;
      const targetLeft =
        maxLeft < minLeft
          ? minLeft
          : Math.min(Math.max(rect.left, minLeft), maxLeft);
      menu.style.setProperty(
        "--thinking-menu-inline-shift",
        `${targetLeft - rect.left}px`,
      );
    };
    const scheduleInlinePositionUpdate = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updateInlinePosition);
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleInlinePositionUpdate);
    resizeObserver?.observe(root);
    resizeObserver?.observe(menu);
    window.addEventListener("resize", scheduleInlinePositionUpdate);
    window.visualViewport?.addEventListener(
      "resize",
      scheduleInlinePositionUpdate,
    );
    window.visualViewport?.addEventListener(
      "scroll",
      scheduleInlinePositionUpdate,
    );
    updateInlinePosition();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleInlinePositionUpdate);
      window.visualViewport?.removeEventListener(
        "resize",
        scheduleInlinePositionUpdate,
      );
      window.visualViewport?.removeEventListener(
        "scroll",
        scheduleInlinePositionUpdate,
      );
    };
  }, [open]);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const toggleEnabled = useCallback(() => {
    control.onToggleEnabled();
    setOpen(false);
  }, [control]);

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      toggleEnabled();
    },
    [toggleEnabled],
  );

  const handleTouchStart = useCallback(() => {
    clearLongPress();
    suppressTouchClickRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      suppressTouchClickRef.current = true;
      longPressTimerRef.current = null;
      toggleEnabled();
    }, 450);
  }, [clearLongPress, toggleEnabled]);

  const handleTouchEnd = useCallback(
    (event: TouchEvent<HTMLButtonElement>) => {
      if (suppressTouchClickRef.current) {
        event.preventDefault();
      }
      clearLongPress();
    },
    [clearLongPress],
  );

  return (
    <div className={toolbarModuleStyles.thinkingControl} ref={rootRef}>
      <button
        type="button"
        className={`${thinkingToolbarStyles.thinkingToggleButton} ${control.mode !== "off" ? `${thinkingToolbarStyles.active} ${thinkingToolbarControlStateClasses[control.mode] ?? ""}` : ""}`}
        data-thinking-toggle-button
        data-thinking-mode={control.mode}
        onClick={(event) => {
          if (suppressTouchClickRef.current) {
            suppressTouchClickRef.current = false;
            return;
          }
          event.currentTarget.blur();
          setOpen((current) => !current);
        }}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={clearLongPress}
        onTouchMove={clearLongPress}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ThinkingIcon mode={control.mode} />
        <span className={thinkingToolbarStyles.thinkingToggleLabel}>
          {getToolbarThinkingLabel(t, control)}
        </span>
      </button>
      {open && (
        <div
          className={toolbarModuleStyles.thinkingMenu}
          data-testid="thinking-toolbar-menu"
          ref={menuRef}
          role="menu"
        >
          <ThinkingControlsPanel
            mode={control.mode}
            modeOptions={control.modeOptions}
            onSetMode={control.onSetMode}
            level={control.level}
            effortOptions={control.effortOptions}
            onSetEffort={control.onSetEffort}
            onSetEffortMode={control.onSetEffortMode}
            showThinking={control.showThinking}
            onSetShowThinking={control.onSetShowThinking}
            provider={control.provider}
            t={t}
            onSelect={close}
            optionRole="menuitemradio"
          />
          <div className={toolbarModuleStyles.thinkingMenuHint}>
            {t("toolbarThinkingAppliesNextTurn")}
          </div>
        </div>
      )}
    </div>
  );
}
