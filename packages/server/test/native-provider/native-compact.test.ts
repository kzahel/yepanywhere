import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { nativeFixture } from "./fixture.js";
import { providers } from "./selection.js";

let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
afterEach(async (context) => {
  if (fixture && context.task.result?.state === "fail")
    console.info(
      JSON.stringify({
        provider: fixture.provider,
        state: fixture.proc.state,
        queue: fixture.proc.getDeferredQueueSummary(),
        requests: fixture.model.requests.map((r) => ({
          model: r.model,
          text: JSON.stringify(r.body.messages ?? r.body.input).slice(-2500),
          labels: ["COMPACT_ALPHA", "COMPACT_BRAVO"].filter((t) =>
            JSON.stringify(r.body).includes(t),
          ),
        })),
        events: fixture.events.slice(-8),
        diagnostics: fixture.diagnostics,
        failures: fixture.model.failures,
      }),
    );
  await fixture?.close();
  fixture = undefined;
});

if (providers.includes("pi"))
  it("Pi's real small-session refusal holds later input until the failed compact is cancelled", async () => {
    const f = await nativeFixture("pi");
    fixture = f;
    const initial = await f.model.next();
    expect(
      f.proc.deferMessage({
        text: "/compact",
        tempId: "compact",
        queuedCompact: { command: "compact", argument: "" },
      }).success,
    ).toBe(true);
    expect(
      f.proc.deferMessage({ text: "AFTER_REFUSED_COMPACT", tempId: "follow" })
        .success,
    ).toBe(true);
    const refused = new Promise<void>((resolve) => {
      const off = f.proc.subscribe(() => {
        if (
          f.proc.getDeferredQueueSummary()[0]?.compactionGate?.state ===
          "failed"
        ) {
          off();
          resolve();
        }
      });
    });
    initial.finish("TOO_SMALL_TO_COMPACT");
    await refused;
    expect(f.model.requests).toHaveLength(1);
    expect(f.proc.getDeferredQueueSummary()[0]?.compactionGate).toMatchObject({
      state: "failed",
      reason: "Nothing to compact (session too small)",
    });
    expect(f.proc.cancelDeferredMessage("compact")).toBe(true);
    const follow = await f.model.next();
    expect(JSON.stringify(follow.body).includes("AFTER_REFUSED_COMPACT")).toBe(
      true,
    );
    follow.finish("FOLLOWING_INPUT_RECOVERED");
    await f.output("FOLLOWING_INPUT_RECOVERED");
    await f.idle();
    expect(f.proc.getDeferredQueueSummary()).toEqual([]);
    await f.close();
    expect(f.diagnostics).toEqual([]);
    expect(f.errors).toEqual([]);
    expect(f.model.failures).toEqual([]);
  });

if (providers.includes("pi"))
  it.each(["refused", "aborted"] as const)(
    "Pi compact %s never releases following input on guessed completion",
    async (outcome) => {
      const f = await nativeFixture("pi", "gentle", { piKeepRecentTokens: 0 });
      fixture = f;
      const initial = await f.model.next();
      f.proc.deferMessage({
        text: "/compact",
        tempId: "compact",
        queuedCompact: { command: "compact", argument: "" },
      });
      f.proc.deferMessage({ text: "AFTER_FAILED_COMPACT", tempId: "follow" });
      initial.finish("BEFORE_COMPACT_FAILURE " + "Owned context. ".repeat(200));
      const summary = await f.model.next();
      if (outcome === "aborted") {
        expect(await f.proc.interrupt()).toBe(false);
        await f.stop();
        await summary.cancelled;
        expect(await f.commandResult).toMatchObject({
          handled: true,
          uncertain: true,
        });
      } else {
        const failed = new Promise<void>((resolve) => {
          const off = f.proc.subscribe(() => {
            if (
              f.proc.getDeferredQueueSummary()[0]?.compactionGate?.state ===
              "failed"
            ) {
              off();
              resolve();
            }
          });
        });
        summary.fail(400, "OWNED_COMPACT_REFUSAL");
        await failed;
        expect(await f.commandResult).toMatchObject({
          handled: true,
          error: expect.stringContaining("OWNED_COMPACT_REFUSAL"),
        });
        expect(f.proc.getDeferredQueueSummary()).toHaveLength(2);
        expect(f.model.requests).toHaveLength(2);
        expect(f.proc.cancelDeferredMessage("compact")).toBe(true);
        const follow = await f.model.next();
        expect(JSON.stringify(follow.body)).toContain("AFTER_FAILED_COMPACT");
        follow.finish("COMPACT_FAILURE_RECOVERED");
        await f.output("COMPACT_FAILURE_RECOVERED");
        await f.idle();
      }
      expect(f.model.requests).toHaveLength(outcome === "aborted" ? 2 : 3);
      await f.close();
      expect(f.errors).toEqual([]);
      expect(f.diagnostics).toEqual([]);
      expect(f.model.failures).toEqual([]);
    },
  );

describe.each(providers.filter((p) => ["claude", "codex", "pi"].includes(p)))(
  "native queued compact: %s",
  (provider) => {
    it("holds A and B until actual compaction completes, then sends separate turns", async () => {
      const f = await nativeFixture(provider, "gentle", {
        piKeepRecentTokens: 0,
      });
      fixture = f;
      const initial = await f.model.next();
      expect(
        f.proc.deferMessage({
          text: "/compact preserve fixture facts",
          tempId: "compact",
          queuedCompact: {
            command: "compact",
            argument: "preserve fixture facts",
          },
        }).success,
      ).toBe(true);
      expect(
        f.proc.deferMessage({ text: "COMPACT_ALPHA", tempId: "compact-a" })
          .success,
      ).toBe(true);
      expect(
        f.proc.deferMessage({ text: "COMPACT_BRAVO", tempId: "compact-b" })
          .success,
      ).toBe(true);
      initial.finish("BEFORE_COMPACTION " + "Owned context. ".repeat(200));
      const summary = await f.model.next();
      expect(JSON.stringify(summary.body).includes("COMPACT_ALPHA")).toBe(
        false,
      );
      expect(JSON.stringify(summary.body).includes("COMPACT_BRAVO")).toBe(
        false,
      );
      expect(f.proc.getDeferredQueueSummary()).toHaveLength(3);
      expect(f.proc.cancelDeferredMessage("compact")).toBe(false);
      summary.finish(
        provider === "claude"
          ? "<analysis>Preserve fixture facts.</analysis><summary>NATIVE_COMPACTION_SUMMARY</summary>"
          : "NATIVE_COMPACTION_SUMMARY",
      );
      if (provider === "pi") {
        expect(await f.commandResult).toMatchObject({ handled: true });
        const source = await f.source();
        const rows = (await readFile(source.filePath!, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          rows.some(
            (row) =>
              row.type === "compaction" &&
              row.summary.includes("NATIVE_COMPACTION_SUMMARY"),
          ),
        ).toBe(true);
      }
      const a = await f.model.next();
      expect(JSON.stringify(a.body).includes("COMPACT_ALPHA")).toBe(true);
      expect(JSON.stringify(a.body).includes("COMPACT_BRAVO")).toBe(false);
      a.finish("POST_COMPACT_ALPHA_DONE");
      const b = await f.model.next();
      expect(JSON.stringify(b.body).includes("COMPACT_BRAVO")).toBe(true);
      b.finish("POST_COMPACT_BRAVO_DONE");
      await f.output("POST_COMPACT_BRAVO_DONE");
      await f.idle();
      expect(f.proc.getDeferredQueueSummary()).toEqual([]);
      if (provider !== "pi")
        expect(
          f.events.some(
            (m) => m.type === "system" && m.subtype === "compact_boundary",
          ),
        ).toBe(true);
      if (provider === "pi")
        expect(JSON.stringify(a.body)).toContain("NATIVE_COMPACTION_SUMMARY");
      await f.stop();
      const history = JSON.stringify(await f.history());
      expect(history.includes("COMPACT_ALPHA")).toBe(true);
      expect(history.includes("POST_COMPACT_BRAVO_DONE")).toBe(true);
      await f.close();
      expect(f.errors).toEqual([]);
      expect(f.events.filter((m) => m.type === "error")).toEqual([]);
      expect(f.diagnostics).toEqual([]);
      expect(f.model.failures).toEqual([]);
    });
  },
);
