import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import styles from "./ComputerSessionSelection.module.css";

export function ComputerSessionSelection({
  eligible,
  selected,
  onChange,
}: {
  eligible: boolean;
  selected: boolean;
  onChange: (value: boolean) => void;
}) {
  const { version } = useVersion();
  const { transport } = useCurrentSourceRuntime();
  const { t } = useI18n();
  const [available, setAvailable] = useState(false);
  const supported = serverHasCapability(
    version,
    SERVER_CAPABILITIES.computerControl.name,
  );
  useEffect(() => {
    let disposed = false;
    setAvailable(false);
    onChange(false);
    if (supported && eligible)
      void transport
        .fetch<{ enabled: boolean; available: boolean }>("/computer-control")
        .then((status) => {
          if (!disposed) setAvailable(status.enabled && status.available);
        })
        .catch(() => {
          /* Optional readiness stays unavailable on failure. */
        });
    return () => {
      disposed = true;
    };
  }, [transport, supported, eligible, onChange]);
  if (!available || !eligible) return null;
  return (
    <label className={styles.selection}>
      <input
        type="checkbox"
        checked={selected}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>
        <strong>{t("computerSessionOptIn")}</strong>
        <small>{t("computerSessionScope")}</small>
      </span>
    </label>
  );
}
