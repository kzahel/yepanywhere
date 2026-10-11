import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  projectTemplatesApi,
  type ProjectTemplateChoice,
  type TemplateCreationOperation,
  type TemplateCreationRequest,
} from "../api/projectTemplatesClient";
import { useI18n } from "../i18n";
import { pathForProjectName } from "../lib/newProjectPath";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import type { Project } from "../types";
import styles from "./TemplateProjectForm.module.css";
import { useActingPrincipal } from "../hooks/useActingPrincipal";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { ComposerRecents } from "./ComposerRecents";
import { PromptHistoryRail } from "./PromptHistoryRail";
import {
  rememberComposerPrompt,
  rememberComposerUpload,
} from "../lib/composerHistory";
import {
  SERVER_CAPABILITIES,
  serverHasCapability,
  type StagedAttachmentRef,
} from "@yep-anywhere/shared";
import { useVersion } from "../hooks/useVersion";
import { useToastContext } from "../contexts/ToastContext";
import { generateUUID } from "../lib/uuid";
import { TemplateCreationProgress } from "./TemplateCreationProgress";

/** One radio in a project's starting-point palette. */
export interface ProjectStartChoice {
  key: string;
  title: string;
  description?: string;
  icon?: string;
}

/** The radio palette of project starting points, templates or otherwise. */
export function ProjectStartPalette({
  name,
  legend,
  choices,
  selected,
  onSelect,
  disabled,
  children,
}: {
  name: string;
  legend: string;
  choices: readonly ProjectStartChoice[];
  selected: string | undefined;
  onSelect: (key: string) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <fieldset className={styles.palette} disabled={disabled}>
      <legend>{legend}</legend>
      {choices.map((item) => (
        <label className={styles.choice} key={item.key}>
          <input
            type="radio"
            name={name}
            checked={selected === item.key}
            onChange={() => onSelect(item.key)}
          />
          {item.icon && <img className={styles.icon} src={item.icon} alt="" />}
          <span>
            <strong>{item.title}</strong>
            {item.description && <small>{item.description}</small>}
          </span>
        </label>
      ))}
      {children}
    </fieldset>
  );
}

export const templateChoiceKey = (item: ProjectTemplateChoice) =>
  `${item.sourceId}/${item.id}`;

interface Props {
  templates: ProjectTemplateChoice[];
  projects: readonly Project[];
  pathBase: string;
  initialName?: string;
  intent?: string;
  sessionSettings?: Record<string, unknown>;
  onBusyChange?: (busy: boolean) => void;
  disabledReason?: string;
  emptyMessage?: string;
  stagedAttachments?: TemplateCreationRequest["stagedAttachments"];
  onStarted: (projectId: string, sessionId: string) => void;
  /**
   * The template, name and path chosen by an enclosing form, which then owns
   * the palette and name fields; this form keeps only creation and progress.
   */
  chosen?: { template: ProjectTemplateChoice; name: string; path: string };
  /** A creation resumed after reload, so the enclosing form can show it. */
  onRecovered?: (request: TemplateCreationRequest) => void;
}

/** The same template radio palette and creation operation in both project entry points. */
export function TemplateProjectForm({
  templates,
  projects,
  pathBase,
  initialName = "",
  intent,
  sessionSettings = {},
  onBusyChange,
  disabledReason,
  emptyMessage,
  stagedAttachments,
  onStarted,
  chosen,
  onRecovered,
}: Props) {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const { version } = useVersion();
  const attachmentsSupported = serverHasCapability(
    version,
    SERVER_CAPABILITIES.templatePreparationAttachments.name,
  );
  const sourceKey = useClientSummarySourceKey();
  const { principal, resolved } = useActingPrincipal();
  const limited = principal.username !== null;
  const historyScope = resolved
    ? JSON.stringify([sourceKey, principal.username])
    : null;
  const { transport } = useCurrentSourceRuntime();
  const [localAttachments, setLocalAttachments] = useState<
    StagedAttachmentRef[]
  >([]);
  const [uploading, setUploading] = useState(0);
  const [recentUploadsOpen, setRecentUploadsOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentBatch = useRef(generateUUID());
  const attachGesture = useRef({ y: 0, swiped: false });
  const storageKey = `ya-template-creation:${sourceKey}${limited ? `:${principal.username}` : ""}`;
  const id = useId();
  const [name, setName] = useState(initialName);
  const [nameEdited, setNameEdited] = useState(false);
  const [parent, setParent] = useState(pathBase);
  const [description, setDescription] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const [operation, setOperation] = useState<TemplateCreationOperation | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<TemplateCreationRequest | null>(null);
  const completed = useRef(false);
  const recovered = useRef(false);
  const selected =
    chosen?.template ??
    templates.find((item) => templateChoiceKey(item) === selection) ??
    (selection === null ? templates[0] : undefined);
  const effectiveName = chosen?.name ?? name;
  const path =
    request.current?.path ??
    chosen?.path ??
    pathForProjectName(name, limited ? pathBase : parent, projects, false);
  const effectiveIntent = intent ?? description;
  const running =
    operation !== null &&
    !["started", "failed", "interrupted"].includes(operation.phase);
  const locked = pending || operation !== null || request.current !== null;
  const attachFiles = async (files: File[]) => {
    if (!resolved || locked || !attachmentsSupported) return;
    setUploading((count) => count + files.length);
    for (const file of files) {
      try {
        const ref = await transport.uploadStagedAttachment(file, {
          batchId: attachmentBatch.current,
        });
        setLocalAttachments((items) => [...items, ref]);
        if (historyScope)
          void rememberComposerUpload(historyScope, file, {
            projectName: effectiveName,
          }).catch((cause) =>
            showToast(
              t("composerHistorySaveError", { error: String(cause) }),
              "error",
            ),
          );
      } catch (cause) {
        setError(`Could not attach ${file.name}: ${String(cause)}`);
      } finally {
        setUploading((count) => count - 1);
      }
    }
  };

  useEffect(() => {
    onBusyChange?.(
      pending || running || (request.current !== null && operation === null),
    );
  }, [pending, running, operation, onBusyChange]);

  useEffect(() => {
    if (!resolved || recovered.current) return;
    recovered.current = true;
    const saved = sessionStorage.getItem(storageKey);
    if (!saved) return;
    const retained = JSON.parse(saved) as TemplateCreationRequest;
    request.current = retained;
    setName(retained.name);
    setNameEdited(true);
    setDescription(retained.intent);
    setSelection(`${retained.sourceId}/${retained.templateId}`);
    onRecovered?.(retained);
    setPending(true);
    void projectTemplatesApi
      .create(retained)
      .then(setOperation)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setPending(false));
  }, [storageKey, resolved, onRecovered]);

  useEffect(() => {
    if (!nameEdited && !request.current) setName(initialName);
  }, [initialName, nameEdited]);

  useEffect(() => {
    if (!operation || !running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await projectTemplatesApi.operation(
          operation.request.operationId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setOperation(next);
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        timer = setTimeout(() => void poll(), 2000);
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [operation, running]);

  useEffect(() => {
    if (
      !completed.current &&
      operation?.phase === "started" &&
      operation.projectId &&
      operation.sessionId
    ) {
      completed.current = true;
      sessionStorage.removeItem(storageKey);
      onStarted(operation.projectId, operation.sessionId);
    }
  }, [operation, onStarted, storageKey]);

  const create = async () => {
    if (
      !resolved ||
      uploading > 0 ||
      pending ||
      disabledReason ||
      !selected ||
      !effectiveName.trim() ||
      !effectiveIntent.trim() ||
      !path
    )
      return;
    request.current ??= {
      operationId: generateUUID(),
      sourceId: selected.sourceId,
      templateId: selected.id,
      path,
      name: effectiveName,
      intent: effectiveIntent,
      session: sessionSettings,
      ...(stagedAttachments || localAttachments.length
        ? {
            stagedAttachments: stagedAttachments ?? {
              batchId: attachmentBatch.current,
              refs: localAttachments,
            },
          }
        : {}),
    };
    setPending(true);
    setError(null);
    if (historyScope)
      void rememberComposerPrompt(historyScope, effectiveIntent).catch(
        (cause) =>
          showToast(
            t("composerHistorySaveError", { error: String(cause) }),
            "error",
          ),
      );
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(request.current));
      setOperation(await projectTemplatesApi.create(request.current));
    } catch (caught) {
      if (
        caught &&
        typeof caught === "object" &&
        "status" in caught &&
        [400, 403, 409].includes(Number(caught.status))
      ) {
        request.current = null;
        sessionStorage.removeItem(storageKey);
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      className={styles.form}
      // A chosen template belongs to the enclosing form's New project region.
      aria-label={chosen ? undefined : t("templateNewProject")}
    >
      {!chosen && (
        <ProjectStartPalette
          name={`${id}-template`}
          legend={t("templateChoose")}
          disabled={locked}
          choices={templates.map((item) => ({
            key: templateChoiceKey(item),
            title: item.title,
            description: item.description,
            icon: item.icon,
          }))}
          selected={selected && templateChoiceKey(selected)}
          onSelect={setSelection}
        >
          {templates.length === 0 && (
            <p role="status">
              {emptyMessage ??
                t(limited ? "templateNoneForUser" : "templateNoReady")}
            </p>
          )}
        </ProjectStartPalette>
      )}
      {selected?.preview && (
        <img
          className={styles.preview}
          src={selected.preview}
          alt={selected.title}
        />
      )}
      {!chosen && (
        <label className={styles.field}>
          {t("projectsAddNameLabel")}
          <input
            value={name}
            onChange={(e) => {
              setNameEdited(true);
              setName(e.target.value);
            }}
            disabled={locked}
            placeholder={t("templateNameExample")}
          />
        </label>
      )}
      {intent === undefined && (
        <div>
          <ComposerRecents
            newSession
            disabled={locked || !attachmentsSupported}
            scope={historyScope}
            onFiles={(files) => void attachFiles(files)}
            uploadsOpen={recentUploadsOpen}
            onUploadsClose={() => setRecentUploadsOpen(false)}
            onBrowse={() => fileInput.current?.click()}
          />
          <label className={styles.field} htmlFor={`${id}-intent`}>
            {t("templateIntent")}
          </label>
          <PromptHistoryRail
            scope={historyScope}
            textareaRef={textareaRef}
            onChange={setDescription}
          >
            <div className={styles.field}>
              <textarea
                id={`${id}-intent`}
                ref={textareaRef}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files);
                  if (files.length) {
                    event.preventDefault();
                    void attachFiles(files);
                  }
                }}
                disabled={locked}
                rows={3}
                placeholder={t("templateIntentExample")}
              />
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void attachFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className={styles.secondary}
              disabled={locked || !resolved || !attachmentsSupported}
              onClick={() => {
                if (attachGesture.current.swiped) {
                  attachGesture.current.swiped = false;
                  return;
                }
                fileInput.current?.click();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setRecentUploadsOpen(true);
              }}
              onTouchStart={(event) => {
                attachGesture.current = {
                  y: event.touches[0]?.clientY ?? 0,
                  swiped: false,
                };
              }}
              onTouchEnd={(event) => {
                if (
                  (event.changedTouches[0]?.clientY ?? 0) -
                    attachGesture.current.y >
                  25
                ) {
                  attachGesture.current.swiped = true;
                  setRecentUploadsOpen(true);
                }
              }}
              title="Choose files; right-click or swipe down for recent uploads"
            >
              Attach files
            </button>
            {uploading > 0 && <p role="status">Uploading attachments…</p>}
            {localAttachments.map((file) => (
              <span key={file.id} className={styles.attachment}>
                {file.originalName}
                <button
                  type="button"
                  disabled={locked}
                  aria-label={`Remove ${file.originalName}`}
                  onClick={() =>
                    setLocalAttachments((items) =>
                      items.filter((item) => item.id !== file.id),
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </PromptHistoryRail>
        </div>
      )}
      {!limited && !chosen && (
        <label className={styles.field}>
          {t("templateParent")}
          <input
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            disabled={locked}
          />
        </label>
      )}
      {path && !chosen && <small className={styles.path}>{path}</small>}
      <button
        type="button"
        className={styles.action}
        onClick={() => void create()}
        disabled={
          !resolved ||
          uploading > 0 ||
          pending ||
          !!disabledReason ||
          operation !== null ||
          !selected ||
          !effectiveName.trim() ||
          !effectiveIntent.trim() ||
          !path
        }
      >
        {pending
          ? t("projectsAdding")
          : running && operation
            ? t(`templatePhase_${operation.phase}`)
            : t("templateCreatePrepare")}
      </button>
      {disabledReason && <p role="status">{disabledReason}</p>}
      {(pending || operation) && (
        <TemplateCreationProgress operation={operation} />
      )}
      {error && <p role="alert">{error}</p>}
      {operation && ["failed", "interrupted"].includes(operation.phase) && (
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            sessionStorage.removeItem(storageKey);
            request.current = null;
            setOperation(null);
            setError(null);
          }}
        >
          {t("templateReset")}
        </button>
      )}
    </section>
  );
}
