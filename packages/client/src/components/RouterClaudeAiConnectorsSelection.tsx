import type { AgentAuthRouterOverview } from "@yep-anywhere/shared";
import { useI18n } from "../i18n";
import { FilterDropdown } from "./FilterDropdown";
import styles from "./RouterClaudeAiConnectorsSelection.module.css";

/**
 * Routed Claude sessions can keep claude.ai connectors from this computer's
 * Claude login while the pool runs inference. Shown only when discovery
 * reports support; off unless a login exists and the user turns it on.
 */
export function RouterClaudeAiConnectorsSelection({
  support,
  selected,
  onChange,
  disabled = false,
  showCaption = false,
}: {
  support: AgentAuthRouterOverview["claudeAiConnectors"];
  selected: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  showCaption?: boolean;
}) {
  const { t } = useI18n();
  if (!support) return null;
  const login = support.login;
  return (
    <div className={`new-session-helper-section ${styles.section}`}>
      <h3>{t("newSessionClaudeAiConnectorsTitle")}</h3>
      <FilterDropdown<"off" | "on">
        label={t("newSessionClaudeAiConnectorsTitle")}
        options={[
          { value: "off", label: t("showThinkingOff"), disabled },
          {
            value: "on",
            label: !login
              ? t("newSessionClaudeAiConnectorsNoLogin")
              : login.email
                ? t("newSessionClaudeAiConnectorsOn", { email: login.email })
                : t("newSessionClaudeAiConnectorsOnUnknown"),
            disabled: disabled || !login,
          },
        ]}
        selected={[selected && login ? "on" : "off"]}
        onChange={([value]) => {
          if (!disabled) onChange(value === "on");
        }}
        multiSelect={false}
        fullWidth
        triggerClassName={styles.leftAlignedTrigger}
      />
      {showCaption && (
        <p className={styles.caption}>
          {t("newSessionClaudeAiConnectorsScope")}
        </p>
      )}
    </div>
  );
}
