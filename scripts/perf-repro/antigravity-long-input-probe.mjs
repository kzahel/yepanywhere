// Plan 195 step 6 review round 3: where `agy` clips a long prompt in its
// brain log, on real `agy` with a scripted model. Run by hand from
// packages/server (no inference, no network, owned profile):
//   pnpm exec tsx --conditions source ../../scripts/perf-repro/antigravity-long-input-probe.mjs \
//     [--agy <path>] [--out <report.json>]
// For each prompt it reports the sent length (UTF-16 units, code points,
// UTF-8 bytes), the logged USER_INPUT content's length in the same units,
// whether the content is a prefix of the full wrapped request, and how the
// content ends (closing marker, metadata blocks).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bounded,
  createScope,
  defaultAgy,
  logsDir,
  makeProfile,
  nextRequest,
  sleep,
  startAgy,
  startModel,
  watchLog,
  now,
} from "./antigravity-probe-support.mjs";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const agy = option("agy") ?? defaultAgy();

const OPEN = "<USER_REQUEST>\n";
const CLOSE = "\n</USER_REQUEST>";
const units = (text) => ({
  utf16: text.length,
  codePoints: [...text].length,
  utf8: Buffer.byteLength(text, "utf8"),
});

/** A prompt of about `size` UTF-16 units, made of `unit` after a marker. */
const prompt = (name, unit, size) =>
  `${name} ${unit.repeat(Math.ceil(size / unit.length))}`.slice(0, size);

const CASES = [
  ["short", prompt("SHORT", "x", 200)],
  ["ascii-190000", prompt("A190", "x", 190_000)],
  ["ascii-192000", prompt("A192", "x", 192_000)],
  ["ascii-200000", prompt("A200", "x", 200_000)],
  ["ascii-262144", prompt("A256", "x", 262_144)],
  ["ascii-524288", prompt("A512", "x", 524_288)],
  ["two-byte-200000", prompt("E200", "é", 200_000)],
  ["three-byte-200000", prompt("U200", "€", 200_000)],
  ["astral-200000", prompt("S200", "😀", 200_000)],
  [
    "lines-262144",
    prompt("L256", "line of pasted text, with words\n", 262_144),
  ],
  ["file-reference", `@a.txt ${prompt("F256", "y", 262_144)}`],
  // A cut inside the closing marker, and inside the metadata after it.
  ["ascii-191980", prompt("A191980", "x", 191_980)],
  ["ascii-191900", prompt("A191900", "x", 191_900)],
];
const only = option("only");

async function probe() {
  const model = await startModel();
  const profile = makeProfile(model);
  const scope = createScope();
  const report = { agy, node: process.version, cases: [] };
  const t0 = now();
  const work = (async () => {
    const agent = await startAgy(scope, profile, { agy, t0 });
    report.agyVersion = agent.initialize()?.agentInfo?.version;
    const { sessionId: id } = await agent.runtime.call("session/new", {
      cwd: profile.project,
      mcpServers: [],
    });
    writeFileSync(join(profile.project, "a.txt"), "A_CONTENT\n");
    const log = watchLog(
      scope,
      join(logsDir(profile.store, id), "transcript_full.jsonl"),
      t0,
    );
    for (const [name, text] of CASES) {
      if (only && !only.split(",").includes(name)) continue;
      const start = log.seen.length;
      const turn = agent.runtime.call(
        "session/prompt",
        { sessionId: id, prompt: [{ type: "text", text }] },
        0,
      );
      (await nextRequest(model, name, 60_000)).finish(`${name}_DONE`);
      await bounded(turn, name, 60_000);
      await sleep(300);
      const input = log.seen
        .slice(start)
        .find((entry) => entry.type === "USER_INPUT");
      const content = String(input?.record.content ?? "");
      const wrapped = `${OPEN}${text}${CLOSE}`;
      const close = content.lastIndexOf(CLOSE);
      report.cases.push({
        name,
        sent: units(text),
        logged: units(content),
        lineBytes: input ? Buffer.byteLength(input.line, "utf8") : undefined,
        keys: input ? Object.keys(input.record) : undefined,
        // The content up to the request's end matches what was sent.
        prefixOfWrapped: wrapped.startsWith(
          close >= 0 ? content.slice(0, close + CLOSE.length) : content,
        ),
        clipped: close < 0,
        hasMetadata: content.includes("<ADDITIONAL_METADATA>"),
        hasSettings: content.includes("<USER_SETTINGS_CHANGE>"),
        endsWithReplacement: content.endsWith("�"),
        endsInSurrogate: /[\uD800-\uDBFF]$/.test(content),
        tail: JSON.stringify(content.slice(-60)),
        longTail: content.slice(-700),
        textUnitsKept:
          close >= 0 ? close - OPEN.length : content.length - OPEN.length,
      });
    }
    return report;
  })();
  work.catch(() => {});
  try {
    return await Promise.race([work, scope.failure]);
  } finally {
    try {
      await scope.close();
    } finally {
      await model.close();
      const { rmSync } = await import("node:fs");
      rmSync(profile.root, { recursive: true, force: true });
    }
  }
}

const report = await probe();
const out = option("out");
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
for (const entry of report.cases)
  console.log(
    entry.name,
    JSON.stringify({
      sent: entry.sent,
      logged: entry.logged,
      kept: entry.textUnitsKept,
      clipped: entry.clipped,
      prefix: entry.prefixOfWrapped,
      meta: entry.hasMetadata,
      tail: entry.tail,
    }),
  );
