import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectionState } from "../../src/routes/ws-relay-handlers.js";
import {
  type SrpLimitedUserLookup,
  handleSrpHello,
  resetSrpUsernameLimitersForTest,
  srpUsernameLimiterCountForTest,
} from "../../src/routes/ws-srp-handlers.js";
import type { WSAdapter } from "../../src/routes/ws-relay-handlers.js";

/**
 * topics/limited-users.md § Delivery v1 — Login, switching, and logout.
 *
 * With limited users enabled, an unknown SRP identity must be answered like a
 * known one and fail only at the proof step. With the feature off — the
 * default — the server keeps its existing behavior of saying the identity is
 * unknown, unpadded and with no per-identity limiter.
 */

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    send: (data: string) => {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
    close: () => {},
    readyState: 1,
  } as unknown as WSAdapter;
  return { ws, sent };
}

const remoteAccess = {
  isEnabled: () => true,
  getCredentials: () => ({
    // A well-formed hex salt and verifier; the handshake only needs parseable
    // values to compute a challenge.
    salt: "a1b2c3",
    verifier: "9f8e7d6c5b4a3928",
  }),
  getUsername: () => "owner",
} as unknown as Parameters<typeof handleSrpHello>[3];

const decoy: SrpLimitedUserLookup = {
  isEnabled: () => true,
  getSrpChallengeInputs: () => ({
    salt: "d1d2d3",
    verifier: "1122334455667788",
    known: false,
  }),
};

const featureOff: SrpLimitedUserLookup = {
  isEnabled: () => false,
  getSrpChallengeInputs: () => {
    throw new Error("consulted while limited users are off");
  },
};

function hello(
  identity: string,
  lookup: SrpLimitedUserLookup,
  connState = createConnectionState(),
) {
  const { ws, sent } = fakeSocket();
  const done = handleSrpHello(
    ws,
    connState,
    { type: "srp_hello", identity, A: "01" } as never,
    remoteAccess,
    lookup,
  );
  return { done, sent };
}

/** A connection already over its own hello limit, answered without SRP work. */
function rateLimitedConnection() {
  const connState = createConnectionState();
  connState.srpLimiter.blockedUntil = Date.now() + 60_000;
  return connState;
}

const RATE_LIMITED = {
  type: "srp_error",
  code: "invalid_proof",
  message: "Too many authentication attempts. Try again shortly.",
};

beforeEach(() => {
  resetSrpUsernameLimitersForTest();
});

afterEach(() => {
  vi.useRealTimers();
  resetSrpUsernameLimitersForTest();
});

describe("srp_hello identity handling", () => {
  it("challenges an unknown identity when limited users are enabled", async () => {
    const { done, sent } = hello("mallory", decoy);
    await done;
    expect(sent.map((message) => message.type)).toEqual(["srp_challenge"]);
  });

  it("still reports an unknown identity while the feature is off", async () => {
    const { done, sent } = hello("mallory", featureOff);
    await done;
    expect(sent).toEqual([
      {
        type: "srp_error",
        code: "invalid_identity",
        message: "Unknown identity",
      },
    ]);
  });

  it("pads the unknown-identity response to the fixed floor when enabled", async () => {
    const startedAt = Date.now();
    await hello("mallory", decoy).done;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
  });

  it("answers at once, unpadded, while the feature is off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    let settled = false;
    const { done, sent } = hello("mallory", featureOff);
    void done.then(() => {
      settled = true;
    });
    // Runs pending microtasks only; a padded response would still be
    // waiting on its timer.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(sent.map((message) => message.code)).toEqual(["invalid_identity"]);
  });
});

describe("srp_hello per-identity limiter", () => {
  it("keeps no limiter for unknown identities while the feature is off", async () => {
    for (let i = 0; i < 50; i++) {
      await hello(`stranger-${i}`, featureOff).done;
    }
    expect(srpUsernameLimiterCountForTest()).toBe(0);
  });

  it("stays bounded when fresh identities are sprayed with the feature on", async () => {
    for (let i = 0; i < 1500; i++) {
      await hello(`stranger-${i}`, decoy, rateLimitedConnection()).done;
    }
    expect(srpUsernameLimiterCountForTest()).toBeLessThanOrEqual(1024);
    expect(srpUsernameLimiterCountForTest()).toBeGreaterThan(0);
  });

  it("does not let a spray of fresh identities lift a name's lockout", async () => {
    // Exhaust the configured name's hello allowance, one fresh connection per
    // attempt so only the per-identity limiter can refuse it.
    let limited = false;
    for (let attempt = 0; attempt < 40 && !limited; attempt++) {
      const { done, sent } = hello("owner", featureOff);
      await done;
      limited = sent.some(
        (message) => message.message === RATE_LIMITED.message,
      );
    }
    expect(limited).toBe(true);

    for (let i = 0; i < 1500; i++) {
      await hello(`stranger-${i}`, decoy, rateLimitedConnection()).done;
    }

    const { done, sent } = hello("owner", decoy);
    await done;
    expect(sent).toEqual([RATE_LIMITED]);
  });
});
