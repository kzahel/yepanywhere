import { afterEach, describe, expect, it } from "vitest";
import { providers } from "./selection.js";
import { readOwnedFile } from "./actions.js";
import { nativeFixture } from "./fixture.js";

const fixtures: Awaited<ReturnType<typeof nativeFixture>>[] = [];
afterEach(async (context) => {
  if (context.task.result?.state === "fail")
    for (const f of fixtures)
      console.info(
        JSON.stringify(
          {
            provider: f.provider,
            state: f.proc.state,
            requests: f.model.requests.map((r) => ({
              model: r.model,
              messages: Array.isArray(r.body.messages)
                ? r.body.messages.map((m) => JSON.stringify(m).slice(0, 800))
                : undefined,
              input: Array.isArray(r.body.input)
                ? r.body.input
                    .slice(-5)
                    .map((item) => JSON.stringify(item).slice(0, 1200))
                : undefined,
              labels: [
                "INITIAL_NATIVE_INPUT",
                "QUEUE_ALPHA",
                "QUEUE_BRAVO",
              ].filter((label) => JSON.stringify(r.body).includes(label)),
            })),
            events: f.events.slice(-20).map((m) => ({
              type: m.type,
              subtype: m.subtype,
              content: JSON.stringify(m.message?.content)?.slice(0, 200),
            })),
            errors: f.errors.map((e) => e.message),
            diagnostics: f.diagnostics,
          },
          null,
          2,
        ),
      );
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});
// Real CLI startup, multiple controlled native turns, persistence and joined teardown.
// Tool and queue assertions share one native startup; qualified steering
// remains separate. Keep per-provider measured budgets below.
describe.each(providers)("real native provider: %s", (provider) => {
  // Native startup plus three turns hit the runner's 5s bound for Antigravity
  // and OpenCode on the capture Mac (2026-11-04). Grok also hit 5s in
  // the full native matrix; its measured isolated work was 1.27s plus 2.01s
  // native stop. Keep semantic assertions; use 2x the observed 5s limit.
  it("YA Queue holds B through A’s real tool and persists separate turns", {
    timeout: ["antigravity", "opencode", "grok"].includes(provider)
      ? 10_000
      : 5_000,
  }, async () => {
    const f = await nativeFixture(provider);
    fixtures.push(f);
    const original = await f.model.next();
    expect(
      f.proc.deferMessage({
        text: "QUEUE_ALPHA",
        tempId: "qa",
        uuid: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(true);
    expect(
      f.proc.deferMessage({
        text: "QUEUE_BRAVO",
        tempId: "qb",
        uuid: "33333333-3333-4333-8333-333333333333",
      }).success,
    ).toBe(true);
    expect(f.model.requests).toHaveLength(1);
    original.finish("INITIAL_DONE");
    const a = await f.model.next();
    expect(JSON.stringify(a.body)).toContain("QUEUE_ALPHA");
    expect(JSON.stringify(a.body)).not.toContain("QUEUE_BRAVO");
    expect(f.proc.getDeferredQueueSummary()).toHaveLength(1);
    expect(JSON.stringify(a.body).includes("OWNED_TOOL_CONTENT")).toBe(false);
    readOwnedFile(provider, f.project, a);
    const afterTool = await f.model.next();
    expect(JSON.stringify(afterTool.body).includes("OWNED_TOOL_CONTENT")).toBe(
      true,
    );
    expect(JSON.stringify(afterTool.body).includes("QUEUE_BRAVO")).toBe(false);
    expect(f.proc.getDeferredQueueSummary()).toHaveLength(1);
    afterTool.finish("ALPHA_DONE");
    const b = await f.model.next();
    expect(JSON.stringify(b.body)).toContain("QUEUE_BRAVO");
    b.finish("BRAVO_DONE");
    await f.idle();
    expect(f.model.requests).toHaveLength(4);
    expect(f.proc.getDeferredQueueSummary()).toEqual([]);
    expect(JSON.stringify(f.events)).toContain("ALPHA_DONE");
    expect(JSON.stringify(f.events)).toContain("BRAVO_DONE");
    const retainsInputUuid =
      provider.startsWith("claude") || provider === "codex";
    if (retainsInputUuid || provider === "codex-oss") {
      const rows = await f.nativeRows();
      if (retainsInputUuid) {
        const native = JSON.stringify(rows);
        expect(native).toContain("QUEUE_ALPHA");
        expect(native).toContain("QUEUE_BRAVO");
        expect(native).toContain("22222222-2222-4222-8222-222222222222");
        expect(native).toContain("33333333-3333-4333-8333-333333333333");
      }
      if (provider.startsWith("codex")) {
        // A mismatched Process default used to reset queued native turns to
        // on-request/workspace-write despite the fixture's bypass launch.
        const contexts = (
          rows as Array<{ type: string; payload?: unknown }>
        ).filter((row) => row.type === "turn_context");
        expect(contexts.length).toBeGreaterThanOrEqual(3);
        for (const row of contexts)
          expect(row.payload).toMatchObject({
            approval_policy: "never",
            sandbox_policy: { type: "danger-full-access" },
          });
      }
    }
    await f.stop();
    const persisted = JSON.stringify(await f.history());
    expect(persisted).toContain("QUEUE_ALPHA");
    expect(persisted).toContain("QUEUE_BRAVO");
    expect(persisted.includes("OWNED_TOOL_CONTENT")).toBe(true);
    await f.close();
    expect(f.model.failures).toEqual([]);
    expect(f.errors).toEqual([]);
    expect(f.events.filter((m) => m.type === "error")).toEqual([]);
    expect(f.diagnostics).toEqual([]);
  });
  if (provider === "codex-oss")
    it("the first exec turn executes a real tool and carries its result into the next native request", async () => {
      const f = await nativeFixture(provider);
      fixtures.push(f);
      const first = await f.model.next();
      expect(JSON.stringify(first.body)).not.toContain("OWNED_TOOL_CONTENT");
      readOwnedFile(provider, f.project, first);
      const afterTool = await f.model.next();
      expect(JSON.stringify(afterTool.body)).toContain("OWNED_TOOL_CONTENT");
      afterTool.finish("TOOL_DONE");
      await f.idle();
      expect(f.model.requests).toHaveLength(2);
      expect(JSON.stringify(f.events)).toContain("TOOL_DONE");
      await f.stop();
      expect(JSON.stringify(await f.history())).toContain("OWNED_TOOL_CONTENT");
      await f.close();
      expect(f.model.failures).toEqual([]);
      expect(f.errors).toEqual([]);
      expect(f.events.filter((m) => m.type === "error")).toEqual([]);
      expect(f.diagnostics).toEqual([]);
    });

  if (
    ["claude", "codex", "claude-gateway", "claude-ollama", "grok"].includes(
      provider,
    )
  )
    it.each(
      provider === "grok"
        ? (["gentle"] as const)
        : (["gentle", "immediate"] as const),
    )("native %s steering preserves correction input", async (mode) => {
      const f = await nativeFixture(provider, mode);
      fixtures.push(f);
      const original = await f.model.next();
      original.partial("PARTIAL_ORIGINAL");
      // Grok's ACP runtime buffers assistant text until its native item ends.
      // Its open model request and acknowledged interject establish this boundary.
      if (provider !== "grok")
        await f.message(
          (message) =>
            (message.type === "stream_event" || message.type === "assistant") &&
            JSON.stringify(message).includes("PARTIAL_ORIGINAL"),
        );
      expect(
        f.proc.queueMessage({
          text: "NATIVE_CORRECTION",
          uuid: "44444444-4444-4444-8444-444444444444",
          tempId: "correction",
          metadata: {
            deliveryIntent: "steer",
            steerNow: mode === "immediate",
          },
        }).success,
      ).toBe(true);
      if (mode === "gentle") {
        if (provider.startsWith("claude")) {
          // Native receipt, not YA's optimistic echo or synchronous queue push.
          await f.message(
            (message) =>
              message.type === "command_lifecycle" &&
              message.command_uuid === "44444444-4444-4444-8444-444444444444" &&
              message.state === "queued",
          );
        } else expect(await f.steerAccepted).toBe(true);
        expect(f.model.requests).toHaveLength(1);
        original.finish("_ORIGINAL_DONE");
      } else await original.cancelled;
      const correction = await f.model.next();
      expect(JSON.stringify(correction.body)).toContain("NATIVE_CORRECTION");
      correction.finish("CORRECTION_DONE");
      await f.output("CORRECTION_DONE");
      await f.idle();
      expect(f.model.requests).toHaveLength(2);
      expect(JSON.stringify(f.events)).toContain("CORRECTION_DONE");
      await f.stop();
      expect(
        JSON.stringify(await f.history()).includes("NATIVE_CORRECTION"),
      ).toBe(true);
      await f.close();
      expect(f.model.failures).toEqual([]);
      expect(f.errors).toEqual([]);
      expect(f.events.filter((m) => m.type === "error")).toEqual([]);
      expect(f.diagnostics).toEqual([]);
    });
});
