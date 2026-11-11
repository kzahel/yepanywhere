import optionStyles from "./NewSessionOptionsPanel.module.css";
import { useEffect, useState } from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useI18n } from "../i18n";
import { FilterDropdown } from "./FilterDropdown";
import styles from "./MachineControlSessionSelection.module.css";

export function MachineControlSessionSelection({
  eligible,
  selected,
  onChange,
  disabled = false,
  showCaption = false,
}: {
  eligible: boolean;
  selected: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  showCaption?: boolean;
}) {
  const { transport } = useCurrentSourceRuntime();
  const { t } = useI18n();
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let disposed = false;
    setAvailable(false);
    onChange(false);
    if (eligible)
      void transport
        .fetch<{ available: boolean }>("/machine-control")
        .then((status) => {
          if (!disposed) setAvailable(status.available === true);
        })
        .catch(() => {
          /* Optional readiness remains unavailable. */
        });
    return () => {
      disposed = true;
    };
  }, [transport, eligible, onChange]);
  if (!eligible || !available) return null;
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
