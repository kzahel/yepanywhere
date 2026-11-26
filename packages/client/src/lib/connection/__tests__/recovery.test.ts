import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../ConnectionManager";
import { categorizeResumeError, canRetryResume } from "../remoteErrors";
import { ResumeError } from "../resumeErrors";
import { RelayReconnectRequiredError, isNonRetryableError } from "../types";
import { MockTimers, MockVisibility } from "./ConnectionSimulator";

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function setup() {
  const timers = new MockTimers();
  const visibility = new MockVisibility();
  const reconnect = vi
    .fn<() => Promise<void>>()
    .mockRejectedValue(new Error("offline"));
  const manager = new ConnectionManager({
    timers,
    visibility,
    maxAttempts: 1,
    baseDelayMs: 1,
    jitterFactor: 0,
  });
  manager.start(reconnect);
  manager.handleClose();
  return { manager, timers, visibility, reconnect };
}

describe("exhausted recovery", () => {
  it("recovers on morning visibility after an arbitrarily long hidden outage", async () => {
    const { manager, timers, visibility, reconnect } = setup();
    visibility.hide();
    timers.advance(1);
    await settle();
    timers.advance(15 * 60 * 60 * 1000);
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(manager.waitingForRecovery).toBe(true);
    reconnect.mockResolvedValue(undefined);
    visibility.show();
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(manager.state).toBe("connected");
    manager.stop();
    expect(timers.pendingCount).toBe(0);
  });

  it("probes slowly while visible and cancels slow probes while hidden", async () => {
    const { manager, timers, visibility, reconnect } = setup();
    timers.advance(1);
    await settle();
    timers.advance(59999);
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(1);
    timers.advance(1);
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(2);
    visibility.hide();
    timers.advance(120000);
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it("does not jitter the slow probe, unlike rapid backoff", async () => {
    const timers = new MockTimers();
    const reconnect = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("offline"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const manager = new ConnectionManager({
      timers,
      visibility: new MockVisibility(),
      maxAttempts: 0,
    });
    manager.start(reconnect);
    manager.handleClose();
    timers.advance(59999);
    expect(reconnect).not.toHaveBeenCalled();
    timers.advance(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    manager.stop();
    vi.restoreAllMocks();
  });

  it("coalesces signals during an in-flight probe", async () => {
    const { manager, timers, reconnect } = setup();
    timers.advance(1);
    await settle();
    let resolve!: () => void;
    reconnect.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    for (let i = 0; i < 20; i++) manager.requestRecovery();
    expect(reconnect).toHaveBeenCalledTimes(2);
    resolve();
    await settle();
    manager.requestRecovery();
    expect(manager.state).toBe("connected");
    expect(reconnect).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it("rate limits repeated signals after a failed probe", async () => {
    const { manager, timers, reconnect } = setup();
    timers.advance(1);
    await settle();
    manager.requestRecovery();
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 20; i++) manager.requestRecovery();
    timers.advance(4999);
    manager.requestRecovery();
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(2);
    timers.advance(1);
    manager.requestRecovery();
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(3);
    manager.stop();
    expect(timers.pendingCount).toBe(0);
  });

  it("ignores delayed success and all recovery signals after stop", async () => {
    const { manager, timers, visibility, reconnect } = setup();
    timers.advance(1);
    await settle();
    let resolve!: () => void;
    reconnect.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    manager.requestRecovery();
    manager.stop();
    resolve();
    await settle();
    visibility.hide();
    visibility.show();
    manager.requestRecovery();
    timers.advance(120000);
    expect(manager.state).toBe("disconnected");
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(timers.pendingCount).toBe(0);
  });

  it("stops probing on an explicit rejection, including a relay-wrapped cause", async () => {
    const { manager, timers, visibility, reconnect } = setup();
    reconnect.mockRejectedValue(
      new RelayReconnectRequiredError(new ResumeError("rejected", "expired")),
    );
    timers.advance(1);
    await settle();
    visibility.hide();
    visibility.show();
    manager.requestRecovery();
    timers.advance(120000);
    expect(manager.state).toBe("disconnected");
    expect(reconnect).toHaveBeenCalledTimes(1);
    manager.stop();
  });
});

describe("resume evidence", () => {
  it.each([
    "Session timed out",
    "Authentication service unavailable",
    "session resume unsupported",
    "Unknown failure",
  ])("does not infer credential rejection from %s", (message) => {
    expect(categorizeResumeError(new Error(message))).toBe("other");
  });
  it.each([
    ["timeout", "resume_timeout", true],
    ["rejected", "auth_failed", false],
    ["incompatible", "resume_incompatible", false],
    ["verification", "resume_verification", false],
    ["protocol", "resume_verification", false],
    ["server", "other", true],
  ] as const)(
    "preserves %s through relay wrapping",
    (kind, reason, retryable) => {
      const error = new RelayReconnectRequiredError(
        new ResumeError(kind, "test evidence"),
      );
      expect(categorizeResumeError(error)).toBe(reason);
      expect(canRetryResume(reason)).toBe(retryable);
      expect(isNonRetryableError(error)).toBe(!retryable);
    },
  );
});
