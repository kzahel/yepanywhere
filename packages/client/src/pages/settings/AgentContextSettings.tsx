import commandStyles from "./SettingsCommand.module.css";
import rowsStyles from "./SettingsRows.module.css";
import agentStyles from "./AgentContextSettings.module.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LATEX_MATH_RENDERING_CLIENT_CAPABILITY,
  buildEffectiveAgentContext,
} from "@yep-anywhere/shared";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { Textarea } from "../../components/ui/Field";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

const MAX_LENGTH = 10000;

export function AgentContextSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("agentContextTitle"));
  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const [instructions, setInstructions] = useState("");
  const [latexMathRendering, setLatexMathRendering] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // True once the form mirrors loaded settings; gates the undo baseline so
  // it snapshots the open-time values, not the pre-load defaults.
  const [formSynced, setFormSynced] = useState(false);

  useEffect(() => {
    if (settings) {
      setInstructions(settings.globalInstructions ?? "");
      setLatexMathRendering(
        settings.agentContextHints?.latexMathRendering ?? false,
      );
      setFormSynced(true);
    }
  }, [settings]);

  const serverInstructions = settings?.globalInstructions ?? "";
  const serverLatexMathRendering =
    settings?.agentContextHints?.latexMathRendering ?? false;
  const effectiveAgentContext = useMemo(
    () =>
      buildEffectiveAgentContext({
        globalInstructions: instructions,
        hints: { latexMathRendering },
      }),
    [instructions, latexMathRendering],
  );

  // Header undo covers shown form values (saved or not), back to open-time.
  const undoState = useMemo(
    () =>
      formSynced
        ? {
            instructions,
            latexMathRendering,
          }
        : null,
    [formSynced, instructions, latexMathRendering],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setInstructions(snapshot.instructions);
      setLatexMathRendering(snapshot.latexMathRendering);
      setHasChanges(false);
      setSaveError(null);
      void updateSettings({
        globalInstructions: snapshot.instructions.trim() || undefined,
        agentContextHints: {
          latexMathRendering: snapshot.latexMathRendering,
        },
      }).catch(() => {
        // surfaced via the hook's error state
      });
    },
    [updateSettings],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const recomputeHasChanges = useCallback(
    (next: { instructions?: string; latexMathRendering?: boolean }) => {
      const nextInstructions = next.instructions ?? instructions;
      const nextLatexMathRendering =
        next.latexMathRendering ?? latexMathRendering;
      setHasChanges(
        nextInstructions !== serverInstructions ||
          nextLatexMathRendering !== serverLatexMathRendering,
      );
    },
    [
      instructions,
      latexMathRendering,
      serverInstructions,
      serverLatexMathRendering,
    ],
  );

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateSettings({
        globalInstructions: instructions.trim() || undefined,
        agentContextHints: { latexMathRendering },
      });
      setHasChanges(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("agentContextSaveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [instructions, latexMathRendering, t, updateSettings]);

  if (isLoading) {
    return <SettingsSection description={t("agentContextLoading")} />;
  }

  return (
    <SettingsSection
      description={t("agentContextDescription")}
      doc="topics/agent-context-injection.md#current-ya-placement"
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges && !isSaving) void handleSave();
      }}
      keywords={[
        t("agentContextGlobalInstructions"),
        t("agentContextGlobalInstructionsDescription"),
        t("agentContextSuggestedLatexTitle"),
        t("agentContextSuggestedLatexDescription"),
      ]}
    >
      <div className={rowsStyles.group} data-settings-group>
        <SettingsItem
          label={t("agentContextGlobalInstructions")}
          description={t("agentContextGlobalInstructionsDescription")}
          layout="custom"
          containerProps={{
            style: { flexDirection: "column", alignItems: "stretch" },
          }}
        >
          <div className={rowsStyles.itemInfo} data-settings-info>
            <strong>{t("agentContextGlobalInstructions")}</strong>
            <p>{t("agentContextGlobalInstructionsDescription")}</p>
          </div>
          <Textarea
            mono
            value={instructions}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_LENGTH);
              setInstructions(value);
              recomputeHasChanges({ instructions: value });
              setSaveError(null);
            }}
            placeholder={t("agentContextPlaceholder")}
            rows={10}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: "var(--space-2)",
            }}
          >
            <span className={rowsStyles.hint}>
              {t("agentContextCharacters", {
                current: instructions.length.toLocaleString(),
                max: MAX_LENGTH.toLocaleString(),
              })}
            </span>
          </div>
        </SettingsItem>

        <HideInSettingsSearch>
          <div className={agentStyles.heading}>
            <strong>{t("agentContextSuggestedHintsTitle")}</strong>
            <p>{t("agentContextSuggestedHintsDescription")}</p>
          </div>
        </HideInSettingsSearch>

        <SettingsItem
          as="label"
          label={t("agentContextSuggestedLatexTitle")}
          description={t("agentContextSuggestedLatexDescription")}
          layout="custom"
        >
          <div className={rowsStyles.itemInfo} data-settings-info>
            <strong>{t("agentContextSuggestedLatexTitle")}</strong>
            <p>{t("agentContextSuggestedLatexDescription")}</p>
          </div>
          <Checkbox
            checked={latexMathRendering}
            onCheckedChange={(nextLatexMathRendering) => {
              setLatexMathRendering(nextLatexMathRendering);
              recomputeHasChanges({
                latexMathRendering: nextLatexMathRendering,
              });
              setSaveError(null);
            }}
            aria-label={t("agentContextSuggestedLatexTitle")}
          />
        </SettingsItem>

        <HideInSettingsSearch>
          <div
            className={rowsStyles.item}
            style={{ flexDirection: "column", alignItems: "stretch" }}
          >
            <div className={rowsStyles.itemInfo} data-settings-info>
              <strong>{t("agentContextSuggestedLatexPreviewTitle")}</strong>
              <p>{t("agentContextSuggestedLatexPreviewDescription")}</p>
            </div>
            <pre className={commandStyles.preview}>
              {`[Client capabilities]\n${LATEX_MATH_RENDERING_CLIENT_CAPABILITY}`}
            </pre>
          </div>

          <details>
            <summary className={rowsStyles.hint}>
              {t("agentContextPreviewSummary")}
            </summary>
            <pre className={commandStyles.preview}>
              {effectiveAgentContext ?? t("agentContextPreviewEmpty")}
            </pre>
          </details>
        </HideInSettingsSearch>
      </div>

      <div className={rowsStyles.formActions}>
        <Button
          variant="primary"
          type="submit"
          disabled={!hasChanges || isSaving}
        >
          {isSaving ? t("providersSaving") : t("providersSave")}
        </Button>
      </div>
      {(saveError || error) && (
        <Banner tone="error">{saveError || error}</Banner>
      )}
    </SettingsSection>
  );
}
