import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [directory, expectedVersion] = process.argv.slice(2);
assert.ok(
  directory && expectedVersion,
  "Pass artifact directory and expected version",
);
const accepted = JSON.parse(
  readFileSync(join(directory, "acceptance.json"), "utf8"),
);
assert.equal(accepted.name, "yepanywhere");
assert.equal(accepted.version, expectedVersion);
if (process.env.GITHUB_SHA)
  assert.equal(
    accepted.sourceRevision,
    process.env.GITHUB_SHA,
    "Candidate was accepted from another source revision",
  );
assert.equal(
  accepted.release,
  true,
  "Production startup alone cannot qualify a release",
);
assert.equal(accepted.startup, "passed");
assert.deepEqual(accepted.providers.map(({ provider }) => provider).sort(), [
  "claude",
  "codex",
]);
assert.equal(accepted.tarball, "candidate.tgz");
assert.equal(
  createHash("sha256")
    .update(readFileSync(join(directory, accepted.tarball)))
    .digest("hex"),
  accepted.sha256,
  "Archive differs from the accepted candidate",
);
console.log(
  `Verified ${accepted.name}@${accepted.version}, SHA-256 ${accepted.sha256}`,
);
