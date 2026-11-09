import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Textarea } from "../../components/ui/Field";
import { useI18n } from "../../i18n";
import {
  applyBrowserSettingsBackup,
  captureBrowserSettings,
} from "../../lib/browserSettingsBackup";
import { writeClipboardText } from "../../lib/clipboard";
import {
  type ClientSettingChange,
  ClientSettingsDocumentError,
  type ParsedClientSettings,
  clientSettingsAsBackup,
  diffClientSettings,
  formatClientSettingsDocument,
  parseClientSettingsDocument,
} from "../../lib/clientSettingsClipboard";
import styles from "./SettingsTransfer.module.css";

const KEY_PREFIX = "yep-anywhere-";

/** Where the user must move text by hand because the clipboard is denied. */
type ManualText = { mode: "copy"; text: string } | { mode: "paste" };

interface Preview extends ParsedClientSettings {
  changes: ClientSettingChange[];
}

function displayKey(key: string): string {
  return key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key;
}

async function readClipboardText(): Promise<string | null> {
  if (!navigator.clipboard?.readText) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/**
 * Copy the portable browser preferences as text and paste them on another YA
 * server. Purely client-side, so it needs no server capability.
 */
export function SettingsClipboardTransfer() {
  const { t } = useI18n();
  const [manual, setManual] = useState<ManualText | null>(null);
  const [pastedText, setPastedText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const problemMessage = (problem: ClientSettingsDocumentError["problem"]) => {
    switch (problem) {
      case "not-json":
      case "wrong-kind":
        return t("settingsClipboardNotSettings");
      case "unsupported-version":
        return t("settingsClipboardUnsupportedVersion");
      case "malformed":
        return t("settingsClipboardMalformed");
    }
  };

  const review = (text: string) => {
    try {
      const parsed = parseClientSettingsDocument(text);
      const changes = diffClientSettings(
        captureBrowserSettings(),
        parsed.document.settings,
      );
      setManual(null);
      setPastedText("");
      if (changes.length === 0) {
        setPreview(null);
        setStatus(t("settingsClipboardNoChanges"));
        return;
      }
      setPreview({ ...parsed, changes });
    } catch (caught) {
      if (!(caught instanceof ClientSettingsDocumentError)) throw caught;
      setError(problemMessage(caught.problem));
    }
  };

  const handleCopy = async () => {
    setError(null);
    setPreview(null);
    const values = captureBrowserSettings();
    const text = formatClientSettingsDocument(values, window.location.host);
    if (await writeClipboardText(text)) {
      setManual(null);
      setStatus(
        t("settingsClipboardCopied", { count: Object.keys(values).length }),
      );
      return;
    }
    setManual({ mode: "copy", text });
    setStatus(t("settingsClipboardCopyManually"));
  };

  const handlePaste = async () => {
    setError(null);
    setStatus(null);
    setPreview(null);
    const text = await readClipboardText();
    if (text === null) {
      setManual({ mode: "paste" });
      setStatus(t("settingsClipboardPasteManually"));
      return;
    }
    review(text);
  };

  const handleApply = () => {
    if (!preview) return;
    setError(null);
    try {
      applyBrowserSettingsBackup(clientSettingsAsBackup(preview.document));
      window.location.reload();
    } catch {
      setError(t("settingsBackupLoadFailed"));
    }
  };

  const formatValue = (value: string | null) =>
    value === null ? t("settingsClipboardDefaultValue") : value;

  return (
    <section
      className={styles.section}
      aria-label={t("settingsClipboardTitle")}
    >
      <span className={styles.title}>{t("settingsClipboardTitle")}</span>
      <span className={styles.status}>{t("settingsClipboardDescription")}</span>
      <div className={styles.buttons}>
        <Button
          onClick={() => void handleCopy()}
          title={t("settingsClipboardCopyTooltip")}
        >
          {t("settingsClipboardCopy")}
        </Button>
        <Button
          onClick={() => void handlePaste()}
          title={t("settingsClipboardPasteTooltip")}
        >
          {t("settingsClipboardPaste")}
        </Button>
      </div>
      {manual?.mode === "copy" && (
        <Textarea
          mono
          aria-label={t("settingsClipboardCopyFieldLabel")}
          value={manual.text}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      {manual?.mode === "paste" && (
        <>
          <Textarea
            mono
            aria-label={t("settingsClipboardPasteFieldLabel")}
            value={pastedText}
            onChange={(event) => setPastedText(event.target.value)}
          />
          <div className={styles.buttons}>
            <Button
              variant="primary"
              onClick={() => {
                setError(null);
                setStatus(null);
                review(pastedText);
              }}
              disabled={pastedText.trim() === ""}
            >
              {t("settingsClipboardReview")}
            </Button>
            <Button
              onClick={() => {
                setManual(null);
                setPastedText("");
                setStatus(null);
                setError(null);
              }}
            >
              {t("settingsClipboardCancel")}
            </Button>
          </div>
        </>
      )}
      {preview && (
        <>
          <span className={styles.status}>
            {t("settingsClipboardPreviewSummary", {
              count: preview.changes.length,
              source: preview.document.sourceHost || "?",
            })}
          </span>
          <ul
            className={styles.changes}
            aria-label={t("settingsClipboardChangesLabel")}
          >
            {preview.changes.map((change) => (
              <li key={change.key} className={styles.change}>
                <span className={styles.changeKey}>
                  {displayKey(change.key)}
                </span>
                <span
                  className={styles.changeValues}
                  title={`${formatValue(change.from)} → ${formatValue(change.to)}`}
                >
                  {formatValue(change.from)} → {formatValue(change.to)}
                </span>
              </li>
            ))}
          </ul>
          {preview.ignoredKeys.length > 0 && (
            <span className={styles.status}>
              {t("settingsClipboardIgnored", {
                count: preview.ignoredKeys.length,
              })}
            </span>
          )}
          <div className={styles.buttons}>
            <Button
              variant="primary"
              onClick={handleApply}
              title={t("settingsClipboardApplyTooltip")}
            >
              {t("settingsClipboardApply")}
            </Button>
            <Button onClick={() => setPreview(null)}>
              {t("settingsClipboardCancel")}
            </Button>
          </div>
        </>
      )}
      <span
        className={`${styles.status} ${error ? styles.error : ""}`}
        role={error ? "alert" : "status"}
      >
        {error ?? status}
      </span>
    </section>
  );
}
