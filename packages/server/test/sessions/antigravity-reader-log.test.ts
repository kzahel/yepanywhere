import {
  appendFile,
  mkdir,
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
import { ownAntigravitySession } from "../../src/sdk/providers/antigravity-owners.js";
import { AntigravitySessionReader } from "../../src/sessions/antigravity-reader.js";
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

  it("shares one fallback replay between requests for different windows", async () => {
    // A record with a field no observed agy writes: an unknown log.
    const conversations = await store("a", line({ step_index: 0, novel: 1 }));
    const shared = reader(conversations);
    const internals = shared as unknown as {
      resolveRuntimeForScope(): Promise<unknown>;
      withRuntime(): Promise<void>;
    };
    vi.spyOn(internals, "resolveRuntimeForScope").mockResolvedValue({});
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runtime = vi
      .spyOn(internals, "withRuntime")
      .mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
    const projectId = toUrlProjectId(project);
    const first = shared.getSession(ID, projectId, undefined, {
      tailCompactions: 2,
    });
    await entered.promise;
    // A catch-up from a stale live ID needs the same replay. Hold the first
    // replay until the second request has reached the fallback.
    const fallback = vi.spyOn(
      shared as unknown as { loadTranscriptEntries(): Promise<unknown> },
      "loadTranscriptEntries",
    );
    const second = shared.getSession(ID, projectId, `${ID}:3`, {
      tailCompactions: 2,
    });
    await vi.waitFor(() => expect(fallback).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    release.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(runtime).toHaveBeenCalledTimes(1);
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

  it("lets a still-admitted waiter retry a replay its first caller was refused", async () => {
    const conversations = await store("a", line({ step_index: 0, novel: 1 }));
    const shared = reader(conversations);
    const internals = shared as unknown as {
      resolveRuntimeForScope(): Promise<unknown>;
      withRuntime(): Promise<void>;
      metadata(id: string): Promise<{
        scope: string;
        cwd: string;
        sourceVersion: string;
      }>;
      loadTranscriptEntries(
        id: string,
        scope: string,
        cwd: string,
        version: string,
        enrich: boolean,
        beforeLoad: () => boolean,
      ): Promise<unknown>;
    };
    const release = Promise.withResolvers<void>();
    const resolving = vi
      .spyOn(internals, "resolveRuntimeForScope")
      .mockImplementation(async () => {
        await release.promise;
        return {};
      });
    const runtime = vi
      .spyOn(internals, "withRuntime")
      .mockResolvedValue(undefined);
    const { scope, cwd, sourceVersion } = await internals.metadata(ID);
    let firstAdmitted = true;
    const first = internals.loadTranscriptEntries(
      ID,
      scope,
      cwd,
      sourceVersion,
      false,
      () => firstAdmitted,
    );
    await vi.waitFor(() => expect(resolving).toHaveBeenCalledTimes(1));
    const second = internals.loadTranscriptEntries(
      ID,
      scope,
      cwd,
      sourceVersion,
      false,
      () => true,
    );
    // The first caller loses its lineage before its replay is admitted.
    firstAdmitted = false;
    release.resolve();
    expect(await first).toBeNull();
    expect(await second).not.toBeNull();
    expect(runtime).toHaveBeenCalledTimes(1);
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

  it("reads again when an owner resumes during a cold read, so its logged turn is not shown twice", async () => {
    const conversations = await store("a", logged);
    const scope = await realpath(conversations);
    const target = reader(conversations);
    const owner = ownAntigravitySession(scope, ID);
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

  it("shows a live tool call and its result once when the result arrives while a page is read", async () => {
    const conversations = await store("a", logged);
    const scope = await realpath(conversations);
    const target = reader(conversations);
    const owner = ownAntigravitySession(scope, ID);
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
          await target.getSession(ID, toUrlProjectId(project), `${ID}:step-0`, {
            tailCompactions: 2,
          }),
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
});
