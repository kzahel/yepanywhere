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
        modelRequests: fixture.model.requests.length,
        events: fixture.events.slice(-12).map((message) => ({
          type: message.type,
          subtype: message.subtype,
          error:
            message.type === "error"
              ? JSON.stringify(message).slice(0, 4000)
              : undefined,
        })),
        errors: fixture.errors.map((error) => error.message),
        diagnostics: fixture.diagnostics.slice(-12),
        nativeDiagnostics: fixture.nativeDiagnostics,
      }),
    );
  await fixture?.close();
  fixture = undefined;
});

describe.each(providers)("native retry: %s", (provider) => {
  // GenAI backoff and Grok startup/retry hit 5s locally (Grok under the
  // full-workspace/all-provider run); retain 2x that observed bound.
  it("retries original input after a controlled rate limit and persists the reply", {
    // Antigravity's real GenAI retry/backoff plus startup exhausted 10s in
    // the concurrent workspace/native run (2026-11-04); retain 2x that bound.
    timeout:
      provider === "antigravity"
        ? 20_000
        : provider === "opencode"
          ? // Linux two/four-worker controls exhausted 5s; the two-worker run
            // already observed the real retry. Startup/backoff get 4x that floor.
            20_000
          : provider === "grok"
            ? 10_000
            : 5_000,
  }, async () => {
    const f = await nativeFixture(provider);
    fixture = f;
    const refused = await f.model.next();
    refused.fail(429, "OWNED_TRANSIENT_RATE_LIMIT", { "retry-after": "0" });
    const retried = await f.model.next();
    expect(JSON.stringify(retried.body).includes("INITIAL_NATIVE_INPUT")).toBe(
      true,
    );
    retried.finish("RATE_LIMIT_RECOVERED");
    await f.output("RATE_LIMIT_RECOVERED");
    await f.idle();
    expect(f.model.requests).toHaveLength(2);
    await f.stop();
    expect(
      JSON.stringify(await f.history()).includes("RATE_LIMIT_RECOVERED"),
    ).toBe(true);
    await f.close();
    expect(f.errors).toEqual([]);
    const errors = f.events.filter((m) => m.type === "error");
    if (provider === "codex") {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        codexWillRetry: true,
        error: "Reconnecting... 1/5",
      });
    } else if (provider === "codex-oss") {
      expect(errors).toHaveLength(1);
      expect(errors[0]?.error).toContain("Reconnecting... 1/5");
    } else expect(errors).toEqual([]);
    expect(f.diagnostics).toEqual([]);
    expect(f.model.failures).toEqual([]);
  });
});
