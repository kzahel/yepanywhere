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

describe.each(providers.filter((p) => ["claude", "codex"].includes(p)))(
  "native queued compact: %s",
  (provider) => {
    it("holds A and B until actual compaction completes, then sends separate turns", async () => {
      const f = await nativeFixture(provider);
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
      initial.finish("BEFORE_COMPACTION");
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
      expect(
        f.events.some(
          (m) => m.type === "system" && m.subtype === "compact_boundary",
        ),
      ).toBe(true);
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
