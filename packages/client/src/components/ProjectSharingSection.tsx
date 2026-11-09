import {
  SERVER_CAPABILITIES,
  serverHasCapability,
  type ProjectAccessEntry,
  type ProjectAccessLevel,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { projectAccessApi } from "../api/projectAccess";
import { useActingPrincipal } from "../hooks/useActingPrincipal";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import styles from "./ProjectSessionDefaultsModal.module.css";
import { Banner } from "./ui/Banner";
import { Select } from "./ui/Field";

/**
 * Sharing this project with limited users, for the superuser or the limited
 * user who created it (topics/limited-users.md § Project sharing). Each
 * choice saves as it is made, apart from the settings form's own Save.
 */
export function ProjectSharingSection({
  projectId,
  ownerUsername,
}: {
  projectId: string;
  ownerUsername?: string;
}) {
  const { t } = useI18n();
  const { version } = useVersion();
  const { principal, resolved } = useActingPrincipal();
  const mayShare =
    resolved &&
    serverHasCapability(
      version,
      SERVER_CAPABILITIES.projectAccessSharing.name,
    ) &&
    ((principal.superuser && !principal.switched) ||
      (!!ownerUsername && principal.username === ownerUsername));
  const [users, setUsers] = useState<ProjectAccessEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!mayShare) return;
    let active = true;
    void projectAccessApi
      .list(projectId)
      .then((response) => active && setUsers(response.users))
      .catch((reason: Error) => active && setError(reason.message));
    return () => {
      active = false;
    };
  }, [mayShare, projectId]);

  if (!mayShare) return null;

  const choose = async (username: string, level: ProjectAccessLevel) => {
    setSaving(username);
    setError(null);
    try {
      await projectAccessApi.set(projectId, username, level);
      setUsers((current) =>
        (current ?? []).map((entry) =>
          entry.username === username ? { ...entry, level } : entry,
        ),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className={styles.section} aria-label={t("projectSharingTitle")}>
      <h3>{t("projectSharingTitle")}</h3>
      <p>{t("projectSharingDescription")}</p>
      {users === null && !error && <p>{t("loading")}</p>}
      {users?.length === 0 && <p>{t("projectSharingNoUsers")}</p>}
      {users && users.length > 0 && (
        <ul className={styles.sharingList}>
          {users.map((entry) => (
            <li key={entry.username} className={styles.sharingRow}>
              <span>{entry.username}</span>
              <Select
                value={entry.level}
                aria-label={entry.username}
                disabled={saving === entry.username}
                onChange={(event) =>
                  void choose(
                    entry.username,
                    event.target.value as ProjectAccessLevel,
                  )
                }
              >
                <option value="none">{t("usersAccessNone")}</option>
                <option value="view">{t("usersAccessView")}</option>
                <option value="join">{t("usersAccessJoin")}</option>
                <option value="new-session">
                  {t("usersAccessNewSession")}
                </option>
              </Select>
              {entry.directoryLevel !== "none" && (
                <span className={styles.sharingNote}>
                  {t("projectSharingViaDirectory", {
                    level: t(
                      entry.directoryLevel === "view"
                        ? "usersAccessView"
                        : entry.directoryLevel === "join"
                          ? "usersAccessJoin"
                          : "usersAccessNewSession",
                    ),
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <Banner tone="error" compact>
          {error}
        </Banner>
      )}
    </section>
  );
}
