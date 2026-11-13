import { describe, expect, it, vi } from "vitest";
import { createMachineControlRoutes } from "../../src/routes/machine-control.js";
import { createMachineControlSettingRoutes } from "../../src/routes/machine-control-setting.js";
import type { ServerSettings } from "../../src/services/ServerSettingsService.js";
import type { InstalledMachineControl } from "../../src/machine-control/installation.js";

const installation: InstalledMachineControl = {
  root: "/fixture/mc-cli",
  directory: "/fixture/mc-cli/commands",
  command: "/fixture/mc-cli/commands/machine-control",
  python: "/fixture/python",
  version: "0.5.3",
  sourceRevision: "a".repeat(40),
};

describe("installed MC readiness", () => {
  it.each(["GET", "POST", "PUT", "DELETE"])(
    "refuses retired operations without installation work (%s)",
    async (method) => {
      const verify = vi.fn();
      const routes = createMachineControlRoutes({ verify });
      const response = await routes.request(
        "/computer-control/releases/update",
        { method },
      );
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        error: expect.stringContaining("legacy component is retired"),
      });
      expect(verify).not.toHaveBeenCalled();
    },
  );
  it.each(["darwin", "win32", "linux"])(
    "verifies configured %s installations without enabling launch advertisement",
    async (platform) => {
      const verify = vi.fn().mockResolvedValue(installation);
      const routes = createMachineControlRoutes({
        platform,
        environment: {
          YEP_MC_APP: "configured product",
          YEP_MC_TEAM_ID: "trusted team",
          YEP_MC_PUBLISHER: "trusted publisher",
          YEP_MC_CONTROL: "0",
        },
        verify,
      });
      const response = await routes.request("/machine-control");
      expect(await response.json()).toEqual({
        available: true,
        version: "0.5.3",
        enabled: false,
      });
      expect(verify).toHaveBeenCalledWith(
        "configured product",
        platform === "darwin" ? "trusted team" : "trusted publisher",
        platform,
      );
    },
  );
  it("returns bounded optional unavailability without leaking verification details", async () => {
    const routes = createMachineControlRoutes({
      platform: "linux",
      environment: {},
      verify: async () => {
        throw new Error("private path and signing detail");
      },
      exists: async () => false,
    });
    const response = await routes.request("/machine-control");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: false,
      reason: "installation-unavailable",
      found: false,
      enabled: false,
    });
  });
  it("finds a per-user Mac install with the release publisher when the system one fails", async () => {
    const verify = vi.fn(async (app: string) => {
      if (app.startsWith("/Applications/")) throw new Error("absent");
      return installation;
    });
    const routes = createMachineControlRoutes({
      platform: "darwin",
      environment: { HOME: "/Users/example" },
      verify,
      exists: async () => false,
    });
    expect(await (await routes.request("/machine-control")).json()).toEqual({
      available: true,
      version: "0.5.3",
      enabled: false,
    });
    expect(verify.mock.calls).toEqual([
      ["/Applications/Machine Control.app", "VD7BYQ6ABM", "darwin"],
      [
        "/Users/example/Applications/Machine Control.app",
        "VD7BYQ6ABM",
        "darwin",
      ],
    ]);
  });
  it("searches nowhere else when the operator names an installation", async () => {
    const verify = vi.fn(async () => {
      throw new Error("tampered");
    });
    const routes = createMachineControlRoutes({
      platform: "darwin",
      environment: { HOME: "/Users/example", YEP_MC_APP: "/opt/Chosen.app" },
      verify,
      exists: async (path) => path === "/opt/Chosen.app",
    });
    // An occupied location that fails verification is reported as found.
    expect(await (await routes.request("/machine-control")).json()).toEqual({
      available: false,
      reason: "installation-unavailable",
      found: true,
      enabled: false,
    });
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it("does not execute an installation probe on unsupported hosts", async () => {
    const verify = vi.fn();
    const routes = createMachineControlRoutes({ platform: "freebsd", verify });
    expect(await (await routes.request("/machine-control")).json()).toEqual({
      available: false,
      reason: "unsupported-host",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("stores the default-advertisement setting and reports it with readiness", async () => {
    const stored: Partial<ServerSettings> = {};
    const settings = {
      getSetting: (key: keyof ServerSettings) => stored[key],
      updateSettings: async (updates: Partial<ServerSettings>) =>
        Object.assign(stored, updates),
    } as unknown as NonNullable<
      Parameters<typeof createMachineControlSettingRoutes>[0]
    >;
    const write = createMachineControlSettingRoutes(settings);
    const put = (body: unknown) =>
      write.request("/machine-control", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const invalid of [{}, { enabled: "yes" }, null])
      expect((await put(invalid)).status).toBe(400);
    expect(stored).toEqual({});
    expect(await (await put({ enabled: true })).json()).toEqual({
      enabled: true,
    });
    const read = createMachineControlRoutes({
      platform: "linux",
      environment: {},
      verify: async () => installation,
      settings,
    });
    expect(await (await read.request("/machine-control")).json()).toEqual({
      available: true,
      version: "0.5.3",
      enabled: true,
    });
    const unbacked = await createMachineControlSettingRoutes().request(
      "/machine-control",
      { method: "PUT", body: JSON.stringify({ enabled: true }) },
    );
    expect(unbacked.status).toBe(503);
  });
});
