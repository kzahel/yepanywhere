import settingsRowsStyles from "../../src/pages/settings/SettingsRows.module.css";
import type { ArtifactVhostSiteView } from "@yep-anywhere/shared";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FileVhostSection,
  type FileVhostService,
} from "../../src/components/FileVhostSection";
import shareStyles from "../../src/components/PublicFileShareModal.module.css";
import {
  PublicShareInventoryList,
  PublicShareInventoryMeta,
  PublicShareInventoryRow,
} from "../../src/components/PublicShareInventory";
import { Modal } from "../../src/components/ui/Modal";
import { I18nProvider, useI18n } from "../../src/i18n";
import settingsStyles from "../../src/pages/settings/ArtifactSettings.module.css";
import "../../src/styles/purposeGlobals";
import styles from "./Mockup.module.css";

const FILE = "/home/graehl/notes/garden-plan.html";
const TAKEN = new Set(["plannotator", "skyler-pancake", "ya", "relay"]);

/** Local stand-in for the server: first claim wins, nothing is served. */
function useFakeService(): FileVhostService {
  const [sites] = useState(() => new Map<string, ArtifactVhostSiteView>());
  return useMemo(
    () => ({
      hostSuffix: "graehl.org",
      list: async (path) =>
        [...sites.values()].filter((site) => site.path === path),
      serve: async ({ name, path, public: publicAccess }) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
          throw new Error(`Invalid vhost name "${name}"`);
        if (TAKEN.has(name) || sites.has(name))
          throw new Error(`The name "${name}" is already taken`);
        const site: ArtifactVhostSiteView = {
          name,
          path,
          public: publicAccess,
          kind: "file",
          publicUrl: `https://${name}.graehl.org/${publicAccess ? "" : "?ya_access=Q2x…"}`,
        };
        sites.set(name, site);
        return site;
      },
      stop: async (name) => {
        sites.delete(name);
      },
    }),
    [sites],
  );
}

function ShareDialog() {
  const { t } = useI18n();
  const service = useFakeService();
  return (
    <Modal title={t("publicFileShareTitle")} onClose={() => {}}>
      <div className={shareStyles.modal}>
        <div className={shareStyles.fileIdentity} title={FILE}>
          <span />
          <span>{FILE}</span>
          <span className={shareStyles.liveBadge}>
            {t("publicShareLiveBadge")}
          </span>
        </div>
        <p className={shareStyles.description}>
          {t("publicFileShareDescription")}
        </p>
        <button
          type="button"
          className={`settings-button settings-button-primary ${shareStyles.createButton}`}
        >
          {t("publicFileShareCreate")}
        </button>
        <div className={shareStyles.inventory}>
          <div className={shareStyles.inventoryHeading}>
            <strong>{t("publicFileShareExisting")}</strong>
          </div>
          <PublicShareInventoryList compact>
            <PublicShareInventoryRow
              title="garden-plan.html"
              mode="live"
              modeLabel={t("publicShareLiveBadge")}
              copyAction={{
                label: t("publicFileShareCopy"),
                onClick: () => {},
              }}
              revokeAction={{
                label: t("publicFileShareRevoke"),
                onClick: () => {},
              }}
            >
              <PublicShareInventoryMeta>
                9/29/2026, 4:12 PM
              </PublicShareInventoryMeta>
            </PublicShareInventoryRow>
          </PublicShareInventoryList>
        </div>
        <FileVhostSection filePath={FILE} service={service} />
      </div>
    </Modal>
  );
}

interface Row {
  name: string;
  kind: "port" | "files";
  port?: number;
  env?: string;
  path?: string;
  public: boolean;
}

function SettingsTable() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[]>([
    {
      name: "plannotator",
      kind: "port",
      port: 19432,
      env: "PLANNOTATOR_PORT",
      public: false,
    },
    {
      name: "garden",
      kind: "files",
      path: "/home/graehl/notes/garden-plan.html",
      public: true,
    },
    {
      name: "papers",
      kind: "files",
      path: "~/papers/_build/site",
      public: false,
    },
  ]);
  const update = (index: number, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  return (
    <section className={`${settingsRowsStyles.section} ${styles.settings}`}>
      <h2>{t("artifactSettingsTitle")}</h2>
      <fieldset className={settingsStyles.fields}>
        <label>
          {t("artifactVhostPublicRoot")}
          <input type="text" defaultValue="graehl.org" />
        </label>
        <div className={settingsStyles.vhosts}>
          <span className={settingsStyles.vhostHeading}>
            {t("artifactVhostTableTitle")}
          </span>
          <p>{t("artifactVhostTableHint")}</p>
          <p>{t("artifactVhostFilesHint")}</p>
          {rows.map((row, index) => (
            <div
              key={row.name || index}
              className={`${settingsStyles.vhostRow} ${settingsStyles.withServes}`}
            >
              <label>
                {t("artifactVhostName")}
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) => update(index, { name: e.target.value })}
                />
              </label>
              <label>
                {t("artifactVhostServes")}
                <select
                  value={row.kind}
                  onChange={(e) =>
                    update(index, { kind: e.target.value as Row["kind"] })
                  }
                >
                  <option value="port">{t("artifactVhostServesPort")}</option>
                  <option value="files">{t("artifactVhostServesFiles")}</option>
                </select>
              </label>
              {row.kind === "files" ? (
                <label className={settingsStyles.pathField}>
                  {t("artifactVhostPath")}
                  <input
                    type="text"
                    value={row.path ?? ""}
                    placeholder="~/site/index.html"
                    onChange={(e) => update(index, { path: e.target.value })}
                  />
                </label>
              ) : (
                <>
                  <label>
                    {t("artifactVhostPort")}
                    <input type="number" defaultValue={row.port} />
                  </label>
                  <label>
                    {t("artifactVhostEnv")}
                    <input type="text" defaultValue={row.env} />
                  </label>
                </>
              )}
              <button
                type="button"
                onClick={() =>
                  setRows((current) => current.filter((_, i) => i !== index))
                }
              >
                {t("artifactVhostRemove")}
              </button>
              <div className={settingsStyles.access}>
                <label className={settingsStyles.toggle}>
                  <input
                    type="checkbox"
                    checked={row.public}
                    onChange={(e) =>
                      update(index, { public: e.target.checked })
                    }
                  />
                  {t("appAccessPublic")}
                </label>
                <button type="button">{t("appAccessCopy")}</button>
                <button type="button">{t("appAccessRevoke")}</button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setRows((current) => [
                ...current,
                { name: "", kind: "port", port: 19432, public: false },
              ])
            }
          >
            {t("artifactVhostAdd")}
          </button>
        </div>
      </fieldset>
    </section>
  );
}

function FileSitesMockup() {
  const [view, setView] = useState<"share" | "settings">(() =>
    location.hash === "#settings" ? "settings" : "share",
  );
  // The share dialog's overlay covers the tabs, so the hash also switches.
  useEffect(() => {
    const follow = () =>
      setView(location.hash === "#settings" ? "settings" : "share");
    addEventListener("hashchange", follow);
    return () => removeEventListener("hashchange", follow);
  }, []);
  return (
    <div className={styles.page}>
      <nav className={styles.tabs} aria-label="Mockup view">
        <button
          type="button"
          aria-pressed={view === "share"}
          onClick={() => setView("share")}
        >
          File Viewer share
        </button>
        <button
          type="button"
          aria-pressed={view === "settings"}
          onClick={() => setView("settings")}
        >
          Settings → Apps
        </button>
      </nav>
      {view === "share" ? <ShareDialog /> : <SettingsTable />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <FileSitesMockup />
  </I18nProvider>,
);
