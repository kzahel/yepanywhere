import type { SpecimenMeta } from "../specimen";
import allowlist from "./token-literal-allowlist.json";
import styles from "./Census.module.css";
import { AllowanceGroup } from "./censusParts";

export default {
  title: "Census/Token literals",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Module and inline type sizes and radii still allowed outside the token scale. Done means tokens cover ordinary UI values and only independent typography, fallback or measured geometry remains. pnpm tokens:check enforces the counted reasons; --record only lowers counts.",
  },
} satisfies SpecimenMeta;

export function Remaining() {
  return (
    <div className={styles.census}>
      <AllowanceGroup
        title="Type and radius values"
        element="font-size / font / border-radius (CSS or inline)"
        entries={allowlist}
        close="Adopt a suitable type/radius token when the semantic or measured constraint is resolved; keep independent output typography and CSS-free fallbacks only while required, and lower cleared counts."
      />
    </div>
  );
}
