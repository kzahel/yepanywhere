import { IssueIcon } from "../../components/IssueIcon";
import type { ReactNode } from "react";
import { useSettingsIconStyle } from "../../hooks/useSettingsIconStyle";

/**
 * Settings category icons.
 *
 * Flat renderers use inline SVGs sized to fit the .settings-category-icon
 * container. The optional emoji renderer uses native color glyphs. SVGs use
 * currentColor for theme-adaptive coloring and evenodd fillRule for
 * cutouts/holes (e.g. lock keyhole).
 */

const baseProps = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24" as const,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Icon(props: {
  children: ReactNode;
  className?: string;
  [key: string]: unknown;
}) {
  const { children, ...rest } = props;
  return (
    <svg {...baseProps} aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const settingsCategoryEmojiIcons: Record<string, string> = {
  appearance: "🎨",
  issues: "🎟️",
  performance: "⚡",
  toolbar: "🎛️",
  model: "🧠",
  "cache-miss-billing": "🧾",
  "message-delivery": "📨",
  "source-control": "🔎",
  storage: "🗄️",
  "agent-context": "📋",
  notifications: "🔔",
  webhooks: "🪝",
  devices: "📱",
  "computer-control": "🖱️",
  "local-access": "🔒",
  remote: "🌐",
  providers: "🔌",
  speech: "🎙️",
  "remote-executors": "🖥️",
  environment: "⚙️",
  about: "ℹ️",
  emulator: "🤖",
  development: "🛠️",
};

export const settingsCategoryIcons: Record<string, ReactNode> = {
  issues: <IssueIcon size={22} />,
  appearance: (
    <Icon strokeWidth={2.5}>
      {/* A font specimen in a card + prominent color swatches. Clean large letter + bigger color blocks + thicker stroke for visual weight matching others. */}
      <rect x="2" y="2" width="20" height="20" rx="3" />
      <text
        x="3.5"
        y="13"
        fontSize="15"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
      >
        A
      </text>
      {/* bigger color blocks on right */}
      <rect x="17" y="4" width="5" height="5" rx="1" fill="#15803d" />
      <rect x="17" y="10" width="5" height="5" rx="1" fill="#1e40af" />
      <rect x="17" y="16" width="5" height="5" rx="1" fill="#b91c1c" />
    </Icon>
  ),

  performance: (
    <Icon strokeWidth={2.5}>
      {/* Gauge / speedometer */}
      <path d="M4 15a8 8 0 0 1 16 0" />
      <path d="M6.5 18h11" />
      <path d="m12 14 4-5" />
      <path d="M12 14h.01" />
      <path d="M7.8 10.8 6.4 9.4" />
      <path d="M16.2 10.8 17.6 9.4" />
    </Icon>
  ),

  model: (
    <Icon strokeWidth={2.5}>
      {/* Brain / model (exact Lucide "brain" for clear structured folds, not blob). Thicker stroke for visual weight. */}
      <path d="M12 18V5" />
      <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
      <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
      <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
      <path d="M18 18a4 4 0 0 0 2-7.464" />
      <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
      <path d="M6 18a4 4 0 0 1-2-7.464" />
      <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
    </Icon>
  ),

  toolbar: (
    <Icon>
      {/* Toolbar: a wide bar with control dots */}
      <rect x="2" y="9" width="20" height="6" rx="2" />
      <circle cx="7" cy="12" r="0.8" fill="currentColor" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" />
      <circle cx="17" cy="12" r="0.8" fill="currentColor" />
    </Icon>
  ),

  "cache-miss-billing": (
    <Icon>
      {/* Receipt with a cache-miss marker. */}
      <path d="M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1 2-1V3Z" />
      <path d="M8 7h8" />
      <path d="M8 11h5" />
      <path d="m15 11 2 2 2-2" />
      <path d="m17 13V8" />
      <path d="M8 16h4" />
    </Icon>
  ),

  "message-delivery": (
    <Icon>
      {/* Send / paper plane */}
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4Z" />
    </Icon>
  ),

  "source-control": (
    <Icon>
      <circle cx="10" cy="10" r="6" />
      <path d="m14.5 14.5 5 5" />
      <path d="M7 10h6" />
    </Icon>
  ),

  storage: (
    <Icon>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
    </Icon>
  ),

  "agent-context": (
    <Icon>
      {/* Clipboard list (exact Lucide "clipboard-list" for clear notes/context) */}
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
    </Icon>
  ),

  notifications: (
    <Icon>
      {/* Bell */}
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </Icon>
  ),

  webhooks: (
    <Icon>
      {/* Webhook (exact Lucide "webhook" icon for recognizability + proper curves) */}
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </Icon>
  ),

  devices: (
    <Icon>
      {/* Mobile phone */}
      <rect x="7" y="2" width="10" height="20" rx="2" ry="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </Icon>
  ),

  "computer-control": (
    <Icon>
      <rect x="2" y="3" width="17" height="12" rx="2" />
      <path d="M7 20h6m-3-5v5" />
      <path d="m15 10 7 5-3 1-1 3z" fill="currentColor" />
    </Icon>
  ),

  "local-access": (
    <Icon>
      {/* Lock with properly transparency-keyed keyhole (evenodd punches hole) */}
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      <path
        d="M5 11h14v11H5V11z M10.5 15a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0z M11.25 17.5h1.5v3h-1.5z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </Icon>
  ),

  remote: (
    <Icon>
      {/* Globe */}
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18" />
      <path d="M3 12h18" />
      <path d="M5.5 7.5c2.5 1 11 1 13 0" />
      <path d="M5.5 16.5c2.5-1 11-1 13 0" />
    </Icon>
  ),

  providers: (
    <Icon>
      {/* Electrical plug */}
      <rect x="6" y="8" width="12" height="6" rx="1" />
      <line x1="9" y1="8" x2="9" y2="3" />
      <line x1="15" y1="8" x2="15" y2="3" />
      <path d="M12 14v5" />
      <path d="M8 19h8" />
    </Icon>
  ),

  speech: (
    <Icon>
      {/* Microphone */}
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <path d="M8 23h8" />
    </Icon>
  ),

  "remote-executors": (
    <Icon>
      {/* Desktop / monitor */}
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </Icon>
  ),

  environment: (
    <Icon>
      {/* Terminal: an env/config console with a prompt chevron + line */}
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 9l3 3-3 3" />
      <line x1="12" y1="15" x2="17" y2="15" />
    </Icon>
  ),

  about: (
    <Icon>
      {/* Info (exact Lucide "info" for clear "i" glyph) */}
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </Icon>
  ),

  emulator: (
    <Icon>
      {/* Robot head */}
      <rect x="5" y="6" width="14" height="10" rx="2" />
      <circle cx="9" cy="10" r="1.4" fill="currentColor" />
      <circle cx="15" cy="10" r="1.4" fill="currentColor" />
      <path d="M8 14h8" />
      <line x1="7" y1="6" x2="5" y2="3" />
      <line x1="17" y1="6" x2="19" y2="3" />
      <circle cx="5" cy="3" r="0.8" fill="currentColor" />
      <circle cx="19" cy="3" r="0.8" fill="currentColor" />
    </Icon>
  ),

  development: (
    <Icon>
      {/* Tools / crossed wrench + screwdriver simplified */}
      <path d="M14.5 6.5l3 3-7 7-3-3 7-7z" />
      <path d="M17 3l4 4M3 17l4 4" />
      <path d="M10 14l-1.5 1.5" />
      <circle cx="18" cy="6" r="1.5" fill="currentColor" />
    </Icon>
  ),
};

export function SettingsCategoryIcon({ id }: { id: string }) {
  const { settingsIconStyle } = useSettingsIconStyle();
  const icon =
    settingsIconStyle === "emoji"
      ? settingsCategoryEmojiIcons[id]
      : settingsCategoryIcons[id];
  if (!icon) return null;
  const className = [
    "settings-category-icon",
    `settings-category-icon-${id}`,
    `settings-category-icon-${settingsIconStyle}`,
  ].join(" ");
  return (
    <span className={className} aria-hidden="true">
      {icon}
    </span>
  );
}
