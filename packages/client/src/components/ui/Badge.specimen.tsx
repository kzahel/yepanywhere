import type { CSSProperties } from "react";
import type { SpecimenMeta } from "../../../design/specimen";
import { Badge, type BadgeTone } from "./Badge";

export default {
  title: "Controls/Badge",
  component: Badge,
  parameters: {
    layer: "control",
    description:
      "Badge from components/ui/Badge.tsx: a short non-interactive label in six tones, soft or solid, tag or count shape, two sizes, optional mono.",
  },
} satisfies SpecimenMeta;

const TONES: readonly BadgeTone[] = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
  "accent",
];

const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2)",
};

const column: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

export function Palettes() {
  return (
    <div style={row}>
      <Badge
        palette={{
          color: "var(--provider-claude)",
          soft: "color-mix(in srgb, var(--provider-claude) 12%, transparent)",
        }}
      >
        Claude
      </Badge>
      <Badge
        palette={{
          color: "var(--thinking-color)",
          soft: "color-mix(in srgb, var(--thinking-color) 15%, transparent)",
        }}
      >
        Thinking
      </Badge>
      <Badge emphasis="solid" palette={{ color: "#8250df", onSolid: "#fff" }}>
        Merged
      </Badge>
      <Badge emphasis="solid" palette={{ color: "#1d4ed8", onSolid: "#fff" }}>
        Jira
      </Badge>
    </div>
  );
}

export function Tones() {
  return (
    <div style={column}>
      <div style={row}>
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </div>
      <div style={row}>
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone} emphasis="solid">
            {tone}
          </Badge>
        ))}
      </div>
    </div>
  );
}

export function SizesAndShapes() {
  return (
    <div style={column}>
      <div style={row}>
        <Badge>Default</Badge>
        <Badge size="small">Small</Badge>
        <Badge mono>Bash</Badge>
        <Badge tone="info" icon="●">
          Running
        </Badge>
      </div>
      <div style={row}>
        <Badge shape="count">3</Badge>
        <Badge shape="count" tone="danger" emphasis="solid">
          12
        </Badge>
        <Badge shape="count" size="small" tone="accent" emphasis="solid">
          1
        </Badge>
        <Badge shape="count" size="small">
          128
        </Badge>
      </div>
      <div style={{ fontSize: "var(--font-size-base)" }}>
        In text: session title <Badge tone="warning">Draft</Badge> and more text
        after it.
      </div>
    </div>
  );
}
