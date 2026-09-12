/** Import an explicitly selected capture; never scans private provider history.
 * Usage: pnpm exec tsx packages/server/scripts/import-provider-capture.ts /absolute/config.json
 * See packages/server/test/fixtures/captured/README.md before publishing output.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const configSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  sessionId: z.string().min(1),
  nativeFile: z.string(),
  rawLog: z.string(),
  outputDirectory: z.string(),
  replacements: z.array(z.object({ from: z.string().min(1), to: z.string() })),
});

const config = configSchema.parse(
  JSON.parse(await readFile(resolve(process.argv[2] ?? ""), "utf8")),
);
const parseLines = (text: string): Record<string, unknown>[] =>
  text
    .trim()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
const native = parseLines(await readFile(config.nativeFile, "utf8"));
const nativeOwner =
  config.provider === "claude"
    ? z.object({ sessionId: z.literal(config.sessionId) })
    : z.object({
        type: z.literal("session_meta"),
        payload: z.object({ id: z.literal(config.sessionId) }),
      });
if (!native.some((row) => nativeOwner.safeParse(row).success)) {
  throw new Error("Native transcript does not identify the selected session");
}
const raw = parseLines(await readFile(config.rawLog, "utf8"));
const selected = raw.filter(
  (row) => row._provider === config.provider && row._sid === config.sessionId,
);
if (!selected.length)
  throw new Error("No raw messages for the selected session");
// Strip only the logger envelope. Keep notification order, repeats and unknown
// provider variants; these files are evidence, not another normalization layer.
const live = selected.map((row) => {
  const { _ts, _sid, _provider, _rawSource, ...message } = row;
  return message;
});
const replacements = [...config.replacements].sort(
  (a, b) => b.from.length - a.from.length,
);
function replaceText(text: string): string {
  for (const { from, to } of replacements) text = text.split(from).join(to);
  return text;
}
function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    return replaceText(value);
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      // Native file-change maps can use absolute paths as dictionary keys.
      Object.entries(value).map(([key, item]) => [
        replaceText(key),
        sanitize(item),
      ]),
    );
  }
  return value;
}
// A new output directory prevents accidental replacement of reviewed fixtures.
await mkdir(config.outputDirectory, { recursive: false });
for (const [name, rows] of [
  ["native", native],
  ["live", live],
] as const) {
  const text = rows.map((row) => JSON.stringify(sanitize(row))).join("\n");
  await writeFile(
    resolve(config.outputDirectory, `${name}.jsonl`),
    `${text}\n`,
  );
}
console.log(
  `Imported ${native.length} native records and ${live.length} live records. Review redactions and add a manifest before committing.`,
);
