// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionImpactDeclinedError,
  connectionImpactOf,
  runConfirmingConnectionImpact,
} from "./connectionImpact";
import { readPlainJSONResponse } from "./plainFetch";

const refusalBody = {
  success: false,
  error: "This change would disconnect this device: …",
  reason: "connection-impact",
  connectionImpact: {
    reasons: [
      { kind: "listener-closed", listener: "127.0.0.1:3400" },
      { kind: "not-a-reason" },
    ],
  },
};

async function refusal(): Promise<unknown> {
  try {
    await readPlainJSONResponse(
      "/network-binding",
      new Response(JSON.stringify(refusalBody), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe("connection impact refusals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries the known reasons on the thrown error", async () => {
    expect(connectionImpactOf(await refusal())).toEqual([
      { kind: "listener-closed", listener: "127.0.0.1:3400" },
    ]);
  });

  it("repeats a refused write once confirmed, and asks once per scope", async () => {
    const refused = await refusal();
    const send = vi.fn(async (confirmed: boolean) => {
      if (!confirmed) throw refused;
      return "applied";
    });
    const confirmReasons = vi.fn(() => true);
    const prompt = {
      serverConfirms: true,
      legacyQuestion: null,
      confirmReasons,
    };
    const scope = { confirmed: false };

    await expect(
      runConfirmingConnectionImpact(send, prompt, scope),
    ).resolves.toBe("applied");
    await expect(
      runConfirmingConnectionImpact(send, prompt, scope),
    ).resolves.toBe("applied");

    expect(confirmReasons).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.map(([confirmed]) => confirmed)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("changes nothing when the user keeps the connection", async () => {
    const refused = await refusal();
    const send = vi.fn(async () => {
      throw refused;
    });

    await expect(
      runConfirmingConnectionImpact(send, {
        serverConfirms: true,
        legacyQuestion: null,
        confirmReasons: () => false,
      }),
    ).rejects.toBeInstanceOf(ConnectionImpactDeclinedError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("asks before sending to a server that cannot check", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const send = vi.fn(async () => "applied");

    await expect(
      runConfirmingConnectionImpact(send, {
        serverConfirms: false,
        legacyQuestion: "May disconnect?",
        confirmReasons: () => true,
      }),
    ).rejects.toBeInstanceOf(ConnectionImpactDeclinedError);
    expect(confirm).toHaveBeenCalledWith("May disconnect?");
    expect(send).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await expect(
      runConfirmingConnectionImpact(send, {
        serverConfirms: false,
        legacyQuestion: "May disconnect?",
        confirmReasons: () => false,
      }),
    ).resolves.toBe("applied");
    // Answered once: a current server must not refuse it again.
    expect(send).toHaveBeenCalledWith(true);
  });
});
