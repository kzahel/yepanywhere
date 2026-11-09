import {
  DEFAULT_JIRA_KEY_BLOCKLIST,
  ISSUE_CONTENT_TTL_SECONDS,
  ISSUE_STATUS_COMMENT_TTL_SECONDS,
  SERVER_CAPABILITIES,
  serverHasCapability,
  type IssueCoverage,
  type KnownJiraProject,
  type IssueCredentialStatus,
  type IssueCredentialsResult,
  type IssueSettings as Settings,
} from "@yep-anywhere/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Select, TextInput } from "../../components/ui/Field";
import { Switch } from "../../components/ui/Switch";
import { useCurrentSourceRuntime } from "../../contexts/SourceRuntimeContext";
import { useVersion } from "../../hooks/useVersion";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { SettingsSection } from "./SettingsSection";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import styles from "./IssueSettings.module.css";

export function IssueSettings() {
  const { t } = useI18n();
  const runtime = useCurrentSourceRuntime();
  useSettingsPaneTitle(t("issuesTitle"));
  return (
    <SettingsSection
      title={t("issuesTitle")}
      description={t("issuesDescription")}
      doc="topics/issue-session-associations.md"
    >
      <IssueSettingsControls key={runtime.sourceKey} />
    </SettingsSection>
  );
}
function IssueSettingsControls() {
  const { t } = useI18n();
  const { transport } = useCurrentSourceRuntime();
  const { refetch } = useServerSettings();
  const [settings, setSettings] = useState<Settings>();
  const [projects, setProjects] = useState<KnownJiraProject[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const source = useRef(transport);
  source.current = transport;
  useEffect(() => {
    let disposed = false;
    setSettings(undefined);
    setError("");
    setBusy(false);
    transport
      .fetch<IssueCoverage>("/issues/settings")
      .then((result) => {
        if (!disposed) {
          setSettings(result.settings);
          setProjects(result.knownJiraProjects ?? []);
        }
      })
      .catch(() => {
        if (!disposed) setError(t("issuesLoadError"));
      });
    return () => {
      disposed = true;
    };
  }, [transport, t]);
  const save = async (next: Settings) => {
    const previous = settings;
    setSettings(next);
    setBusy(true);
    setError("");
    try {
      const result = await transport.fetch<IssueCoverage>("/issues/settings", {
        method: "PUT",
        body: JSON.stringify(next),
      });
      if (source.current === transport) {
        setSettings(result.settings);
        setProjects(result.knownJiraProjects ?? []);
        await refetch();
      }
    } catch {
      if (source.current === transport) {
        setSettings(previous);
        setError(t("issuesSaveError"));
      }
    } finally {
      if (source.current === transport) setBusy(false);
    }
  };
  return (
    <div className={styles.settings}>
      <SettingsItem
        as="label"
        id="issue-discovery-enabled"
        label={t("issuesEnable")}
        description={t("issuesRetention")}
      >
        <Switch
          aria-label={t("issuesEnable")}
          checked={settings?.enabled ?? false}
          disabled={!settings || busy}
          onCheckedChange={(checked) =>
            settings && void save({ ...settings, enabled: checked })
          }
        />
      </SettingsItem>
      <SettingsItem
        id="issue-discovery-scope"
        label={t("issuesScope")}
        className={styles.scopeRow}
        description={
          settings?.scope === "recent"
            ? t("issuesRecentHelp")
            : t("issuesViewedHelp")
        }
      >
        <Select
          className={styles.control}
          aria-label={t("issuesScope")}
          value={settings?.scope ?? "viewed"}
          disabled={!settings || busy}
          onChange={(e) =>
            settings &&
            void save({
              ...settings,
              scope: e.target.value as Settings["scope"],
            })
          }
        >
          <option value="viewed">{t("issuesViewed")}</option>
          <option value="recent">{t("issuesRecent")}</option>
        </Select>
      </SettingsItem>
      {settings?.scope === "recent" && (
        <SettingsItem id="issue-discovery-days" label={t("issuesDays")}>
          <TextInput
            className={styles.days}
            type="number"
            aria-label={t("issuesDays")}
            min={1}
            max={90}
            defaultValue={settings.recentDays}
            disabled={busy}
            onBlur={(e) => {
              const days = Number(e.target.value);
              if (Number.isInteger(days) && days >= 1 && days <= 90)
                void save({ ...settings, recentDays: days });
              else e.target.value = String(settings.recentDays);
            }}
          />
        </SettingsItem>
      )}
      {settings?.contentTtlSeconds !== undefined && (
        <CacheTtlControl
          settings={settings}
          busy={busy}
          save={save}
          field="contentTtlSeconds"
        />
      )}
      {settings?.statusCommentTtlSeconds !== undefined && (
        <CacheTtlControl
          settings={settings}
          busy={busy}
          save={save}
          field="statusCommentTtlSeconds"
        />
      )}
      <SettingsItem
        as="label"
        id="issue-aggressive-matching"
        label={t("issuesAggressiveMatching")}
        description={t("issuesAggressiveHelp")}
      >
        <Switch
          aria-label={t("issuesAggressiveMatching")}
          checked={settings?.aggressiveMatching ?? false}
          disabled={!settings || busy}
          onCheckedChange={(checked) =>
            settings && void save({ ...settings, aggressiveMatching: checked })
          }
        />
      </SettingsItem>
      <SettingsItem
        id="issue-known-projects"
        className={styles.scopeRow}
        label={t("issuesKnownProjects")}
        description={t("issuesKnownProjectsHelp")}
      >
        {projects.length ? (
          <ul className={styles.projects}>
            {projects.map((project) => (
              <li key={`${project.prefix}:${project.site}`}>
                <strong>{project.prefix}</strong> · {project.site}
              </li>
            ))}
          </ul>
        ) : (
          <span>{t("issuesNoKnownProjects")}</span>
        )}
      </SettingsItem>
      {settings && (
        <ConfirmationControls settings={settings} busy={busy} save={save} />
      )}
      {settings && (
        <BlocklistControl settings={settings} busy={busy} save={save} />
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

interface ControlProps {
  settings: Settings;
  busy: boolean;
  save: (next: Settings) => Promise<void>;
}

function CacheTtlControl({
  settings,
  busy,
  save,
  field,
}: ControlProps & {
  field: "contentTtlSeconds" | "statusCommentTtlSeconds";
}) {
  const { t } = useI18n();
  const content = field === "contentTtlSeconds";
  const values: readonly (number | null)[] = content
    ? ISSUE_CONTENT_TTL_SECONDS
    : ISSUE_STATUS_COMMENT_TTL_SECONDS;
  const value = settings[field];
  const saved = value === undefined ? -1 : values.indexOf(value);
  const [position, setPosition] = useState(saved);
  useEffect(() => setPosition(saved), [saved]);
  const label = (seconds: number | null) => {
    if (seconds === null) return t("issuesTtlNever");
    if (seconds === 1) return t("issuesTtlSecond");
    if (seconds === 60) return t("issuesTtlMinute");
    if (seconds === 3600) return t("issuesTtlHour");
    if (seconds === 86400) return t("issuesTtlDay");
    if (seconds === 14 * 86400) return t("issuesTtlTwoWeeks");
    if (seconds % 86400 === 0)
      return t("issuesTtlDays", { count: seconds / 86400 });
    if (seconds % 3600 === 0)
      return t("issuesTtlHours", { count: seconds / 3600 });
    if (seconds % 60 === 0)
      return t("issuesTtlMinutes", { count: seconds / 60 });
    return t("issuesTtlSeconds", { count: seconds });
  };
  const commit = (input: HTMLInputElement) => {
    const value = values[Number(input.value)];
    if (!busy && value !== undefined && value !== settings[field])
      void save({ ...settings, [field]: value });
  };
  const id = `issue-${field}`;
  const title = t(content ? "issuesContentTtl" : "issuesStatusCommentTtl");
  return (
    <SettingsItem
      id={id}
      label={title}
      className={styles.scopeRow}
      description={t(
        content ? "issuesContentTtlHelp" : "issuesStatusCommentTtlHelp",
      )}
    >
      <div className={styles.cacheLifetime}>
        <output htmlFor={`${id}-slider`}>
          {label(values[position] ?? null)}
        </output>
        <input
          className={styles.slider}
          id={`${id}-slider`}
          type="range"
          min={0}
          max={values.length - 1}
          step={1}
          list={`${id}-ticks`}
          aria-label={title}
          aria-valuetext={label(values[position] ?? null)}
          value={position}
          disabled={busy}
          onChange={(event) => setPosition(Number(event.target.value))}
          onPointerUp={(event) => commit(event.currentTarget)}
          onKeyUp={(event) => commit(event.currentTarget)}
          onBlur={(event) => commit(event.currentTarget)}
        />
        <datalist id={`${id}-ticks`}>
          {values.map((value, index) => (
            <option key={String(value)} value={index} label={label(value)} />
          ))}
        </datalist>
        <div className={styles.cacheEndpoints}>
          <span>{t("issuesTtlSecond")}</span>
          <span>{t("issuesTtlNever")}</span>
        </div>
      </div>
    </SettingsItem>
  );
}

const NO_CONFIRMATION: NonNullable<Settings["confirmation"]> = {
  enabled: false,
  jiraSite: "",
  jiraEmail: "",
};

/**
 * Opt-in tracker confirmation, with the credential inventory beside it.
 *
 * The point of showing every source by name is that most installations
 * already have one: the pane says where a credential would come from and
 * whether it is there, without ever displaying it.
 */
function ConfirmationControls({ settings, busy, save }: ControlProps) {
  const { t } = useI18n();
  const { transport } = useCurrentSourceRuntime();
  const [credentials, setCredentials] = useState<IssueCredentialStatus[]>();
  const [saving, setSaving] = useState("");
  const confirmation = settings.confirmation ?? NO_CONFIRMATION;
  const { version } = useVersion();
  const supported = serverHasCapability(
    version,
    SERVER_CAPABILITIES.githubStatusControls.name,
  );
  const statusEnabled = settings.githubStatusEnabled ?? confirmation.enabled;
  const cli = settings.githubCli ?? { enabled: true, account: "" };
  const github = credentials?.find((x) => x.provider === "github");
  const [actionError, setActionError] = useState("");
  const update = (next: Partial<typeof confirmation>) =>
    void save({
      ...settings,
      ...(supported ? { githubStatusEnabled: statusEnabled } : {}),
      confirmation: { ...confirmation, ...next },
    });
  // The inventory probes environment variables and the gh CLI; ask only once
  // the reader has opted in, the only state in which it is shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: CLI policy changes invalidate the server's credential inventory even when lookup enablement stays unchanged.
  useEffect(() => {
    let disposed = false;
    setCredentials(undefined);
    if (!confirmation.enabled && !(supported && statusEnabled)) return;
    transport
      .fetch<IssueCredentialsResult>("/issues/credentials")
      .then((result) => {
        if (!disposed) setCredentials(result.credentials);
      })
      .catch(() => {
        if (!disposed) setCredentials([]);
      });
    return () => {
      disposed = true;
    };
  }, [
    transport,
    confirmation.enabled,
    supported,
    statusEnabled,
    cli.enabled,
    cli.account,
  ]);
  const storeKey = async (provider: string, key: string) => {
    setSaving(provider);
    setActionError("");
    try {
      const result = await transport.fetch<IssueCredentialsResult>(
        "/issues/credentials",
        { method: "PUT", body: JSON.stringify({ provider, key }) },
      );
      setCredentials(result.credentials);
    } catch {
      setActionError(t("issuesSaveError"));
    } finally {
      setSaving("");
    }
  };
  return (
    <>
      {supported && (
        <>
          <SettingsItem
            as="label"
            id="issue-github-status"
            label={t("issuesGithubStatusEnable")}
            description={t("issuesGithubStatusHelp")}
          >
            <Switch
              aria-label={t("issuesGithubStatusEnable")}
              checked={statusEnabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                void save({
                  ...settings,
                  githubStatusEnabled: checked,
                })
              }
            />
          </SettingsItem>
          <SettingsItem
            as="label"
            id="issue-github-cli"
            label={t("issuesGithubCliEnable")}
            description={t("issuesGithubCliHelp")}
          >
            <Switch
              aria-label={t("issuesGithubCliEnable")}
              checked={cli.enabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                void save({
                  ...settings,
                  githubCli: { ...cli, enabled: checked },
                })
              }
            />
          </SettingsItem>
          <SettingsItem
            id="issue-github-account"
            className={styles.scopeRow}
            label={t("issuesGithubAccount")}
            description={t("issuesGithubAccountHelp")}
          >
            <Select
              className={styles.control}
              aria-label={t("issuesGithubAccount")}
              value={cli.account}
              disabled={busy || !cli.enabled}
              onChange={(e) =>
                void save({
                  ...settings,
                  githubCli: { ...cli, account: e.target.value },
                })
              }
            >
              <option value="">{t("issuesGithubActiveAccount")}</option>
              {[
                ...new Set([
                  ...(github?.accounts ?? []),
                  ...(cli.account ? [cli.account] : []),
                ]),
              ].map((account) => (
                <option key={account} value={account}>
                  {account}
                </option>
              ))}
            </Select>
          </SettingsItem>
          <SettingsItem
            id="issue-github-cache"
            className={styles.scopeRow}
            label={t("issuesGithubCache")}
            description={t("issuesGithubCacheHelp")}
          >
            <Button
              disabled={busy || !!saving}
              onClick={() => {
                setSaving("cache");
                setActionError("");
                void transport
                  .fetch("/issues/status", { method: "DELETE" })
                  .catch(() => setActionError(t("issuesSaveError")))
                  .finally(() => setSaving(""));
              }}
            >
              {t("issuesGithubCacheClear")}
            </Button>
          </SettingsItem>
        </>
      )}
      <SettingsItem
        as="label"
        id="issue-confirm-enabled"
        label={t("issuesConfirmEnable")}
        description={t("issuesConfirmHelp")}
      >
        <Switch
          aria-label={t("issuesConfirmEnable")}
          checked={confirmation.enabled}
          disabled={busy}
          onCheckedChange={(checked) => update({ enabled: checked })}
        />
      </SettingsItem>
      {confirmation.enabled && (
        <>
          <SettingsItem
            id="issue-confirm-jira-site"
            label={t("issuesJiraSite")}
          >
            <TextInput
              className={styles.control}
              type="url"
              aria-label={t("issuesJiraSite")}
              placeholder="https://example.atlassian.net"
              defaultValue={confirmation.jiraSite}
              disabled={busy}
              onBlur={(e) => update({ jiraSite: e.target.value.trim() })}
            />
          </SettingsItem>
          <SettingsItem
            id="issue-confirm-jira-email"
            label={t("issuesJiraEmail")}
          >
            <TextInput
              className={styles.control}
              type="email"
              aria-label={t("issuesJiraEmail")}
              defaultValue={confirmation.jiraEmail}
              disabled={busy}
              onBlur={(e) => update({ jiraEmail: e.target.value.trim() })}
            />
          </SettingsItem>
        </>
      )}
      {credentials
        ?.filter((credential) =>
          credential.provider === "github"
            ? confirmation.enabled || (supported && statusEnabled)
            : confirmation.enabled,
        )
        .map((credential) => (
          <CredentialControl
            key={credential.provider}
            credential={credential}
            busy={saving === credential.provider}
            store={storeKey}
          />
        ))}
      {actionError && <p role="alert">{actionError}</p>}
    </>
  );
}

function CredentialControl({
  credential,
  busy,
  store,
}: {
  credential: IssueCredentialStatus;
  busy: boolean;
  store: (provider: string, key: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [key, setKey] = useState("");
  const label =
    credential.provider === "github"
      ? t("issuesCredentialGithub")
      : t("issuesCredentialJira");
  const stored = credential.sources.find((source) => source.kind === "stored");
  return (
    <fieldset className={styles.credential}>
      <legend>{label}</legend>
      <p>
        {credential.active
          ? t("issuesCredentialActive", { source: credential.active })
          : t("issuesCredentialMissing")}
      </p>
      {credential.active?.startsWith("gh auth token") && credential.account && (
        <p>{t("issuesGithubUsingAccount", { account: credential.account })}</p>
      )}
      <ul>
        {credential.sources.map((source) => (
          <li key={source.name}>
            {source.name}
            {": "}
            {source.present
              ? t("issuesCredentialPresent")
              : t("issuesCredentialAbsent")}
          </li>
        ))}
      </ul>
      <Field label={t("issuesCredentialOverride")} className={styles.stacked}>
        <TextInput
          type="password"
          aria-label={`${label}: ${t("issuesCredentialOverride")}`}
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          value={key}
          disabled={busy}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
      <Button
        variant="primary"
        disabled={busy || !key.trim()}
        onClick={() => {
          void store(credential.provider, key.trim()).then(() => setKey(""));
        }}
      >
        {t("issuesCredentialSave")}
      </Button>
      {stored?.present && (
        <Button
          variant="danger-outline"
          disabled={busy}
          onClick={() => void store(credential.provider, "")}
        >
          {t("issuesCredentialClear")}
        </Button>
      )}
    </fieldset>
  );
}

/** The project names that never become a ticket when seen without a URL. */
function BlocklistControl({ settings, busy, save }: ControlProps) {
  const { t } = useI18n();
  const current = settings.jiraKeyBlocklist ?? [...DEFAULT_JIRA_KEY_BLOCKLIST];
  return (
    <SettingsItem id="issue-jira-blocklist" label={t("issuesBlocklist")}>
      <TextInput
        mono
        className={styles.control}
        aria-label={t("issuesBlocklist")}
        defaultValue={current.join(" ")}
        disabled={busy}
        onBlur={(e) => {
          const names = e.target.value
            .toUpperCase()
            .split(/[\s,]+/)
            .filter(Boolean);
          if (names.every((name) => /^[A-Z][A-Z0-9_]{0,31}$/.test(name)))
            void save({ ...settings, jiraKeyBlocklist: names });
          else e.target.value = current.join(" ");
        }}
      />
    </SettingsItem>
  );
}
