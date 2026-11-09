import { RENDEZ_DELIVERIES, type RendezDelivery } from "@yep-anywhere/shared";
import { useState } from "react";
import type { ServerSettings } from "../../api/client";
import { ButtonBase } from "../../components/ui/Button";
import { Checkbox, Radio } from "../../components/ui/Checkbox";
import { Select } from "../../components/ui/Field";
import { useI18n } from "../../i18n";
import { shortenPath } from "../../lib/text";
import { SettingsItem } from "./SettingsItem";
import styles from "./RendezSettings.module.css";

export type RendezSettingsValue = NonNullable<ServerSettings["rendez"]>;

type RendezChoice = "on" | "inherit" | "off";

const CHOICES: RendezChoice[] = ["on", "inherit", "off"];

export interface RendezProject {
  path: string;
  name: string;
}

interface RendezSettingsProps {
  value: RendezSettingsValue;
  /** Known projects; configured paths that are not projects are listed too. */
  projects: readonly RendezProject[];
  /** Projects whose observer runs; null when the server does not report it. */
  watching: ReadonlySet<string> | null;
  saving: boolean;
  onChange: (next: RendezSettingsValue) => void;
}

function choiceOf(value: RendezSettingsValue, path: string): RendezChoice {
  const explicit = value.projects[path];
  return explicit === undefined ? "inherit" : explicit ? "on" : "off";
}

function withChoice(
  value: RendezSettingsValue,
  path: string,
  choice: RendezChoice,
): RendezSettingsValue {
  const { [path]: _replaced, ...projects } = value.projects;
  return {
    ...value,
    projects:
      choice === "inherit"
        ? projects
        : { ...projects, [path]: choice === "on" },
  };
}

/**
 * The .rendez default plus per-project On / Inherit / Off. The table opens
 * showing only the overrides that change behavior; Show all lists every
 * project. Each change applies at once: turning a project on attaches nothing
 * until a session in it receives a user message.
 */
export function RendezSettings({
  value,
  projects,
  watching,
  saving,
  onChange,
}: RendezSettingsProps) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);

  const known = new Map(projects.map((project) => [project.path, project]));
  const rows: RendezProject[] = [
    ...projects,
    ...Object.keys(value.projects)
      .filter((path) => !known.has(path))
      .map((path) => ({
        path,
        name: path.split("/").filter(Boolean).at(-1) ?? path,
      })),
  ];
  const watched = (path: string) => value.projects[path] ?? value.enabled;
  // An override matters only when it differs from the default.
  const effective = (path: string) =>
    value.projects[path] !== undefined &&
    value.projects[path] !== value.enabled;
  const shown = (showAll ? rows : rows.filter((row) => effective(row.path)))
    .slice()
    .sort(
      (a, b) =>
        Number(choiceOf(value, a.path) === "inherit") -
          Number(choiceOf(value, b.path) === "inherit") ||
        a.name.localeCompare(b.name),
    );
  const overrideCount = Object.keys(value.projects).length;
  const watchedCount = rows.filter((row) => watched(row.path)).length;

  return (
    <div className={styles.card}>
      <SettingsItem
        as="label"
        label={t("rendezDefaultTitle")}
        description={t("rendezDefaultDescription")}
        doc={{ path: "topics/rendez.md", label: "rendez uploads" }}
        descriptionLayout="full-width-on-narrow"
        keywords={[
          "rendez",
          ".rendez",
          "rendezvous",
          "scp",
          "rsync",
          "upload",
          "watch",
        ]}
      >
        <Checkbox
          checked={value.enabled}
          disabled={saving}
          aria-label={t("rendezDefaultTitle")}
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        />
      </SettingsItem>
      <SettingsItem
        label={t("rendezDeliveryTitle")}
        description={t("rendezDeliveryDescription")}
        descriptionLayout="full-width-on-narrow"
        keywords={["rendez", "upload", "steer", "queue", "delivery"]}
      >
        <Select
          value={value.delivery ?? "auto"}
          disabled={saving}
          aria-label={t("rendezDeliveryTitle")}
          onChange={(event) => {
            const next = event.target.value as RendezDelivery;
            if (!RENDEZ_DELIVERIES.includes(next)) return;
            onChange({ ...value, delivery: next });
          }}
        >
          <option value="auto">{t("rendezDeliveryAuto")}</option>
          <option value="steer">{t("rendezDeliverySteer")}</option>
          <option value="queue">{t("rendezDeliveryQueue")}</option>
        </Select>
      </SettingsItem>
      {shown.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.nameHead} scope="col">
                {t("rendezProjectColumn")}
              </th>
              <th scope="col">{t("rendezOn")}</th>
              <th scope="col">
                {value.enabled ? t("rendezInheritOn") : t("rendezInheritOff")}
              </th>
              <th scope="col">{t("rendezOff")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const choice = choiceOf(value, row.path);
              const isWatching = watching?.has(row.path) === true;
              return (
                <tr key={row.path}>
                  <td className={styles.name} title={row.path}>
                    <strong>{row.name}</strong>
                    {watching !== null && isWatching && (
                      <span className={styles.watching}>
                        ● {t("rendezWatching")}
                      </span>
                    )}
                    {watching !== null && !isWatching && watched(row.path) && (
                      <span className={styles.waiting}>
                        <span className={styles.waitingLong}>
                          {t("rendezWaitingForMessage")}
                        </span>
                        <span className={styles.waitingShort}>
                          {t("rendezWaitingShort")}
                        </span>
                      </span>
                    )}
                    <span className={styles.path}>{shortenPath(row.path)}</span>
                  </td>
                  {CHOICES.map((option) => (
                    <td key={option} className={styles.choice}>
                      <label>
                        <Radio
                          name={`rendez-${row.path}`}
                          value={option}
                          checked={choice === option}
                          disabled={saving}
                          aria-label={`${row.name}: ${t(
                            option === "on"
                              ? "rendezOn"
                              : option === "off"
                                ? "rendezOff"
                                : "rendezInherit",
                          )}`}
                          onCheckedChange={() =>
                            onChange(withChoice(value, row.path, option))
                          }
                        />
                      </label>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div
        className={`${styles.footer} ${shown.length === 0 ? styles.footerAlone : ""}`}
      >
        <ButtonBase
          className={styles.link}
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll
            ? t("rendezShowOverrides")
            : t("rendezShowAll", { count: rows.length })}
        </ButtonBase>
        <span className={styles.count}>
          {t("rendezWatchedCount", {
            watched: watchedCount,
            total: rows.length,
          })}
        </span>
        {overrideCount > 0 && (
          <ButtonBase
            className={styles.link}
            disabled={saving}
            onClick={() => {
              onChange({ ...value, projects: {} });
              setShowAll(false);
            }}
          >
            {t("rendezAllInherit")}
          </ButtonBase>
        )}
      </div>
    </div>
  );
}
