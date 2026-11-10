import rowsStyles from "./SettingsRows.module.css";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  LimitedUserSummary,
  PathGrant,
  ProjectAccessLevel,
  UsageReport,
  TemplateCreationGrant,
} from "@yep-anywhere/shared";
import {
  JOIN_STALE_OFFSET_MAX_MINUTES,
  JOIN_STALE_OFFSET_MIN_MINUTES,
  SERVER_CAPABILITIES,
  serverHasCapability,
  templateGrantFor,
  instructionBlocksError,
} from "@yep-anywhere/shared";
import { api } from "../../api/client";
import { Banner } from "../../components/ui/Banner";
import { Button, IconButton } from "../../components/ui/Button";
import { confirmDialog } from "../../components/ui/ConfirmDialog";
import { Field, Select, TextInput } from "../../components/ui/Field";
import { Switch } from "../../components/ui/Switch";
import { useActingPrincipal } from "../../hooks/useActingPrincipal";
import { useProjects } from "../../hooks/useProjects";
import { useProviders } from "../../hooks/useProviders";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { toBrowserAppHref } from "../../lib/appHref";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { UserUsageTable } from "./UserUsageTable";
import styles from "./UsersSettings.module.css";
import { UserTemplateGrant } from "./UserTemplateGrant";
import { useVersion } from "../../hooks/useVersion";
import {
  instructionBlockDrafts,
  type InstructionBlockDraft,
} from "./InstructionBlocks";
import {
  SharedLimitedUserInstructions,
  PerUserInstructions,
} from "./LimitedUserInstructions";
import { LimitedUserBrowserDefaults } from "./LimitedUserBrowserDefaults";

/**
 * Settings → Users: the superuser's user-management surface.
 *
 * Contract: topics/limited-users.md § Delivery v1 — Settings → Users. This is
 * the only place limited users are created, edited, and removed; creating the
 * first one turns the feature on. Everything here is presentation — the server
 * enforces the same grants at the operation, so a hidden control is never the
 * protection.
 */

const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

interface DraftState {
  username: string;
  password: string;
  enabled: boolean;
  access: Record<string, ProjectAccessLevel>;
  joinStaleOffsetMinutes: number;
  provider: string;
  model: string;
  effort: string;
  projectRoot: string;
  allowNoProjectSessions: boolean;
  allowPublicApps: boolean;
  allowPrivateAppLinks: boolean;
  templateCreation?: TemplateCreationGrant;
  instructionBlocks: InstructionBlockDraft[];
  pathGrants: PathGrant[];
}

/** Which optional user fields this server stores; others are never sent. */
interface EditorSupport {
  templates: boolean;
  instructions: boolean;
  pathGrants: boolean;
  noProject: boolean;
  appLinks: boolean;
}

function draftFromUser(user: LimitedUserSummary): DraftState {
  const access: Record<string, ProjectAccessLevel> = {};
  for (const id of user.viewProjects) access[id] = "view";
  for (const id of user.joinProjects) access[id] = "join";
  for (const id of user.newSessionProjects) access[id] = "new-session";
  return {
    username: user.username,
    password: "",
    enabled: !user.disabled,
    access,
    joinStaleOffsetMinutes: user.joinStaleOffsetMinutes,
    provider: user.lock.provider ?? "",
    model: user.lock.model ?? "",
    effort: user.lock.effort ?? "",
    projectRoot: user.projectRoot ?? "",
    allowNoProjectSessions: user.allowNoProjectSessions === true,
    allowPublicApps: user.allowPublicApps === true,
    allowPrivateAppLinks: user.allowPrivateAppLinks !== false,
    templateCreation: templateGrantFor(user),
    instructionBlocks: instructionBlockDrafts(user.instructionBlocks ?? []),
    pathGrants: structuredClone(user.pathGrants ?? []),
  };
}

function grantsFromDraft(draft: DraftState, support: EditorSupport) {
  const newSessionProjects: string[] = [];
  const joinProjects: string[] = [];
  const viewProjects: string[] = [];
  for (const [projectId, level] of Object.entries(draft.access)) {
    if (level === "new-session") newSessionProjects.push(projectId);
    else if (level === "join") joinProjects.push(projectId);
    else if (level === "view") viewProjects.push(projectId);
  }
  return {
    newSessionProjects,
    joinProjects,
    viewProjects,
    joinStaleOffsetMinutes: draft.joinStaleOffsetMinutes,
    lock: {
      ...(draft.provider ? { provider: draft.provider } : {}),
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.effort ? { effort: draft.effort } : {}),
    },
    // Always sent, so clearing the field revokes the grant.
    projectRoot: draft.projectRoot.trim(),
    ...(support.noProject
      ? { allowNoProjectSessions: draft.allowNoProjectSessions }
      : {}),
    ...(support.appLinks
      ? {
          allowPublicApps: draft.allowPublicApps,
          allowPrivateAppLinks: draft.allowPrivateAppLinks,
        }
      : {}),
    disabled: !draft.enabled,
    ...(support.templates ? { templateCreation: templateGrantFor(draft) } : {}),
    ...(support.instructions
      ? {
          instructionBlocks: draft.instructionBlocks.map((block) => block.text),
        }
      : {}),
    ...(support.pathGrants
      ? {
          // A row still being filled in is not a grant yet.
          pathGrants: draft.pathGrants
            .map((grant) => ({ ...grant, path: grant.path.trim() }))
            .filter((grant) => grant.path),
        }
      : {}),
  };
}

/** The lock as one readable phrase, or null when nothing is locked. */
function lockSummary(user: LimitedUserSummary): string | null {
  const parts = [user.lock.provider, user.lock.model, user.lock.effort].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** A username being edited, a new user being named, or nothing open. */
type Selection = { kind: "create" } | { kind: "edit"; username: string };

export function UsersSettings() {
  const { t } = useI18n();
  const { version } = useVersion();
  const supportsTemplates = serverHasCapability(
    version,
    SERVER_CAPABILITIES.limitedUserProjectTemplates.name,
  );
  useSettingsPaneTitle(t("settingsUsersTitle"));
  const supportsInstructions = serverHasCapability(
    version,
    SERVER_CAPABILITIES.limitedUserInstructions.name,
  );
  const supportsBrowserDefaults = serverHasCapability(
    version,
    SERVER_CAPABILITIES.limitedUserBrowserDefaults.name,
  );
  const supportsPathGrants = serverHasCapability(
    version,
    SERVER_CAPABILITIES.limitedUserPathGrants.name,
  );
  const support = useMemo<EditorSupport>(
    () => ({
      templates: supportsTemplates,
      instructions: supportsInstructions,
      pathGrants: supportsPathGrants,
      noProject: serverHasCapability(
        version,
        SERVER_CAPABILITIES.limitedUserNoProjectSessions.name,
      ),
      appLinks: serverHasCapability(
        version,
        SERVER_CAPABILITIES.projectAppAddressLinks.name,
      ),
    }),
    [supportsTemplates, supportsInstructions, supportsPathGrants, version],
  );
  const {
    settings,
    updateSetting,
    updateSettings,
    isLoading: settingsLoading,
  } = useServerSettings();
  const {
    principal,
    resolved: principalResolved,
    refresh: refreshPrincipal,
  } = useActingPrincipal();

  const [users, setUsers] = useState<LimitedUserSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<UsageReport | null>(null);

  // Acting as a limited user, every /api/users call but /me and /logout is
  // refused, which is the point: they manage nobody.
  const canManage = principal.superuser && !principal.switched;

  const loadUsers = useCallback(async () => {
    // Until the server says who this client is, the hook reports the
    // superuser placeholder. Asking now would send one refused request on
    // every load for a switched superuser or a limited user.
    if (!principalResolved) return;
    if (!canManage) {
      setLoaded(true);
      return;
    }
    try {
      const response = await api.listUsers();
      setUsers(response.users);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [canManage, principalResolved]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  // Usage is its own read: a server without the ledger 404s here while the
  // directory above still works, and the table simply does not appear.
  const loadUsage = useCallback(async () => {
    if (!principalResolved || !canManage) return;
    try {
      setUsage(await api.getUserUsage());
    } catch {
      setUsage(null);
    }
  }, [canManage, principalResolved]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const enabled = settings?.limitedUsersEnabled === true;

  const create = async (username: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      // The server supplies every grant's default; they are set, and saved,
      // in the editor that opens next.
      const { user } = await api.createUser({ username, password });
      await loadUsers();
      // Creating the first user turns the feature on server-side; re-read so
      // this pane and the acting principal agree without a reload.
      await refreshPrincipal();
      setSelection({ kind: "edit", username: user.username });
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (username: string) => {
    if (
      !(await confirmDialog({
        title: t("usersDeleteConfirmTitle"),
        message: t("usersDeleteConfirm", { username }),
        confirmLabel: t("usersDelete"),
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteUser(username);
      setSelection(null);
      await loadUsers();
    } catch (deleteError) {
      setError((deleteError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const switchTo = async (username: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.switchUser(username);
      // Acting as a different principal changes every list in the app.
      window.location.reload();
    } catch (switchError) {
      setError((switchError as Error).message);
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      const result = await api.logoutUser();
      if (result.redirect === "relay-login")
        window.location.href = toBrowserAppHref("/login/relay");
      else if (result.redirect === "direct-login")
        window.location.href = toBrowserAppHref("/login");
      else window.location.reload();
    } catch (logoutError) {
      setError((logoutError as Error).message);
      setBusy(false);
    }
  };

  // Rendering the directory before the identity lands would flash the
  // superuser's pane at a limited user on every load.
  if (!principalResolved) {
    return <SettingsSection description={t("loading")} />;
  }

  if (!canManage) {
    return <LimitedUserView onLogout={() => void logout()} busy={busy} />;
  }

  const editing =
    selection?.kind === "edit"
      ? users.find((user) => user.username === selection.username)
      : undefined;

  return (
    <SettingsSection
      title={t("settingsUsersTitle")}
      description={
        supportsInstructions ? undefined : t("settingsUsersDescription")
      }
      keywords={["limited users", "accounts", "guest", "sandbox", "grants"]}
      doc={{
        path: "site/src/content/docs/local-access.md#limited-users-preview",
        label: "limited users",
      }}
    >
      {/* First, because it is the decision the rest of the pane depends on.
          Turning it off keeps the records and refuses their logins. */}
      {selection === null && (
        <details
          className={styles.account}
          open={!supportsInstructions || !enabled}
        >
          <summary>{t("usersAccessSettings")}</summary>
          <SettingsItem
            label={t("advancedLimitedUsersTitle")}
            description={t("advancedLimitedUsersDescription")}
            keywords={["limited users", "accounts", "enable", "disable"]}
          >
            <Switch
              aria-label={t("advancedLimitedUsersTitle")}
              checked={enabled}
              disabled={settingsLoading || busy}
              onCheckedChange={(checked) =>
                void updateSetting("limitedUsersEnabled", checked)
              }
            />
          </SettingsItem>
          <p className={rowsStyles.hint}>{t("usersTrustWarning")}</p>
        </details>
      )}

      <div className={rowsStyles.group} data-settings-group>
        {loaded && users.length === 0 && (
          <p className={rowsStyles.hint}>{t("usersEmpty")}</p>
        )}
        <div
          className={styles.userBar}
          role="group"
          aria-label={t("usersListLabel")}
        >
          {users.map((user) => {
            const selected =
              selection?.kind === "edit" &&
              selection.username === user.username;
            return (
              <Button
                key={user.username}
                variant="outline"
                className={user.disabled ? styles.userChipDisabled : undefined}
                aria-pressed={selected}
                title={user.disabled ? t("usersDisabledTitle") : undefined}
                onClick={() =>
                  setSelection(
                    selected ? null : { kind: "edit", username: user.username },
                  )
                }
              >
                {user.username}
              </Button>
            );
          })}
          <Button
            variant="outline"
            aria-pressed={selection?.kind === "create"}
            disabled={busy}
            onClick={() =>
              setSelection(
                selection?.kind === "create" ? null : { kind: "create" },
              )
            }
          >
            + {t("usersAddUser")}
          </Button>
        </div>
      </div>

      {selection?.kind === "create" && (
        <CreateUserForm
          busy={busy}
          error={error}
          onCreate={(username, password) => void create(username, password)}
          onCancel={() => {
            setSelection(null);
            setError(null);
          }}
        />
      )}

      {editing && (
        <UserEditor
          key={editing.username}
          user={editing}
          users={users}
          support={support}
          sharedInstructions={settings?.limitedUserInstructions}
          busy={busy}
          onSaved={(saved) =>
            setUsers((current) =>
              current.map((user) =>
                user.username === saved.username ? saved : user,
              ),
            )
          }
          onActAs={() => void switchTo(editing.username)}
          onDelete={() => void remove(editing.username)}
        />
      )}

      {supportsInstructions &&
        selection === null &&
        !settingsLoading &&
        settings && (
          <div className={rowsStyles.group} data-settings-group>
            <SharedLimitedUserInstructions
              value={settings.limitedUserInstructions}
              onSave={(limitedUserInstructions) =>
                updateSettings({ limitedUserInstructions })
              }
            />
          </div>
        )}

      {supportsBrowserDefaults && selection === null && (
        <div className={rowsStyles.group} data-settings-group>
          <LimitedUserBrowserDefaults />
        </div>
      )}

      {error && selection?.kind !== "create" && (
        <Banner tone="error">{error}</Banner>
      )}

      {usage && <UserUsageTable report={usage} />}
    </SettingsSection>
  );
}

/** What a limited user (or a switched superuser) sees here: their own row. */
function LimitedUserView({
  onLogout,
  busy,
}: {
  onLogout: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const { principal } = useActingPrincipal();
  const grants = principal.grants;
  const lock = grants
    ? [grants.lock.provider, grants.lock.model, grants.lock.effort]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <SettingsSection
      title={t("settingsUsersTitle")}
      description={t("usersOwnAccountDescription")}
    >
      <div className={rowsStyles.group} data-settings-group>
        <dl className={styles.grants}>
          <dt>{t("usersSignedInAs")}</dt>
          <dd>{principal.username}</dd>
          {grants && (
            <>
              <dt>{t("usersGrantNewSession")}</dt>
              <dd>{grants.newSessionProjects.length}</dd>
              <dt>{t("usersGrantJoin")}</dt>
              <dd>{grants.joinProjects.length}</dd>
              <dt>{t("usersGrantView")}</dt>
              <dd>{grants.viewProjects.length}</dd>
            </>
          )}
          {lock && (
            <>
              <dt>{t("usersGrantLock")}</dt>
              <dd>{lock}</dd>
            </>
          )}
        </dl>
        <Button disabled={busy} onClick={onLogout}>
          {principal.switched ? t("usersReturnToSuperuser") : t("usersLogout")}
        </Button>
      </div>
    </SettingsSection>
  );
}

/**
 * The project-root grant, with a hint saying what the current value grants.
 * An empty field is no grant, and the server discards a relative path as no
 * grant too, so both states are spelled out rather than left to a greyed
 * placeholder that reads like a default.
 */
function ProjectRootField({
  projectRoot,
  username,
  onChange,
}: {
  projectRoot: string;
  username: string;
  /** `commit` is true for a whole-value choice, false while typing. */
  onChange: (projectRoot: string, commit: boolean) => void;
}) {
  const { t } = useI18n();
  const root = projectRoot.trim().replace(/\/+$/, "");
  const suggestion = root === "" && username ? `~/${username}` : "";
  const hint =
    root === ""
      ? t("usersProjectRootEmptyHint")
      : !root.startsWith("/") && !root.startsWith("~")
        ? t("usersProjectRootRelativeHint")
        : t("usersProjectRootSetHint", { example: `${root}/my-project` });

  return (
    <Field label={t("usersProjectRootLabel")} hint={hint}>
      <span className={styles.inputRow}>
        <TextInput
          className={styles.grow}
          value={projectRoot}
          placeholder={t("usersProjectRootPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value, false)}
        />
        {suggestion && (
          <Button onClick={() => onChange(suggestion, true)}>
            {t("usersProjectRootUseSuggestion", { path: suggestion })}
          </Button>
        )}
      </span>
    </Field>
  );
}

/**
 * Per-project access selects. A server can hold many projects, and most
 * users are granted a few, so only granted rows show until the superuser
 * expands the rest. A row stays shown for the rest of this edit once it was
 * granted or touched, so revoking one does not make it vanish mid-edit.
 */
function ProjectAccessList({
  projects,
  access,
  onChange,
}: {
  projects: readonly { id: string; name: string; path: string }[];
  access: Record<string, ProjectAccessLevel>;
  onChange: (access: Record<string, ProjectAccessLevel>) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        Object.entries(access)
          .filter(([, level]) => level !== "none")
          .map(([id]) => id),
      ),
  );

  if (projects.length === 0) {
    return <p className={rowsStyles.hint}>{t("usersNoProjects")}</p>;
  }

  const shown = expanded
    ? projects
    : projects.filter((project) => pinned.has(project.id));
  const hiddenCount = projects.length - shown.length;

  return (
    <>
      {shown.length === 0 ? (
        <p className={rowsStyles.hint}>{t("usersNoProjectAccess")}</p>
      ) : (
        <ul className={styles.projectList}>
          {shown.map((project) => (
            <li key={project.id} className={styles.projectRow}>
              <span className={styles.projectName} title={project.path}>
                {project.name}
              </span>
              <Select
                value={access[project.id] ?? "none"}
                aria-label={project.name}
                onChange={(event) => {
                  setPinned((prev) => new Set(prev).add(project.id));
                  onChange({
                    ...access,
                    [project.id]: event.target.value as ProjectAccessLevel,
                  });
                }}
              >
                <option value="none">{t("usersAccessNone")}</option>
                <option value="view">{t("usersAccessView")}</option>
                <option value="join">{t("usersAccessJoin")}</option>
                <option value="new-session">
                  {t("usersAccessNewSession")}
                </option>
              </Select>
            </li>
          ))}
        </ul>
      )}
      {(expanded || hiddenCount > 0) && (
        <Button
          className={styles.projectExpand}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t("usersProjectsHideNoAccess")
            : t("usersProjectsShowNoAccess", { count: hiddenCount })}
        </Button>
      )}
    </>
  );
}

/**
 * Directory grants: one access level for every project at or beneath a path,
 * including projects created there later. A user's project directory is the
 * common choice, so it can be picked by username rather than typed.
 */
function DirectoryAccessList({
  grants,
  users,
  onChange,
}: {
  grants: PathGrant[];
  users: readonly LimitedUserSummary[];
  /** `commit` is true for a whole-value choice, false while typing. */
  onChange: (grants: PathGrant[], commit: boolean) => void;
}) {
  const { t } = useI18n();
  const roots = users.filter((user) => user.projectRoot);
  const update = (index: number, grant: PathGrant, commit: boolean) =>
    onChange(
      grants.map((existing, i) => (i === index ? grant : existing)),
      commit,
    );
  return (
    <>
      <p className={rowsStyles.hint}>{t("usersDirectoriesHint")}</p>
      {grants.length > 0 && (
        <ul className={styles.projectList}>
          {grants.map((grant, index) => (
            // Rows have no identity beyond their position while edited.
            <li key={index} className={styles.directoryRow}>
              <TextInput
                className={styles.directoryPath}
                value={grant.path}
                placeholder={t("usersDirectoryPlaceholder")}
                aria-label={t("usersDirectoryPath")}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  update(index, { ...grant, path: event.target.value }, false)
                }
              />
              <Select
                value={grant.level}
                aria-label={t("usersDirectoryLevel", { path: grant.path })}
                onChange={(event) =>
                  update(
                    index,
                    {
                      ...grant,
                      level: event.target.value as PathGrant["level"],
                    },
                    true,
                  )
                }
              >
                <option value="view">{t("usersAccessView")}</option>
                <option value="join">{t("usersAccessJoin")}</option>
                <option value="new-session">
                  {t("usersAccessNewSession")}
                </option>
              </Select>
              <IconButton
                label={t("usersDirectoryRemove", { path: grant.path })}
                onClick={() =>
                  onChange(
                    grants.filter((_, i) => i !== index),
                    true,
                  )
                }
              >
                ×
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <span className={styles.inputRow}>
        <Button
          onClick={() =>
            onChange([...grants, { path: "", level: "view" }], false)
          }
        >
          {t("usersDirectoryAdd")}
        </Button>
        {roots.length > 0 && (
          <Select
            value=""
            aria-label={t("usersDirectoryFromUser")}
            onChange={(event) => {
              if (!event.target.value) return;
              onChange(
                [...grants, { path: event.target.value, level: "view" }],
                true,
              );
            }}
          >
            <option value="">{t("usersDirectoryFromUser")}</option>
            {roots.map((user) => (
              <option key={user.username} value={user.projectRoot}>
                {user.username} — {user.projectRoot}
              </option>
            ))}
          </Select>
        )}
      </span>
    </>
  );
}

/** Naming a new account; its grants are edited, and saved, once it exists. */
function CreateUserForm({
  busy,
  error,
  onCreate,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onCreate: (username: string, password: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form
      className={`${rowsStyles.group} ${styles.editor}`}
      data-settings-group
      onSubmit={(event) => {
        event.preventDefault();
        onCreate(username.trim(), password);
      }}
    >
      <h3 className={styles.editorTitle}>{t("usersAddUser")}</h3>
      <Field label={t("usersUsernameLabel")}>
        <TextInput
          value={username}
          placeholder={t("usersUsernamePlaceholder")}
          autoComplete="off"
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>
      <Field label={t("usersPasswordLabel")}>
        <TextInput
          type="password"
          value={password}
          placeholder={t("usersPasswordPlaceholder")}
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      {error && <Banner tone="error">{error}</Banner>}
      <div className={styles.editorActions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {t("usersCreateUser")}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          {t("usersCancel")}
        </Button>
      </div>
    </form>
  );
}

interface UserEditorProps {
  user: LimitedUserSummary;
  /** Every user, whose project directories a directory grant may name. */
  users: readonly LimitedUserSummary[];
  support: EditorSupport;
  sharedInstructions:
    | import("@yep-anywhere/shared").LimitedUserInstructions
    | undefined;
  busy: boolean;
  onSaved: (user: LimitedUserSummary) => void;
  onActAs: () => void;
  onDelete: () => void;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * One user's settings, saved as they are made: a choice (select, checkbox,
 * add/remove/move) saves at once, typed text when its field loses focus, and
 * anything pending when the editor closes. There is no Save button to miss
 * beneath the long sections above it.
 */
function UserEditor({
  user,
  users,
  support,
  sharedInstructions,
  busy,
  onSaved,
  onActAs,
  onDelete,
}: UserEditorProps) {
  const { templates: supportsTemplates, instructions: supportsInstructions } =
    support;
  const { t } = useI18n();
  const { projects } = useProjects();
  const { providers } = useProviders();
  const [draft, setDraft] = useState(() => draftFromUser(user));
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // What the server holds, so an unchanged blur sends nothing.
  const savedKey = useRef<string | null>(
    JSON.stringify(grantsFromDraft(draftFromUser(user), support)),
  );
  const queue = useRef<Promise<void>>(Promise.resolve());
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const persist = useCallback(
    (next: DraftState) => {
      const grants = grantsFromDraft(next, support);
      const key = JSON.stringify(grants);
      const password = next.password;
      if (key === savedKey.current && !password) return;
      if (supportsInstructions) {
        const invalid = instructionBlocksError(grants.instructionBlocks);
        if (invalid) {
          setSaveError(invalid);
          setStatus("error");
          return;
        }
      }
      // Claimed now, so a blur racing this save does not send it twice.
      savedKey.current = key;
      queue.current = queue.current.then(async () => {
        setStatus("saving");
        try {
          const { user: saved } = await api.updateUser(user.username, {
            ...grants,
            ...(password ? { password } : {}),
          });
          if (password)
            setDraft((current) =>
              current.password === password
                ? { ...current, password: "" }
                : current,
            );
          setSaveError(null);
          setStatus("saved");
          onSavedRef.current(saved);
        } catch (error) {
          // Forget the claim so the next blur or choice retries it.
          if (savedKey.current === key) savedKey.current = null;
          setSaveError((error as Error).message);
          setStatus("error");
        }
      });
    },
    [support, supportsInstructions, user.username],
  );
  const persistRef = useRef(persist);
  persistRef.current = persist;
  // Closing the editor (another user, the bar, leaving Settings) keeps edits.
  useEffect(() => () => persistRef.current(draftRef.current), []);

  const change = (next: DraftState, commit: boolean) => {
    setDraft(next);
    if (commit) persist(next);
  };

  const models = useMemo(() => {
    const provider = providers.find((entry) => entry.name === draft.provider);
    return provider?.models ?? [];
  }, [providers, draft.provider]);
  const lock = lockSummary(user);
  const noProjectHintId = useId();

  return (
    <div
      className={`${rowsStyles.group} ${styles.editor}`}
      data-settings-group
      onBlur={() => persist(draftRef.current)}
      role="group"
      aria-label={t("usersEditUserTitle", { username: user.username })}
    >
      <div className={styles.editorHeader}>
        <div className={styles.editorHeading}>
          <h3 className={styles.editorTitle}>
            {t("usersEditUserTitle", { username: user.username })}
          </h3>
          <span className={styles.userMeta}>
            {t("usersGrantSummary", {
              newSession: user.newSessionProjects.length,
              join: user.joinProjects.length,
              view: user.viewProjects.length,
            })}
            {lock ? ` · ${lock}` : ""}
            {status === "saving" && ` · ${t("usersAutosaveSaving")}`}
            {status === "saved" && ` · ${t("usersAutosaveSaved")}`}
          </span>
        </div>
        <div className={styles.userActions}>
          <Switch
            label={t("usersEnabledLabel")}
            checked={draft.enabled}
            onCheckedChange={(enabled) => change({ ...draft, enabled }, true)}
          />
          <Button disabled={busy || !draft.enabled} onClick={onActAs}>
            {t("usersActAs")}
          </Button>
          <Button variant="danger-outline" disabled={busy} onClick={onDelete}>
            {t("usersDelete")}
          </Button>
        </div>
      </div>
      {saveError && <Banner tone="error">{saveError}</Banner>}

      <details className={styles.account} open={!supportsInstructions}>
        <summary>{t("usersAccountAndAccess")}</summary>
        <div className={styles.accountFields}>
          <Field label={t("usersNewPasswordLabel")}>
            <TextInput
              type="password"
              value={draft.password}
              placeholder={t("usersNewPasswordPlaceholder")}
              autoComplete="new-password"
              onChange={(event) =>
                change({ ...draft, password: event.target.value }, false)
              }
            />
          </Field>

          <p className={styles.subhead}>{t("usersProjectRootHeading")}</p>
          {support.noProject && (
            <div className={styles.switchWithHint}>
              <Switch
                label={t("usersAllowNoProject")}
                aria-describedby={noProjectHintId}
                checked={draft.allowNoProjectSessions}
                onCheckedChange={(allowNoProjectSessions) =>
                  change({ ...draft, allowNoProjectSessions }, true)
                }
              />
              <p id={noProjectHintId} className={rowsStyles.hint}>
                {t("usersAllowNoProjectHint")}
              </p>
            </div>
          )}
          {support.appLinks && (
            <>
              <Switch
                label={t("usersAllowPublicApps")}
                checked={draft.allowPublicApps}
                onCheckedChange={(allowPublicApps) =>
                  change({ ...draft, allowPublicApps }, true)
                }
              />
              <Switch
                label={t("usersAllowPrivateAppLinks")}
                checked={draft.allowPrivateAppLinks}
                onCheckedChange={(allowPrivateAppLinks) =>
                  change({ ...draft, allowPrivateAppLinks }, true)
                }
              />
            </>
          )}
          <ProjectRootField
            projectRoot={draft.projectRoot}
            username={user.username}
            onChange={(projectRoot, commit) =>
              change({ ...draft, projectRoot }, commit)
            }
          />
          {supportsTemplates && (
            <UserTemplateGrant
              value={templateGrantFor(draft)}
              onChange={(templateCreation) =>
                change({ ...draft, templateCreation }, true)
              }
            />
          )}

          <p className={styles.subhead}>{t("usersLockHeading")}</p>
          <p className={rowsStyles.hint}>{t("usersLockHint")}</p>
          <div className={styles.lockRow}>
            <Field label={t("usersLockProvider")}>
              <Select
                value={draft.provider}
                onChange={(event) =>
                  change(
                    { ...draft, provider: event.target.value, model: "" },
                    true,
                  )
                }
              >
                <option value="">{t("usersLockUnset")}</option>
                {providers.map((provider) => (
                  <option key={provider.name} value={provider.name}>
                    {provider.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("usersLockModel")}>
              <Select
                value={draft.model}
                disabled={!draft.provider}
                onChange={(event) =>
                  change({ ...draft, model: event.target.value }, true)
                }
              >
                <option value="">{t("usersLockUnset")}</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("usersLockEffort")}>
              <Select
                value={draft.effort}
                onChange={(event) =>
                  change({ ...draft, effort: event.target.value }, true)
                }
              >
                <option value="">{t("usersLockUnset")}</option>
                {EFFORT_OPTIONS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <p className={styles.subhead}>{t("usersProjectsHeading")}</p>
          <ProjectAccessList
            projects={projects}
            access={draft.access}
            onChange={(access) => change({ ...draft, access }, true)}
          />

          {support.pathGrants && (
            <>
              <p className={styles.subhead}>{t("usersDirectoriesHeading")}</p>
              <DirectoryAccessList
                grants={draft.pathGrants}
                users={users}
                onChange={(pathGrants, commit) =>
                  change({ ...draft, pathGrants }, commit)
                }
              />
            </>
          )}

          <Field
            label={t("usersJoinOffsetLabel")}
            hint={t("usersJoinOffsetHint")}
          >
            <TextInput
              type="number"
              min={JOIN_STALE_OFFSET_MIN_MINUTES}
              max={JOIN_STALE_OFFSET_MAX_MINUTES}
              value={draft.joinStaleOffsetMinutes}
              onChange={(event) =>
                change(
                  {
                    ...draft,
                    joinStaleOffsetMinutes: Number(event.target.value),
                  },
                  false,
                )
              }
            />
          </Field>
        </div>
      </details>
      {supportsInstructions && (
        <PerUserInstructions
          shared={sharedInstructions}
          blocks={draft.instructionBlocks}
          disabled={busy}
          onChange={(instructionBlocks) =>
            // Adding, removing or reordering a block is a choice; typing
            // inside one saves when the field loses focus.
            change(
              { ...draft, instructionBlocks },
              instructionBlocks.map((block) => block.id).join() !==
                draft.instructionBlocks.map((block) => block.id).join(),
            )
          }
        />
      )}
    </div>
  );
}
