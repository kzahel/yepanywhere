/** Owned-emulator acceptance matrix. Each child owns its server, relay and cleanup. */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

if (!/^emulator-\d+$/.test(process.env.ANDROID_SERIAL ?? ""))
  throw new Error(
    "Select the owned emulator with ANDROID_SERIAL; physical devices are refused",
  );
const smoke = [
  ["direct-session-read", "direct", "session", "in-flight"],
  ["mux-session-read", "mux", "session", "in-flight"],
  ["direct-inbox-disconnect", "direct", "inbox", "disconnect"],
  ["mux-inbox-outage", "mux", "inbox", "outage"],
  ["direct-session-wake", "direct", "session", "wake-outage"],
].map(([name, route, surface, fault]) => [
  name,
  "android",
  route,
  surface,
  fault,
  [],
]);
const hardening = ["android", "android-chrome"].flatMap((client) =>
  [
    ["cold-offline", "direct", "session", "process-death-offline", []],
    [
      "direct-silent",
      "direct",
      "session",
      "silent",
      ["--outage-ms=75000", "--steady-ms=30000"],
    ],
    ["mux-silent", "mux", "session", "silent", ["--outage-ms=75000"]],
    [
      "session-cycles",
      "direct",
      "session",
      "cycles",
      ["--cycles=8", "--sleep-ms=3000"],
    ],
    [
      "inbox-cycles",
      "mux",
      "inbox",
      "cycles",
      ["--cycles=8", "--sleep-ms=3000"],
    ],
    ["doze", "direct", "session", "doze", ["--sleep-ms=180000"]],
    [
      "attachment-wake",
      "direct",
      "session",
      "wake-outage",
      ["--attachment=true"],
    ],
  ].map(([name, route, surface, fault, extra]) => [
    `${client}-${name}`,
    client,
    route,
    surface,
    fault,
    [...extra, ...(client === "android-chrome" ? ["--chrome=stock"] : [])],
  ]),
);
const relayComparison = ["wake-outage", "relay-restart"].flatMap((fault) =>
  ["android", "android-chrome"].map((client) => [
    `${client}-${fault}`,
    client,
    "mux",
    "session",
    fault,
    client === "android-chrome" ? ["--chrome=stock"] : [],
  ]),
);
const push = ["notification", "notification-offline"].map((fault) => [
  fault,
  "android",
  "direct",
  "session",
  fault,
  [],
]);
push.push([
  "notification-offline-restart",
  "android",
  "direct",
  "session",
  "notification-offline",
  ["--restart-after-tap=true"],
]);
const suite = process.env.YA_LIFECYCLE_SUITE ?? "smoke";
const cases = { smoke, hardening, "relay-comparison": relayComparison, push }[
  suite
];
if (!cases)
  throw new Error(
    "Unknown YA_LIFECYCLE_SUITE; use smoke, hardening, relay-comparison or push",
  );
const selected = process.env.YA_LIFECYCLE_CASES?.split(",");
if (selected?.some((name) => !cases.some(([id]) => id === name)))
  throw new Error("Unknown YA_LIFECYCLE_CASES name");
const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const out = join(
  root,
  "tasks/source-lifecycle-study",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-android-acceptance`,
);
await mkdir(out, { recursive: true });
const results = [];
for (const [name, client, route, surface, fault, extra] of cases) {
  if (selected && !selected.includes(name)) continue;
  console.log(`Checking ${name}…`);
  const log = createWriteStream(join(out, `${name}.log`));
  const directory = join(out, name);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--conditions",
      "source",
      fileURLToPath(new URL("run.mjs", import.meta.url)),
      `--client=${client}`,
      `--route=${route}`,
      `--surface=${surface}`,
      `--fault=${fault}`,
      "--verify=true",
      `--out=${directory}`,
      ...extra,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const code = await new Promise((done, fail) => {
    child.once("error", fail);
    child.once("close", done);
  });
  log.end();
  await finished(log);
  const evidence = await readFile(join(directory, "result.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const result = {
    name,
    passed: code === 0 && evidence?.acceptance?.passed === true,
    failures: evidence?.acceptance?.failures ?? ["No completed result"],
    directory,
    recoveryMs: evidence?.firstHealthyAt
      ? evidence.firstHealthyAt - evidence.restoredAt
      : null,
  };
  results.push(result);
  console.log(
    `${result.passed ? "PASS" : "FAIL"} ${name}: ${result.failures.join("; ") || `${result.recoveryMs} ms to observed recovery`}`,
  );
  await writeFile(join(out, "matrix.json"), JSON.stringify(results, null, 2));
}
console.log(`Evidence: ${out}`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
