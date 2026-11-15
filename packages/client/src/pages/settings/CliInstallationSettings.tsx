import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CliInstallationFamily,
  CliInstallationInventory,
} from "@yep-anywhere/shared/provider-cli-installations";
import { cliInstallationsApi } from "../../api/cliInstallationsClient";
import { Button } from "../../components/ui/Button";
import { Banner } from "../../components/ui/Banner";
import { Field, Select, TextInput } from "../../components/ui/Field";
import { useClientSummarySourceKey } from "../../lib/clientSummaryStore";
import { useI18n } from "../../i18n";
import styles from "./CliInstallationSettings.module.css";
import { SettingsCaption } from "./SettingsDocLink";

export function CliInstallationSettings({
  family,
  onChanged,
}: {
  family: CliInstallationFamily;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const source = useClientSummarySourceKey();
  const api = useMemo(() => cliInstallationsApi(source), [source]);
  const [inventory, setInventory] = useState<CliInstallationInventory>();
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<false | "scan" | "test" | "save">(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const dirty = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    dirty.current = false;
    setInventory(undefined);
    setCustom(false);
    setDraft("");
    setError(undefined);
    setBusy("scan");
    void api
      .inventory(family)
      .then((result) => {
        if (current !== generation.current) return;
        setInventory(result);
        if (!dirty.current) setDraft(result.selection ?? "");
      })
      .catch((cause) => {
        if (current === generation.current) setError(String(cause));
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [family, api]);

  const run = async (
    action: () => Promise<CliInstallationInventory & { error?: string }>,
    kind: "scan" | "test" | "save" = "scan",
  ) => {
    const current = ++generation.current;
    setBusy(kind);
    setError(undefined);
    try {
      const result = await action();
      if (current === generation.current) {
        setInventory(result);
        setError(result.error);
        onChanged?.();
      }
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const managed = inventory?.managed ?? false;
  const selection = inventory?.selection ?? "auto";
  return (
    <div className={styles.root} data-cli-installation={family}>
      <Field
        label={t("cliInstallationTitle")}
        hint={t(managed ? "cliInstallationManaged" : "cliInstallationHint")}
      >
        <Select
          className={styles.selector}
          aria-label={t("cliInstallationTitle")}
          value={custom ? "custom" : selection}
          disabled={managed || Boolean(busy) || !inventory}
          onChange={(event) => {
            const value = event.target.value;
            setCustom(value === "custom");
            if (value !== "custom")
              void run(
                () => api.select(family, value === "auto" ? null : value),
                "save",
              );
          }}
        >
          <option value="auto">{t("cliInstallationAuto")}</option>
          {inventory?.candidates.map((candidate) => (
            <option key={candidate.path} value={candidate.path}>
              {candidate.source} —{" "}
              {candidate.version ?? t("cliInstallationVersionUnknown")} —{" "}
              {candidate.path}
            </option>
          ))}
          {!managed && (
            <option value="custom">{t("cliInstallationCustom")}</option>
          )}
        </Select>
      </Field>
      {custom && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => api.select(family, draft), "save");
          }}
        >
          <Field label={t("cliInstallationPath")}>
            <TextInput
              mono
              value={draft}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                dirty.current = true;
                setDraft(event.target.value);
              }}
            />
          </Field>
          <Button
            type="submit"
            busy={busy === "save"}
            disabled={Boolean(busy) || !draft.trim()}
          >
            {t("cliInstallationSave")}
          </Button>
        </form>
      )}
      <div className={styles.actions}>
        <Button
          busy={busy === "scan"}
          disabled={Boolean(busy) || !inventory}
          onClick={() => void run(() => api.rescan(family))}
        >
          {t("cliInstallationRescan")}
        </Button>
        <Button
          busy={busy === "test"}
          disabled={
            Boolean(busy) ||
            !inventory ||
            inventory.candidates.every(
              (candidate) => candidate.verification === "unsupported",
            )
          }
          onClick={() => void run(() => api.test(family), "test")}
        >
          {t("cliInstallationTest")}
        </Button>
      </div>
      <p className={styles.hint}>
        <SettingsCaption
          text={t("cliInstallationVerificationHint")}
          doc="topics/provider-cli-installations.md"
        />
      </p>
      {error && (
        <Banner tone="error" compact>
          {error}
        </Banner>
      )}
      <ul className={styles.candidates}>
        {inventory?.candidates.map((candidate) => (
          <li key={candidate.path}>
            <div>
              {candidate.source} ·{" "}
              {candidate.version ?? t("cliInstallationVersionUnknown")}{" "}
              {candidate.selected && (
                <strong>{t("cliInstallationSelected")}</strong>
              )}
            </div>
            <code>{candidate.path}</code>
            <div>{t(`cliInstallationState_${candidate.verification}`)}</div>
            {(candidate.error || candidate.verificationError) && (
              <Banner tone="error" compact>
                {candidate.error ?? candidate.verificationError}
              </Banner>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
