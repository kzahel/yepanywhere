import {
  MAX_PROJECT_CAPTION_LENGTH,
  normalizeProjectCaption,
} from "@yep-anywhere/shared";
import { useCallback, useRef, useState } from "react";
import { useLongPress } from "../hooks/useLongPress";
import { useI18n } from "../i18n";
import type { Project } from "../types";
import styles from "./ProjectCaptionEditor.module.css";
import { IconButton } from "./ui/Button";

interface ProjectCaptionEditorProps {
  project: Project;
  /** Saves an override; `null` clears it so the derived caption returns. */
  onUpdateCaption?: (project: Project, caption: string | null) => Promise<void>;
}

/**
 * Caption line on a project card. Read-only when no save handler is given;
 * otherwise the small pencil button, or a long press / right-click on the
 * caption, opens an inline editor with save (✓) and cancel (×) controls.
 * A plain tap on the caption opens the project like the rest of the card.
 */
export function ProjectCaptionEditor({
  project,
  onUpdateCaption,
}: ProjectCaptionEditorProps) {
  const { t } = useI18n();
  const caption = project.caption;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(caption?.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Set while this edit is being saved or once it is left, so a later blur
  // (the field keeps focus through Enter and may blur as it unmounts) cannot
  // start a second save.
  const closingRef = useRef(false);

  // Focus in the commit that creates the field: opening the editor means the
  // next keystroke belongs to it (topics/early-typing-handoff.md).
  const attachInput = useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const openEditor = () => {
    setDraft(caption?.text ?? "");
    setError(null);
    closingRef.current = false;
    setEditing(true);
  };
  const longPress = useLongPress(openEditor);

  const startEdit = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openEditor();
  };

  const cancelEdit = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    closingRef.current = true;
    setDraft(caption?.text ?? "");
    setError(null);
    setEditing(false);
  };

  // Enter and ✓ commit without moving focus, so a refused caption leaves the
  // user typing in the field; a commit started by leaving the field does not
  // take focus back.
  const commitEdit = async () => {
    if (!onUpdateCaption || closingRef.current) return;
    let next: string;
    try {
      next = normalizeProjectCaption(draft);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("projectCaptionSaveFailed"),
      );
      return;
    }
    closingRef.current = true;
    const unchanged =
      (next === "" && caption?.source !== "override") ||
      (next !== "" && next === caption?.text && caption?.source === "override");
    if (unchanged) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onUpdateCaption(project, next === "" ? null : next);
      setEditing(false);
    } catch (caught) {
      closingRef.current = false;
      setError(
        caught instanceof Error
          ? caught.message
          : t("projectCaptionSaveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  if (!caption && !onUpdateCaption) return null;

  const sourceHint =
    caption?.source === "override"
      ? t("projectCaptionSourceOverride")
      : caption?.source === "manifest"
        ? t("projectCaptionSourceManifest")
        : t("projectCaptionSourceReadme");

  if (editing && onUpdateCaption) {
    return (
      <div className={styles.slot}>
        <div className={styles.editor}>
          <input
            ref={attachInput}
            aria-label={t("projectCaptionLabel")}
            aria-invalid={error ? true : undefined}
            className={styles.input}
            readOnly={saving}
            maxLength={MAX_PROJECT_CAPTION_LENGTH}
            placeholder={t("projectCaptionPlaceholder")}
            value={draft}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onBlur={() => void commitEdit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitEdit();
              } else if (event.key === "Escape") {
                cancelEdit(event);
              }
            }}
          />
          <IconButton
            size="small"
            label={t("projectCaptionSave")}
            disabled={saving}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void commitEdit();
            }}
          >
            ✓
          </IconButton>
          <IconButton
            size="small"
            label={t("projectCaptionCancelEdit")}
            disabled={saving}
            onMouseDown={(event) => event.preventDefault()}
            onClick={cancelEdit}
          >
            ×
          </IconButton>
        </div>
        {error && (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }

  if (onUpdateCaption) {
    return (
      <div className={`${styles.slot} ${styles.editableSlot}`}>
        {caption && (
          // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the long press is a touch shortcut; the pencil button is the keyboard path to the editor
          <span
            className={`${styles.caption} ${styles.pressable}`}
            title={sourceHint}
            {...longPress.handlers}
            onClick={(event) => {
              // A plain tap belongs to the card; only the click ending a
              // long press is swallowed.
              let swallowed = true;
              longPress.click(() => {
                swallowed = false;
              })();
              if (swallowed) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            {caption.text}
          </span>
        )}
        <IconButton
          size="small"
          className={styles.editButton}
          label={caption ? t("projectCaptionEdit") : t("projectCaptionAdd")}
          onClick={startEdit}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </IconButton>
      </div>
    );
  }

  return (
    <div className={styles.slot}>
      <span className={styles.caption} title={sourceHint}>
        {caption?.text}
      </span>
    </div>
  );
}
