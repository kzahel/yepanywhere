import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  captureProjectObservation,
  projectObservationCurrent,
} from "../../src/projects/project-discovery-observation.js";

it("empty/absent inputs are cheap negative evidence; unobserved nonempty roots cannot grant a lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-observation-"));
  try {
    const empty = join(root, "empty");
    await mkdir(empty);
    const scope = {
      claude: empty,
      codex: join(root, "missing"),
      gemini: null,
      metadata: null,
    };
    const proof = await captureProjectObservation(scope);
    expect(await projectObservationCurrent(proof, 0)).toBe("current");
    await writeFile(join(empty, "new.jsonl"), "{}");
    expect(await projectObservationCurrent(proof, 0)).toBe("changed");
    expect(
      await projectObservationCurrent(
        await captureProjectObservation(scope),
        0,
      ),
    ).toBe("unobserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("an observer acquired while negative evidence is checked cannot bless an earlier enumeration", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-observation-"));
  try {
    const proof = await captureProjectObservation({
      claude: join(root, "missing"),
      codex: null,
      gemini: null,
      metadata: null,
    });
    let reads = 0;
    expect(
      await projectObservationCurrent(proof, 0, () =>
        ++reads === 1 ? null : 2,
      ),
    ).toBe("changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
