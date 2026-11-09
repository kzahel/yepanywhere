import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import type { TranslationFn } from "../i18n";
import { useSourceContextMenu } from "./SourceContextMenu";

const BROWSER_DEBUG_CONTEXT_KEY = "browser-debug";

interface DataAttributes {
  "data-session-toolbar-control"?: string;
  "data-session-toolbar-special-context"?: "true";
}

export interface BrowserDebugToolbarButtonProps {
  t: TranslationFn;
  active: boolean;
  connected: boolean;
  disabled?: boolean;
  className: string;
  title: string;
  menuItem?: boolean;
  onToggle: () => void;
  onReactivate: () => void;
  onReload: () => void;
  children: ReactNode;
  dataAttributes?: DataAttributes;
}

/** Optional debug actions stay out of the initial composer bundle. */
export function BrowserDebugToolbarButton({
  t,
  active,
  connected,
  disabled,
  className,
  title,
  menuItem = false,
  onToggle,
  onReactivate,
  onReload,
  children,
  dataAttributes,
}: BrowserDebugToolbarButtonProps) {
  const contextMenu = useSourceContextMenu(t, {
    menu: t("toolbarBrowserDebugMenu"),
  });
  const actions = useMemo(
    () =>
      active
        ? [
            {
              label: t("toolbarBrowserDebugReload"),
              onSelect: onReload,
            },
            {
              label: t("toolbarBrowserDebugReactivate"),
              onSelect: onReactivate,
              disabled: connected,
            },
            {
              label: t("toolbarBrowserDebugDisableNow"),
              onSelect: onToggle,
              separatorBefore: true,
            },
          ]
        : [
            {
              label: t("toolbarBrowserDebugEnable"),
              onSelect: onToggle,
            },
          ],
    [active, connected, onReactivate, onReload, onToggle, t],
  );
  useEffect(() => {
    contextMenu.refreshOpenActions(BROWSER_DEBUG_CONTEXT_KEY, actions);
  }, [actions, contextMenu.refreshOpenActions]);
  const ariaProps = menuItem
    ? ({ role: "menuitemcheckbox", "aria-checked": active } as const)
    : ({ "aria-pressed": active } as const);

  return (
    <>
      <button
        type="button"
        className={className}
        {...dataAttributes}
        {...contextMenu.targetProps(actions, onToggle, {
          contextKey: BROWSER_DEBUG_CONTEXT_KEY,
        })}
        {...ariaProps}
        title={title}
        aria-label={title}
        disabled={disabled}
        data-browser-debug-context-menu="true"
      >
        {children}
      </button>
      {contextMenu.menu}
    </>
  );
}
