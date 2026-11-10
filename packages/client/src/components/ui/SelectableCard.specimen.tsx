import { useState } from "react";
import type { SpecimenMeta } from "../../../design/specimen";
import { SelectableCard } from "./SelectableCard";

export default {
  title: "Patterns/Selectable card",
  component: SelectableCard,
  parameters: {
    layer: "pattern",
    description:
      "A rich whole-card action or selectable option; the surface owns its border, fill, padding and states.",
  },
} satisfies SpecimenMeta;

export function States() {
  const [selected, setSelected] = useState(false);
  return (
    <div style={{ display: "grid", gap: 8, width: "100%" }}>
      <SelectableCard
        selected={selected}
        onClick={() => setSelected(!selected)}
      >
        <strong>Selectable option</strong>
        <p>Click or press Space to change selection.</p>
      </SelectableCard>
      <SelectableCard>
        <strong>Open session</strong>
        <p>A rich action with a longer description that wraps on a phone.</p>
      </SelectableCard>
      <SelectableCard aria-current="page" size="compact">
        Current navigation row
      </SelectableCard>
      <SelectableCard size="compact">Compact navigation row</SelectableCard>
      <SelectableCard variant="quiet">
        Secondary connection option
      </SelectableCard>
      <SelectableCard variant="accent">Queued project action</SelectableCard>
      <SelectableCard disabled aria-busy="true">
        Connecting…
      </SelectableCard>
      <SelectableCard disabled>Unavailable action</SelectableCard>
    </div>
  );
}
