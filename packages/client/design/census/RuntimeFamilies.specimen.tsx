import { openCensus } from "virtual:ya-design-data";
import type { SpecimenMeta } from "../specimen";
import styles from "./Census.module.css";
import { CensusRows } from "./censusParts";

export default {
  title: "Census/Runtime class families",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Runtime and generated class families still allowed to keep global CSS alive. Done means authored owners use modules and only documented generated markup remains global. pnpm css:unused rejects invalid or stale families and runs in pnpm lint.",
  },
} satisfies SpecimenMeta;

export function Remaining() {
  return (
    <div className={styles.census}>
      <p className={styles.intro}>
        {openCensus.runtime.length} declared families against{" "}
        {openCensus.globalClasses} global classes. Each row counts its matches
        against that total; patterns may overlap. Generated markup is a
        deliberate continuing exception.
      </p>
      <CensusRows rows={openCensus.runtime} />
    </div>
  );
}
