import { displayModelId, type ProviderName } from "@yep-anywhere/shared";
import { getIndicatorToneFromProcess } from "../lib/modelConfigIndicator";
import { getModelIndicatorModelParts } from "../lib/modelIndicatorText";
import {
  getEffortLevelLabel,
  normalizeEffortLevelForProvider,
} from "../lib/effortLevels";
import { useI18n } from "../i18n";
import { Badge } from "./ui/Badge";
import styles from "./ProviderBadge.module.css";

const PROVIDER_COLORS: Record<ProviderName, string> = {
  claude: "var(--provider-claude)", // Claude orange
  "claude-gateway": "var(--provider-claude)",
  "claude-ollama": "var(--provider-claude)", // Same as Claude (uses Claude SDK)
  codex: "var(--provider-codex)", // OpenAI green
  "codex-oss": "var(--provider-codex)", // OpenAI green (same as codex)
  gemini: "var(--provider-gemini)", // Google blue
  "gemini-acp": "var(--provider-gemini)", // Google blue (same as gemini)
  antigravity: "var(--provider-gemini)",
  grok: "var(--provider-grok)", // xAI Grok
  opencode: "var(--provider-opencode)", // OpenCode purple
  pi: "var(--provider-pi)", // pi teal
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: "Claude",
  "claude-gateway": "Gateway",
  "claude-ollama": "Ollama",
  codex: "Codex",
  "codex-oss": "CodexOSS",
  gemini: "Gemini",
  "gemini-acp": "Gemini ACP",
  antigravity: "Antigravity",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "pi",
};

const MODEL_ACCENT_COLORS = {
  daybreak: "var(--provider-gemini)",
} as const;

interface ProviderBadgeProps {
  provider: ProviderName;
  /** Show as small dot only (for sidebar) vs full badge (for header) */
  compact?: boolean;
  /** Keep model identity and abbreviated effort in a narrow session header. */
  condensed?: boolean;
  /** Show known thinking/effort for any provider, as on Inbox cards. */
  showThinking?: boolean;
  /** Model name to display alongside provider (e.g., "opus", "sonnet") */
  model?: string;
  /** Current thinking mode for live process config */
  thinking?: { type: string };
  /** Current effort level for live process config */
  effort?: string;
  /** Whether the session is actively thinking/processing */
  isThinking?: boolean;
  className?: string;
}

/**
 * Badge showing which AI provider is running a session.
 * Use compact mode for sidebar lists, full mode for session headers.
 */
export function ProviderBadge({
  provider,
  compact = false,
  condensed = false,
  showThinking = false,
  model,
  thinking,
  effort,
  isThinking = false,
  className = "",
}: ProviderBadgeProps) {
  const { t } = useI18n();
  const color = PROVIDER_COLORS[provider];
  const label = PROVIDER_LABELS[provider];

  const isGptModel =
    provider === "codex" &&
    typeof model === "string" &&
    model.toLowerCase().startsWith("gpt-");

  const showKnownThinking = showThinking || isGptModel;
  const effortTone =
    showKnownThinking && (thinking || effort)
      ? effort && thinking?.type !== "disabled"
        ? normalizeEffortLevelForProvider(effort, provider)
        : getIndicatorToneFromProcess(thinking, effort, provider)
      : null;

  const effortLabel = (() => {
    if (!showKnownThinking) return null;
    if (!thinking && !effort) return null;
    if (thinking?.type === "disabled") {
      return t("modelSettingsThinkingOffLabel");
    }
    if (!effort)
      return t(
        showThinking
          ? "modelSettingsThinkingOnLabel"
          : "modelSettingsThinkingAutoLabel",
      );
    const level = normalizeEffortLevelForProvider(effort, provider);
    const label = getEffortLevelLabel(level, provider, t);
    if (level === "medium") return t("effortLevelMediumShortLabel");
    if (level === "xhigh") return t("effortLevelExtraHighShortLabel");
    return label;
  })();

  // Compact glyph label for the badge body (full text preserved in title)
  const effectiveModel = !model || model === "default" ? undefined : model;
  const modelParts = getModelIndicatorModelParts(provider, effectiveModel);
  // Color the model glyph/version by the sub-badge it implies (e.g. claude for a
  // copilot-routed claude-opus), not the routing provider. Skip the override
  // when the family matches the running provider so normal badges are unchanged.
  const familyKey = modelParts?.modelFamilyKey;
  const modelFamilyColor =
    familyKey && familyKey in PROVIDER_COLORS
      ? PROVIDER_COLORS[familyKey as ProviderName]
      : undefined;
  const modelAccentColor = modelParts?.modelAccent
    ? MODEL_ACCENT_COLORS[modelParts.modelAccent]
    : undefined;
  const modelColor = modelAccentColor ?? modelFamilyColor;
  const modelColorStyle =
    modelColor && modelColor !== color ? { color: modelColor } : undefined;

  const fullTitle = effectiveModel
    ? provider === "antigravity"
      ? `${label} · ${displayModelId(effectiveModel)}`
      : displayModelId(effectiveModel)
    : label;
  const accessibleTitle = effortLabel
    ? `${fullTitle} · ${t("providerBadgeEffort", { effort: effortLabel })}`
    : fullTitle;
  const shortEffort = effortTone
    ? {
        off: "Off",
        auto: showThinking ? "On" : "Auto",
        low: "L",
        medium: "M",
        high: "H",
        xhigh: "XH",
        max: "Max",
      }[effortTone]
    : null;
  const condensedModel = modelParts
    ? provider === "antigravity"
      ? [
          modelParts.providerGlyph,
          modelParts.subProvider,
          modelParts.modelLabel,
        ]
          .filter(Boolean)
          .join(" ")
      : modelParts.modelLabel || modelParts.providerGlyph
    : provider === "antigravity"
      ? "Agy"
      : label;

  if (compact) {
    return (
      <span
        className={className}
        style={{ backgroundColor: color }}
        title={fullTitle}
        role="img"
        aria-label={fullTitle}
      />
    );
  }

  const dotClass = `${styles.dot} ${isThinking ? styles.thinking : ""}`;
  const effortToneClass = effortTone
    ? {
        off: styles.off,
        auto: styles.auto,
        low: styles.low,
        medium: styles.medium,
        high: styles.high,
        xhigh: styles.xhigh,
        max: styles.max,
      }[effortTone]
    : "";
  const dotStyle = isThinking
    ? { backgroundColor: "var(--thinking-color)" }
    : { backgroundColor: color };

  return (
    <span
      className={` ${styles.root} ${className}`}
      data-provider-badge=""
      title={accessibleTitle}
      role="img"
      aria-label={accessibleTitle}
    >
      <Badge
        size="small"
        palette={{
          color,
          soft: `color-mix(in srgb, ${color} 12%, transparent)`,
        }}
        className={`${styles.badge} ${condensed ? styles.condensed : ""}`}
      >
        <span className={dotClass} style={dotStyle} />
        <span className={styles.model}>
          {condensed ? (
            <span style={modelColorStyle}>{condensedModel}</span>
          ) : modelParts ? (
            <>
              {modelParts.providerGlyph}
              {modelParts.subProvider ? ` ${modelParts.subProvider}` : ""}
              {modelParts.modelLabel ? (
                <span style={modelColorStyle}>
                  {` ${modelParts.modelLabel}`}
                </span>
              ) : null}
            </>
          ) : provider === "antigravity" ? (
            "Agy"
          ) : (
            label
          )}
        </span>
        {effortLabel && effortTone && (
          <span
            className={styles.effort}
            title={t("providerBadgeEffort", { effort: effortLabel })}
          >
            <span
              className={`${styles.effortDot} ${effortToneClass}`}
              aria-hidden="true"
            />
            <span className={styles.effortLabel}>
              {condensed ? shortEffort : effortLabel}
            </span>
          </span>
        )}
      </Badge>
    </span>
  );
}
