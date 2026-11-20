import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const MiB = 2 ** 20;
const exec = promisify(execFile);
const SNAPSHOT_MS = 1_000;
const WINDOWS_PROCESS_QUERY = `
Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,CreationDate | ForEach-Object {
  $started = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks } else { 0 }
  "{0} {1} 0 {2} {3}" -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize,$started
}
`;

export class ProviderMemoryCapacityError extends Error {
  outcome = "capacity_unavailable";

  constructor(
    message = "Provider launch refused because memory capacity is unavailable",
  ) {
    super(message);
    this.name = "ProviderMemoryCapacityError";
  }
}

export function providerHostRequestError(response, op) {
  const message = response.error ?? `${op} failed`;
  return response.outcome === "capacity_unavailable"
    ? new ProviderMemoryCapacityError(message)
    : new Error(message);
}

function memAvailable() {
  if (process.platform !== "linux") return Infinity;
  try {
    const value = /^MemAvailable:\s+(\d+) kB$/m.exec(
      readFileSync("/proc/meminfo", "utf8"),
    )?.[1];
    return value ? Number(value) * 1024 : Infinity;
  } catch {
    return Infinity;
  }
}

export function readCgroupMemory(read = (file) => readFileSync(file, "utf8")) {
  const root = "/sys/fs/cgroup";
  let total = Infinity;
  let available = Infinity;
  try {
    const membership = /^0::(\/.*)$/m.exec(read("/proc/self/cgroup"))?.[1];
    if (!membership || membership.split("/").includes(".."))
      return { total, available };
    for (
      let path = resolve(root, `.${membership}`);
      path === root || path.startsWith(`${root}/`);
      path = dirname(path)
    ) {
      try {
        const limit = Math.min(
          ...["memory.max", "memory.high"].map((file) => {
            const value = read(join(path, file)).trim();
            return value === "max" ? Infinity : Number(value);
          }),
        );
        if (Number.isFinite(limit)) {
          total = Math.min(total, limit);
          const current = Number(read(join(path, "memory.current")));
          const reclaimable = Number(
            /^inactive_file (\d+)$/m.exec(
              read(join(path, "memory.stat")),
            )?.[1] ?? 0,
          );
          available = Math.min(
            available,
            Math.max(0, limit - current + reclaimable),
          );
        }
      } catch {
        // The controller can be unavailable at an individual hierarchy level.
      }
    }
  } catch {
    // Other cgroup layouts fall back to the runtime's memory constraint.
  }
  return { total, available };
}

async function darwinAvailable() {
  // Older Node and Bun report free pages only in availableMemory().
  const { stdout } = await exec("/usr/bin/vm_stat", {
    timeout: 1_000,
    maxBuffer: 16 * 1024,
    env: { LC_ALL: "C" },
  });
  const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]);
  const counts = [
    ...stdout.matchAll(/^Pages (?:free|inactive|purgeable):\s+(\d+)\.$/gm),
  ];
  if (!pageSize || counts.length !== 3)
    throw new Error("Unrecognized vm_stat output");
  return pageSize * counts.reduce((sum, match) => sum + Number(match[1]), 0);
}

const runtimeAvailable = () => process.availableMemory?.() ?? freemem();
const readDarwinAvailable = cachedSample(darwinAvailable, runtimeAvailable);

async function hostMemory() {
  const physical = totalmem();
  const runtimeLimit = process.constrainedMemory?.() || Infinity;
  if (process.platform === "darwin")
    return {
      total: Math.min(physical, runtimeLimit),
      available: await readDarwinAvailable(),
    };
  if (process.platform !== "linux")
    return {
      total: Math.min(physical, runtimeLimit),
      available: runtimeAvailable(),
    };
  const cgroup = readCgroupMemory();
  const linuxAvailable = memAvailable();
  return {
    total: Math.min(physical, cgroup.total, runtimeLimit),
    available: Math.min(
      cgroup.available,
      linuxAvailable,
      runtimeLimit < Math.min(physical, cgroup.total) ||
        !Number.isFinite(Math.min(cgroup.available, linuxAvailable)) ||
        (Number.isFinite(cgroup.total) && !Number.isFinite(cgroup.available))
        ? runtimeAvailable()
        : Infinity,
    ),
  };
}

async function processMemory() {
  const windows = process.platform === "win32";
  const executable = windows
    ? join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "/bin/ps";
  const args = windows
    ? ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY]
    : ["-axo", "pid=,ppid=,pgid=,rss="];
  const { stdout } = await exec(executable, args, {
    timeout: 4_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout
    .trim()
    .split(/\r?\n/)
    .flatMap((line) => {
      const columns = line.trim().split(/\s+/);
      if (
        columns.length !== (windows ? 5 : 4) ||
        columns.some((value) => !/^\d+$/.test(value))
      )
        return [];
      const [pid, parent, group, memory, started] = columns.map(Number);
      return [
        { pid, parent, group, started, bytes: memory * (windows ? 1 : 1024) },
      ];
    });
}

function cachedSample(read, fallback) {
  let promise;
  let until = 0;
  return () => {
    if (Date.now() >= until) {
      until = Infinity;
      promise = Promise.resolve()
        .then(read)
        .catch(fallback)
        .finally(() => {
          until = Date.now() + SNAPSHOT_MS;
        });
    }
    return promise;
  };
}

function startupBytes(provider) {
  return (provider.startsWith("claude") ? 512 : 384) * MiB;
}

function liveBytes(roots, rows) {
  const children = new Map();
  const groups = new Map();
  const byPid = new Map();
  for (const row of rows) byPid.set(row.pid, row);
  for (const row of byPid.values()) {
    const parent = byPid.get(row.parent);
    // Windows can report an orphan's former parent ID after it was reused.
    if (!(row.started && parent?.started && row.started < parent.started)) {
      if (!children.has(row.parent)) children.set(row.parent, []);
      children.get(row.parent).push(row);
    }
    if (!row.group) continue;
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(row);
  }
  const counted = new Set();
  let total = 0;
  for (const { provider, pid, processGroupIds = [] } of roots) {
    const pending = [...(children.get(pid) ?? [])];
    const root = byPid.get(pid);
    if (root) pending.push(root);
    for (const group of processGroupIds)
      pending.push(...(groups.get(group) ?? []));
    let measured = 0;
    while (pending.length) {
      const row = pending.pop();
      if (counted.has(row.pid)) continue;
      counted.add(row.pid);
      measured += row.bytes;
      pending.push(...(children.get(row.pid) ?? []));
    }
    total += Math.max(measured, provider ? startupBytes(provider) : 0);
  }
  return total;
}

export class ProviderMemoryBudget {
  #reserved = 0;
  #budget;
  #readHost;
  #readProcesses;

  constructor({
    limit = process.env.YEP_PROVIDER_MEMORY_LIMIT_MIB,
    readHost = hostMemory,
    readProcesses = processMemory,
  } = {}) {
    const value = limit?.trim();
    if (
      value &&
      /^\d+$/.test(value) &&
      Number.isSafeInteger(Number(value) * MiB)
    )
      this.#budget = Number(value) * MiB;
    this.#readHost = readHost;
    this.#readProcesses = cachedSample(readProcesses, () => []);
  }

  async reserve(provider, readRoots) {
    if (this.#budget === 0) return () => {};
    const [{ total, available }, rows] = await Promise.all([
      this.#readHost(),
      readRoots().some(({ pid, processGroupIds }) => pid || processGroupIds)
        ? this.#readProcesses()
        : [],
    ]);
    const budget = Math.min(total, this.#budget ?? Math.floor(total / 2));
    const headroom = Math.min(2 * 1024 * MiB, Math.ceil(total / 8));
    const reservation = startupBytes(provider);
    const pending = this.#reserved + reservation;
    const live = liveBytes(readRoots(), rows);
    if (live + pending > budget || available - pending < headroom) {
      const reason =
        live + pending > budget ? "provider budget" : "system headroom";
      throw new ProviderMemoryCapacityError(
        `Provider launch refused for ${reason} (live estimate ${Math.ceil(live / MiB)} MiB, reserved with request ${Math.ceil(pending / MiB)} MiB, budget ${Math.floor(budget / MiB)} MiB, available ${Math.floor(available / MiB)} MiB)`,
      );
    }
    this.#reserved += reservation;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#reserved -= reservation;
    };
  }
}
