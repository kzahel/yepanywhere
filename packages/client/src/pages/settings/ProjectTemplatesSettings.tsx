import { useEffect, useState } from "react";
import {
  DEFAULT_PROJECT_TEMPLATE_SOURCE,
  DEFAULT_PROJECT_TEMPLATE_SOURCES,
  type ProjectTemplateSourceState,
  type ProjectTemplateSourcesConfig,
} from "@yep-anywhere/shared";
import { fetchJSON } from "../../api/sourceApiFetch";
import { useActingPrincipal } from "../../hooks/useActingPrincipal";
import { useI18n } from "../../i18n";
import { generateUUID } from "../../lib/uuid";
import { SettingsSection } from "./SettingsSection";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import styles from "./ProjectTemplatesSettings.module.css";

function editConfig(config: ProjectTemplateSourcesConfig) {
  return {
    ...config,
    sources: config.sources.map((source) => ({
      ...source,
      location:
        source.repository +
        (source.contentPath ? `/${source.contentPath}` : ""),
    })),
  };
}

type EditedSource = ReturnType<typeof editConfig>["sources"][number];

function isLocalLocation(location: string) {
  return /^(?:\/|~\/|[A-Za-z]:[\\/])/.test(location);
}

const GITHUB_REF_URL =
  /^(?:https:\/\/)?github\.com\/([^/]+\/[^/]+)\/(tree|blob)\/(.+?)\/?$/;

/**
 * Splits a GitHub address-bar URL for a directory (`…/tree/<ref>/<path>`) or
 * its `library.json` (`…/blob/<ref>/<path>/library.json`) into the location
 * field and the revision field. GitHub's URL does not delimit a ref containing
 * `/`, so the ref is the revision already entered when the URL continues with
 * it, and otherwise the first segment. A link to any other file is left as
 * typed; `githubFileLocation` reports it.
 */
function splitGitHubRefUrl(source: EditedSource): EditedSource {
  const match = GITHUB_REF_URL.exec(source.location.trim());
  if (!match) return source;
  const [, repository, kind, rest = ""] = match;
  const typed = source.revision.trim();
  const revision =
    typed && (rest === typed || rest.startsWith(`${typed}/`))
      ? typed
      : (rest.split("/")[0] ?? "");
  const path = rest.slice(revision.length + 1);
  const directory =
    kind === "blob" ? path.replace(/(?:^|\/)library\.json$/, "") : path;
  if (kind === "blob" && directory === path) return source;
  return {
    ...source,
    location: `https://github.com/${repository}${directory ? `/${directory}` : ""}`,
    revision,
  };
}

function githubFileLocation(source: EditedSource) {
  return GITHUB_REF_URL.exec(source.location.trim())?.[2] === "blob";
}

function sourceConfig(source: EditedSource) {
  const { location, ...config } = source;
  const value = location
    .trim()
    .replace(/^github\.com\//, "https://github.com/");
  const github = /^(https:\/\/github\.com\/[^/]+\/[^/]+)(?:\/(.*))?$/.exec(
    value,
  );
  return {
    ...config,
    repository: github?.[1] ?? value,
    contentPath: github?.[2] ?? "",
    revision: isLocalLocation(value) ? "HEAD" : config.revision,
  };
}

export function ProjectTemplatesSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("settingsProjectTemplatesTitle"));
  const { principal, resolved } = useActingPrincipal();
  const allowed = resolved && principal.superuser && !principal.switched;
  const [state, setState] = useState<ProjectTemplateSourceState | null>(null);
  const [draft, setDraft] = useState(() =>
    editConfig(DEFAULT_PROJECT_TEMPLATE_SOURCES),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    void fetchJSON<ProjectTemplateSourceState>("/project-template-source")
      .then((value) => {
        if (active) {
          setState(value);
          setDraft(editConfig(value.config));
        }
      })
      .catch((cause: Error) => {
        if (active) setError(cause.message);
      });
    return () => {
      active = false;
    };
  }, [allowed]);

  useEffect(() => {
    if (!allowed || state?.phase !== "fetching") return;
    let active = true;
    const timer = setTimeout(() => {
      void fetchJSON<ProjectTemplateSourceState>("/project-template-source")
        .then((value) => {
          if (active) setState(value);
        })
        .catch((cause: Error) => {
          if (active) {
            setError(cause.message);
            setState((previous) =>
              previous ? { ...previous, phase: "error" } : null,
            );
          }
        });
    }, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [allowed, state]);

  // Only a location the user changed is read as a GitHub address-bar URL: a
  // saved content directory named `tree` or `blob` displays like one.
  const savedLocations = new Map(
    (state ? editConfig(state.config).sources : []).map((source) => [
      source.id,
      source.location,
    ]),
  );
  const locationEdited = (source: EditedSource) =>
    savedLocations.get(source.id) !== source.location;

  const save = async (defaultTip?: string) => {
    const split = {
      ...draft,
      sources: draft.sources.map((source) =>
        locationEdited(source) ? splitGitHubRefUrl(source) : source,
      ),
    };
    if (
      split.sources.some(
        (source) => locationEdited(source) && githubFileLocation(source),
      )
    ) {
      setError(t("templatesFileLocation"));
      return;
    }
    setSaving(true);
    setError(null);
    const edited = defaultTip
      ? {
          ...split,
          enabled: true,
          sources: split.sources.map((source) =>
            source.id === defaultTip ? { ...source, revision: "HEAD" } : source,
          ),
        }
      : split;
    setDraft(edited);
    const config = {
      enabled: edited.enabled,
      sources: edited.sources.map(sourceConfig),
    };
    try {
      const value = await fetchJSON<ProjectTemplateSourceState>(
        "/project-template-source",
        { method: "PUT", body: JSON.stringify(config) },
      );
      setState(value);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!allowed) return null;
  const busy = saving || state?.phase === "fetching";
  return (
    <SettingsSection
      title={t("settingsProjectTemplatesTitle")}
      description={t("settingsProjectTemplatesDescription")}
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className={styles.enabled}>
          <input
            type="checkbox"
            disabled={!state}
            checked={draft.enabled}
            onChange={(event) =>
              setDraft({ ...draft, enabled: event.target.checked })
            }
          />
          {t("templatesEnable")}
        </label>
        <p>{t("templatesLayerHelp")}</p>
        {draft.sources.map((source, index) => (
          <fieldset className={styles.source} key={source.id} disabled={!state}>
            <legend>
              {source.location
                ? source.location.replace("https://github.com/", "")
                : t("templatesNewSource")}
            </legend>
            {(isLocalLocation(source.location)
              ? (["location"] as const)
              : (["location", "revision"] as const)
            ).map((field) => (
              <label className={styles.field} key={field}>
                {t(
                  field === "location"
                    ? "templatesRepository"
                    : "templatesRevision",
                )}
                <input
                  className="settings-input"
                  value={source[field]}
                  onBlur={
                    field === "location"
                      ? () =>
                          setDraft((previous) => ({
                            ...previous,
                            sources: previous.sources.map((entry) =>
                              entry.id === source.id && locationEdited(entry)
                                ? splitGitHubRefUrl(entry)
                                : entry,
                            ),
                          }))
                      : undefined
                  }
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      sources: previous.sources.map((entry) =>
                        entry.id === source.id
                          ? { ...entry, [field]: event.target.value }
                          : entry,
                      ),
                    }))
                  }
                />
              </label>
            ))}
            <div className={styles.actions}>
              <button
                className="settings-button"
                type="button"
                disabled={index === 0 || busy}
                onClick={() =>
                  setDraft((previous) => {
                    const sources = [...previous.sources];
                    const earlier = sources[index - 1];
                    if (!earlier) return previous;
                    sources[index - 1] = source;
                    sources[index] = earlier;
                    return { ...previous, sources };
                  })
                }
              >
                {t("templatesMoveUp")}
              </button>
              <button
                className="settings-button"
                type="button"
                disabled={draft.sources.length === 1 || busy}
                onClick={() =>
                  setDraft((previous) => ({
                    ...previous,
                    sources: previous.sources.filter(
                      (entry) => entry.id !== source.id,
                    ),
                  }))
                }
              >
                {t("templatesRemoveSource")}
              </button>
              {draft.enabled && !isLocalLocation(source.location) && (
                <button
                  className="settings-button"
                  type="button"
                  disabled={busy || !state}
                  onClick={() => void save(source.id)}
                >
                  {t("templatesUpdateHead")}
                </button>
              )}
            </div>
          </fieldset>
        ))}
        <button
          className="settings-button"
          type="button"
          disabled={!state || busy || draft.sources.length >= 20}
          onClick={() =>
            setDraft((previous) => ({
              ...previous,
              sources: [
                ...previous.sources,
                {
                  ...DEFAULT_PROJECT_TEMPLATE_SOURCE,
                  id: `source-${generateUUID()}`,
                  repository: "",
                  contentPath: "",
                  location: "",
                },
              ],
            }))
          }
        >
          {t("templatesAddSource")}
        </button>
        <p>{t("templatesFetchHelp")}</p>
        <div className={styles.actions}>
          <button
            className="settings-button"
            type="submit"
            disabled={busy || !state}
          >
            {draft.enabled ? t("templatesFetch") : t("templatesSave")}
          </button>
        </div>
      </form>
      <div className={styles.status} role="status">
        {state?.phase === "fetching" && t("templatesFetching")}
        {state?.phase === "disabled" && t("templatesDisabled")}
        {state?.phase === "ready" && (
          <p>
            {state.result === "up-to-date"
              ? t("templatesUpToDate")
              : t("templatesFetched")}
          </p>
        )}
        {state?.snapshot && (
          <>
            {state.snapshot.sources.map((source) => (
              <div key={source.id}>
                <p>
                  {source.repository.replace("https://github.com/", "")}
                  {source.commit && (
                    <>
                      {" — "}
                      {t(
                        source.local ? "templatesLocalHead" : "templatesCommit",
                      )}{" "}
                      <code>{source.commit}</code>
                    </>
                  )}
                </p>
                <p>
                  {source.local
                    ? t("templatesLocalDirect")
                    : t("templatesRewritten", { count: source.rewrittenFiles })}
                </p>
              </div>
            ))}
            <ul>
              {state.snapshot.templates.map((template) => (
                <li key={template.id}>
                  <strong>{template.title}</strong> —{" "}
                  {state.snapshot?.sources
                    .find((source) => source.id === template.sourceId)
                    ?.repository.replace("https://github.com/", "")}{" "}
                  — {template.description} (
                  {template.status === "draft"
                    ? t("templatesDraft")
                    : t("templatesReady")}
                  )
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
    </SettingsSection>
  );
}
