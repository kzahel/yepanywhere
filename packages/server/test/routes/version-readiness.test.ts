import type { SessionSandboxAvailability } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createVersionRoutes,
  type CurrentVersionInfo,
  type DeviceBridgeStatus,
} from "../../src/routes/version.js";

describe("version readiness", () => {
  it.each([false, true])(
    "starts independent probes together (fresh=%s)",
    async (fresh) => {
      const current = Promise.withResolvers<CurrentVersionInfo>();
      const bridge = Promise.withResolvers<DeviceBridgeStatus>();
      const sandbox = Promise.withResolvers<SessionSandboxAvailability>();
      const latest = Promise.withResolvers<string | null>();
      const getCurrentVersionInfo = vi.fn(() => current.promise);
      const getDeviceBridgeStatus = vi.fn(() => bridge.promise);
      const getSessionSandboxAvailability = vi.fn(() => sandbox.promise);
      const getLatestVersion = vi.fn(() => latest.promise);
      const routes = createVersionRoutes({
        getCurrentVersionInfo,
        getDeviceBridgeStatus,
        getSessionSandboxAvailability,
        getLatestVersion,
      });
      let settled = false;
      const response = Promise.resolve(
        routes.request(fresh ? "/?fresh=1" : "/"),
      ).then((r) => {
        settled = true;
        return r;
      });
      try {
        await vi.waitFor(() => {
          expect(getCurrentVersionInfo).toHaveBeenCalledTimes(1);
          expect(getDeviceBridgeStatus).toHaveBeenCalledWith({
            forceRefresh: fresh,
          });
          expect(getSessionSandboxAvailability).toHaveBeenCalledWith({
            forceRefresh: fresh,
          });
        });
        expect(getLatestVersion).not.toHaveBeenCalled();
        current.resolve({ version: "0.9.2-3-g123", installSource: "source" });
        await vi.waitFor(() =>
          expect(getLatestVersion).toHaveBeenCalledWith("0.9.2", undefined, {
            forceRefresh: fresh,
          }),
        );
        latest.resolve("0.9.3");
        expect(settled).toBe(false);
      } finally {
        current.resolve({ version: "0.9.2-3-g123", installSource: "source" });
        bridge.resolve({ state: "unavailable" });
        sandbox.resolve({ state: "unsupported-platform", platform: "test" });
        latest.resolve("0.9.3");
        await response;
      }
      expect(await (await response).json()).toMatchObject({
        current: "0.9.2-3-g123",
        latest: "0.9.3",
        updateAvailable: true,
        deviceBridgeState: "unavailable",
        sessionSandboxing: { state: "unsupported-platform", platform: "test" },
      });
    },
  );
});
