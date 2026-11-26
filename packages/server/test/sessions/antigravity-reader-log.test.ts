import {
  appendFile,
  mkdir,
  rename,
  stat,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAntigravityLiveLimitsForTests } from "../../src/sdk/providers/antigravity-live-projection.js";
import {
  antigravityWriteIsOwn,
  hostedAntigravityOwnerLink,
  ownAntigravitySession,
} from "../../src/sdk/providers/antigravity-owners.js";
import { HostedNativeOwnerSync } from "../../src/sdk/providers/hosted-native-owner.js";
import { AntigravitySessionReader } from "../../src/sessions/antigravity-reader.js";
import { ownHostedAntigravitySession } from "../utils/antigravity-hosted-owner.js";
import { writeAntigravitySummaries } from "../utils/antigravity-store.js";

const ID = "c0ffee00-0000-4000-8000-000000000197";
const at = "2026-11-22T08:00:00Z";
const line = (record: object) => `${JSON.stringify(record)}\n`;
const prompt = (text: string) =>
  line({
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: at,
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
  });
const reply = (step: number, content: string) =>
  line({
    step_index: step,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: at,
    content,
  });

let root: string;
let project: string;
const readers: AntigravitySessionReader[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ya-agy-reader-log-")));
  project = join(root, "project");
  await mkdir(project);
});
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

/** A store holding the conversation, with `log` as its brain log. */
async function store(name: string, log: string, title = "") {
  const dir = join(root, name);
  const conversations = join(dir, "conversations");
  const logs = join(dir, "brain", ID, ".system_generated", "logs");
  await mkdir(logs, { recursive: true });
  await writeAntigravitySummaries(dir, [{ id: ID, cwd: project, title }]);
  await writeFile(join(conversations, `${ID}.db`), "db");
  await writeFile(join(logs, "transcript_full.jsonl"), log);
  return conversations;
}

function reader(sessionsDir: string) {
  const created = new AntigravitySessionReader({
    projectPath: project,
    sessionsDir,
  });
  readers.push(created);
  return created;
}

const texts = (
  loaded: Awaited<ReturnType<AntigravitySessionReader["getSession"]>>,
) =>
  loaded?.data.session.messages.map(
    (message) =>
      (message as { message?: { content?: unknown } }).message?.content,
  );

describe("Antigravity reader over the log", () => {
  it("reports the context the last logged model call filled", async () => {
    const tokens = (step: number, input: number, cached: number) =>
      line({
        step_index: step,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: at,
        model: "gemini-4-neon-low",
        content: `REPLY_${step}`,
        input_tokens: input,
        cache_read_tokens: cached,
        output_tokens: 7,
      });
    const read = async (name: string, log: string) =>
      (
        await reader(await store(name, log)).getSession(
          ID,
          toUrlProjectId(project),
          undefined,
          { tailCompactions: 2 },
        )
      )?.summary.contextUsage;
    expect(await read("a", prompt("Ask") + reply(1, "NO"))).toBeUndefined();
    // A step that logged no tokens (a cancelled reply) leaves the last one.
    const log =
      prompt("Ask") +
      tokens(1, 11_177, 0) +
      tokens(2, 2_153, 113_019) +
      reply(3, "CANCELLED");
    expect(await read("b", log)).toEqual({
      inputTokens: 115_172,
      percentage: 12,
      contextWindow: 1_000_000,
      outputTokens: 7,
      cacheReadTokens: 113_019,
    });
  });

  it("never returns the old store's messages after its binding moves mid-read", async () => {
    const a = await store("a", prompt("Ask") + reply(1, "REPLY_FROM_A"));
    const b = await store("b", prompt("Ask") + reply(1, "REPLY_FROM_B"));
    const alias = join(root, "conversations");
    await symlink(a, alias);
    const rebound = reader(alias);
    const projectId = toUrlProjectId(project);
    const options = { tailCompactions: 2 };
    expect(
      texts(await rebound.getSession(ID, projectId, undefined, options)),
    ).toEqual(["Ask", "REPLY_FROM_A"]);
    // Move the binding after the log is read, before the result is published.
    const metadata = (
      rebound as unknown as { metadata(id: string): Promise<unknown> }
    ).metadata.bind(rebound);
    let calls = 0;
    vi.spyOn(
      rebound as unknown as { metadata(id: string): Promise<unknown> },
      "metadata",
    ).mockImplementation(async (id) => {
      if (++calls === 2) {
        await unlink(alias);
        await symlink(b, alias);
      }
      return metadata(id);
    });
    const held = await rebound.getSession(ID, projectId, undefined, options);
    expect(held).toBeNull();
    // The next read follows the new binding.
    expect(
      texts(await rebound.getSession(ID, projectId, undefined, options)),
    ).toEqual(["Ask", "REPLY_FROM_B"]);
  });

  it("shows one row for history it cannot read, and none for a conversation never prompted, starting no agy", async () => {
    vi.stubEnv("ANTIGRAVITY_ACP_PATH", join(root, "no-agy"));
    const projectId = toUrlProjectId(project);
    const notice = (gap: string) => [
      expect.objectContaining({
        type: "system",
        subtype: "informational",
        uuid: `${ID}:history-unavailable`,
        content: expect.stringContaining(gap),
      }),
    ];
    // A record with a field no observed agy writes: an unknown log, with
    // the reason behind the row.
    const unknown = reader(
      await store("unknown", prompt("Ask") + line({ step_index: 1, novel: 1 })),
    );
    for (const after of [undefined, `${ID}:history-unavailable`]) {
      const read = await unknown.getSession(ID, projectId, after, {
        tailCompactions: 2,
      });
      expect(read?.transcriptComplete).toBe(false);
      expect(read?.readWindow).toBeUndefined();
      expect(read?.data.session.messages).toEqual(
        notice("cannot read Antigravity's log"),
      );
      const [row] = (read?.data.session.messages ?? []) as Array<{
        details?: string[];
      }>;
      expect(row?.details).toEqual([expect.stringMatching(/^Why: .+\.$/)]);
    }
    // No log: the summaries index counts steps (or says nothing), so the
    // conversation was prompted and its history is gone.
    const missingAt = await store("missing", "");
    await rm(join(missingAt, "..", "brain"), { recursive: true });
    const missing = await reader(missingAt).getSession(ID, projectId);
    expect(missing?.transcriptComplete).toBe(false);
    expect(missing?.data.session.messages).toEqual(
      notice("log does not hold it"),
    );
    // A log recreated after it was lost starts at agy's next step.
    const late = await reader(
      await store(
        "late",
        prompt("Again").replace('"step_index":0', '"step_index":2') +
          reply(3, "Answer"),
      ),
    ).getSession(ID, projectId, undefined, { tailCompactions: 2 });
    expect(late?.transcriptComplete).toBe(false);
    expect(late?.data.session.messages.map((m) => m.uuid)).toEqual([
      `${ID}:history-unavailable`,
      `${ID}:step-2`,
      `${ID}:step-3:text`,
    ]);
    // Never prompted: `agy` counts 0 steps and wrote no log.
    const neverAt = await store("never", "");
    await rm(join(neverAt, "..", "brain"), { recursive: true });
    await writeAntigravitySummaries(join(neverAt, ".."), [
      { id: ID, cwd: project, stepCount: 0 },
    ]);
    const never = await reader(neverAt).getSession(ID, projectId);
    expect(never?.transcriptComplete).toBeUndefined();
    expect(never?.data.session.messages).toEqual([]);
  });

  it("titles an untitled summary from the log's first prompt, starting no agy", async () => {
    const conversations = await store(
      "a",
      prompt("FIRST_PROMPT_TITLE") + reply(1, "x"),
    );
    vi.stubEnv("ANTIGRAVITY_ACP_PATH", join(root, "no-agy"));
    const summary = await reader(conversations).getSessionSummary(
      ID,
      toUrlProjectId(project),
    );
    expect(summary?.title).toBe("FIRST_PROMPT_TITLE");
  });

  it("never titles a summary from a store whose binding moved during the read", async () => {
    const a = await store("a", prompt("TITLE_FROM_A") + reply(1, "x"));
    const b = await store("b", prompt("TITLE_FROM_B") + reply(1, "x"));
    const alias = join(root, "conversations");
    await symlink(a, alias);
    const rebound = reader(alias);
    const metadata = (
      rebound as unknown as { metadata(id: string): Promise<unknown> }
    ).metadata.bind(rebound);
    let calls = 0;
    vi.spyOn(
      rebound as unknown as { metadata(id: string): Promise<unknown> },
      "metadata",
    ).mockImplementation(async (id) => {
      if (++calls === 2) {
        await unlink(alias);
        await symlink(b, alias);
      }
      return metadata(id);
    });
    expect(
      await rebound.getSessionSummary(ID, toUrlProjectId(project)),
    ).toBeNull();
  });

  /** Holds the reader's next log read, once it has read, until it returns. */
  function duringNextLogRead(
    target: AntigravitySessionReader,
    during: () => Promise<void> | void,
  ) {
    const internals = target as unknown as {
      readLog(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.readLog.bind(target);
    let armed = true;
    return vi
      .spyOn(internals, "readLog")
      .mockImplementation(async (...args: unknown[]) => {
        const result = await original(...args);
        if (armed) {
          armed = false;
          await during();
        }
        return result;
      });
  }
  const uuids = (
    loaded: Awaited<ReturnType<AntigravitySessionReader["getSession"]>>,
  ) => loaded?.data.session.messages.map((message) => message.uuid);
  const logged = prompt("Ask") + reply(1, "Reply");
  const resumedAt = { step: 1, end: Buffer.byteLength(logged) };

  it("shows the log alone, never as complete, for a hosted owner this backend cannot read yet, and takes its writes as YA's", async () => {
    const conversations = await store("a", logged);
    const scope = await realpath(conversations);
    const target = reader(conversations);
    // A replacement backend before its worker reattached, or one whose
    // attach failed and whose worker the host has not reaped yet.
    const read = () =>
      target.getSession(ID, toUrlProjectId(project), undefined, {
        tailCompactions: 2,
      });
    // One this backend is launching has written nothing past the log yet.
    const launching = hostedAntigravityOwnerLink();
    launching.expect({ storageScope: scope, id: ID });
    expect((await read())?.transcriptComplete).toBeUndefined();
    launching.end("exited");
    const link = hostedAntigravityOwnerLink();
    link.expect({ storageScope: scope, id: ID }, true);
    try {
      const pending = await read();
      expect(uuids(pending)).toEqual([`${ID}:step-0`, `${ID}:step-1:text`]);
      expect(pending?.transcriptComplete).toBe(false);
      expect(antigravityWriteIsOwn(scope, ID, Date.now())).toBe(true);
    } finally {
      link.end("exited");
    }
    expect((await read())?.transcriptComplete).toBeUndefined();
    expect(antigravityWriteIsOwn(scope, ID, Date.now() - 1_000)).toBe(true);
    expect(antigravityWriteIsOwn(scope, ID, Date.now() + 60_000)).toBe(false);
  });

  it("falls back at once to the log, marked incomplete, when the worker does not answer its read", async () => {
    const conversations = await store("a", logged);
    const scope = await realpath(conversations);
    const target = reader(conversations);
    const link = hostedAntigravityOwnerLink();
    let reads = 0;
    // A worker stand-in that is connected but never answers.
    const sync = new HostedNativeOwnerSync(
      { cwd: project, hostedNativeOwner: link },
      () => {
        reads++;
        return new Promise(() => {});
      },
      () => {},
      () => false,
      50,
    );
    sync.observe({ kind: "snapshot", scope, id: ID, retired: [] });
    try {
      const started = performance.now();
      const loaded = await target.getSession(
        ID,
        toUrlProjectId(project),
        undefined,
        { tailCompactions: 2 },
      );
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(reads).toBe(1);
      expect(uuids(loaded)).toEqual([`${ID}:step-0`, `${ID}:step-1:text`]);
      expect(loaded?.transcriptComplete).toBe(false);
    } finally {
      sync.end("exited");
    }
  });

  // The same reads with the owner in this process and in a Provider Host
  // worker, whose view crosses as JSON (plan 195 step 9).
  describe.each([
    ["in this process", ownAntigravitySession],
    ["in a Provider Host worker", ownHostedAntigravitySession],
  ] as const)("with the owner %s", (_where, own) => {
    it("reads again when an owner resumes during a cold read, so its logged turn is not shown twice", async () => {
      const conversations = await store("a", logged);
      const scope = await realpath(conversations);
      const target = reader(conversations);
      const owner = own(scope, ID);
      try {
        duringNextLogRead(target, async () => {
          // The resumed owner opens and agy logs its prompt, read as cold.
          owner.open(resumedAt);
          owner.record({
            type: "user",
            uuid: "live-prompt",
            message: { role: "user", content: "Next" },
          });
          await appendFile(
            join(
              root,
              "a",
              "brain",
              ID,
              ".system_generated",
              "logs",
              "transcript_full.jsonl",
            ),
            line({
              step_index: 2,
              source: "USER_EXPLICIT",
              type: "USER_INPUT",
              status: "DONE",
              created_at: at,
              content: "<USER_REQUEST>\nNext\n</USER_REQUEST>",
            }),
          );
        });
        const loaded = await target.getSession(
          ID,
          toUrlProjectId(project),
          undefined,
          {
            tailCompactions: 2,
          },
        );
        expect(uuids(loaded)).toEqual([
          `${ID}:step-0`,
          `${ID}:step-1:text`,
          "live-prompt",
        ]);
      } finally {
        owner.release();
      }
      // Once the owner has gone, the log alone shows the turn, once.
      expect(
        texts(
          await target.getSession(ID, toUrlProjectId(project), undefined, {
            tailCompactions: 2,
          }),
        ),
      ).toEqual(["Ask", "Reply", "Next"]);
    });

    it("reads again when the owner moves a turn into the log during a read, losing and repeating nothing", async () => {
      const conversations = await store("a", logged);
      const scope = await realpath(conversations);
      const target = reader(conversations);
      const owner = own(scope, ID);
      let proven: ((boundary: typeof resumedAt) => void) | undefined;
      const live = owner.open(
        resumedAt,
        () => new Promise((resolve) => (proven = resolve)),
      );
      const turn = [
        {
          type: "user" as const,
          uuid: "live-prompt",
          message: { role: "user", content: "Next" },
        },
        {
          type: "assistant" as const,
          uuid: "live-reply",
          message: { role: "assistant", content: "Done" },
        },
      ];
      for (const row of turn) owner.record(row);
      const turnLog =
        line({
          step_index: 2,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: at,
          content: "<USER_REQUEST>\nNext\n</USER_REQUEST>",
        }) + reply(3, "Done");
      await appendFile(
        join(
          root,
          "a",
          "brain",
          ID,
          ".system_generated",
          "logs",
          "transcript_full.jsonl",
        ),
        turnLog,
      );
      // The next turn's prompt, a candidate the log proves.
      const seq = live.seq;
      owner.record({
        type: "user",
        uuid: "live-next",
        message: { role: "user", content: "Again" },
      });
      setAntigravityLiveLimitsForTests({ softRows: 1, splitAgeMs: 0 });
      try {
        // The read takes the log through the old boundary; then the turn
        // leaves memory for the log before it takes the owner's rows.
        duringNextLogRead(target, async () => {
          live.addCandidate({ seq, size: 0, at: 0 });
          proven!({ step: 3, end: Buffer.byteLength(logged + turnLog) });
          await new Promise((resolve) => setImmediate(resolve));
          expect(live.history().map((m) => m.uuid)).toEqual(["live-next"]);
        });
        const loaded = await target.getSession(
          ID,
          toUrlProjectId(project),
          undefined,
          { tailCompactions: 2 },
        );
        expect(uuids(loaded)).toEqual([
          `${ID}:step-0`,
          `${ID}:step-1:text`,
          `${ID}:step-2`,
          `${ID}:step-3:text`,
          "live-next",
        ]);
        expect(loaded?.transcriptComplete).not.toBe(false);
        const catchUp = (id: string) =>
          target.getSession(ID, toUrlProjectId(project), id, {
            tailCompactions: 2,
          });
        // A cursor on a row that left memory is not in the answer: a miss.
        expect(uuids(await catchUp("live-reply"))).not.toContain("live-reply");
        // A log cursor before the moved rows would cross rows a client may
        // hold under live IDs: a deliberate miss, though the page holds it.
        const crossing = await catchUp(`${ID}:step-1:text`);
        expect(crossing?.afterAnchor).toBe("missed");
        expect(uuids(crossing)).toContain(`${ID}:step-1:text`);
        // One after the moved rows, or on a live row, is incremental.
        expect(
          (await catchUp(`${ID}:step-3:text`))?.afterAnchor,
        ).toBeUndefined();
        expect(uuids(await catchUp("live-next"))).toEqual(["live-next"]);
      } finally {
        setAntigravityLiveLimitsForTests();
        owner.release();
      }
    });

    it("shows a live tool call and its result once when the result arrives while a page is read", async () => {
      const conversations = await store("a", logged);
      const scope = await realpath(conversations);
      const target = reader(conversations);
      const owner = own(scope, ID);
      owner.open(resumedAt);
      const call = {
        type: "assistant" as const,
        uuid: "live-call",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool-1", name: "read_file", input: {} },
          ],
        },
      };
      owner.record(call);
      try {
        duringNextLogRead(target, () => {
          owner.record({
            type: "user",
            uuid: "live-result",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tool-1", content: "done" },
              ],
            },
          });
        });
        const loaded = await target.getSession(
          ID,
          toUrlProjectId(project),
          undefined,
          {
            tailCompactions: 2,
          },
        );
        expect(uuids(loaded)).toEqual([
          `${ID}:step-0`,
          `${ID}:step-1:text`,
          "live-call",
          "live-result",
        ]);
        // A page before the live call is the log through the boundary.
        const older = await target.getSession(
          ID,
          toUrlProjectId(project),
          undefined,
          {
            tailCompactions: 2,
            beforeMessageId: "live-call",
          },
        );
        expect(uuids(older)).toEqual([
          `${ID}:step-0`,
          `${ID}:step-1:text`,
          "live-call",
          "live-result",
        ]);
        expect(older?.readWindow).toMatchObject({
          kind: "log-page",
          before: false,
        });
        // A page before a log row is the log alone.
        const logPage = await target.getSession(
          ID,
          toUrlProjectId(project),
          undefined,
          {
            tailCompactions: 2,
            beforeMessageId: `${ID}:step-1:text`,
          },
        );
        expect(uuids(logPage)).toEqual([`${ID}:step-0`]);
        expect(logPage?.readWindow).toMatchObject({
          kind: "log-page",
          before: true,
        });
        // A catch-up from a live row is the live rows; from a log row, the
        // log after it and the live rows.
        expect(
          uuids(
            await target.getSession(ID, toUrlProjectId(project), "live-call", {
              tailCompactions: 2,
            }),
          ),
        ).toEqual(["live-call", "live-result"]);
        expect(
          uuids(
            await target.getSession(
              ID,
              toUrlProjectId(project),
              `${ID}:step-0`,
              {
                tailCompactions: 2,
              },
            ),
          ),
        ).toEqual([
          `${ID}:step-0`,
          `${ID}:step-1:text`,
          "live-call",
          "live-result",
        ]);
      } finally {
        owner.release();
      }
    });

    it("reports the history before an open boundary as unavailable once the log is gone, for every request", async () => {
      const conversations = await store("a", logged);
      const scope = await realpath(conversations);
      const target = reader(conversations);
      const logFile = join(
        root,
        "a",
        "brain",
        ID,
        ".system_generated",
        "logs",
        "transcript_full.jsonl",
      );
      const projectId = toUrlProjectId(project);
      const requests: Array<[string | undefined, object]> = [
        [undefined, { tailCompactions: 2 }],
        [undefined, {}],
        [
          undefined,
          { tailCompactions: 2, beforeMessageId: `${ID}:step-1:text` },
        ],
        [undefined, { tailCompactions: 2, beforeMessageId: "live-prompt" }],
        [`${ID}:step-0`, { tailCompactions: 2 }],
        ["live-prompt", { tailCompactions: 2 }],
      ];
      const owner = own(scope, ID);
      owner.open(resumedAt);
      owner.record({
        type: "user",
        uuid: "live-prompt",
        message: { role: "user", content: "Next" },
      });
      try {
        // Intact: every form is complete.
        for (const [after, options] of requests)
          expect(
            (await target.getSession(ID, projectId, after, options))
              ?.transcriptComplete,
            JSON.stringify([after, options]),
          ).toBeUndefined();
        for (const damage of ["unlinked", "truncated"]) {
          if (damage === "unlinked") await rm(logFile);
          else await writeFile(logFile, prompt("Ask"));
          for (const [after, options] of requests) {
            const loaded = await target.getSession(
              ID,
              projectId,
              after,
              options,
            );
            const label = JSON.stringify([damage, after, options]);
            expect(loaded?.transcriptComplete, label).toBe(false);
            // One row says the earlier history cannot be shown; the owner's
            // rows are still served (a page before a log row is older than
            // all of them).
            const ids = uuids(loaded);
            expect(ids[0], label).toBe(`${ID}:history-unavailable`);
            if (
              "beforeMessageId" in options &&
              options.beforeMessageId !== "live-prompt"
            )
              expect(ids, label).toHaveLength(1);
            else expect(ids, label).toContain("live-prompt");
          }
        }
      } finally {
        owner.release();
      }
    });

    it("serves only the final owner's rows when the log was replaced on the last handoff", async () => {
      const conversations = await store("a", logged);
      const scope = await realpath(conversations);
      const target = reader(conversations);
      const logFile = join(
        root,
        "a",
        "brain",
        ID,
        ".system_generated",
        "logs",
        "transcript_full.jsonl",
      );
      let owner = own(scope, ID);
      owner.open(resumedAt);
      const internals = target as unknown as {
        readLog(...args: unknown[]): Promise<unknown>;
      };
      const original = internals.readLog.bind(target);
      let reads = 0;
      vi.spyOn(internals, "readLog").mockImplementation(async (...args) => {
        const result = await original(...args);
        reads++;
        owner.release();
        owner = own(scope, ID);
        let boundary: object = resumedAt;
        if (reads >= 4) {
          // A different file of the same shape, pinned by the final owner.
          const replacement = `${logFile}.next`;
          await writeFile(replacement, prompt("Asked") + reply(1, "Other"));
          await rename(replacement, logFile);
          const { dev, ino } = await stat(logFile);
          boundary = { ...resumedAt, dev, ino };
        }
        owner.open(boundary as typeof resumedAt);
        owner.record({
          type: "user",
          uuid: `live-${reads}`,
          message: { role: "user", content: `Live ${reads}` },
        });
        return result;
      });
      try {
        const loaded = await target.getSession(
          ID,
          toUrlProjectId(project),
          undefined,
          { tailCompactions: 2 },
        );
        expect(reads).toBe(4);
        expect(loaded?.transcriptComplete).toBe(false);
        // The old file's rows are not the final owner's history.
        expect(uuids(loaded)).toEqual([`${ID}:history-unavailable`, "live-4"]);
      } finally {
        owner.release();
      }
    });

    it("answers with the last read, marked incomplete, when the owner changes during every read", async () => {
      const conversations = await store("a", logged);
      const scope = await realpath(conversations);
      const target = reader(conversations);
      let owner = own(scope, ID);
      owner.open(resumedAt);
      const internals = target as unknown as {
        readLog(...args: unknown[]): Promise<unknown>;
      };
      const original = internals.readLog.bind(target);
      let reads = 0;
      vi.spyOn(internals, "readLog").mockImplementation(async (...args) => {
        const result = await original(...args);
        // A distinct owner, at the same boundary, after every read.
        reads++;
        owner.release();
        owner = own(scope, ID);
        owner.open(resumedAt);
        owner.record({
          type: "user",
          uuid: `live-${reads}`,
          message: { role: "user", content: `Live ${reads}` },
        });
        return result;
      });
      try {
        const loaded = await target.getSession(
          ID,
          toUrlProjectId(project),
          undefined,
          { tailCompactions: 2 },
        );
        expect(reads).toBeGreaterThan(1);
        expect(loaded?.transcriptComplete).toBe(false);
        expect(uuids(loaded)).toEqual([
          `${ID}:step-0`,
          `${ID}:step-1:text`,
          `live-${reads}`,
        ]);
      } finally {
        owner.release();
      }
    });
  });
});
