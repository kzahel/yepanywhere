// The writer and SQLite observer are in the driver. They keep running even
// if the isolated server's event loop is busy or its watcher misses a write.
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { catalogFileVersion } from "../../packages/server/src/sessions/catalog-adapters/row.ts";

export async function replayFreshness({
  fixture,
  row,
  get,
  snapshot,
  result,
  rawHints,
}) {
  const s = fixture.active[0];
  const owner = Buffer.from(s.project).toString("base64url");
  const hint = () => get("/__mixed_freshness_hint", "POST");
  result.writes = {};
  for (const [label, number, spacing] of [
    ["first-append", 1, 0],
    ["repeat-append", 1, 0],
    ["spaced-appends", 12, 500],
    ["streaming-appends", 60, 100],
  ]) {
    await snapshot("before-" + label);
    const started = Date.now();
    const observed = new Set();
    const versions = new Set();
    let lastWrite,
      maxInterWriteMs = 0;
    for (let i = 0; i < number; i++) {
      if (i) await delay(Math.max(0, started + i * spacing - Date.now()));
      const accepted = row(s);
      assert.equal(accepted.project_id, owner);
      if (versions.has(accepted.source_version))
        observed.add(accepted.source_version);
      const at = Date.now();
      if (lastWrite !== undefined)
        maxInterWriteMs = Math.max(maxInterWriteMs, at - lastWrite);
      lastWrite = at;
      fixture.append(s);
      versions.add(catalogFileVersion(statSync(s.file)));
      if (rawHints) assert.equal((await hint()).delivered, true);
    }
    const expected = catalogFileVersion(statSync(s.file));
    const matches = () => row(s)?.source_version === expected;
    async function wait(ms) {
      const until = Date.now() + ms;
      while (!matches() && Date.now() < until) await delay(40);
      return matches();
    }
    const sample = {
      number,
      writeStart: started,
      maxInterWriteMs,
      writeSpanMs: lastWrite - started,
      versionsSeenBeforeLastWrite: observed.size,
      settledWithoutRescue: await wait(12000),
    };
    result.writes[label] = sample;
    if (!sample.settledWithoutRescue) {
      await snapshot(label + "-before-rescue");
      assert.equal((await hint()).delivered, true);
      assert(
        await wait(15000),
        "Exact-path diagnostic hint failed to settle " + label,
      );
    }
    sample.finalLagMs = Date.now() - lastWrite;
    await snapshot(label);
    assert.equal(row(s).project_id, owner);
  }
  const detail = await get("/api/projects/" + owner + "/sessions/" + s.id);
  assert.equal(detail.session.id, s.id);
  assert(
    JSON.stringify(detail.messages).includes(s.marker),
    "Final changed session detail",
  );
}
