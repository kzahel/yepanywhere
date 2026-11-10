// Read-only-copy parity probe. Pass only a task-owned copy to --source.
// --before-dist <dist> --after-dist <dist> --provider claude|codex
// --source <copied JSONL> --work <scratch> --label <unique>
// Replays three real prefixes, including unterminated lines, through the warm
// candidate owner. Compare each with a fresh full rebuild from the old reader.
import assert from "node:assert/strict";
import { readFile, writeFile, appendFile, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const args = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
    process.argv[2 + i * 2].replace(/^--/, ""),
    process.argv[3 + i * 2],
  ]),
);
assert(
  args.source &&
    args.work &&
    args.label &&
    args["before-dist"] &&
    args["after-dist"],
);
const out = resolve(args.work, args.label);
await mkdir(out, { recursive: false });
const file = join(out, "source.jsonl");
const bytes = await readFile(args.source),
  provider = args.provider ?? "claude";
const load = (build, name) =>
  import(pathToFileURL(resolve(args[build + "-dist"], name)).href);
const implementations = {};
for (const build of ["before", "after"]) {
  const { normalizeSession } = await load(build, "sessions/normalization.js");
  if (provider === "claude") {
    const { ClaudeTranscriptCache } = await load(
      build,
      "sessions/claude-transcript-cache.js",
    );
    const { buildSummaryFromState } = await load(
      build,
      "sessions/claude-summary.js",
    );
    implementations[build] = {
      normalizeSession,
      owner: () =>
        new ClaudeTranscriptCache({
          maxSourceBytes: build === "before" ? 0 : 192 * 1024 ** 2,
        }),
      read: async (owner) => {
        const snapshot = await owner.load(file);
        assert(snapshot);
        return {
          summary: buildSummaryFromState(snapshot.summaryState, {
            filePath: file,
            stats: snapshot.stats,
            sessionId: "copy",
            projectId: "copy",
          }),
          data: { provider: "claude", session: { messages: snapshot.entries } },
        };
      },
    };
  } else {
    const { CodexSessionReader } = await load(
      build,
      "sessions/codex-reader.js",
    );
    const head = JSON.parse(
      bytes.subarray(0, bytes.indexOf(10)).toString("utf8").trim(),
    );
    const id = head.payload.id;
    implementations[build] = {
      normalizeSession,
      owner: () => new CodexSessionReader({ sessionsDir: out }),
      read: async (owner) => {
        const snapshot = await owner.readEntries(id, file, {
          cache: build === "after",
        });
        const summary = await owner.buildSessionSummaryFromEntries(
          id,
          "copy",
          snapshot.entries,
          snapshot.transcriptSnapshotUpdatedAt,
        );
        assert(summary);
        return {
          summary,
          data: {
            provider: summary.provider,
            session: { entries: snapshot.entries },
          },
        };
      },
    };
  }
}
const digest = (session) => {
  const hash = createHash("sha256");
  for (const message of session.messages) hash.update(JSON.stringify(message));
  return { messages: session.messages.length, sha256: hash.digest("hex") };
};
const candidate = implementations.after.owner(),
  results = [];
let previous = 0;
try {
  for (const end of [
    Math.floor(bytes.length * 0.8),
    Math.floor(bytes.length * 0.9),
    bytes.length,
  ]) {
    await appendFile(file, bytes.subarray(previous, end));
    previous = end;
    const reference = implementations.before.owner();
    try {
      const actualLoaded = await implementations.after.read(candidate);
      const expectedLoaded = await implementations.before.read(reference);
      const actual = digest(
        implementations.after.normalizeSession(actualLoaded),
      );
      const expected = digest(
        implementations.before.normalizeSession(expectedLoaded),
      );
      assert.deepEqual(actual, expected, `Projection differs at byte ${end}`);
      assert.deepEqual(
        actualLoaded.summary,
        expectedLoaded.summary,
        `Summary differs at byte ${end}`,
      );
      results.push({ bytes: end, ...actual });
    } finally {
      await reference.close?.();
      reference.invalidate?.();
    }
    globalThis.gc?.();
  }
  await writeFile(
    join(out, "result.json"),
    JSON.stringify({ provider, sourceBytes: bytes.length, results }, null, 2),
  );
  console.log(JSON.stringify({ provider, results }));
} finally {
  await candidate.close?.();
  candidate.invalidate?.();
  await rm(file, { force: true });
}
