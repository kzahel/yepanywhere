import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLedger, findTimerSites } from "./check-timer-ownership.mjs";

const classes = (source) =>
  findTimerSites("packages/probe/src/probe.ts", source).map(
    (site) => site.class,
  );

for (const [name, source, expected] of [
  ["interval", "const id = setInterval(tick, 1000);", ["recurring"]],
  ["window interval", "window.setInterval(tick, 1000);", ["recurring"]],
  ["literal zero", "const id = setTimeout(run, 0);", ["yield"]],
  ["omitted delay", "rootWindow.setTimeout(run);", ["yield"]],
  [
    "promise sleep",
    "await new Promise((resolve) => setTimeout(resolve, 50));",
    ["sleep"],
  ],
  [
    "promise sleep in a block executor",
    "new Promise((resolve) => { setTimeout(() => resolve(1), 50); });",
    ["sleep"],
  ],
  [
    "promise zero is a yield",
    "await new Promise((resolve) => setTimeout(resolve, 0));",
    ["yield"],
  ],
  [
    "awaitable timer import",
    'import { setTimeout as delay } from "node:timers/promises";\nawait delay(50);\nawait delay(0);',
    ["sleep", "yield"],
  ],
  ["bare statement", "setTimeout(run, 50);", ["detached"]],
  [
    "unref does not keep the handle",
    "setTimeout(run, 50).unref();",
    ["detached"],
  ],
  ["void", "void setTimeout(run, 50);", ["detached"]],
  [
    "result-dropping callback",
    "items.forEach((item) => setTimeout(() => use(item), 50));",
    ["detached"],
  ],
  ["variable", "const timer = setTimeout(run, 50);", ["owned"]],
  [
    "assignment through unref",
    "(this.timer = setTimeout(run, 50)).unref();",
    ["owned"],
  ],
  [
    "wrapper call",
    "this.timer = runOutsideRequestContext(() => setTimeout(run, 50));",
    ["owned"],
  ],
  [
    "mapped handles",
    "timers = delays.map((ms) => setTimeout(run, ms));",
    ["owned"],
  ],
  ["returned", "function arm() { return setTimeout(run, 50); }", ["owned"]],
  [
    "deadline kept inside a promise",
    "new Promise((_, reject) => { const t = setTimeout(reject, 50); done(t); });",
    ["owned"],
  ],
  [
    "injected clock",
    "this.timers.setTimeout(run, 0); deps.setInterval(run, 5);",
    [],
  ],
  [
    "frame and immediate",
    "requestAnimationFrame(run); setImmediate(run);",
    ["frame", "immediate"],
  ],
]) {
  test(`classifies ${name}`, () => {
    assert.deepEqual(classes(source), expected);
  });
}

const site = (file, siteClass) => ({ file, class: siteClass });
const stops = "Cleared when its owner closes.";

test("accepts recorded counts and offers to lower a surplus", () => {
  const ledger = {
    recurring: { "a.ts": { count: 2, kind: "poll", stops } },
    yields: {},
    detached: {},
  };
  assert.deepEqual(checkLedger(ledger, [site("a.ts", "recurring")]), {
    errors: [],
    lowerable: [{ section: "recurring", file: "a.ts", count: 1, recorded: 2 }],
  });
});

for (const [name, ledger, sites, expected] of [
  [
    "an unrecorded file",
    { recurring: {} },
    [site("a.ts", "recurring")],
    /a\.ts: 1 recurring timer with no recurring entry/,
  ],
  [
    "growth past the recorded count",
    { detached: { "a.ts": { count: 1, reason: stops } } },
    [site("a.ts", "detached"), site("a.ts", "detached")],
    /a\.ts: 2 detached timers exceeds its recorded 1/,
  ],
  [
    "an entry without its note",
    { yields: { "a.ts": { count: 1, reason: "short" } } },
    [site("a.ts", "yield")],
    /a\.ts: yields entry needs "reason"/,
  ],
  [
    "an unknown recurring kind",
    { recurring: { "a.ts": { count: 1, kind: "timer", stops } } },
    [site("a.ts", "recurring")],
    /a\.ts: recurring "kind" must be one of/,
  ],
]) {
  test(`rejects ${name}`, () => {
    const { errors } = checkLedger(ledger, sites);
    assert.equal(errors.length, 1);
    assert.match(errors[0], expected);
  });
}
