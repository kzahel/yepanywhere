import { useCallback, useId, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { TextInput } from "./ui/Field";
import styles from "./SessionRenameEditor.module.css";

interface SessionRenameEditorProps {
  initialTitle: string;
  presentation: "inline" | "dialog";
  onSave: (title: string) => Promise<boolean>;
  onCancel: () => void;
}

/** Draft changes stay here rather than reconciling the live transcript per key. */
export function SessionRenameEditor({
  initialTitle,
  presentation,
  onSave,
  onCancel,
}: SessionRenameEditorProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(initialTitle);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputId = useId();
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const closing = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const attachInput = useCallback((input: HTMLInputElement | null) => {
    inputRef.current = input;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const cancel = () => {
    if (closing.current) return;
    closing.current = true;
    onCancel();
  };
  const save = async () => {
    if (closing.current || !value.trim()) return;
    if (value.trim() === initialTitle) {
      cancel();
      return;
    }
    closing.current = true;
    setSaving(true);
    setFailed(false);
    if (!(await onSave(value))) {
      closing.current = false;
      setSaving(false);
      setFailed(true);
    }
  };

  const dialog = presentation === "dialog";
  const saveButton = (
    <Button
      type="submit"
      form={formId}
      variant="primary"
      busy={saving}
      disabled={!value.trim()}
    >
      {t("sessionRenameSave")}
    </Button>
  );
  const cancelButton = (
    <Button disabled={saving} onClick={cancel}>
      {t("sessionRenameCancel")}
    </Button>
  );

  const form = (
    <form
      ref={formRef}
      id={formId}
      className={dialog ? styles.dialog : styles.inline}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className={styles.label} htmlFor={inputId}>
        {t("sessionRenameTitleLabel")}
      </label>
      <TextInput
        id={inputId}
        ref={attachInput}
        className={styles.input}
        value={value}
        readOnly={saving}
        onChange={(event) => {
          setValue(event.target.value);
          setFailed(false);
        }}
        onBlur={(event) => {
          if (
            dialog ||
            formRef.current?.contains(event.relatedTarget as Node | null)
          )
            return;
          if (!value.trim()) cancel();
          else void save();
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.keyCode === 229)
          ) {
            event.preventDefault();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
      />
      {!dialog && (
        <div className={styles.actions}>
          {saveButton}
          {cancelButton}
        </div>
      )}
      {failed && (
        <Banner tone="error" compact className={styles.failure}>
          {t("sessionRenameFailed")}
        </Banner>
      )}
    </form>
  );

  return dialog ? (
    <Dialog
      title={t("sessionRenameDialogTitle")}
      size="small"
      onClose={cancel}
      initialFocusRef={inputRef}
      closeOnBackGesture
      footer={
        <>
          {cancelButton}
          {saveButton}
        </>
      }
    >
      {form}
    </Dialog>
  ) : (
    form
  );
}
