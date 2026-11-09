import type { SteeringMode, SteeringModeSettings } from "@yep-anywhere/shared";
import { Select } from "../../components/ui/Field";
import { useProviders } from "../../hooks/useProviders";
import { useProcesses } from "../../hooks/useProcesses";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";

/** Provider capabilities select rows; the UI contains no native protocol map. */
export function ProviderSteeringSettings({
  value,
  onChange,
}: {
  value: SteeringModeSettings;
  onChange: (settings: SteeringModeSettings) => void;
}) {
  const { providers } = useProviders();
  const { processes } = useProcesses();
  const { t } = useI18n();
  const label = (mode: SteeringMode | "native-config") =>
    mode === "gentle"
      ? t("providerSteeringGentle")
      : mode === "immediate"
        ? t("providerSteeringImmediate")
        : t("providerSteeringNativeConfig");
  return providers
    .filter((provider) => provider.steering?.selection === "launch")
    .map((provider) => {
      const capability = provider.steering!;
      const owners = processes.filter(
        (process) => process.provider === provider.name && process.steering,
      );
      return (
        <SettingsItem
          key={provider.name}
          label={t("providerSteeringLaunchTitle", {
            provider: provider.displayName,
          })}
          description={t("providerSteeringLaunchDescription")}
          descriptionLayout="full-width-on-narrow"
          doc="topics/steer-queue-provider-differences.md#shared-steering-contract"
          after={
            owners.length > 0 && (
              <p className="settings-hint">
                {t("providerSteeringOwners", {
                  modes: [
                    ...new Set(
                      owners.map((owner) => label(owner.steering!.mode)),
                    ),
                  ].join(", "),
                })}
              </p>
            )
          }
        >
          <Select
            value={value[provider.name] ?? capability.defaultMode}
            aria-label={t("providerSteeringLaunchTitle", {
              provider: provider.displayName,
            })}
            onChange={(event) =>
              onChange({
                ...value,
                [provider.name]: event.target.value as SteeringMode,
              })
            }
          >
            {capability.modes.map((mode) => (
              <option key={mode} value={mode}>
                {label(mode)}
              </option>
            ))}
          </Select>
        </SettingsItem>
      );
    });
}
