// Fetch the list APIs from two servers and diff them (plan 189 review gates
// for steps 5 and 7). Usage:
//   node scripts/compare-list-responses.mjs http://127.0.0.1:3417 http://127.0.0.1:3418 [out.json]
// Volatile fields (catalog generation/epoch, server clocks) are normalized;
// everything else must match. Request timings are recorded per side. Wait
// for both servers to finish warming up before a pass that counts: provider
// child relationships and the summary index fill in after startup.
import { writeFileSync } from "node:fs";

const [a, b, out] = process.argv.slice(2);
const headers = { "X-Yep-Anywhere": "true" };
const VOLATILE = new Set([
  "catalogGeneration",
  "catalogEpoch",
  "generation",
  "serverTime",
  "generatedAt",
  "now",
  "uptimeMs",
  "lastCheckedAt",
]);

async function get(base, path) {
  const started = performance.now();
  const response = await fetch(base + path, { headers });
  const text = await response.text();
  const ms = performance.now() - started;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, ms, bytes: text.length };
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value))
      result[key] = VOLATILE.has(key) ? "<volatile>" : normalize(item);
    return result;
  }
  return value;
}

const MAX_DIFFS = 40;

function diff(left, right, path = "", found = []) {
  if (found.length >= MAX_DIFFS) return found;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length)
      found.push({ path: `${path}.length`, a: left.length, b: right.length });
    for (let i = 0; i < Math.min(left.length, right.length); i++)
      diff(left[i], right[i], `${path}[${i}]`, found);
    return found;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
    const order =
      JSON.stringify(Object.keys(left)) === JSON.stringify(Object.keys(right));
    if (!order)
      found.push({
        path: `${path}{keys}`,
        a: Object.keys(left),
        b: Object.keys(right),
      });
    for (const key of keys)
      diff(left[key], right[key], `${path}.${key}`, found);
    return found;
  }
  if (JSON.stringify(left) !== JSON.stringify(right))
    found.push({ path, a: left, b: right });
  return found;
}

const short = (value) => {
  const text = JSON.stringify(value);
  return text && text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

const projects = (await get(a, "/api/projects")).body.projects ?? [];
const global = (await get(a, "/api/sessions?limit=100")).body.sessions ?? [];
const paths = [
  "/api/projects",
  "/api/sessions",
  "/api/sessions?includeStats=true",
  "/api/sessions?limit=100",
  "/api/sessions?includeArchived=true",
  "/api/sessions?starred=true",
  "/api/sessions?categorized=true",
  "/api/sessions?summaryMode=retained",
  "/api/sessions?summaryMode=retained&includeArchived=true",
  "/api/sessions/stats",
  "/api/inbox",
  "/api/inbox?summaryMode=retained",
  "/api/recents",
  "/api/processes",
];
for (const project of projects) {
  const id = encodeURIComponent(project.id);
  paths.push(
    `/api/projects/${id}`,
    `/api/projects/${id}/sessions`,
    `/api/inbox?projectId=${id}`,
  );
}
for (const session of global.slice(0, 60))
  paths.push(
    `/api/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}/metadata`,
  );

const report = [];
let equal = 0;
for (const path of paths) {
  // Same moment on both sides: a session that changes between two requests
  // would otherwise differ.
  const [left, right] = await Promise.all([get(a, path), get(b, path)]);
  const found =
    left.status !== right.status
      ? [{ path: "status", a: left.status, b: right.status }]
      : diff(normalize(left.body), normalize(right.body));
  if (found.length === 0) equal++;
  report.push({
    path,
    status: left.status,
    msA: Math.round(left.ms),
    msB: Math.round(right.ms),
    bytes: left.bytes,
    diffs: found,
  });
}
const differing = report.filter((entry) => entry.diffs.length > 0);
console.log(
  `${equal}/${report.length} responses identical; ${differing.length} differ`,
);
for (const entry of differing.slice(0, 30)) {
  const capped =
    entry.diffs.length >= MAX_DIFFS ? ", capped: rest not compared" : "";
  console.log(
    `\n${entry.path} (${entry.status}, ${entry.diffs.length} diffs${capped})`,
  );
  for (const d of entry.diffs.slice(0, 8))
    console.log(`  ${d.path}: ${short(d.a)} | ${short(d.b)}`);
}
const statuses = {};
for (const entry of report)
  statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
const sum = (key) =>
  Math.round(report.reduce((total, entry) => total + entry[key], 0));
console.log("\nstatuses", statuses, "total ms A", sum("msA"), "B", sum("msB"));
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
