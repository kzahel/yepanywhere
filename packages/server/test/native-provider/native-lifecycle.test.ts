import { afterEach, describe, expect, it } from "vitest";
import { nativeFixture } from "./fixture.js";
import { readOwnedFile } from "./actions.js";
import { providers } from "./selection.js";

let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
afterEach(async (context) => {
  if (fixture && context.task.result?.state === "fail")
    console.info(
      JSON.stringify({
        provider: fixture.provider,
        state: fixture.proc.state,
        requests: fixture.model.requests.map((r) => ({
          model: r.model,
          labels: [
            "INITIAL_NATIVE_INPUT",
            "AFTER_MODEL_CHANGE",
            "CONTINUE_AFTER_CANCEL",
            "AFTER_COLD_RESTART",
          ].filter((label) => JSON.stringify(r.body).includes(label)),
        })),
        events: fixture.events.slice(-10).map((m) => ({
          type: m.type,
          subtype: m.subtype,
          text: JSON.stringify(m.message?.content)?.slice(0, 200),
        })),
        errors: fixture.errors.map((e) => e.message),
        diagnostics: fixture.diagnostics,
      }),
    );
  await fixture?.close();
  fixture = undefined;
});

describe.each(providers)("native lifecycle: %s", (provider) => {
  if (["claude", "codex", "pi"].includes(provider))
    it("live model selection changes the actual next request and cold launch", async () => {
      const f = await nativeFixture(provider);
      fixture = f;
      const initial = await f.model.next();
      initial.finish("BEFORE_MODEL_CHANGE");
      await f.output("BEFORE_MODEL_CHANGE");
      await f.idle();
      if (provider === "pi") {
        await expect(f.proc.setModel("owned/does-not-exist")).rejects.toThrow();
        expect(f.proc.requestedModel).not.toBe("owned/does-not-exist");
      }
      const selection =
        provider === "pi"
          ? "owned/m2"
          : provider === "codex"
            ? "gpt-6.1-terra"
            : "claude-sonnet-5-5";
      const wireModel = provider === "pi" ? "m2" : selection;
      expect(await f.proc.setModel(selection)).toBe(true);
      expect(f.proc.queueMessage({ text: "AFTER_MODEL_CHANGE" }).success).toBe(
        true,
      );
      const changed = await f.model.next();
      expect(changed.model).toBe(wireModel);
      changed.finish("MODEL_CHANGE_DONE");
      await f.output("MODEL_CHANGE_DONE");
      await f.idle();
      const id = f.nativeId();
      await f.stop();
      const source = await f.source();
      await f.restart({
        resumeSessionId: id,
        nativeResumeSource: source,
        model: selection,
        initialMessage: { text: "RESTORED_MODEL_CHOICE" },
      });
      const restored = await f.model.next();
      expect(restored.model).toBe(wireModel);
      expect(JSON.stringify(restored.body).includes("AFTER_MODEL_CHANGE")).toBe(
        true,
      );
      restored.finish("RESTORED_MODEL_DONE");
      await f.output("RESTORED_MODEL_DONE");
      await f.idle();
      expect(f.nativeId()).toBe(id);
      await f.close();
      expect(f.diagnostics).toEqual([]);
      expect(f.errors).toEqual([]);
      expect(f.model.failures).toEqual([]);
    });

  // Antigravity native reader teardown and Grok restart hit the
  // initial 5s bound locally; use 2x that observed bound.
  it("cancels an active native request and continues with saved context", {
    timeout: ["antigravity", "grok"].includes(provider) ? 10_000 : 5_000,
  }, async () => {
    const f = await nativeFixture(provider);
    fixture = f;
    const initial = await f.model.next();
    initial.finish("BEFORE_CANCELLATION");
    await f.output("BEFORE_CANCELLATION");
    await f.idle();
    const nativeId = f.nativeId();
    expect(f.proc.queueMessage({ text: "CANCEL_THIS_TURN" }).success).toBe(
      true,
    );
    const cancelled = await f.model.next();
    cancelled.partial("UNFINISHED_GENERATION");
    if (f.session.interrupt) {
      expect(await f.proc.interrupt()).toBe(true);
      await cancelled.cancelled;
      await f.idle();
      expect(
        f.proc.queueMessage({ text: "CONTINUE_AFTER_CANCEL" }).success,
      ).toBe(true);
    } else {
      expect(await f.proc.interrupt()).toBe(false);
      await f.stop();
      await cancelled.cancelled;
      const source = await f.source();
      await f.restart({
        resumeSessionId: nativeId,
        nativeResumeSource: source,
        initialMessage: { text: "CONTINUE_AFTER_CANCEL" },
      });
    }
    const continuation = await f.model.next();
    const body = JSON.stringify(continuation.body);
    expect(body.includes("BEFORE_CANCELLATION")).toBe(true);
    expect(body.includes("CONTINUE_AFTER_CANCEL")).toBe(true);
    continuation.finish("CONTINUED_AFTER_CANCEL");
    await f.output("CONTINUED_AFTER_CANCEL");
    await f.idle();
    expect(f.nativeId()).toBe(nativeId);
    await f.stop();
    expect(
      JSON.stringify(await f.history()).includes("CONTINUED_AFTER_CANCEL"),
    ).toBe(true);
    await f.close();
    expect(f.errors).toEqual([]);
    expect(f.diagnostics).toEqual([]);
    expect(f.model.failures).toEqual([]);
  });

  // Antigravity, Grok and OpenCode hit the runner's 5s limit during cold start/load.
  // Two real launches plus native reader teardown get 2x that observed bound.
  it.each(provider === "opencode" ? [true, false] : [true])(
    "cold resume preserves native identity, prior turns and actual tool bytes (git=%s)",
    {
      timeout: ["antigravity", "grok", "opencode"].includes(provider)
        ? 10_000
        : 5_000,
    },
    async (gitProject) => {
      const f = await nativeFixture(provider, "gentle", {
        gitProject,
      });
      fixture = f;
      const initial = await f.model.next();
      readOwnedFile(provider, f.project, initial);
      const afterTool = await f.model.next();
      expect(
        JSON.stringify(afterTool.body).includes("OWNED_TOOL_CONTENT"),
      ).toBe(true);
      afterTool.finish("BEFORE_COLD_RESTART");
      await f.output("BEFORE_COLD_RESTART");
      await f.idle();
      const id = f.nativeId();
      await f.stop();
      expect(
        JSON.stringify(await f.history()).includes("BEFORE_COLD_RESTART"),
      ).toBe(true);
      const source = await f.source();
      await f.restart({
        resumeSessionId: id,
        nativeResumeSource: source,
        ...(provider === "antigravity"
          ? { model: "gemini-3.7-flash-medium" }
          : {}),
        initialMessage: {
          text: "AFTER_COLD_RESTART",
          uuid: "55555555-5555-4555-8555-555555555555",
        },
      });
      const resumed = await f.model.next();
      if (provider === "antigravity")
        expect(resumed.model).toBe("gemini-3.7-flash");
      const body = JSON.stringify(resumed.body);
      expect(body.includes("INITIAL_NATIVE_INPUT")).toBe(true);
      expect(body.includes("OWNED_TOOL_CONTENT")).toBe(true);
      expect(body.includes("BEFORE_COLD_RESTART")).toBe(true);
      expect(body.includes("AFTER_COLD_RESTART")).toBe(true);
      resumed.finish("COLD_RESUME_DONE");
      await f.output("COLD_RESUME_DONE");
      await f.idle();
      expect(f.nativeId()).toBe(id);
      await f.stop();
      const persisted = JSON.stringify(await f.history());
      expect(persisted.includes("BEFORE_COLD_RESTART")).toBe(true);
      expect(persisted.includes("COLD_RESUME_DONE")).toBe(true);
      await f.close();
      expect(f.errors).toEqual([]);
      expect(f.diagnostics).toEqual([]);
      expect(f.model.failures).toEqual([]);
    },
  );
});
