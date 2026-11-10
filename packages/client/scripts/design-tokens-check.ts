import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  checkTokenAllowlist,
  scanTokenLiterals,
  type TokenAllowlist,
} from "../design/tokenLiterals";
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
    "Usage: pnpm tokens:check [--record] [--json]\nReject non-token type sizes and radii in client modules and production TSX. --record only lowers counted, reasoned exceptions.",
  );
} else {
  const path = join(clientRoot, "design/census/token-literal-allowlist.json");
  const rows = await scanTokenLiterals(join(clientRoot, "src"));
  const allowlist = JSON.parse(await readFile(path, "utf8")) as TokenAllowlist;
  const { problems, next } = checkTokenAllowlist(
    rows,
    allowlist,
    values.record,
  );
  if (values.record && !problems.length)
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  const counts = {
    fonts: rows.filter((row) => /font/.test(row.property)).length,
    radii: rows.filter((row) => !/font/.test(row.property)).length,
    files: new Set(rows.map((row) => row.file)).size,
  };
  if (values.json)
    console.log(JSON.stringify({ counts, rows, problems }, null, 2));
  else {
    console.log(
      `Type/radius tokens: ${counts.fonts} type and ${counts.radii} radius exceptions in ${counts.files} files.`,
    );
    for (const problem of problems) console.error(problem);
  }
  if (problems.length) process.exitCode = 1;
}
