import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultInstallation,
  verifyClientFiles,
  verifyInstalledMachineControl,
} from "../../src/machine-control/installation.js";
import { startMachineControlSession } from "../../src/sdk/providers/machine-control.js";
import type {
  AgentSession,
  StartSessionOptions,
} from "../../src/sdk/providers/types.js";

const environment = {
  YEP_MC_CONTROL: "1",
  YEP_MC_APP: "/Applications/Example.app",
  YEP_MC_TEAM_ID: "EXAMPLE123",
  PATH: "/usr/bin:/bin",
};
const options: StartSessionOptions = {
  cwd: "/project",
  permissionMode: "bypassPermissions",
};
const installed = {
  root: "/verified/mc-cli",
  directory: "/verified/mc-cli/commands",
  command: "/verified/mc-cli/commands/machine-control",
  python: "/verified/python3",
  version: "1.2.3",
  sourceRevision: "a".repeat(40),
};
const start = () =>
  vi.fn(async (_options: StartSessionOptions) => ({}) as AgentSession);

describe("installed Machine Control launch", () => {
  it("discovers the packaged Linux resource root and preserves explicit locations", async () => {
    expect(defaultInstallation("linux", {})).toBe("/usr/share/machine-control");
    const verify = vi.fn(async () => installed);
    for (const app of [
      undefined,
      "/opt/Example App/usr/share/machine-control",
    ]) {
      await startMachineControlSession("codex", options, start(), {
        environment: { YEP_MC_CONTROL: "1", YEP_MC_APP: app },
        platform: "linux",
        verify,
      });
      expect(verify).toHaveBeenLastCalledWith(
        app ?? "/usr/share/machine-control",
        undefined,
        "linux",
      );
    }
  });

  it("preserves default and explicit-disabled launch options without discovery", async () => {
    const verify = vi.fn();
    for (const [launch, env] of [
      [options, {}],
      [{ ...options, machineControl: false }, environment],
    ] as const) {
      const launchProvider = start();
      await startMachineControlSession("codex", launch, launchProvider, {
        environment: env,
        platform: "darwin",
        verify,
      });
      expect(launchProvider).toHaveBeenCalledWith(launch);
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it("does not advertise unsupported, remote, plan or sandboxed sessions", async () => {
    const verify = vi.fn();
    for (const launch of [
      { ...options, permissionMode: "default" as const },
      { ...options, permissionMode: "plan" as const },
      { ...options, executor: { name: "remote" } },
      { ...options, sessionSandboxOptions: { level: "project-write" } },
    ] as StartSessionOptions[]) {
      const launchProvider = start();
      await startMachineControlSession("codex", launch, launchProvider, {
        environment,
        platform: "darwin",
        verify,
      });
      expect(launchProvider).toHaveBeenCalledWith(launch);
    }
    await startMachineControlSession("pi", options, start(), {
      environment,
      platform: "darwin",
      verify,
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("adds only verified command discovery while preserving existing context", async () => {
    const launchProvider = start();
    const verify = vi.fn(async () => ({
      ...installed,
      command: "/verified/Example App's CLI/machine-control",
    }));
    await startMachineControlSession(
      "codex",
      {
        ...options,
        globalInstructions: "Existing",
        agentEnvironment: { AGENT_YA_API_TOKEN: "synthetic" },
      },
      launchProvider,
      { environment, platform: "darwin", verify },
    );
    const launch = launchProvider.mock.calls[0]?.[0];
    expect(launch?.globalInstructions).toContain("Existing");
    expect(launch?.globalInstructions).toContain("App'\\''s CLI");
    expect(launch?.globalInstructions).toContain("agent instructions");
    expect(launch?.agentEnvironment).toEqual({
      AGENT_YA_API_TOKEN: "synthetic",
      PATH: `${installed.directory}${delimiter}${environment.PATH}`,
    });
    expect(verify).toHaveBeenCalledWith(
      environment.YEP_MC_APP,
      environment.YEP_MC_TEAM_ID,
      "darwin",
    );
  });

  it("refuses configured verification failure before provider creation", async () => {
    const launchProvider = start();
    await expect(
      startMachineControlSession("codex", options, launchProvider, {
        environment,
        platform: "darwin",
        verify: async () => {
          throw new Error("bad signature");
        },
      }),
    ).rejects.toThrow("integrity");
    expect(launchProvider).not.toHaveBeenCalled();
  });

  it("applies the operator default unless the launch declines, and never blocks on it", async () => {
    const enabledByDefault = () => true;
    const dependencies = {
      environment: { PATH: "/usr/bin" },
      platform: "linux",
      enabledByDefault,
    };
    const advertised = start();
    await startMachineControlSession("codex", options, advertised, {
      ...dependencies,
      verify: async () => installed,
    });
    expect(advertised.mock.calls[0]?.[0].globalInstructions).toContain(
      "agent instructions",
    );

    const verify = vi.fn(async () => installed);
    const declined = start();
    const launch = { ...options, machineControl: false };
    await startMachineControlSession("codex", launch, declined, {
      ...dependencies,
      verify,
    });
    expect(declined).toHaveBeenCalledWith(launch);
    expect(verify).not.toHaveBeenCalled();

    // A standing default must not fail every launch once the app is removed;
    // a choice made for this launch still refuses.
    const missing = async () => {
      throw new Error("absent");
    };
    const unadvertised = start();
    await startMachineControlSession("codex", options, unadvertised, {
      ...dependencies,
      verify: missing,
      exists: async () => false,
    });
    expect(unadvertised).toHaveBeenCalledWith(options);
    await expect(
      startMachineControlSession(
        "codex",
        { ...options, machineControl: true },
        start(),
        { ...dependencies, verify: missing, exists: async () => false },
      ),
    ).rejects.toThrow("integrity");
  });

  it("refuses a retired component selection before discovery", async () => {
    await expect(
      startMachineControlSession(
        "codex",
        {
          ...options,
          computerControl: true,
        },
        start(),
        { environment, platform: "darwin", verify: async () => installed },
      ),
    ).rejects.toThrow("legacy component");
  });

  it("quotes Windows instructions for PowerShell without executing a batch probe", async () => {
    const launchProvider = start();
    await startMachineControlSession("codex", options, launchProvider, {
      environment,
      platform: "win32",
      verify: async () => ({
        ...installed,
        root: "C:\\Example App's CLI\\mc-cli",
        command: "C:\\Example App's CLI\\machine-control.cmd",
      }),
    });
    expect(launchProvider.mock.calls[0]?.[0].globalInstructions).toContain(
      "& 'C:\\Example App''s CLI\\machine-control.cmd' agent instructions",
    );
    expect(
      launchProvider.mock.calls[0]?.[0].agentEnvironment
        ?.MACHINE_CONTROL_DESKTOP_INSTALL_DIR,
    ).toBe("C:\\Example App's CLI");
  });
});

describe("installed client authenticity", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function fixture(platform = "darwin") {
    const app = await mkdtemp(join(tmpdir(), "ya-mc-install-"));
    directories.push(app);
    if (platform === "win32") {
      await mkdir(join(app, "runtime"));
      await writeFile(join(app, "runtime", "running.exe"), "native fixture");
    }
    const root =
      platform === "darwin"
        ? join(app, "Contents", "Resources", "mc-cli")
        : join(app, "mc-cli");
    await mkdir(root, { recursive: true });
    const identity = {
      schema: "machine-control-client-identity/v1",
      clientProtocol: 1,
      residentProtocol: "machine-control/v0",
      distribution: "desktop",
      version: "1.2.3",
      sourceRevision: "a".repeat(40),
      platform: platform === "darwin" ? "macos" : "windows",
      target: `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "darwin" ? "apple-darwin" : "pc-windows-msvc"}`,
      command:
        platform === "darwin"
          ? "commands/machine-control"
          : "commands/machine-control.cmd",
      pythonVersion: "3.12.15",
      pythonArchiveSha256: "b".repeat(64),
      features: [
        "agent.instructions",
        "host.desktop",
        "host.browser",
        "host.claims",
      ],
    };
    const file = Buffer.from(JSON.stringify(identity));
    await writeFile(join(root, "client-runtime.json"), file);
    const files = [
      {
        path: "client-runtime.json",
        byteLength: file.length,
        sha256: createHash("sha256").update(file).digest("hex"),
      },
    ];
    for (const path of [
      "launch.py",
      "client/machine_control.py",
      "client/agent_interface.py",
      "client/scoped_run.py",
      "client/scoped_process.py",
      "providers/claims/claims.py",
      platform === "darwin"
        ? "commands/machine-control"
        : "commands/machine-control.cmd",
      platform === "darwin" ? "python/bin/python3" : "python/python.exe",
      platform === "darwin"
        ? "platforms/macos/bin/machost"
        : "platforms/windows/host/winhost.py",
    ]) {
      const destination = join(root, path);
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, "fixture");
      files.push({
        path,
        byteLength: 7,
        sha256: createHash("sha256").update("fixture").digest("hex"),
      });
    }
    const receipt = Buffer.from(
      JSON.stringify({ schema: "machine-control-client-files/v1", files }),
    );
    await writeFile(join(root, "files.json"), receipt);
    return { app, root, identity, receipt };
  }

  it("authenticates before executing any installed probe", async () => {
    const { app, identity } = await fixture();
    const run = vi.fn(async (command: string) =>
      command === "/usr/bin/codesign" ? "" : JSON.stringify(identity),
    );
    const result = await verifyInstalledMachineControl(
      app,
      "EXAMPLE123",
      "darwin",
      run,
    );
    expect(result.version).toBe("1.2.3");
    expect(run.mock.calls[0]?.[0]).toBe("/usr/bin/codesign");
    expect(run.mock.calls[1]?.[0]).toContain(join("python", "bin", "python3"));
  });

  it("requires authenticated Windows native dependency and CLI identities to agree before a probe", async () => {
    const { app, identity } = await fixture("win32");
    const runtime = {
      sourceRevision: identity.sourceRevision,
      runtime: process.arch === "arm64" ? "win-arm64" : "win-x64",
      version: identity.version,
    };
    const snapshots: string[] = [];
    const run = vi.fn(
      async (_command: string, args: string[], input?: string) => {
        if (!args.includes("-EncodedCommand")) return JSON.stringify(identity);
        const snapshot = JSON.parse(input ?? "{}").runtimeSnapshot as string;
        snapshots.push(snapshot);
        expect(snapshot).not.toBe(join(app, "runtime"));
        expect(await readFile(join(snapshot, "running.exe"), "utf8")).toBe(
          "native fixture",
        );
        return JSON.stringify(runtime);
      },
    );
    await verifyInstalledMachineControl(app, "Example Publisher", "win32", run);
    const powershell = Buffer.from(
      run.mock.calls[0]?.[1][3] ?? "",
      "base64",
    ).toString("utf16le");
    expect(powershell).toContain("runtime/package.cat");
    expect(powershell).toContain("runtime/machine-control-windows.exe");
    expect(powershell).toContain("MC runtime catalog mismatch");
    expect(powershell).toContain("[version]'0.5.3'");
    expect(powershell).toContain("-Path (Join-Path $p.root 'files.json')");
    expect(powershell).toContain("MC CLI inventory catalog mismatch");
    run.mockClear();
    runtime.sourceRevision = "b".repeat(40);
    await expect(
      verifyInstalledMachineControl(app, "Example Publisher", "win32", run),
    ).rejects.toThrow("incompatible");
    expect(run).toHaveBeenCalledTimes(1);
    for (const snapshot of snapshots)
      await expect(
        readFile(join(snapshot, "running.exe")),
      ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a changed Windows payload after catalog authentication without executing its probe", async () => {
    const { app, root, identity } = await fixture("win32");
    await writeFile(join(root, "client", "machine_control.py"), "changed");
    const run = vi.fn(async () =>
      JSON.stringify({
        sourceRevision: identity.sourceRevision,
        runtime: process.arch === "arm64" ? "win-arm64" : "win-x64",
        version: identity.version,
      }),
    );
    await expect(
      verifyInstalledMachineControl(app, "Example Publisher", "win32", run),
    ).rejects.toThrow("digest mismatch");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not run installed code after publisher or payload failure", async () => {
    const { app, root } = await fixture();
    const badPublisher = vi.fn(async () => {
      throw new Error("wrong team");
    });
    await expect(
      verifyInstalledMachineControl(app, "EXAMPLE123", "darwin", badPublisher),
    ).rejects.toThrow("wrong team");
    expect(badPublisher).toHaveBeenCalledTimes(1);
    await writeFile(join(root, "injected.py"), "injected");
    const run = vi.fn(async () => "");
    await expect(
      verifyInstalledMachineControl(app, "EXAMPLE123", "darwin", run),
    ).rejects.toThrow("Unexpected");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects changed files and a receipt path escaping the installation", async () => {
    const { root, receipt } = await fixture();
    await writeFile(join(root, "client-runtime.json"), "tampered");
    await expect(verifyClientFiles(root, receipt)).rejects.toThrow(
      "identity mismatch",
    );
    const value = JSON.parse(
      (await readFile(join(root, "files.json"))).toString(),
    );
    value.files[0].path = "../outside";
    await expect(
      verifyClientFiles(root, Buffer.from(JSON.stringify(value))),
    ).rejects.toThrow("payload path");
  });

  it("refuses unsupported client protocols without executing a probe", async () => {
    const { app, root, identity } = await fixture();
    const file = Buffer.from(
      JSON.stringify({ ...identity, clientProtocol: 2 }),
    );
    await writeFile(join(root, "client-runtime.json"), file);
    const inventory = JSON.parse(
      (await readFile(join(root, "files.json"))).toString(),
    );
    inventory.files[0] = {
      path: "client-runtime.json",
      byteLength: file.length,
      sha256: createHash("sha256").update(file).digest("hex"),
    };
    await writeFile(join(root, "files.json"), JSON.stringify(inventory));
    const run = vi.fn(async () => "");
    await expect(
      verifyInstalledMachineControl(app, "EXAMPLE123", "darwin", run),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
