import { describe, expect, it } from "vitest";
import {
  type BuildSessionLivenessSnapshotInput,
  buildSessionLivenessSnapshot,
} from "../../src/supervisor/liveness.js";

const STARTED_AT = new Date("2026-05-06T00:00:00.000Z");
const RECENT_STATE_CHANGE_AT = new Date("2026-05-06T00:04:30.000Z");
const STALE_STATE_CHANGE_AT = new Date("2026-05-05T23:55:00.000Z");
const NOW = new Date("2026-05-06T00:05:00.000Z");
const THRESHOLD_MS = 5 * 60 * 1000;

function snapshot(
  overrides: Partial<BuildSessionLivenessSnapshotInput>,
): ReturnType<typeof buildSessionLivenessSnapshot> {
  return buildSessionLivenessSnapshot({
    provider: "claude",
    state: { type: "in-turn" },
    startedAt: STARTED_AT,
    lastStateChangeAt: RECENT_STATE_CHANGE_AT,
    lastProviderMessageAt: null,
    lastLivenessProbe: null,
    processAlive: true,
    queueDepth: 0,
    deferredQueueDepth: 0,
    now: NOW,
    longSilenceThresholdMs: THRESHOLD_MS,
    ...overrides,
  });
}

describe("buildSessionLivenessSnapshot", () => {
  it("marks idle sessions as verified idle without treating queues as work", () => {
    const idleSince = new Date("2026-05-06T00:03:00.000Z");

    expect(
      snapshot({
        state: { type: "idle", since: idleSince },
        queueDepth: 2,
        deferredQueueDepth: 1,
      }),
    ).toMatchObject({
      derivedStatus: "verified-idle",
      activeWorkKind: "none",
      state: "idle",
      lastVerifiedIdleAt: idleSince.toISOString(),
      queueDepth: 2,
      deferredQueueDepth: 1,
    });
  });

  it("uses a recent provider message as verified turn progress", () => {
    const lastProviderMessageAt = new Date("2026-05-06T00:04:50.000Z");

    expect(snapshot({ lastProviderMessageAt })).toMatchObject({
      derivedStatus: "verified-progressing",
      activeWorkKind: "agent-turn",
      lastProviderMessageAt: lastProviderMessageAt.toISOString(),
      lastVerifiedProgressAt: lastProviderMessageAt.toISOString(),
      silenceMs: 10_000,
      evidence: expect.arrayContaining(["provider-message-recent"]),
    });
  });

  it("keeps a silent detached reply retained without claiming progress", () => {
    expect(
      snapshot({
        provider: "antigravity",
        state: { type: "idle", since: STALE_STATE_CHANGE_AT },
        providerRetention: {
          retained: true,
          reasons: ["antigravity-detached-reply"],
          detachedReply: { status: "progressing", at: STALE_STATE_CHANGE_AT },
        },
      }),
    ).toMatchObject({
      derivedStatus: "long-silent-unverified",
      lastVerifiedIdleAt: null,
      providerRetention: { retained: true },
    });
  });

  it("flags a live active turn as unverified after long provider silence", () => {
    const lastProviderMessageAt = new Date("2026-05-05T23:59:30.000Z");

    expect(snapshot({ lastProviderMessageAt })).toMatchObject({
      derivedStatus: "long-silent-unverified",
      activeWorkKind: "agent-turn",
      silenceMs: 330_000,
      evidence: expect.arrayContaining(["provider-message-stale"]),
    });
  });

  it("surfaces raw provider events without treating them as progress", () => {
    const rawEventAt = new Date("2026-05-06T00:04:55.000Z");

    expect(
      snapshot({
        lastProviderMessageAt: null,
        lastStateChangeAt: STALE_STATE_CHANGE_AT,
        lastRawProviderEventAt: rawEventAt,
        lastRawProviderEventSource: "codex:notification:thread/status/changed",
      }),
    ).toMatchObject({
      derivedStatus: "long-silent-unverified",
      activeWorkKind: "agent-turn",
      lastRawProviderEventAt: rawEventAt.toISOString(),
      lastRawProviderEventSource: "codex:notification:thread/status/changed",
      lastVerifiedProgressAt: null,
      evidence: expect.arrayContaining([
        "no-provider-message-observed",
        "raw-provider-event-observed",
        "raw-provider-event-recent",
      ]),
    });
  });

  it("does not treat a dead active process as live work", () => {
    expect(snapshot({ processAlive: false })).toMatchObject({
      derivedStatus: "needs-attention",
      activeWorkKind: "agent-turn",
      processAlive: false,
      evidence: expect.arrayContaining(["active-process-dead"]),
    });
  });

  it("keeps a newly active turn unverified until provider evidence arrives", () => {
    expect(
      snapshot({
        lastProviderMessageAt: null,
        lastStateChangeAt: RECENT_STATE_CHANGE_AT,
      }),
    ).toMatchObject({
      derivedStatus: "recently-active-unverified",
      activeWorkKind: "agent-turn",
      lastVerifiedProgressAt: null,
      evidence: expect.arrayContaining([
        "recent-state-change-no-provider-message",
      ]),
    });
  });

  it("flags a never-observed active turn after the silence threshold", () => {
    expect(
      snapshot({
        lastProviderMessageAt: null,
        lastStateChangeAt: STALE_STATE_CHANGE_AT,
      }),
    ).toMatchObject({
      derivedStatus: "long-silent-unverified",
      activeWorkKind: "agent-turn",
      evidence: expect.arrayContaining(["no-provider-message-observed"]),
    });
  });

  it("uses a recent active provider probe to verify a stale active turn", () => {
    const checkedAt = new Date("2026-05-06T00:04:45.000Z");

    expect(
      snapshot({
        lastProviderMessageAt: new Date("2026-05-05T23:59:30.000Z"),
        lastLivenessProbe: {
          checkedAt,
          status: "active",
          source: "codex:thread/read",
          detail: "thread.status:active",
        },
      }),
    ).toMatchObject({
      derivedStatus: "verified-waiting-provider",
      activeWorkKind: "agent-turn",
      lastLivenessProbeAt: checkedAt.toISOString(),
      lastLivenessProbeStatus: "active",
      lastLivenessProbeSource: "codex:thread/read",
      lastLivenessProbeDetail: "thread.status:active",
      evidence: expect.arrayContaining([
        "probe:active",
        "probe-source:codex:thread/read",
        "provider-probe-active",
      ]),
    });
  });

  it("flags idle provider probe results that contradict an active turn", () => {
    expect(
      snapshot({
        lastProviderMessageAt: new Date("2026-05-05T23:59:30.000Z"),
        lastLivenessProbe: {
          checkedAt: new Date("2026-05-06T00:04:45.000Z"),
          status: "idle",
          source: "codex:thread/read",
        },
      }),
    ).toMatchObject({
      derivedStatus: "needs-attention",
      activeWorkKind: "agent-turn",
      lastVerifiedProgressAt: null,
      evidence: expect.arrayContaining(["probe-idle-while-in-turn"]),
    });
  });

  it("marks provider input requests as needing attention", () => {
    expect(snapshot({ state: { type: "waiting-input" } })).toMatchObject({
      derivedStatus: "needs-attention",
      activeWorkKind: "waiting-input",
      state: "waiting-input",
    });
  });
});
