import {
  SERVER_CAPABILITIES,
  serverHasCapability,
  type ProjectAppInventory,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { projectAppApi } from "../../api/projectApp";
import { api } from "../../api/client";
import { ProjectAppViewer } from "../../components/ProjectAppViewer";
import { Button, ButtonBase } from "../../components/ui/Button";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import styles from "./ProjectAppInventorySection.module.css";
import { expandableRowProps, SettingsCollection } from "./SettingsCollection";
import { SettingsDocLink } from "./SettingsDocLink";
import { ElidedPath } from "../../components/ui/ElidedPath";
import { SettingsSortHeader, useSettingsTableSort } from "./SettingsTableSort";

/** Project apps and retained names beside the operator's manual port forwards. */
export function ProjectAppInventorySection() {
  const { version } = useVersion();
  const { t } = useI18n();
  const supported = serverHasCapability(
    version,
    SERVER_CAPABILITIES.projectAppInventory.name,
  );
  const canDelete = serverHasCapability(
    version,
    SERVER_CAPABILITIES.projectAppDeletion.name,
  );
  const [inventory, setInventory] = useState<ProjectAppInventory | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const tableSort = useSettingsTableSort<
    "project" | "folder" | "domain" | "status"
  >();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh and address release deliberately invalidate the inventory through revision.
  useEffect(() => {
    if (!supported) return;
    let active = true;
    setLoading(true);
    void projectAppApi
      .inventory()
      .then((next) => {
        if (active) setInventory(next);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [supported, revision]);
  const knownProjects = new Set(
    inventory?.projects.map((row) => row.projectId),
  );
  const selected = inventory?.projects.find(
    (row) => row.projectId === expanded,
  );
  const retained =
    inventory?.reservations.filter(
      (row) => !knownProjects.has(row.projectId),
    ) ?? [];
  const displayedRows = tableSort.sortedRows(
    [
      ...(inventory?.projects ?? []).map((project) => ({
        key: project.projectId,
        project,
        retained: undefined,
        name: project.name,
        path: project.path,
        status: t("projectAppState", { state: project.info.state }),
        addresses: inventory!.reservations.filter(
          (address) => address.projectId === project.projectId,
        ),
      })),
      ...retained.map((address) => ({
        key: `${address.projectId}:${address.namespace}`,
        project: undefined,
        retained: address,
        name: t("projectAppInventoryUnavailable", { owner: address.owner }),
        path: "",
        status: t("projectAppRelease"),
        addresses: [address],
      })),
    ],
    (row, column) => {
      if (column === "project") return row.name;
      if (column === "folder") return row.path;
      if (column === "status") return row.status;
      return row.addresses
        .map((address) => `${address.name}.${address.namespace}`)
        .sort()
        .join(" ");
    },
  );
  async function releaseAddress(
    row: ProjectAppInventory["reservations"][number],
  ) {
    if (
      !window.confirm(
        t("projectAppReleaseConfirm", {
          address: `${row.name}.${row.namespace}`,
        }),
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await projectAppApi.releaseAddress(row.projectId, row.namespace);
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function deleteSelected(removeProject: boolean) {
    if (!selected || busy) return;
    if (
      !window.confirm(
        t(
          removeProject
            ? "projectAppDeleteProjectConfirm"
            : "projectAppDeleteAppConfirm",
          { name: selected.name },
        ),
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await projectAppApi.deleteApp(selected.projectId);
      if (removeProject) await api.deleteProject(selected.projectId);
      setExpanded(undefined);
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      // Refresh even after partial cleanup, without claiming it succeeded.
      setRevision((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={styles.inventory}
      aria-label={t("projectAppInventoryTitle")}
    >
      <div className={styles.heading}>
        <h3>{t("projectAppInventoryTitle")}</h3>
        {supported && (
          <Button
            disabled={loading || busy}
            onClick={() => {
              setError("");
              setRevision((value) => value + 1);
            }}
          >
            {t("projectAppInventoryRefresh")}
          </Button>
        )}
      </div>
      <p>
        {t(supported ? "projectAppInventoryHint" : "projectAppInventoryUpdate")}{" "}
        <SettingsDocLink
          doc={{
            path: "site/src/content/docs/project-apps.md",
            label: "project apps and vhosts",
          }}
        />
      </p>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">{t("projectAppLoading")}</p>}
      {supported && inventory && (
        <>
          {inventory.projects.length === 0 && retained.length === 0 && (
            <p>{t("projectAppInventoryEmpty")}</p>
          )}
          <SettingsCollection
            selectedKey={selected?.projectId ?? null}
            title={selected?.name ?? ""}
            onClose={() => setExpanded(undefined)}
            actions={
              selected && canDelete ? (
                <span className={styles.deleteActions}>
                  <Button
                    disabled={busy}
                    title={t("projectAppDeleteAppTitle")}
                    onClick={() => void deleteSelected(false)}
                  >
                    {t("projectAppDeleteApp")}
                  </Button>
                  <Button
                    disabled={busy}
                    title={t("projectAppDeleteProject")}
                    onClick={() => void deleteSelected(true)}
                  >
                    {t("projectAppDeleteProject")}
                  </Button>
                </span>
              ) : undefined
            }
            detail={inventory.projects.map(
              (row) =>
                expanded === row.projectId && (
                  <article className={styles.row} key={row.projectId}>
                    {!canDelete && <p>{t("projectAppDeleteUpdate")}</p>}
                    <p>
                      {row.owner ?? t("projectAppInventoryAdministrator")} ·{" "}
                      <code>{row.path}</code>
                    </p>
                    {inventory.reservations
                      .filter((address) => address.projectId === row.projectId)
                      .map((address) => (
                        <p key={address.namespace}>
                          <strong>
                            {address.name}.{address.namespace}
                          </strong>
                          {!version?.artifactViewer?.vhostPublicRoot && (
                            <Button
                              disabled={busy}
                              onClick={() => void releaseAddress(address)}
                            >
                              {t("projectAppRelease")}
                            </Button>
                          )}
                        </p>
                      ))}
                    {expanded === row.projectId && (
                      <div className={styles.viewer}>
                        <ProjectAppViewer
                          key={`${row.projectId}:${revision}`}
                          projectId={row.projectId}
                          presentation="settings"
                          onAddressesChanged={(addresses) =>
                            setInventory((current) =>
                              current && addresses.enabled
                                ? {
                                    ...current,
                                    reservations: [
                                      ...current.reservations.filter(
                                        (address) =>
                                          address.projectId !== row.projectId,
                                      ),
                                      ...addresses.reservations.map(
                                        (address) => ({
                                          ...address,
                                          projectId: row.projectId,
                                        }),
                                      ),
                                    ],
                                  }
                                : current,
                            )
                          }
                          onInfoChanged={(info) =>
                            setInventory(
                              (current) =>
                                current && {
                                  ...current,
                                  projects: current.projects.map((project) =>
                                    project.projectId === row.projectId
                                      ? { ...project, info }
                                      : project,
                                  ),
                                },
                            )
                          }
                        />
                      </div>
                    )}
                  </article>
                ),
            )}
          >
            <table
              className={styles.table}
              aria-label={t("projectAppInventoryTitle")}
            >
              <thead>
                <tr>
                  <SettingsSortHeader
                    column="project"
                    label={t("settingsCollectionProject")}
                    {...tableSort}
                  />
                  <SettingsSortHeader
                    column="folder"
                    label={t("settingsCollectionFolder")}
                    {...tableSort}
                  />
                  <SettingsSortHeader
                    column="domain"
                    label={t("settingsCollectionDomain")}
                    {...tableSort}
                  />
                  <SettingsSortHeader
                    column="status"
                    label={t("settingsCollectionStatus")}
                    {...tableSort}
                  />
                </tr>
              </thead>
              <tbody>
                {displayedRows.map((row) => {
                  const projectId = row.project?.projectId;
                  const toggle =
                    projectId === undefined
                      ? undefined
                      : () =>
                          setExpanded(
                            expanded === projectId ? undefined : projectId,
                          );
                  return (
                    <tr
                      key={row.key}
                      {...(toggle && expandableRowProps(toggle))}
                    >
                      <td>
                        {row.project ? (
                          <ButtonBase
                            aria-expanded={expanded === row.project.projectId}
                            onClick={toggle}
                          >
                            <span aria-hidden="true">
                              {expanded === row.project.projectId
                                ? "▾"
                                : "▸"}{" "}
                            </span>
                            {row.name}
                          </ButtonBase>
                        ) : (
                          row.name
                        )}
                      </td>
                      <td>{row.path ? <ElidedPath path={row.path} /> : "—"}</td>
                      <td>
                        {row.addresses.map((address) => (
                          <div key={address.namespace}>
                            {address.name}.{address.namespace}
                          </div>
                        ))}
                      </td>
                      <td>
                        {row.retained ? (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              row.retained && void releaseAddress(row.retained)
                            }
                          >
                            {t("projectAppRelease")}
                          </Button>
                        ) : (
                          row.status
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </SettingsCollection>
        </>
      )}
    </section>
  );
}
