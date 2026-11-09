import type { CSSProperties } from "react";
import type { SpecimenMeta } from "../../../design/specimen";
import { Spinner } from "./Spinner";

export default {
  title: "Controls/Spinner",
  component: Spinner,
  parameters: {
    layer: "control",
    description:
      "Spinner from components/ui/Spinner.tsx: the one rotating busy ring, in the current text color. Decorative unless given a label (then role=status).",
  },
} satisfies SpecimenMeta;

const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-4)",
};

export function Sizes() {
  return (
    <div style={row}>
      <Spinner size="small" />
      <Spinner />
      <Spinner size="large" label="Loading" />
      <span style={{ color: "var(--text-muted)" }}>
        <Spinner size="small" /> Loading agent content…
      </span>
      <span style={{ color: "var(--error-color)" }}>
        <Spinner /> Inherits color
      </span>
    </div>
  );
}
