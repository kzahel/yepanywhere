import {
  MAX_PROJECT_CODE_NAME_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  allocateProjectCodeName,
  defaultProjectNameForPath,
  normalizeProjectCodeName,
} from "@yep-anywhere/shared";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { pathForProjectName, settlePathEntry } from "../lib/newProjectPath";
import type { Project } from "../types";
import styles from "./AddProjectForm.module.css";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Field, TextInput } from "./ui/Field";

export interface AddProjectRequest {
  path: string;
  /** Present only when the user chose a name other than the path's own. */
  name?: string;
  /** Present only when the user edited the code; else the server allocates. */
  codeName?: string;
}

interface AddProjectFormProps {
  /** Existing projects, for the default code allocation. */
  projects: readonly Project[];
  /**
   * Where a typed name or relative path lands: `~` for the host home, or a
   * limited user's project root.
   */
  pathBase: string;
  /** The server accepts a chosen name and code (`project-names`). */
  chooseName: boolean;
  /** Code names are supported and shown in this browser. */
  chooseCodeName: boolean;
  adding: boolean;
  error: string | null;
  onSubmit: (request: AddProjectRequest) => void;
  onCancel: () => void;
  /** Reports whether the user has typed a path, name or code. */
  onTypedChange?: (typed: boolean) => void;
}

/** An empty or blank draft means "use the default", not a chosen value. */
function chosenDraft(draft: string | null): string | null {
  return draft?.trim() ? draft : null;
}

/**
 * Path entry for a new project, with the name and code the project will get.
 * Both follow the path until the user types into them. An emptied field stays
 * empty while it is edited, so a replacement can be typed from scratch; it
 * shows the default again on blur and submits as the default. The defaults
 * stay visible and editable rather than hidden behind an empty placeholder.
 *
 * The path runs the other way until it is typed into: a name typed first
 * derives the path as it is typed. A path-box entry settles on blur (and on
 * submit): a relative entry lands under `pathBase`, and a description moves
 * to the name and derives the path from it (`lib/newProjectPath.ts`).
 */
export function AddProjectForm({
  projects,
  pathBase,
  chooseName,
  chooseCodeName,
  adding,
  error,
  onSubmit,
  onCancel,
  onTypedChange,
}: AddProjectFormProps) {
  const { t } = useI18n();
  // Null while the path follows the name; a string once typed into.
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [codeDraft, setCodeDraft] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const typed = !!(pathDraft?.trim() || nameDraft?.trim() || codeDraft?.trim());
  useEffect(() => onTypedChange?.(typed), [typed, onTypedChange]);

  const typedName = chosenDraft(nameDraft);
  const path =
    pathDraft ??
    (typedName && chooseName
      ? pathForProjectName(typedName, pathBase, projects)
      : "");
  const defaultName = defaultProjectNameForPath(path);
  const name = typedName ?? defaultName;
  const defaultCode = useMemo(() => {
    if (!chooseCodeName || !name.trim()) return "";
    return allocateProjectCodeName(
      name,
      projects.flatMap((project) =>
        project.codeName ? [project.codeName] : [],
      ),
      projects.map((project) => project.name),
    );
  }, [chooseCodeName, name, projects]);

  /** Settle a typed path entry: see the component comment. */
  const settle = (text: string): { path: string; name: string } => {
    const entry = settlePathEntry(text, pathBase, projects);
    return {
      path: entry.path,
      name: typedName ?? entry.name ?? defaultProjectNameForPath(entry.path),
    };
  };

  const settlePathDraft = () => {
    if (pathDraft === null) return;
    if (!pathDraft.trim()) {
      setPathDraft(null);
      return;
    }
    const entry = settlePathEntry(pathDraft, pathBase, projects);
    if (entry.name !== undefined && chooseName && !typedName) {
      // The description is the name now, and the path follows it.
      setNameDraft(entry.name);
      setPathDraft(null);
    } else {
      setPathDraft(entry.path);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const settled = pathDraft === null ? { path, name } : settle(pathDraft);
    if (!settled.path) return;
    const request: AddProjectRequest = { path: settled.path };
    if (chooseName) {
      const chosenName = settled.name.trim();
      const existing = projects.find(
        (project) => project.path === settled.path,
      );
      // Re-adding a project by its name in another case is not a rename.
      const unchanged = existing
        ? chosenName.toLowerCase() === existing.name.trim().toLowerCase()
        : chosenName === defaultProjectNameForPath(settled.path);
      if (chosenName && !unchanged) request.name = chosenName;
    }
    const chosenCode = chosenDraft(codeDraft);
    if (chooseCodeName && chosenCode) {
      try {
        request.codeName = normalizeProjectCodeName(chosenCode);
      } catch (caught) {
        setCodeError(
          caught instanceof Error
            ? caught.message
            : t("projectCodeNameInvalid"),
        );
        return;
      }
    }
    onSubmit(request);
  };

  return (
    <form onSubmit={submit} className={styles.form}>
      <TextInput
        mono
        aria-label={t("projectsAddPathLabel")}
        value={path}
        onChange={(event) => setPathDraft(event.target.value)}
        onBlur={settlePathDraft}
        placeholder={t("projectsAddPlaceholder")}
        disabled={adding}
      />
      {chooseName && (
        <div className={styles.fields}>
          <Field
            label={t("projectsAddNameLabel")}
            hint={t("projectsAddNameHint")}
            className={styles.field}
          >
            <TextInput
              maxLength={MAX_PROJECT_NAME_LENGTH}
              value={nameDraft ?? defaultName}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={() => setNameDraft(chosenDraft)}
              disabled={adding}
            />
          </Field>
          {chooseCodeName && (
            <Field
              label={t("projectsAddCodeNameLabel")}
              hint={codeError ? undefined : t("projectsAddCodeNameHint")}
              error={codeError}
              className={styles.codeField}
            >
              <TextInput
                mono
                maxLength={MAX_PROJECT_CODE_NAME_LENGTH}
                value={codeDraft ?? defaultCode}
                onChange={(event) => {
                  setCodeError(null);
                  setCodeDraft(event.target.value);
                }}
                onBlur={() => setCodeDraft(chosenDraft)}
                disabled={adding}
              />
            </Field>
          )}
        </div>
      )}
      <div className={styles.actions}>
        <Button
          variant="primary"
          type="submit"
          disabled={adding || !path.trim()}
        >
          {adding ? t("projectsAdding") : t("projectsAddConfirm")}
        </Button>
        <Button onClick={onCancel} disabled={adding}>
          {t("projectsCancel")}
        </Button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
    </form>
  );
}
