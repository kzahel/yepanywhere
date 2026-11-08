import type { ProviderName } from "@yep-anywhere/shared";
import {
  type FormEvent,
  type Ref,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useProjects } from "../hooks/useProjects";
import { getLaunchableProviders, useProviders } from "../hooks/useProviders";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import {
  getPreferredProviderModelId,
  getProviderSessionDefaults,
  providerRequiresAdvertisedModel,
} from "../lib/newSessionDefaults";
import { sortProjectsForChooser } from "../lib/newSessionProjects";
import styles from "./NewSessionQueueOptions.module.css";
import { NewSessionQueueMark } from "./NewSessionQueueMark";
import { IconButton } from "./ui/Button";

/**
 * Where a Project Queue new-session item goes and what it launches with.
 * An absent provider or model means the composer's own session settings.
 */
export interface NewSessionQueueTarget {
  projectId: string;
  provider?: ProviderName;
  model?: string;
}

/** A chosen target plus the project name the confirmation names. */
export interface ChosenNewSessionQueueTarget extends NewSessionQueueTarget {
  projectName?: string;
  delivery?: "now";
}

/**
 * Composer-adjacent new session options; the draft stays in its editing host.
 */
export function NewSessionQueueOptions({
  initial,
  primaryDelivery,
  formRef,
  disabled,
  onSubmit,
  onClose,
}: {
  initial: NewSessionQueueTarget;
  primaryDelivery: "now" | "patient";
  formRef?: Ref<HTMLFormElement>;
  disabled?: boolean;
  onSubmit: (target: ChosenNewSessionQueueTarget) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { projects } = useProjects();
  const { providers } = useProviders();
  const { settings } = useServerSettings();
  const launchable = useMemo(
    () => getLaunchableProviders(providers),
    [providers],
  );
  const sortedProjects = useMemo(
    () => sortProjectsForChooser(projects, [initial.projectId]),
    [projects, initial.projectId],
  );
  const [projectId, setProjectId] = useState(initial.projectId);
  const [provider, setProvider] = useState<ProviderName | undefined>(
    initial.provider,
  );
  const [model, setModel] = useState<string | undefined>(initial.model);
  const [modelMenu, setModelMenu] = useState<"browse" | "search" | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const modelListId = useId();
  const modelListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modelMenu) return;
    const list = modelListRef.current;
    const option = list?.children[activeIndex];
    if (!list || !(option instanceof HTMLElement)) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (
      option.offsetTop + option.offsetHeight >
      list.scrollTop + list.clientHeight
    ) {
      list.scrollTop =
        option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [activeIndex, modelMenu]);
  const providerModels =
    launchable.find((candidate) => candidate.name === provider)?.models ?? [];
  const matches = useMemo(() => {
    const query = modelMenu === "search" ? (model ?? "").toLowerCase() : "";
    return launchable.flatMap((candidate) =>
      modelMenu === "browse" && candidate.name !== provider
        ? []
        : (candidate.models ?? [])
            .filter((entry) =>
              `${entry.id} ${entry.name} ${candidate.displayName}`
                .toLowerCase()
                .includes(query),
            )
            .map((entry) => ({
              ...entry,
              provider: candidate.name,
              providerName: candidate.displayName,
            })),
    );
  }, [launchable, model, modelMenu, provider]);
  const canSubmit =
    !disabled &&
    !!projectId &&
    (!providerRequiresAdvertisedModel(provider) ||
      providerModels.some((entry) => entry.id === model));
  const chooseModel = (entry: (typeof matches)[number]) => {
    setModel(entry.id);
    setProvider(entry.provider);
    setModelMenu(null);
  };

  const chooseProvider = (next: ProviderName) => {
    setModelMenu(null);
    setProvider(next);
    if (next === initial.provider) {
      setModel(initial.model);
      return;
    }
    const models =
      launchable.find((candidate) => candidate.name === next)?.models ?? [];
    const saved = getProviderSessionDefaults(
      settings?.newSessionDefaults,
      next,
    );
    setModel(
      getPreferredProviderModelId(next, models, saved.model) ?? undefined,
    );
  };

  const submit = (delivery: "now" | "patient") => {
    if (!canSubmit) return;
    onSubmit({
      projectId,
      provider,
      model,
      projectName: sortedProjects.find((project) => project.id === projectId)
        ?.name,
      ...(delivery === "now" ? { delivery } : {}),
    });
  };

  return (
    <form
      ref={formRef}
      className={`${styles.form} ${primaryDelivery === "now" ? styles.regular : styles.patient}`}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        submit(primaryDelivery);
      }}
      aria-label={t("newSessionQueueOptionsTitle")}
    >
      <div className={styles.fields}>
        <label className={`${styles.field} ${styles.project}`}>
          <span>{t("newSessionQueueOptionsProject")}</span>
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {sortedProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <div
          className={`${styles.field} ${styles.model}`}
          role="group"
          aria-label={t("newSessionQueueOptionsModel")}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setModelMenu(null);
          }}
        >
          <label htmlFor={`${modelListId}-input`}>
            {t("newSessionQueueOptionsModel")}
          </label>
          <div className={styles.modelInput}>
            <input
              id={`${modelListId}-input`}
              value={model ?? ""}
              autoComplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={modelMenu !== null}
              aria-controls={modelListId}
              aria-activedescendant={
                modelMenu && matches[activeIndex]
                  ? `${modelListId}-${activeIndex}`
                  : undefined
              }
              onChange={(event) => {
                setModel(event.target.value);
                setModelMenu("search");
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape" && modelMenu) {
                  event.preventDefault();
                  event.stopPropagation();
                  setModelMenu(null);
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (!modelMenu) {
                    setModelMenu("browse");
                    setActiveIndex(0);
                  } else
                    setActiveIndex((index) =>
                      Math.max(
                        0,
                        Math.min(
                          matches.length - 1,
                          index + (event.key === "ArrowDown" ? 1 : -1),
                        ),
                      ),
                    );
                }
                if (event.key === "Enter" && modelMenu) {
                  event.preventDefault();
                  if (matches[activeIndex]) chooseModel(matches[activeIndex]);
                }
              }}
            />
            <IconButton
              size="small"
              className={styles.browse}
              label={t("newSessionQueueBrowseModels")}
              onClick={() => {
                setModelMenu(modelMenu ? null : "browse");
                setActiveIndex(0);
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </IconButton>
          </div>
          {modelMenu && (
            <div
              className={styles.models}
              ref={modelListRef}
              id={modelListId}
              role="listbox"
              aria-label={t("newSessionQueueOptionsModel")}
            >
              {matches.map((entry, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  id={`${modelListId}-${index}`}
                  key={`${entry.provider}/${entry.id}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseModel(entry)}
                >
                  <span>{entry.name}</span>
                  <small>({entry.providerName})</small>
                </button>
              ))}
              {matches.length === 0 && (
                <span className={styles.empty}>
                  {t("newSessionQueueNoModels")}
                </span>
              )}
            </div>
          )}
        </div>
        {launchable.length > 0 && (
          <label className={styles.field}>
            <span>{t("newSessionQueueOptionsProvider")}</span>
            <select
              value={provider ?? ""}
              onChange={(event) =>
                chooseProvider(event.target.value as ProviderName)
              }
            >
              {!provider && <option value="" />}
              {launchable.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className={styles.actions}>
        <span className={styles.status}>
          {t("newSessionQueueStatus")} ·{" "}
          <strong>
            {sortedProjects.find((project) => project.id === projectId)?.name}
          </strong>
        </span>
        <IconButton
          label={t("newSessionQueueExit")}
          className={styles.close}
          onClick={onClose}
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
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </IconButton>
        <div className={styles.sendActions}>
          {(["now", "patient"] as const).map((delivery) => (
            <button
              key={delivery}
              type="button"
              className={`${styles.send} ${delivery === "now" ? styles.regular : styles.patient}`}
              disabled={!canSubmit}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => submit(delivery)}
              aria-label={t(
                delivery === "now"
                  ? "newSessionQueueStartNow"
                  : "newSessionQueueOptionsSubmit",
              )}
              title={`${t(delivery === "now" ? "newSessionQueueStartNow" : "toolbarProjectQueueNewSessionTooltip")}${delivery === primaryDelivery ? " · Enter" : ""}`}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 12h12m-5-5 5 5-5 5m9-12v14" />
              </svg>
              <NewSessionQueueMark />
            </button>
          ))}
        </div>
      </div>
    </form>
  );
}
