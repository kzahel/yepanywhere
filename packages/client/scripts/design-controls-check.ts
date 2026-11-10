/** Shared controls own look and size; caller classes own layout (plan 191). */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  checkControlAllowlist,
  type ControlOverrideAllowlist,
} from "../design/controlOverrideAllowlist";
import {
  BUTTON_CONTROLS,
  scanControlOverrides,
} from "../design/controlOverrides";
import { clientRoot } from "./design-index";

const { values } = parseArgs({
  options: {
    record: { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "Usage: pnpm controls:check [--record] [--json]\nReject caller classes that set shared controls' look or size. Exceptions live in design/census/control-override-allowlist.json; --record only lowers counts and removes cleared entries, never adds an exception.",
  );
} else {
  const path = join(
    clientRoot,
    "design/census/control-override-allowlist.json",
  );
  const scan = await scanControlOverrides(join(clientRoot, "src"));
  const allowlist = JSON.parse(
    await readFile(path, "utf8"),
  ) as ControlOverrideAllowlist;
  const { problems, next } = checkControlAllowlist(
    scan.overrides,
    allowlist,
    values.record,
  );
  // Do not partially record when an unreviewed increase or invalid entry exists.
  if (values.record && !problems.length)
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  const buttons = scan.overrides.filter((row) =>
    BUTTON_CONTROLS.has(row.control),
  );
  if (values.json) console.log(JSON.stringify({ ...scan, problems }, null, 2));
  else {
    console.log(
      `Control ownership: ${buttons.length}/${scan.buttonUses} button-family uses in ${new Set(buttons.map((row) => row.file)).size} files; ${scan.overrides.length - buttons.length} other-control overrides. All remaining exceptions need counted reasons.`,
    );
    for (const problem of problems) console.error(problem);
  }
  if (problems.length) process.exitCode = 1;
}
