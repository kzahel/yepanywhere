import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  type VocabularyCatalogMark,
  type VocabularyCatalogScan,
  VocabularyLearning,
} from "../../src/services/voice/VocabularyLearning.js";
import { VocabularyStore } from "../../src/services/voice/VocabularyStore.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

it("resumes automatic scans from the generation the last completed one read", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ya-vocabulary-changes-"));
  const store = new VocabularyStore(dataDir);
  const asked: (VocabularyCatalogMark | undefined)[] = [];
  let generation = 0;
  let fail = false;
  const learning = new VocabularyLearning(
    store,
    async function* (_cutoff: number, scan?: VocabularyCatalogScan) {
      asked.push(scan?.since);
      if (scan)
        scan.reached = { catalogEpoch: "e", catalogGeneration: ++generation };
      yield {
        key: "session",
        version: `v${generation}`,
        updatedAt: Date.now(),
        messages: async function* () {
          if (fail) throw new Error("unreadable");
          yield [
            {
              uuid: `m${generation}`,
              type: "user" as const,
              timestamp: new Date().toISOString(),
              content: `word${generation}`,
            },
          ];
        },
      };
    },
  );
  cleanup.push(async () => {
    await learning.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const scan = async (retrospective = false) => {
    learning.scan(retrospective);
    await learning.settled();
  };

  // Enabling scans the window in full; the next automatic scan reads changes.
  learning.configure({ enabled: true, biasing: false, hours: 24 });
  await learning.settled();
  await scan();
  expect(asked).toEqual([
    undefined,
    { catalogEpoch: "e", catalogGeneration: 1 },
  ]);

  // A failed scan does not move the mark, so its sessions are read again.
  fail = true;
  await scan();
  fail = false;
  await scan();
  expect(asked.slice(2)).toEqual([
    { catalogEpoch: "e", catalogGeneration: 2 },
    { catalogEpoch: "e", catalogGeneration: 2 },
  ]);

  // A retrospective scan, or a wider window, reads everything again.
  await scan(true);
  expect(asked.at(-1)).toBeUndefined();
  learning.configure({ enabled: true, biasing: false, hours: 48 });
  await scan();
  expect(asked.at(-1)).toBeUndefined();
  await scan();
  expect(asked.at(-1)).toEqual({ catalogEpoch: "e", catalogGeneration: 6 });
});
