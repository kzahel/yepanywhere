import { describe, expect, it } from "vitest";
import {
  ProviderMemoryBudget,
  ProviderMemoryCapacityError,
  readCgroupMemory,
} from "../src/sdk/providers/provider-memory-budget.mjs";

const MiB = 2 ** 20;
const ample = () => ({ total: 16_384 * MiB, available: 12_288 * MiB });
const empty = () => [];

describe("provider memory budget", () => {
  it("uses reclaimable cache at a namespaced cgroup root and stops there", () => {
    const files = new Map([
      ["/proc/self/cgroup", "0::/\n"],
      ["/sys/fs/cgroup/memory.max", String(1024 * MiB)],
      ["/sys/fs/cgroup/memory.high", "max"],
      ["/sys/fs/cgroup/memory.current", String(700 * MiB)],
      ["/sys/fs/cgroup/memory.stat", `inactive_file ${640 * MiB}\n`],
    ]);
    const reads: string[] = [];
    const result = readCgroupMemory((file) => {
      reads.push(file);
      return files.get(file) ?? "";
    });
    expect(result).toEqual({ total: 1024 * MiB, available: 964 * MiB });
    expect(reads).toEqual([...files.keys()]);
  });

  it("reserves competing starts before either can spawn and releases once", async () => {
    const budget = new ProviderMemoryBudget({ limit: "1024", readHost: ample });
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => budget.reserve("claude", empty)),
    );
    const releases = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(releases).toHaveLength(2);
    expect(results[2]).toMatchObject({
      status: "rejected",
      reason: { outcome: "capacity_unavailable" },
    });
    releases[0]!();
    releases[0]!();
    await budget.reserve("codex", empty);
    await expect(budget.reserve("claude", empty)).rejects.toBeInstanceOf(
      ProviderMemoryCapacityError,
    );
  });

  it("charges observed descendants and retained process groups above the harness estimate", async () => {
    const budget = new ProviderMemoryBudget({
      limit: "1024",
      readHost: ample,
      readProcesses: async () => [
        { pid: 10, parent: 1, group: 10, bytes: 200 * MiB },
        { pid: 11, parent: 10, group: 10, bytes: 200 * MiB },
        { pid: 12, parent: 1, group: 20, bytes: 300 * MiB },
      ],
    });
    await expect(
      budget.reserve("codex", () => [
        { provider: "claude", pid: 10, processGroupIds: [10] },
        { processGroupIds: [20] },
      ]),
    ).rejects.toThrow(/live estimate 812 MiB/);
  });

  it("excludes Windows orphans older than the process that reused their parent ID", async () => {
    const budget = new ProviderMemoryBudget({
      limit: "1024",
      readHost: ample,
      readProcesses: async () => [
        { pid: 10, parent: 1, group: 0, started: 2, bytes: 300 * MiB },
        { pid: 11, parent: 10, group: 0, started: 1, bytes: 500 * MiB },
        { pid: 12, parent: 10, group: 0, started: 3, bytes: 250 * MiB },
      ],
    });
    const roots = () => [{ provider: "claude", pid: 10 }];
    const release = await budget.reserve("codex", roots);
    release();
    await expect(budget.reserve("claude", roots)).rejects.toThrow(
      /live estimate 550 MiB/,
    );
  });

  it("uses half the effective limit by default and protects system headroom separately", async () => {
    let available = 2048 * MiB;
    const budget = new ProviderMemoryBudget({
      limit: "",
      readHost: () => ({ available, total: 2048 * MiB }),
    });
    const release = await budget.reserve("claude", empty);
    await expect(
      budget.reserve("claude", () => [{ provider: "codex" }]),
    ).rejects.toThrow(/provider budget/);
    release();
    available = 700 * MiB;
    await expect(budget.reserve("claude", empty)).rejects.toThrow(
      /system headroom/,
    );
  });

  it("uses a conservative provider estimate when attribution is unavailable", async () => {
    const budget = new ProviderMemoryBudget({
      limit: "895",
      readHost: ample,
      readProcesses: async () => {
        throw new Error("process table unavailable");
      },
    });
    await expect(
      budget.reserve("codex", () => [{ provider: "claude", pid: 10 }]),
    ).rejects.toThrow(/live estimate 512 MiB/);
  });
});
