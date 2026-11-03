import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeFixture, nativeProviders } from "./fixture.js";

const fixtures: Awaited<ReturnType<typeof nativeFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});
const selected = process.env.YEP_NATIVE_TEST_PROVIDERS?.split(",") ?? [
  ...nativeProviders,
];
for (const provider of selected)
  if (!nativeProviders.includes(provider as "claude" | "codex"))
    throw Error(
      `Provider ${provider} has no qualified native local-model fixture; refusing a fake or paid fallback`,
    );
const providers = nativeProviders.filter((provider) =>
  selected.includes(provider),
);

// Real CLI startup, multiple controlled native turns, persistence and joined teardown.
// Eight cases took 1.97-4.16s total on the capture Mac. Use the runner default
// budget until slower CI measurements justify an override (test-time-budgets.md).
describe.each(providers)("real native provider: %s", (provider) => {
  it("YA Queue delivers A then B in separate turns and retains native history", async () => {
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
    a.finish("ALPHA_DONE");
    const b = await f.model.next();
    expect(JSON.stringify(b.body)).toContain("QUEUE_BRAVO");
    b.finish("BRAVO_DONE");
    await f.idle();
    expect(f.model.requests).toHaveLength(3);
    expect(f.proc.getDeferredQueueSummary()).toEqual([]);
    expect(JSON.stringify(f.events)).toContain("ALPHA_DONE");
    expect(JSON.stringify(f.events)).toContain("BRAVO_DONE");
    const native = JSON.stringify(await f.nativeRows());
    expect(native).toContain("QUEUE_ALPHA");
    expect(native).toContain("QUEUE_BRAVO");
    expect(native).toContain("22222222-2222-4222-8222-222222222222");
    expect(native).toContain("33333333-3333-4333-8333-333333333333");
    await f.close();
    expect(f.model.failures).toEqual([]);
    expect(f.errors).toEqual([]);
  });
  it("executes a real tool and carries its result into the next native request", async () => {
    const f = await nativeFixture(provider);
    fixtures.push(f);
    const first = await f.model.next();
    expect(JSON.stringify(first.body)).not.toContain("OWNED_TOOL_CONTENT");
    if (provider === "claude")
      first.tool("Read", { file_path: join(f.project, "notes.txt") });
    else
      first.tool(
        "exec",
        `const result = await tools.exec_command({cmd: ${JSON.stringify(process.platform === "win32" ? "type notes.txt" : "cat notes.txt")}, workdir: ${JSON.stringify(f.project)}, max_output_tokens: 100}); text(result.output);`,
      );
    const afterTool = await f.model.next();
    expect(JSON.stringify(afterTool.body)).toContain("OWNED_TOOL_CONTENT");
    afterTool.finish("TOOL_DONE");
    await f.idle();
    expect(f.model.requests).toHaveLength(2);
    expect(JSON.stringify(f.events)).toContain("TOOL_DONE");
    expect(JSON.stringify(await f.nativeRows())).toContain(
      "OWNED_TOOL_CONTENT",
    );
    await f.close();
    expect(f.model.failures).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  it.each(["gentle", "immediate"] as const)(
    "native %s steering preserves correction input",
    async (mode) => {
      const f = await nativeFixture(provider, mode);
      fixtures.push(f);
      const original = await f.model.next();
      original.partial("PARTIAL_ORIGINAL");
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
          metadata: { deliveryIntent: "steer", steerNow: mode === "immediate" },
        }).success,
      ).toBe(true);
      if (mode === "gentle") {
        if (provider === "claude") {
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
      expect(JSON.stringify(await f.nativeRows())).toContain(
        "NATIVE_CORRECTION",
      );
      await f.close();
      expect(f.model.failures).toEqual([]);
      expect(f.errors).toEqual([]);
    },
  );
});
