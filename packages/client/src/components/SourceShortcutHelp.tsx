import { useRef, useState } from "react";
import type { TranslationFn } from "../i18n";
import { ButtonBase } from "./ui/Button";
import { Popover } from "./ui/Popover";
import styles from "./SourceShortcutHelp.module.css";

/** Compact hover/focus/tap disclosure for Source Control keyboard shortcuts. */
export function SourceShortcutHelp({ t }: { t: TranslationFn }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const open = hovered || focused || pinned;
  const close = () => {
    setPinned(false);
    setHovered(false);
    setFocused(false);
  };

  const shortcuts = [
    ["/", t("sourceShortcutSearch")],
    ["↑ ↓ ← →", t("sourceShortcutNavigate")],
    ["[ ]", t("sourceShortcutFileDiffs")],
    ["PgUp PgDn", t("sourceShortcutScrollDiff")],
    ["Enter", t("sourceShortcutOpen")],
    ["Esc", t("sourceShortcutBack")],
    ["N P", t("sourceShortcutHunks")],
    ["⇧ F10", t("sourceShortcutActions")],
  ] as const;

  return (
    <span
      ref={rootRef}
      className={styles.root}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
    >
      <ButtonBase
        ref={triggerRef}
        className={styles.trigger}
        aria-label={t("sourceShortcutHelp")}
        aria-expanded={open}
        onClick={(event) => {
          if (pinned) {
            close();
            event.currentTarget.blur();
          } else {
            setPinned(true);
          }
        }}
      >
        ?
      </ButtonBase>
      {/* Portaled, but a React child of the root, so hovering it keeps
          the root's pointer hover. */}
      <Popover
        open={open}
        onClose={close}
        anchorRef={triggerRef}
        insideRefs={[rootRef]}
        placement="bottom-end"
        role="tooltip"
        surface="card"
        className={styles.popover}
      >
        <span className={styles.popoverTitle}>{t("sourceShortcutHelp")}</span>
        {shortcuts.map(([keys, label]) => (
          <span key={keys} className={styles.row}>
            <kbd>{keys}</kbd>
            <span>{label}</span>
          </span>
        ))}
      </Popover>
    </span>
  );
}
