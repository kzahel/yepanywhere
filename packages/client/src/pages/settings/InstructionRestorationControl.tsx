import { useState } from "react";
import type {
  InstructionRestorationSettings,
  ProviderName,
} from "@yep-anywhere/shared";
import { useI18n } from "../../i18n";
import { api } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { SettingsItem } from "./SettingsItem";
import { CommittedRangeNumberInput } from "../../components/ui/CommittedRangeNumberInput";
import styles from "./InstructionRestorationControl.module.css";

export function InstructionRestorationControl({
  value,
  providers,
  save,
}: {
  value: InstructionRestorationSettings;
  providers: readonly { id: string; displayName: string }[];
  save: (value: InstructionRestorationSettings) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof api.previewInstructionRestoration>
  > | null>(null);
  return (
    <SettingsItem
      baseClassName={styles.row}
      id="providers-instruction-restoration"
      label={t("instructionRestorationTitle")}
      description={t("instructionRestorationDescription")}
      doc={{
        path: "topics/agent-context-injection.md#optional-instruction-restoration",
        label: "instruction restoration",
      }}
    >
      <form
        className={styles.controls}
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setSaved(false);
          setError("");
          try {
            await save(draft);
            setSaved(true);
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          {t("instructionRestorationPrefix")}
          <input
            className="settings-input"
            aria-label={t("instructionRestorationPrefix")}
            value={draft.pathPrefix}
            placeholder="~/agents/topics/"
            onChange={(event) =>
              setDraft({ ...draft, pathPrefix: event.target.value })
            }
          />
        </label>
        <label>
          {t("instructionRestorationPattern")}
          <input
            className="settings-input"
            aria-label={t("instructionRestorationPattern")}
            value={draft.pattern}
            onChange={(event) =>
              setDraft({ ...draft, pattern: event.target.value })
            }
          />
        </label>
        <p>{t("instructionRestorationBoundary")}</p>
        <Button
          onClick={async () => {
            setError("");
            try {
              setPreview(await api.previewInstructionRestoration(draft));
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          {t("instructionRestorationPreview")}
        </Button>
        {preview && (
          <details open>
            <summary>{preview.prefix}</summary>
            <ul>
              {preview.matches.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            {preview.truncated && (
              <p>{t("instructionRestorationPreviewLimit")}</p>
            )}
          </details>
        )}
        <label htmlFor="instruction-restoration-delay">
          {t("instructionRestorationDelay")}
        </label>
        <CommittedRangeNumberInput
          id="instruction-restoration-delay"
          min={0}
          max={10}
          step={1}
          value={draft.delayTurns}
          ariaLabel={t("instructionRestorationDelay")}
          onCommit={(delayTurns) => setDraft({ ...draft, delayTurns })}
        />
        <div className={styles.providers}>
          {providers.map((provider) => (
            <label key={provider.id}>
              <input
                type="checkbox"
                checked={draft.providers[provider.id as ProviderName] === true}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    providers: {
                      ...draft.providers,
                      [provider.id]: event.target.checked,
                    },
                  })
                }
              />
              {provider.displayName}
            </label>
          ))}
        </div>
        <p>{t("instructionRestorationCompanion")}</p>
        <Button variant="primary" type="submit" disabled={saving}>
          {t("instructionRestorationSave")}
        </Button>
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">{t("instructionRestorationSaved")}</p>}
      </form>
    </SettingsItem>
  );
}
