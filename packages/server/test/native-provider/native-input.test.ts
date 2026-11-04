import { afterEach, describe, expect, it } from "vitest";
import { nativeFixture } from "./fixture.js";
import { providers } from "./selection.js";
import { readOwnedFile } from "./actions.js";
import { normalizeSession } from "../../src/sessions/normalization.js";

const alphaId = "22222222-2222-4222-8222-222222222222";
const bravoId = "33333333-3333-4333-8333-333333333333";
let fixture: Awaited<ReturnType<typeof nativeFixture>> | undefined;
afterEach(async (context) => {
  if (fixture && context.task.result?.state === "fail")
    console.info({
      events: fixture.events.slice(-12),
      errors: fixture.errors.map(String),
      diagnostics: fixture.diagnostics,
    });
  await fixture?.close();
  fixture = undefined;
});

for (const provider of providers.filter((p) =>
  ["claude", "codex", "pi"].includes(p),
)) {
  describe(`native input boundaries: ${provider}`, () => {
    it("keeps buffered inputs separate before native grouping and preserves history", async () => {
      const f = await nativeFixture(provider);
      fixture = f;
      readOwnedFile(provider, f.project, await f.model.next());
      const active = await f.model.next();
      expect(JSON.stringify(active.body)).toContain("OWNED_TOOL_CONTENT");
      active.partial("INPUT_BOUNDARY_ACTIVE");
      await f.message((m) =>
        JSON.stringify(m).includes("INPUT_BOUNDARY_ACTIVE"),
      );
      const yielded: string[][] = [];
      f.session.queue.subscribeYielded?.((messages) =>
        yielded.push(messages.map((m) => m.uuid!)),
      );
      expect(
        f.proc.queueMessage(
          { text: "BOUNDARY_ALPHA", uuid: alphaId },
          { allowSteer: false },
        ).success,
      ).toBe(true);
      expect(
        f.proc.queueMessage(
          { text: "BOUNDARY_BRAVO", uuid: bravoId },
          { allowSteer: false },
        ).success,
      ).toBe(true);
      active.finish("ORIGINAL_DONE");
      const alpha = await f.model.next();
      const body = JSON.stringify(alpha.body);
      expect(body).toContain("BOUNDARY_ALPHA");
      expect(body).not.toContain(
        JSON.stringify("BOUNDARY_ALPHA\n\n--------\n\nBOUNDARY_BRAVO"),
      );
      if (provider === "claude") {
        // The real CLI may group already separate native commands itself.
        expect(body).toContain("BOUNDARY_BRAVO");
      } else expect(body).not.toContain("BOUNDARY_BRAVO");
      alpha.finish("ALPHA_DONE");
      if (provider !== "claude") {
        const bravo = await f.model.next();
        expect(JSON.stringify(bravo.body)).toContain("BOUNDARY_BRAVO");
        bravo.finish("BRAVO_DONE");
        await f.output("BRAVO_DONE");
      } else await f.output("ALPHA_DONE");
      await f.idle();
      expect(yielded).toEqual([[alphaId], [bravoId]]);
      await f.stop();
      const loaded = await f.history();
      expect(loaded).not.toBeNull();
      const rows = normalizeSession(loaded!).messages.filter(
        (m) => m.type === "user" && JSON.stringify(m).includes("BOUNDARY_"),
      );
      expect(rows).toHaveLength(provider === "claude" ? 1 : 2);
      expect(JSON.stringify(rows)).not.toContain("--------");
      if (provider !== "pi") {
        expect(JSON.stringify(rows)).toContain(alphaId);
        expect(JSON.stringify(rows)).toContain(bravoId);
      }
      expect(f.model.failures).toEqual([]);
      expect(f.errors).toEqual([]);
      expect(f.diagnostics).toEqual([]);
    });

    if (provider !== "pi")
      it("retains both identities for identical independently acknowledged native steers", async () => {
        const f = await nativeFixture(provider);
        fixture = f;
        const active = await f.model.next();
        active.partial("IDENTITY_ACTIVE");
        await f.message((m) => JSON.stringify(m).includes("IDENTITY_ACTIVE"));
        for (const uuid of [alphaId, bravoId]) {
          expect(
            await f.session.steer!({
              text: "IDENTICAL_NATIVE_INPUT",
              uuid,
              metadata: { deliveryIntent: "steer" },
            }),
          ).toBe(true);
          if (provider === "claude")
            await f.message(
              (m) =>
                m.type === "command_lifecycle" &&
                m.command_uuid === uuid &&
                m.state === "queued",
            );
        }
        active.finish("ORIGINAL_DONE");
        const next = await f.model.next();
        expect(
          JSON.stringify(next.body).match(/IDENTICAL_NATIVE_INPUT/g),
        ).toHaveLength(2);
        next.finish("IDENTITY_DONE");
        await f.output("IDENTITY_DONE");
        await f.idle();
        await f.stop();
        const rows = normalizeSession((await f.history())!).messages.filter(
          (m) =>
            m.type === "user" &&
            JSON.stringify(m).includes("IDENTICAL_NATIVE_INPUT"),
        );
        expect(rows).toHaveLength(provider === "claude" ? 1 : 2);
        expect(JSON.stringify(rows)).toContain(alphaId);
        expect(JSON.stringify(rows)).toContain(bravoId);
        expect(f.model.failures).toEqual([]);
        expect(f.errors).toEqual([]);
        expect(f.diagnostics).toEqual([]);
      });
  });
}
