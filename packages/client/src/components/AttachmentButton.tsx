import { useI18n } from "../i18n";
import { hasCoarsePointer } from "../lib/deviceDetection";
import { useAttachmentAction } from "../hooks/useAttachmentAction";
import { useSourceContextMenu } from "./SourceContextMenu";

interface Props {
  className: string;
  disabled: boolean;
  count: number;
  onFiles?: () => void;
  onMemo?: () => void;
  onHide?: () => void;
  onPanel?: () => void;
}

/** Attach files or record an audio memo; touch and context gestures share a menu. */
export function AttachmentButton({
  className,
  disabled,
  count,
  onFiles,
  onMemo,
  onHide,
  onPanel,
}: Props) {
  const { t } = useI18n();
  const [preference] = useAttachmentAction();
  const menu = useSourceContextMenu(t, {
    menu: t("audioMemoShareMenu"),
    heading: t("audioMemoShareMenu"),
  });
  const primary = !onMemo
    ? "files"
    : preference === "auto"
      ? hasCoarsePointer()
        ? "menu"
        : "files"
      : preference;
  const actions = [
    { label: t("toolbarAttachFiles"), onSelect: () => onFiles?.() },
    ...(onMemo ? [{ label: t("audioMemoRecord"), onSelect: onMemo }] : []),
    ...(onHide
      ? [
          {
            label: t("appearanceToolbarHide"),
            onSelect: onHide,
            separatorBefore: true,
          },
        ]
      : []),
  ];
  const gestures = menu.targetProps(actions, () => {});
  return (
    <>
      <button
        {...gestures}
        onContextMenu={(event) => {
          if (onPanel && window.innerWidth >= 900 && !hasCoarsePointer()) {
            event.preventDefault();
            event.stopPropagation();
            onPanel();
          } else gestures.onContextMenu?.(event);
        }}
        type="button"
        className={className}
        data-session-toolbar-control="attachments"
        data-session-toolbar-special-context="true"
        data-attachment-menu="true"
        disabled={disabled}
        aria-label={t("toolbarAttachFiles")}
        aria-haspopup="menu"
        title={
          disabled
            ? t("toolbarAttachDisabled")
            : !onMemo
              ? t("toolbarAttachFiles")
              : primary === "memo"
                ? t("audioMemoAttachTooltipFiles")
                : t("audioMemoAttachTooltip")
        }
        onClick={(event) => {
          if (menu.consumeLongPressClick()) return;
          const action =
            event.shiftKey && onMemo
              ? primary === "memo"
                ? "files"
                : "memo"
              : primary;
          if (action === "menu") menu.openFromButton(event, actions);
          else if (action === "memo") onMemo?.();
          else onFiles?.();
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        {count > 0 && <span className="attach-count">{count}</span>}
      </button>
      {menu.menu}
    </>
  );
}
