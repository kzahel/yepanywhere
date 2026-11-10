import type { SpecimenMeta } from "../specimen";
import allowlist from "./button-base-allowlist.json";
import styles from "./Census.module.css";
import { AllowanceGroup } from "./censusParts";

export default {
  title: "Census/ButtonBase exceptions",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Rich or specialized ButtonBase targets still allowed to draw their own surface. Done means ordinary actions use Button or SelectableCard and only justified rich targets remain. pnpm buttons:check enforces the counted reasons; --record only lowers counts.",
  },
} satisfies SpecimenMeta;

export function Remaining() {
  return (
    <div className={styles.census}>
      <AllowanceGroup
        title="Hand-drawn surfaces"
        element="ButtonBase"
        entries={allowlist}
        close="Qualify a shared Button, link or SelectableCard replacement against the measured rich interaction, then lower this count; keep a rich-target exception only while that boundary is necessary."
      />
    </div>
  );
}
