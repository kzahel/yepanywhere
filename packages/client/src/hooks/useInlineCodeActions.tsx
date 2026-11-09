import { type MouseEvent, useState } from "react";
import { SourceContextMenu } from "../components/SourceContextMenu";
import { useOptionalToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";

function inlineCodeTarget(event: MouseEvent<HTMLElement>) {
  const code =
    event.target instanceof Element ? event.target.closest("code") : null;
  return code instanceof HTMLElement &&
    event.currentTarget.contains(code) &&
    !code.closest("pre, [contenteditable=true]")
    ? code
    : null;
}

/** Whole-item selection and copy for inline fixed-font Markdown text. */
export function useInlineCodeActions() {
  const [menu, setMenu] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const handleDoubleClick = (event: MouseEvent<HTMLElement>) => {
    const code = inlineCodeTarget(event);
    if (!code) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    event.preventDefault();
  };
  const handleContextMenu = (event: MouseEvent<HTMLElement>) => {
    const code = inlineCodeTarget(event);
    // Linked paths keep the richer file menu; a live range keeps quote actions.
    if (!code || code.closest("a") || event.shiftKey) return false;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return false;
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      text: code.textContent ?? "",
      x: event.clientX,
      y: event.clientY,
    });
    return true;
  };
  return {
    handleDoubleClick,
    handleContextMenu,
    menu: menu ? (
      <InlineCodeMenu {...menu} close={() => setMenu(null)} />
    ) : null,
  };
}

function InlineCodeMenu({
  text,
  x,
  y,
  close,
}: {
  text: string;
  x: number;
  y: number;
  close: () => void;
}) {
  const { t } = useI18n();
  const toast = useOptionalToastContext();
  return (
    <SourceContextMenu
      x={x}
      y={y}
      returnFocus={null}
      t={t}
      onClose={close}
      labels={{
        menu: t("inlineCodeActions"),
      }}
      actions={[
        {
          label: t("sessionCopySelectionText"),
          onSelect: () => {
            void writeClipboardText(text).then((copied) =>
              toast?.showToast(
                t(copied ? "inlineCodeCopied" : "inlineCodeCopyFailed"),
                copied ? "success" : "error",
              ),
            );
          },
        },
      ]}
    />
  );
}
