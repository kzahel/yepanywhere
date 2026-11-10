import {
  MAX_PROJECT_CODE_NAME_LENGTH,
  normalizeProjectCodeName,
} from "@yep-anywhere/shared";
import { useCallback, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { Project } from "../types";
import styles from "./ProjectCodeNameEditor.module.css";
import { Button, IconButton } from "./ui/Button";
import { TextInput } from "./ui/Field";

interface ProjectCodeNameEditorProps {
  project: Project;
  onUpdateCodeName?: (project: Project, codeName: string) => Promise<void>;
  /**
   * Why the last commit was refused. The caller renders it, because the chip
   * sits in a title line that clips anything laid out below it.
   */
  error: string | null;
  onErrorChange: (error: string | null) => void;
  /** Id of the element showing `error`, for the field's `aria-describedby`. */
  errorId: string;
}

export function ProjectCodeNameEditor({
  project,
  onUpdateCodeName,
  error,
  onErrorChange: setError,
  errorId,
}: ProjectCodeNameEditorProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.codeName ?? "");
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

  const startEdit = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDraft(project.codeName ?? "");
    setError(null);
    closingRef.current = false;
    setEditing(true);
  };

  const cancelEdit = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    closingRef.current = true;
    setDraft(project.codeName ?? "");
    setError(null);
    setEditing(false);
  };

  // Enter commits without moving focus, so a refused code leaves the user
  // typing in the field; a commit started by leaving the field does not take
  // focus back.
  const commitEdit = async () => {
    if (!onUpdateCodeName || closingRef.current) return;
    let codeName: string;
    try {
      codeName = normalizeProjectCodeName(draft);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("projectCodeNameInvalid"),
      );
      return;
    }
    closingRef.current = true;
    if (codeName === project.codeName) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onUpdateCodeName(project, codeName);
      setEditing(false);
    } catch (caught) {
      closingRef.current = false;
      setError(
        caught instanceof Error
          ? caught.message
          : t("projectCodeNameSaveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  if (!project.codeName) return null;

  return (
    <div className={styles.slot}>
      {editing && onUpdateCodeName ? (
        <div className={styles.editor}>
          <TextInput
            ref={attachInput}
            size="small"
            aria-label={t("projectCodeNameLabel")}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={styles.input}
            readOnly={saving}
            maxLength={MAX_PROJECT_CODE_NAME_LENGTH}
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
            label={t("projectCodeNameCancelEdit")}
            disabled={saving}
            onMouseDown={(event) => event.preventDefault()}
            onClick={cancelEdit}
          >
            ×
          </IconButton>
        </div>
      ) : onUpdateCodeName ? (
        <Button
          variant="outline"
          textFlow="truncate"
          size="dense"
          className={styles.codeNameButton}
          aria-label={t("projectCodeNameEdit")}
          onClick={startEdit}
        >
          {project.codeName}
        </Button>
      ) : (
        <span className={styles.codeName}>{project.codeName}</span>
      )}
    </div>
  );
}
