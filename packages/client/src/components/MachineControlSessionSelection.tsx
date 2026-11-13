import optionStyles from "./NewSessionOptionsPanel.module.css";
import { useI18n } from "../i18n";
import { FilterDropdown } from "./FilterDropdown";
import styles from "./MachineControlSessionSelection.module.css";

/** Per-session choice; the form owns readiness and the server default. */
export function MachineControlSessionSelection({
  available,
  selected,
  onChange,
  disabled = false,
  showCaption = false,
}: {
  available: boolean;
  selected: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  showCaption?: boolean;
}) {
  const { t } = useI18n();
  if (!available) return null;
  return (
    <div
      className={`${optionStyles.newSessionHelperSection} ${styles.section}`}
      data-new-session-helper-section
    >
      <h3>{t("newSessionMachineControlTitle")}</h3>
      <FilterDropdown<"off" | "on">
        label={t("newSessionMachineControlTitle")}
        options={[
          { value: "off", label: t("showThinkingOff"), disabled },
          { value: "on", label: t("showThinkingOn"), disabled },
        ]}
        selected={[selected ? "on" : "off"]}
        onChange={([value]) => {
          if (!disabled) onChange(value === "on");
        }}
        multiSelect={false}
        fullWidth
        triggerClassName={styles.leftAlignedTrigger}
      />
      {showCaption && (
        <p className={styles.caption}>{t("machineControlSessionScope")}</p>
      )}
    </div>
  );
}
