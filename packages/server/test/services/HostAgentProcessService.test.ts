import { parseNativeSessionId, parseYaSessionId } from "@yep-anywhere/shared";
import type { NativeProcessSession } from "../../src/services/providerProcessClassifier.js";
import type { ProcessInfo } from "../../src/supervisor/types.js";
import {
  HostAgentProcessService,
  parseLinuxProcCpuTicks,
  parseProcessCpuTime,
  parsePsSnapshot,
  type HostProcessSnapshot,
} from "../../src/services/HostAgentProcessService.js";
import { describe, expect, it, vi } from "vitest";

function ownedProcess(pid: number): ProcessInfo {
  return {
    id: "owned-process",
    sessionId: "owned-session",
    projectId: "project" as ProcessInfo["projectId"],
    projectPath: "/project",
    projectName: "project",
    sessionTitle: null,
    state: "idle",
    startedAt: "2026-07-28T12:00:00.000Z",
    queueDepth: 0,
    provider: "codex",
    pid,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("HostAgentProcessService", () => {
  it("parses cumulative CPU time and reduces ps rows to safe fields", () => {
    expect(parseProcessCpuTime("01:02")).toBe(62_000);
    expect(parseProcessCpuTime("02:03:04")).toBe(7_384_000);
    expect(parseProcessCpuTime("2-03:04:05")).toBe(183_845_000);
    expect(
      parseLinuxProcCpuTicks(
        "42 (agent helper) S 1 2 3 4 5 6 7 8 9 10 125 25 0 0",
      ),
    ).toBe(150);

    const snapshots = parsePsSnapshot(
      "1000 42 1 512 00:00:03 Tue Jul 28 12:00:00 2026 codex",
      1000,
    );
    expect(snapshots).toEqual([
      expect.objectContaining({
        pid: 42,
        parentPid: 1,
        cpuTimeMs: 3_000,
        rssBytes: 512 * 1024,
        provider: "codex",
      }),
    ]);
    expect(Object.keys(snapshots[0] ?? {})).not.toContain("command");
  });

  it("joins owned roots, collapses provider descendants, and samples CPU", async () => {
    let sampledAtMs = Date.parse("2026-07-28T12:00:10.000Z");
    let rootCpuTimeMs = 1_000;
    let preciseRootCpuTimeMs = 1_000;
    let preciseChildCpuTimeMs = 100;
    const readSnapshot = async (): Promise<HostProcessSnapshot[]> => [
      {
        pid: 100,
        parentPid: 1,
        startedAtMs: Date.parse("2026-07-28T12:00:00.000Z"),
        cpuTimeMs: rootCpuTimeMs,
        rssBytes: 100,
      },
      {
        pid: 101,
        parentPid: 100,
        startedAtMs: Date.parse("2026-07-28T12:00:01.000Z"),
        cpuTimeMs: 100,
        rssBytes: 50,
      },
      {
        pid: 200,
        parentPid: 1,
        startedAtMs: Date.parse("2026-07-28T11:00:00.000Z"),
        cpuTimeMs: 500,
        rssBytes: 200,
        provider: "claude",
      },
      {
        pid: 201,
        parentPid: 200,
        startedAtMs: Date.parse("2026-07-28T11:00:01.000Z"),
        cpuTimeMs: 300,
        rssBytes: 75,
        provider: "claude",
      },
      {
        pid: 300,
        parentPid: 1,
        startedAtMs: Date.parse("2026-07-28T10:00:00.000Z"),
        cpuTimeMs: 0,
        rssBytes: 999,
      },
    ];
    const service = new HostAgentProcessService(
      readSnapshot,
      "linux",
      () => sampledAtMs,
      async () =>
        new Map([
          [100, preciseRootCpuTimeMs],
          [101, preciseChildCpuTimeMs],
        ]),
    );

    const first = await service.sample([ownedProcess(100)]);
    expect(first.observations).toHaveLength(2);
    expect(first.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: 100,
          supervision: "ya",
          supervisorProcessId: "owned-process",
          memory: {
            rootRssBytes: 100,
            treeRssBytes: 150,
            descendantCount: 1,
          },
        }),
        expect.objectContaining({
          pid: 200,
          supervision: "external",
          provider: "claude",
          memory: {
            rootRssBytes: 200,
            treeRssBytes: 275,
            descendantCount: 1,
          },
        }),
      ]),
    );
    expect(first.observations.every((observation) => !observation.cpu)).toBe(
      true,
    );

    sampledAtMs += 6_000;
    rootCpuTimeMs += 500;
    preciseRootCpuTimeMs += 500;
    preciseChildCpuTimeMs += 300;
    const second = await service.sample([ownedProcess(100)]);
    expect(
      second.observations.find((observation) => observation.pid === 100)?.cpu,
    ).toEqual({ rootPercent: 8.3, treePercent: 13.3, windowMs: 6_000 });
    expect(JSON.stringify(second)).not.toMatch(
      /command|environment|executable|workingDirectory/i,
    );
  });

  it("reports unsupported platforms without reading the process table", async () => {
    let read = false;
    const service = new HostAgentProcessService(async () => {
      read = true;
      return [];
    }, "win32");

    expect(await service.sample([])).toEqual({
      enabled: true,
      supported: false,
      observations: [],
    });
    expect(read).toBe(false);
  });

  it("shares one in-flight snapshot for simultaneous equivalent requests", async () => {
    const snapshot = deferred<HostProcessSnapshot[]>();
    const readSnapshot = vi.fn(() => snapshot.promise);
    const service = new HostAgentProcessService(
      readSnapshot,
      "linux",
      () => Date.parse("2026-07-28T12:00:10.000Z"),
      async () => new Map(),
    );

    const first = service.sample([ownedProcess(100)]);
    const second = service.sample([ownedProcess(100)]);
    expect(readSnapshot).toHaveBeenCalledOnce();

    snapshot.resolve([]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ observations: [] }),
      expect.objectContaining({ observations: [] }),
    ]);
  });
});

describe("HostAgentProcessService session correlation", () => {
  it("names external roots' sessions from the provider record, enriching once per process", async () => {
    let now = Date.parse("2026-07-28T12:00:10.000Z");
    const startedAtMs = Date.parse("2026-07-28T11:00:00.000Z");
    const snapshot = (pid: number, provider: "claude" | "codex") => ({
      pid,
      parentPid: 1,
      startedAtMs,
      cpuTimeMs: 0,
      rssBytes: 1,
      provider,
    });
    const readNativeSession = vi.fn(async (_provider: string, pid: number) =>
      pid === 200
        ? {
            nativeSessionId: parseNativeSessionId("external-session"),
            projectPath: "/work/project",
          }
        : undefined,
    );
    const describeSession = vi.fn(
      async (sessions: readonly NativeProcessSession[]) =>
        new Map(
          sessions.map((session) => [
            session,
            {
              sessionId: parseYaSessionId("external-session"),
              projectId: "cHJvamVjdA" as ProcessInfo["projectId"],
              sessionTitle: "Port rendez",
            },
          ]),
        ),
    );
    const service = new HostAgentProcessService(
      async () => [snapshot(100, "codex"), snapshot(200, "claude")],
      "linux",
      () => now,
      async () => new Map(),
      readNativeSession,
      describeSession,
    );

    const first = await service.sample([ownedProcess(100)]);
    now += 5_000;
    const second = await service.sample([ownedProcess(100)]);

    for (const response of [first, second]) {
      const byPid = new Map(response.observations.map((o) => [o.pid, o]));
      expect(byPid.get(200)).toMatchObject({
        supervision: "external",
        sessionId: "external-session",
        projectId: "cHJvamVjdA",
        sessionTitle: "Port rendez",
      });
      expect(byPid.get(100)?.sessionId).toBeUndefined();
    }
    // Owned rows are already joined; only the external root is looked up,
    // and the title lookup is not repeated on a metrics refresh.
    expect(readNativeSession).toHaveBeenCalledOnce();
    expect(describeSession).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          nativeSessionId: "external-session",
          projectPath: "/work/project",
        }),
      ],
      expect.any(AbortSignal),
    );
    expect(describeSession).toHaveBeenCalledOnce();
  });
});
