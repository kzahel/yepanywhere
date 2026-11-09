import { useState } from "react";
import {
  defaultLimitedUserInstructions,
  instructionBlocksError,
  resolveLimitedUserInstructions,
  type LimitedUserInstructions as Instructions,
} from "@yep-anywhere/shared";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { useI18n } from "../../i18n";
import {
  InstructionBlocks,
  instructionBlockDrafts,
  type InstructionBlockDraft,
} from "./InstructionBlocks";
import styles from "./InstructionBlocks.module.css";

export function SharedLimitedUserInstructions({
  value,
  onSave,
}: {
  value: Instructions | undefined;
  onSave: (value: Instructions) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [blocks, setBlocks] = useState(() =>
    instructionBlockDrafts((value ?? defaultLimitedUserInstructions()).blocks),
  );
  const [startFromDefault, setStartFromDefault] = useState(
    (value ?? defaultLimitedUserInstructions()).startFromDefault,
  );
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const draft = { startFromDefault, blocks: blocks.map((block) => block.text) };
  const error = instructionBlocksError(draft.blocks);
  async function save() {
    setBusy(true);
    setSaveError(false);
    try {
      await onSave(draft);
      setSaved(true);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={styles.panel}
      aria-label={t("usersSharedInstructionsTitle")}
    >
      <h3>{t("usersSharedInstructionsTitle")}</h3>
      <Checkbox
        label={t("usersInstructionsDefault")}
        checked={startFromDefault}
        disabled={busy}
        onCheckedChange={(checked) => {
          setStartFromDefault(checked);
          setSaved(false);
        }}
      />
      <p className={styles.hint}>
        {t(
          startFromDefault
            ? "usersInstructionsAppendHint"
            : "usersInstructionsReplaceHint",
        )}
      </p>
      <InstructionBlocks
        value={blocks}
        disabled={busy}
        onChange={(next) => {
          setBlocks(next);
          setSaved(false);
        }}
      />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={busy || !!error}
          aria-label={t("usersInstructionsSave")}
          onClick={() => void save()}
        >
          {t("usersInstructionsSaveShort")}
        </Button>
        <Button
          aria-expanded={preview}
          aria-label={t("usersInstructionsPreview")}
          onClick={() => setPreview(!preview)}
        >
          {t("usersInstructionsPreviewShort")}
        </Button>
        {saved && (
          <span role="status" className={styles.hint}>
            {t("usersInstructionsSaved")}
          </span>
        )}
      </div>
      {saveError && (
        <p role="alert" className="form-error">
          {t("usersInstructionsSaveFailed")}
        </p>
      )}
      {preview && (
        <pre className={styles.preview}>
          {resolveLimitedUserInstructions(draft).text ||
            t("usersInstructionsEmpty")}
        </pre>
      )}
      <p className={styles.hint}>{t("usersInstructionsTiming")}</p>
      <p className={styles.restriction}>{t("usersInstructionsMcp")}</p>
    </section>
  );
}

export function PerUserInstructions({
  shared,
  blocks,
  onChange,
  disabled,
}: {
  shared: Instructions | undefined;
  blocks: InstructionBlockDraft[];
  onChange: (blocks: InstructionBlockDraft[]) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(false);
  const inherited = shared ?? defaultLimitedUserInstructions();
  const text = resolveLimitedUserInstructions(
    inherited,
    blocks.map((block) => block.text),
  ).text;
  return (
    <section
      className={styles.panel}
      aria-label={t("usersOwnInstructionsTitle")}
    >
      <h3>{t("usersOwnInstructionsTitle")}</h3>
      <details className={styles.inherited}>
        <summary>{t("usersInstructionsInherited")}</summary>
        <p className={styles.hint}>
          {t(
            inherited.startFromDefault
              ? "usersInstructionsAppendHint"
              : "usersInstructionsReplaceHint",
          )}
        </p>
        <pre className={styles.preview}>
          {resolveLimitedUserInstructions(inherited).text ||
            t("usersInstructionsEmpty")}
        </pre>
      </details>
      <p className={styles.hint}>{t("usersOwnInstructionsHint")}</p>
      <InstructionBlocks
        value={blocks}
        onChange={onChange}
        disabled={disabled}
      />
      <div className={styles.actions}>
        <Button
          aria-expanded={preview}
          aria-label={t("usersInstructionsPreview")}
          onClick={() => setPreview(!preview)}
        >
          {t("usersInstructionsPreviewShort")}
        </Button>
      </div>
      {preview && (
        <pre className={styles.preview}>
          {text || t("usersInstructionsEmpty")}
        </pre>
      )}
      <p className={styles.hint}>{t("usersInstructionsTiming")}</p>
    </section>
  );
}
