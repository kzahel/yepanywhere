import { openCensus } from "virtual:ya-design-data";
import type { SpecimenMeta } from "../specimen";
import styles from "./Census.module.css";
import { CensusRows } from "./censusParts";

export default {
  title: "Census/Composer",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Raw composer controls and counted overrides/literals still excluded from the shared-control sweep. Done means plan 182's composer pass replaces these controls and retires their rules. pnpm buttons:check enforces the boundary; the composer-file exemption remains until that pass.",
  },
} satisfies SpecimenMeta;

export function Remaining() {
  return (
    <div className={styles.census}>
      <p className={styles.intro}>
        {openCensus.composer.length} remaining raw-control and counted-debt
        rows. Raw controls with counted exceptions also appear on Element
        exceptions; composer-file exemptions are listed here even when no
        allowlist entry is needed.
      </p>
      <CensusRows rows={openCensus.composer} />
    </div>
  );
}
