import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityRuntime } from "../../src/sdk/providers/antigravity-runtime.js";
import { AntigravitySessionReader } from "../../src/sessions/antigravity-reader.js";
import { prepareQueuedCompaction } from "../../src/routes/session-input-admission.js";
import {
  antigravityLogLines,
  projectAntigravityLog,
} from "../../src/sessions/antigravity-log-projection.js";
import type { Message } from "../../src/supervisor/types.js";
import { compareProjectionWithReplay } from "../utils/antigravity-projection-compare.js";
import { nativeFixture } from "./fixture.js";
import { providers } from "./selection.js";

/** Size, modification time and SHA-256 of every file under a directory. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const info = await stat(path);
    const hash = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    files[relative(root, path)] = `${info.size} ${info.mtimeMs} ${hash}`;
  }
  return files;
}

let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const call = (name: string, args: Record<string, unknown>) => ({
  functionCall: { name, args },
});

describe.skipIf(!providers.includes("antigravity"))(
  "native Antigravity log projection",
  () => {
    it("projects the log as ACP replay shows the same conversation, plus what replay omits", async () => {
      const f = await nativeFixture("antigravity");
      fixture = f;
      const notes = join(f.project, "notes.txt");
      let request = await f.model.next();
      request.geminiParts([{ text: "FIRST_THOUGHT", thought: true }], false);
      request.partial("FIRST_TEXT ");
      request.geminiParts([call("read_file", { Path: notes })], true);
      request = await f.model.next();
      request.geminiParts(
        [
          call("run_command", {
            CommandLine: "echo PAIR_ONE_MARK",
            WaitMsBeforeAsync: 5000,
            toolSummary: "pair one",
          }),
          call("read_file", { Path: notes, StartLine: 1 }),
        ],
        true,
      );
      request = await f.model.next();
      request.finish("TURN_ONE_DONE");
      await f.idle();

      expect(f.proc.queueMessage({ text: "BACKGROUND_TURN" }).success).toBe(
        true,
      );
      request = await f.model.next();
      request.tool("run_command", {
        CommandLine: "sleep 1; echo BG_DONE_MARK",
        WaitMsBeforeAsync: 100,
        toolSummary: "background",
      });
      (await f.model.next()).finish("BG_LAUNCHED");
      const wake = await f.model.next();
      wake.finish("WAKE_REPLY");
      await f.output("WAKE_REPLY");
      await f.idle();

      expect(f.proc.queueMessage({ text: "CANCEL_TURN" }).success).toBe(true);
      request = await f.model.next();
      request.partial("CANCEL_PARTIAL ");
      await f.output("CANCEL_PARTIAL");
      await f.proc.interrupt();
      await request.cancelled;
      await f.idle();

      expect(f.proc.queueMessage({ text: "COMPACT_TURN" }).success).toBe(true);
      request = await f.model.next();
      const compact = {
        text: "/compact keep markers",
        tempId: "compact",
        queuedCompact: {
          command: "compact" as const,
          argument: "keep markers",
        },
      };
      expect(
        await prepareQueuedCompaction(f.proc, compact, "keep markers"),
      ).toBeUndefined();
      expect(f.proc.deferMessage(compact).success).toBe(true);
      request.finish("BEFORE_COMPACTION");
      (await f.model.next()).finish(
        "<analysis>a</analysis><summary>COMPACTION_SUMMARY_MARK</summary>",
      );
      (await f.model.next()).finish("COMPACTION_CONTINUE");
      expect(await f.commandResult).toMatchObject({ completion: "completed" });
      await f.idle();

      expect(f.proc.queueMessage({ text: "LAST_TURN" }).success).toBe(true);
      (await f.model.next()).finish("LAST_DONE");
      await f.output("LAST_DONE");
      await f.idle();
      await f.stop();
      const id = f.nativeId();
      const store = join(f.environment.GEMINI_HOME!, "antigravity-cli");

      // Viewing the stopped conversation reads its log: it starts no agy and
      // leaves every file in the store as it was.
      const before = await snapshot(store);
      const launches = vi.spyOn(AntigravityRuntime.prototype, "connect");
      const viewer = new AntigravitySessionReader({ projectPath: f.project });
      let viewed: Message[];
      try {
        const projectId = toUrlProjectId(f.project);
        const latest = await viewer.getSession(id, projectId, undefined, {
          tailCompactions: 1,
        });
        expect(latest?.readWindow).toMatchObject({
          kind: "log-page",
          omittedPrefix: true,
        });
        const messagesOf = (loaded: typeof latest) =>
          (loaded!.data.session as { messages: Message[] }).messages;
        const latestMessages = messagesOf(latest);
        expect(latestMessages[0]?.subtype).toBe("compact_boundary");
        const older = await viewer.getSession(id, projectId, undefined, {
          tailCompactions: 1,
          beforeMessageId: latestMessages[0]!.uuid,
        });
        expect(older?.readWindow).toMatchObject({ omittedPrefix: false });
        viewed = [...messagesOf(older), ...latestMessages];
        expect(await viewer.getLastAgentExcerpt(id)).toBe("LAST_DONE");
        expect(await viewer.getAgentMappings(id)).toEqual([]);
        expect(JSON.stringify(await f.history())).toContain("LAST_DONE");
      } finally {
        await viewer.close();
        launches.mockRestore();
      }
      expect(launches).not.toHaveBeenCalled();
      // YA's read-only SQLite open of the summaries index creates the empty
      // WAL and shared-memory files SQLite needs, as every listing already
      // did (gaps/antigravity-summaries-read-creates-sqlite-sidecars.md).
      // Nothing else in the store may differ.
      const afterView = await snapshot(store);
      const sidecars = [
        "conversation_summaries.db-wal",
        "conversation_summaries.db-shm",
      ];
      // A newly created WAL must be empty; then neither sidecar is compared.
      if (!(sidecars[0]! in before) && sidecars[0]! in afterView)
        expect(afterView[sidecars[0]!]).toMatch(/^0 /);
      for (const name of sidecars)
        if (!(name in before)) delete afterView[name];
      expect(afterView).toEqual(before);

      const projected = await projectAntigravityLog(
        antigravityLogLines(
          createReadStream(
            join(
              f.environment.GEMINI_HOME!,
              "antigravity-cli",
              "brain",
              id,
              ".system_generated",
              "logs",
              "transcript_full.jsonl",
            ),
          ),
        ),
        { conversationId: id, ownerLive: false },
      );
      if (projected.status !== "known") throw Error(projected.reason);
      expect(viewed).toEqual(projected.messages);
      const replayReader = new AntigravitySessionReader({
        projectPath: f.project,
        historySource: "acp-replay",
      });
      let replay: Message[];
      try {
        replay = (
          (await replayReader.getSession(id, toUrlProjectId(f.project)))!.data
            .session as { messages: Message[] }
        ).messages;
      } finally {
        await replayReader.close();
      }
      const compared = compareProjectionWithReplay(projected.messages, replay);
      expect(compared.mismatches).toEqual([]);
      expect(compared.replay.map((item) => item.kind)).toEqual([
        "user",
        "thinking",
        "text",
        "tool",
        "tool",
        "tool",
        "text",
        "user",
        "tool",
        "text",
        "user",
        "text",
        "user",
        "text",
        "user",
        "text",
        "user",
        "text",
      ]);

      // What only the projection has, each under its step's ID.
      const results = new Map(
        projected.messages.flatMap((message) =>
          Array.isArray(message.message?.content)
            ? message.message.content
                .filter((block) => block.type === "tool_result")
                .map((block) => [block.tool_use_id, String(block.content)])
            : [],
        ),
      );
      const calls = projected.messages.flatMap((message) =>
        Array.isArray(message.message?.content)
          ? message.message.content.filter((block) => block.type === "tool_use")
          : [],
      );
      expect(calls.map((call) => [call.name, call.id])).toEqual([
        ["read_file", `${id}:step-1:tool-0`],
        ["run_command", `${id}:step-3:tool-0`],
        ["read_file", `${id}:step-3:tool-1`],
        ["run_command", `${id}:step-8:tool-0`],
      ]);
      expect(calls.map((call) => results.get(String(call.id)))).toEqual([
        expect.stringContaining("OWNED_TOOL_CONTENT"),
        expect.stringContaining("PAIR_ONE_MARK"),
        expect.stringContaining("OWNED_TOOL_CONTENT"),
        expect.stringContaining("Tool is running as a background task"),
      ]);
      expect(projected.messages.some((m) => m.orphanedToolUseIds)).toBe(false);
      // The cancel shows one error on both versions: 1.5.14's planner error
      // is reported again by the ERROR_MESSAGE after it.
      expect(
        projected.messages
          .filter((message) => message.type === "error")
          .map((message) => message.uuid),
      ).toEqual([expect.stringMatching(new RegExp(`^${id}:step-\\d+$`))]);
      const others = projected.messages.filter(
        (message) => message.type === "system" || message.type === "error",
      );
      expect(
        others.map((message) => [
          message.type === "system" ? message.subtype : "error",
          String(
            message.compactSummaryText ??
              (message.details as string[] | undefined)?.[0] ??
              message.error,
          ),
        ]),
      ).toEqual(
        expect.arrayContaining([
          [
            "informational",
            expect.stringMatching(/^\[Message\].*finished with result:/s),
          ],
          ["error", expect.stringMatching(/./)],
          [
            "compact_boundary",
            expect.stringContaining("COMPACTION_SUMMARY_MARK"),
          ],
        ]),
      );
      for (const message of projected.messages) {
        expect(message.uuid).toMatch(new RegExp(`^${id}:step-\\d+(:|$)`));
        expect(message.session_id).toBe(id);
        expect(message.timestamp).toMatch(/Z$/);
      }
      expect(f.errors).toEqual([]);
      expect(f.model.failures).toEqual([]);
    }, 90_000);
  },
);
