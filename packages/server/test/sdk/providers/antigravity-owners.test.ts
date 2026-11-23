import { afterEach, describe, expect, it, vi } from "vitest";
import { setAntigravityLiveLimitsForTests } from "../../../src/sdk/providers/antigravity-live-projection.js";
import {
  antigravitySessionOwned,
  antigravityWriteIsOwn,
  hostedAntigravityOwnerLink,
  ownAntigravitySession,
  takeAntigravityOwnerView,
} from "../../../src/sdk/providers/antigravity-owners.js";
import type { SDKMessage } from "../../../src/sdk/types.js";

const row = (n: number) =>
  ({
    type: "assistant",
    uuid: `r${n}`,
    message: { role: "assistant", content: [{ type: "text", text: `t${n}` }] },
  }) as SDKMessage;

afterEach(() => {
  setAntigravityLiveLimitsForTests();
  vi.useRealTimers();
});

describe("Antigravity owner views (plan 195 step 9)", () => {
  it("takes a local owner's rows with its generation and flags, whatever lands in the await gap", async () => {
    setAntigravityLiveLimitsForTests({ capRows: 3 });
    const owner = ownAntigravitySession("/scope-race", "c1");
    try {
      owner.open({ step: -1, end: 0 });
      for (let i = 0; i < 3; i++) owner.record(row(i));
      const taking = takeAntigravityOwnerView("/scope-race", "c1", {
        rows: "all",
      });
      // Evicts r0 (generation 1, incomplete) before the reader resumes.
      queueMicrotask(() => owner.record(row(3)));
      const view = await taking;
      if (!view || view === "unavailable") throw new Error("no view");
      expect({
        generation: view.generation,
        incomplete: view.incomplete,
        rows: view.history().map((message) => message.uuid),
      }).toEqual({
        generation: 0,
        incomplete: false,
        rows: ["r0", "r1", "r2"],
      });
    } finally {
      owner.release();
    }
  });

  it("keeps a worker no backend attached to held and unread until the host reaps it, with no timer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const link = hostedAntigravityOwnerLink();
    link.expect({ storageScope: "/scope-unattached", id: "c" }, true);
    link.end("unattached");
    expect(await takeAntigravityOwnerView("/scope-unattached", "c")).toBe(
      "unavailable",
    );
    expect(antigravitySessionOwned("/scope-unattached", "c")).toBe(true);
    expect(
      antigravityWriteIsOwn("/scope-unattached", "c", Date.now() + 20_000),
    ).toBe(true);
    vi.setSystemTime(Date.now() + 31_000);
    expect(
      await takeAntigravityOwnerView("/scope-unattached", "c"),
    ).toBeUndefined();
    expect(antigravitySessionOwned("/scope-unattached", "c")).toBe(false);
    expect(antigravityWriteIsOwn("/scope-unattached", "c", Date.now())).toBe(
      true,
    );
    expect(
      antigravityWriteIsOwn("/scope-unattached", "c", Date.now() + 1),
    ).toBe(false);
  });
});
