import { afterEach, describe, expect, it } from "vitest";
import { nativeFixture } from "./fixture.js";
import { readOwnedFile } from "./actions.js";
import { providers } from "./selection.js";

let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
let coldPhases:
  | {
      provider: (typeof providers)[number];
      started: number;
      marks: Array<{ phase: string; atMs: number }>;
    }
  | undefined;
afterEach(async (context) => {
  if (coldPhases)
    console.info(
      JSON.stringify({
        nativeColdResume: {
          provider: coldPhases.provider,
          marks: coldPhases.marks,
          elapsedMs: Math.round(performance.now() - coldPhases.started),
          state: context.task.result?.state,
        },
      }),
    );
  coldPhases = undefined;
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
          error:
            m.type === "error" ? JSON.stringify(m).slice(0, 4000) : undefined,
          text: JSON.stringify(m.message?.content)?.slice(0, 200),
        })),
        errors: fixture.errors.map((e) => e.message),
        diagnostics: fixture.diagnostics,
        nativeDiagnostics: fixture.nativeDiagnostics,
      }),
    );
  await fixture?.close();
  fixture = undefined;
});

describe.each(providers)("native lifecycle: %s", (provider) => {
  if (["claude", "codex", "pi", "antigravity"].includes(provider))
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
            : provider === "antigravity"
              ? "gemini-3.7-flash"
              : "claude-sonnet-5-5";
      const wireModel = provider === "pi" ? "m2" : selection;
      if (provider === "antigravity")
        expect(await f.proc.setEffort(undefined)).toBe(true);
      expect(await f.proc.setModel(selection)).toBe(true);
      if (provider === "antigravity") {
        // Observe the target's Auto wire level before introducing an override.
        expect(
          f.proc.queueMessage({ text: "LIVE_SWITCH_BASELINE" }).success,
        ).toBe(true);
        const liveBaseReq = await f.model.next();
        expect(liveBaseReq.model).toBe(wireModel);
        const liveBaseMatch = JSON.stringify(liveBaseReq.body).match(
          /"(?:thinkingLevel|thinking_level)":"([A-Z]+)"/i,
        );
        const observedLiveBaseline = liveBaseMatch?.[1]?.toLowerCase();
        expect(observedLiveBaseline).toBeTruthy();
        liveBaseReq.finish("LIVE_BASELINE_DONE");
        await f.output("LIVE_BASELINE_DONE");
        await f.idle();

        const liveOverride =
          observedLiveBaseline === "medium" ? "high" : "medium";
        expect(await f.proc.setModel(initial.model)).toBe(true);
        expect(await f.proc.setEffort(liveOverride)).toBe(true);
        expect(await f.proc.setModel(selection)).toBe(true);
        expect(
          f.proc.queueMessage({ text: "LIVE_SWITCH_OVERRIDE" }).success,
        ).toBe(true);
        const liveOverrideReq = await f.model.next();
        expect(JSON.stringify(liveOverrideReq.body)).toMatch(
          new RegExp(
            `"(?:thinkingLevel|thinking_level)":"${liveOverride.toUpperCase()}"`,
            "i",
          ),
        );
        liveOverrideReq.finish("LIVE_OVERRIDE_DONE");
        await f.output("LIVE_OVERRIDE_DONE");
        await f.idle();

        expect(await f.proc.setEffort(undefined)).toBe(true);
        expect(f.proc.queueMessage({ text: "LIVE_SWITCH_AUTO" }).success).toBe(
          true,
        );
        const liveAutoReq = await f.model.next();
        expect(JSON.stringify(liveAutoReq.body)).toMatch(
          new RegExp(
            `"(?:thinkingLevel|thinking_level)":"${observedLiveBaseline!.toUpperCase()}"`,
            "i",
          ),
        );
        liveAutoReq.finish("LIVE_AUTO_DONE");
        await f.output("LIVE_AUTO_DONE");
        await f.idle();

        expect(await f.proc.setEffort("low")).toBe(true);
      }
      expect(f.proc.queueMessage({ text: "AFTER_MODEL_CHANGE" }).success).toBe(
        true,
      );
      const changed = await f.model.next();
      expect(changed.model).toBe(wireModel);
      if (provider === "antigravity") {
        expect(JSON.stringify(changed.body)).toMatch(
          /"thinkingLevel":"LOW"|"thinking_level":"LOW"/i,
        );
      }
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
        ...(provider === "antigravity" ? { effort: "low" as const } : {}),
        initialMessage: { text: "RESTORED_MODEL_CHOICE" },
      });
      const restored = await f.model.next();
      expect(restored.model).toBe(wireModel);
      if (provider === "antigravity") {
        expect(JSON.stringify(restored.body)).toMatch(
          /"thinkingLevel":"LOW"|"thinking_level":"LOW"/i,
        );
      }
      expect(JSON.stringify(restored.body).includes("AFTER_MODEL_CHANGE")).toBe(
        true,
      );
      restored.finish("RESTORED_MODEL_DONE");
      await f.output("RESTORED_MODEL_DONE");
      await f.idle();
      expect(f.nativeId()).toBe(id);
      await f.close();
      fixture = undefined;
      expect(f.diagnostics).toEqual([]);
      expect(f.errors).toEqual([]);
      expect(f.model.failures).toEqual([]);
      if (provider === "antigravity") {
        // Verify Auto restores the actual observed startup baseline for a
        // non-default model (captured on the wire before any override).
        const autoFixture = await nativeFixture("antigravity", "gentle", {
          launch: { model: "gemini-3.7-flash" },
        });
        fixture = autoFixture;
        const baseReq = await autoFixture.model.next();
        const baseMatch = JSON.stringify(baseReq.body).match(
          /"(?:thinkingLevel|thinking_level)":"([A-Z]+)"/i,
        );
        const observedBaseline = baseMatch?.[1]?.toLowerCase();
        expect(observedBaseline).toBeTruthy();
        baseReq.finish("BASELINE_DONE");
        await autoFixture.output("BASELINE_DONE");
        await autoFixture.idle();

        const override = observedBaseline === "medium" ? "high" : "medium";
        expect(await autoFixture.proc.setEffort(override)).toBe(true);
        expect(
          autoFixture.proc.queueMessage({ text: "EFFORT_OVERRIDE_DISTINCT" })
            .success,
        ).toBe(true);
        const overrideTurn = await autoFixture.model.next();
        expect(JSON.stringify(overrideTurn.body)).toMatch(
          new RegExp(
            `"(?:thinkingLevel|thinking_level)":"${override.toUpperCase()}"`,
            "i",
          ),
        );
        overrideTurn.finish("OVERRIDE_DONE");
        await autoFixture.output("OVERRIDE_DONE");
        await autoFixture.idle();

        expect(await autoFixture.proc.setEffort(undefined)).toBe(true);
        expect(
          autoFixture.proc.queueMessage({ text: "EFFORT_RESET_AUTO" }).success,
        ).toBe(true);
        const autoTurn = await autoFixture.model.next();
        expect(JSON.stringify(autoTurn.body)).toMatch(
          new RegExp(
            `"(?:thinkingLevel|thinking_level)":"${observedBaseline!.toUpperCase()}"`,
            "i",
          ),
        );
        autoTurn.finish("AUTO_DONE");
        await autoFixture.output("AUTO_DONE");
        await autoFixture.idle();
        await autoFixture.close();
        fixture = undefined;
        expect(autoFixture.diagnostics).toEqual([]);
        expect(autoFixture.errors).toEqual([]);
        expect(autoFixture.model.failures).toEqual([]);
      }
    });

  it("cancels an active native request and continues with saved context", {
    // Linux runs 42060535825 / 42063066589: Antigravity cancel max 9.520s
    // -> 20s (2.10x). Mac triple-suite overlap (2026-11-05) measures Grok
    // at 6.393s -> 20s (3.13x). OpenCode retains 4x its exhausted 5s floor.
    timeout: ["antigravity", "opencode", "grok"].includes(provider)
      ? 20_000
      : 5_000,
  }, async () => {
    const f = await nativeFixture(provider, "gentle", {
      // Pair the queued bypass scenario with real non-bypass exec resumes.
      ...(provider === "codex-oss" ? { permissionMode: "default" } : {}),
    });
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
    if (provider === "codex-oss") {
      const contexts = (
        (await f.nativeRows()) as Array<{ type: string; payload?: unknown }>
      ).filter((row) => row.type === "turn_context");
      expect(contexts.length).toBeGreaterThanOrEqual(3);
      for (const row of contexts)
        expect(row.payload).toMatchObject({
          approval_policy: "never",
          sandbox_policy: { type: "workspace-write" },
        });
    }
    await f.close();
    expect(f.errors).toEqual([]);
    expect(f.diagnostics).toEqual([]);
    expect(f.model.failures).toEqual([]);
  });

  // Retain both independent reader replays around native resume. Guards include
  // construction, model/tool exchanges, native history and process teardown.
  it.each(provider === "opencode" ? [true, false] : [true])(
    "cold resume preserves native identity, prior turns and actual tool bytes (git=%s)",
    {
      // Linux Antigravity passes in 16.217s (run 42063066589), including two
      // reader replays of ~3s each. Use 35s, 2.16x that measured maximum.
      // Runs 42060535825 / 42063066589: OpenCode cold max 12.591s -> 30s
      // (2.38x, both git variants). Mac triple-suite overlap (2026-11-05)
      // measures Grok cold at 6.389s -> 20s (3.13x). Claude passes in
      // 2.3-2.7s on Linux and run 43022773170 exhausted the former 5s default,
      // so the remaining providers get 15s, 3x that lower bound.
      timeout:
        provider === "antigravity"
          ? 35_000
          : provider === "opencode"
            ? 30_000
            : provider === "grok"
              ? 20_000
              : 15_000,
    },
    async (gitProject) => {
      const phases = {
        provider,
        started: performance.now(),
        marks: [] as Array<{ phase: string; atMs: number }>,
      };
      coldPhases = phases;
      const mark = (phase: string) =>
        phases.marks.push({
          phase,
          atMs: Math.round(performance.now() - phases.started),
        });
      mark("fixture-start");
      const f = await nativeFixture(provider, "gentle", {
        gitProject,
      });
      fixture = f;
      mark("await-initial-request");
      const initial = await f.model.next();
      mark("native-tool");
      readOwnedFile(provider, f.project, initial);
      const afterTool = await f.model.next();
      expect(
        JSON.stringify(afterTool.body).includes("OWNED_TOOL_CONTENT"),
      ).toBe(true);
      mark("initial-output");
      afterTool.finish("BEFORE_COLD_RESTART");
      await f.output("BEFORE_COLD_RESTART");
      await f.idle();
      const id = f.nativeId();
      mark("initial-stop");
      await f.stop();
      // Opening a stopped session runs a production-reader replay before a
      // user resumes it. Retain this interaction as well as the final reopen.
      mark("initial-history");
      expect(
        JSON.stringify(await f.history()).includes("BEFORE_COLD_RESTART"),
      ).toBe(true);
      mark("resume-source");
      const source = await f.source();
      mark("resume-start");
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
      mark("await-resumed-request");
      const resumed = await f.model.next();
      if (provider === "antigravity")
        expect(resumed.model).toBe("gemini-3.7-flash");
      const body = JSON.stringify(resumed.body);
      expect(body.includes("INITIAL_NATIVE_INPUT")).toBe(true);
      expect(body.includes("OWNED_TOOL_CONTENT")).toBe(true);
      expect(body.includes("BEFORE_COLD_RESTART")).toBe(true);
      expect(body.includes("AFTER_COLD_RESTART")).toBe(true);
      mark("resumed-output");
      resumed.finish("COLD_RESUME_DONE");
      await f.output("COLD_RESUME_DONE");
      await f.idle();
      expect(f.nativeId()).toBe(id);
      mark("resumed-stop");
      await f.stop();
      mark("persisted-history");
      const persisted = JSON.stringify(await f.history());
      expect(persisted.includes("BEFORE_COLD_RESTART")).toBe(true);
      expect(persisted.includes("COLD_RESUME_DONE")).toBe(true);
      mark("fixture-close");
      await f.close();
      mark("complete");
      expect(f.errors).toEqual([]);
      expect(f.diagnostics).toEqual([]);
      expect(f.model.failures).toEqual([]);
    },
  );
});
