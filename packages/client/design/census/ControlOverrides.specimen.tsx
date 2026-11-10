import type { SpecimenMeta } from "../specimen";
import allowlist from "./control-override-allowlist.json";
import styles from "./Census.module.css";
import { AllowanceGroup } from "./censusParts";

export default {
  title: "Census/Control overrides",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Caller classes and inline styles still allowed to override shared controls. Done means shared variants own every look and these counts reach zero. pnpm controls:check enforces the counted reasons; --record only lowers counts.",
  },
} satisfies SpecimenMeta;

export function Remaining() {
  return (
    <div className={styles.census}>
      <AllowanceGroup
        title="Button family"
        element="Button / IconButton / buttonClassName"
        entries={allowlist.buttons}
        close="Move the needed look into a shared variant or remove caller look styles, then lower the allowlist count to zero."
      />
      <AllowanceGroup
        title="Other shared controls"
        element="Shared control caller class / style"
        entries={allowlist.controls}
        close="Use the control's own variant or move the specialized content outside its surface, then lower the allowlist count to zero."
      />
    </div>
  );
}
