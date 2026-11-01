import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import type {
  HostAgentProcessObservation,
  HostAgentProcessesResponse,
  ProviderName,
  YaSessionId,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { ProcessInfo } from "../supervisor/types.js";
import {
  classifyProviderProcess,
  type NativeProcessSession,
  readNativeProcessSession,
} from "./providerProcessClassifier.js";

const SNAPSHOT_CACHE_MS = 1_000;
const SESSION_CORRELATION_TTL_MS = 60_000;

type SessionCorrelation = Pick<
  HostAgentProcessObservation,
  "sessionId" | "projectId" | "sessionTitle"
>;
type NativeSessionReader = (
  provider: ProviderName,
  pid: number,
  startedAtMs: number,
) => Promise<NativeProcessSession | undefined>;
/** One operation-scoped native/catalogue join for uncached process records. */
export type NativeSessionDescriber = (
  sessions: readonly NativeProcessSession[],
  signal: AbortSignal,
) => Promise<
  ReadonlyMap<
    NativeProcessSession,
    {
      sessionId: YaSessionId;
      projectId: UrlProjectId;
      sessionTitle?: string;
    }
  >
>;
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Internal, minimized process facts. Raw argv is reduced to `provider` while
 * parsing the one process-table snapshot and is never retained here.
 */
export interface HostProcessSnapshot {
  pid: number;
  parentPid: number;
  startedAtMs: number;
  cpuTimeMs: number;
  rssBytes: number;
  provider?: ProviderName;
}

type HostProcessSnapshotReader = () => Promise<HostProcessSnapshot[]>;
type HostCpuTimeReader = (
  pids: readonly number[],
) => Promise<ReadonlyMap<number, number>>;

interface PreviousCpuSample {
  cpuTimeMs: number;
  sampledAtMs: number;
}

interface CachedResponse {
  key: string;
  sampledAtMs: number;
  response: HostAgentProcessesResponse;
}

type LocalOwnedProcess = ProcessInfo & { pid: number };

interface InFlightSample {
  generation: number;
  promise: Promise<HostAgentProcessesResponse>;
}

let linuxClockTicksPromise: Promise<number> | null = null;

export function parseProcessCpuTime(value: string): number | null {
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes)) return null;

  let hours = 0;
  let days = 0;
  if (parts.length === 3) {
    const hourPart = parts[0] ?? "";
    const daySeparator = hourPart.indexOf("-");
    if (daySeparator >= 0) {
      days = Number(hourPart.slice(0, daySeparator));
      hours = Number(hourPart.slice(daySeparator + 1));
    } else {
      hours = Number(hourPart);
    }
  }
  if (![days, hours].every(Number.isFinite)) return null;

  return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
}

export function parseLinuxProcCpuTicks(stat: string): number | null {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fieldsAfterCommand = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const userTicks = Number(fieldsAfterCommand[11]);
  const systemTicks = Number(fieldsAfterCommand[12]);
  if (
    !Number.isFinite(userTicks) ||
    userTicks < 0 ||
    !Number.isFinite(systemTicks) ||
    systemTicks < 0
  ) {
    return null;
  }
  return userTicks + systemTicks;
}

/**
 * Reduce a C-locale `ps` snapshot directly to safe facts. The return type has
 * no field capable of carrying raw command text.
 */
export function parsePsSnapshot(
  stdout: string,
  currentUid: number,
): HostProcessSnapshot[] {
  const snapshots: HostProcessSnapshot[] = [];

  for (const line of stdout.split("\n")) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)(?:\s+(.*))?$/.exec(
        line,
      );
    if (!match) continue;

    const uid = Number(match[1]);
    const pid = Number(match[2]);
    const parentPid = Number(match[3]);
    const rssKiB = Number(match[4]);
    const cpuTimeMs = parseProcessCpuTime(match[5] ?? "");
    const startedAtMs = Date.parse(match[6] ?? "");
    if (
      uid !== currentUid ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      !Number.isFinite(rssKiB) ||
      rssKiB < 0 ||
      cpuTimeMs === null ||
      !Number.isFinite(startedAtMs)
    ) {
      continue;
    }

    const commandName = match[7] ?? "";
    // ps flattens argv for display. Only the first few executable-position
    // tokens are inspected, and they are discarded before this iteration ends.
    const executableTokens = (match[8] ?? "").trim().split(/\s+/).slice(0, 4);

    snapshots.push({
      pid,
      parentPid,
      startedAtMs,
      cpuTimeMs,
      rssBytes: rssKiB * 1024,
      provider: classifyProviderProcess(commandName, executableTokens),
    });
  }

  return snapshots;
}

async function readHostProcessSnapshot(): Promise<HostProcessSnapshot[]> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return [];
  }
  const currentUid = process.getuid?.();
  if (currentUid === undefined) return [];

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "ps",
      ["-axo", "uid=,pid=,ppid=,rss=,time=,lstart=,comm=,args="],
      {
        encoding: "utf8",
        maxBuffer: PS_MAX_BUFFER_BYTES,
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
      },
      (error, output) => {
        if (error) {
          // Replace the process-spawn error so no attached stdout or command
          // metadata can escape through route error handling.
          reject(new Error("Host process observation failed"));
          return;
        }
        resolve(output);
      },
    );
  });

  return parsePsSnapshot(stdout, currentUid);
}

async function getLinuxClockTicks(): Promise<number> {
  if (linuxClockTicksPromise) return linuxClockTicksPromise;
  linuxClockTicksPromise = new Promise<number>((resolve) => {
    execFile(
      "getconf",
      ["CLK_TCK"],
      { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C" } },
      (error, output) => {
        const ticks = Number(output.trim());
        resolve(!error && Number.isFinite(ticks) && ticks > 0 ? ticks : 100);
      },
    );
  });
  return linuxClockTicksPromise;
}

async function readLinuxCpuTimes(
  pids: readonly number[],
): Promise<ReadonlyMap<number, number>> {
  const ticksPerSecond = await getLinuxClockTicks();
  const entries = await Promise.all(
    pids.map(async (pid): Promise<readonly [number, number] | null> => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const ticks = parseLinuxProcCpuTicks(stat);
        return ticks === null ? null : [pid, (ticks * 1000) / ticksPerSecond];
      } catch {
        return null;
      }
    }),
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [number, number] => entry !== null,
    ),
  );
}

function isAncestor(
  possibleAncestorPid: number,
  pid: number,
  byPid: ReadonlyMap<number, HostProcessSnapshot>,
): boolean {
  const visited = new Set<number>();
  let current = byPid.get(pid);
  while (current && current.parentPid > 0 && !visited.has(current.parentPid)) {
    if (current.parentPid === possibleAncestorPid) return true;
    visited.add(current.parentPid);
    current = byPid.get(current.parentPid);
  }
  return false;
}

function collectTree(
  rootPid: number,
  childrenByParent: ReadonlyMap<number, readonly HostProcessSnapshot[]>,
): HostProcessSnapshot[] {
  const tree: HostProcessSnapshot[] = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  const visited = new Set<number>([rootPid]);
  while (pending.length > 0) {
    const process = pending.pop();
    if (!process || visited.has(process.pid)) continue;
    visited.add(process.pid);
    tree.push(process);
    pending.push(...(childrenByParent.get(process.pid) ?? []));
  }
  return tree;
}

export class HostAgentProcessService {
  private readonly previousCpuByIdentity = new Map<string, PreviousCpuSample>();
  private readonly sessionByIdentity = new Map<
    string,
    { at: number; result: Promise<SessionCorrelation> }
  >();
  private cachedResponse: CachedResponse | null = null;
  private generation = 0;
  private controller = new AbortController();
  private closed = false;
  private readonly inFlightByKey = new Map<string, InFlightSample>();

  constructor(
    private readonly readSnapshot: HostProcessSnapshotReader = readHostProcessSnapshot,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly now: () => number = Date.now,
    private readonly readCpuTimes: HostCpuTimeReader = readLinuxCpuTimes,
    private readonly readNativeSession: NativeSessionReader = readNativeProcessSession,
    private readonly describeNativeSessions?: NativeSessionDescriber,
  ) {}

  isSupported(): boolean {
    return this.platform === "linux" || this.platform === "darwin";
  }

  clear(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation += 1;
    this.previousCpuByIdentity.clear();
    this.sessionByIdentity.clear();
    this.cachedResponse = null;
    this.inFlightByKey.clear();
  }

  close(): void {
    this.clear();
    this.closed = true;
    this.controller.abort();
  }

  async sample(
    supervisorProcesses: readonly ProcessInfo[],
  ): Promise<HostAgentProcessesResponse> {
    if (this.closed)
      return {
        enabled: false,
        supported: this.isSupported(),
        observations: [],
      };
    if (!this.isSupported()) {
      this.clear();
      return { enabled: true, supported: false, observations: [] };
    }

    const localOwned = supervisorProcesses.filter(
      (process): process is LocalOwnedProcess =>
        process.pid !== undefined && process.executor === undefined,
    );
    const cacheKey = localOwned
      .map((process) => `${process.id}:${process.pid}`)
      .sort()
      .join("|");
    const requestStartedAtMs = this.now();
    if (
      this.cachedResponse &&
      this.cachedResponse.key === cacheKey &&
      requestStartedAtMs - this.cachedResponse.sampledAtMs < SNAPSHOT_CACHE_MS
    ) {
      return this.cachedResponse.response;
    }

    const generation = this.generation;
    const pending = this.inFlightByKey.get(cacheKey);
    if (pending?.generation === generation) {
      return pending.promise;
    }
    const promise = this.sampleUncached(localOwned, cacheKey, generation);
    this.inFlightByKey.set(cacheKey, { generation, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlightByKey.get(cacheKey)?.promise === promise) {
        this.inFlightByKey.delete(cacheKey);
      }
    }
  }

  private async sampleUncached(
    localOwned: readonly LocalOwnedProcess[],
    cacheKey: string,
    generation: number,
  ): Promise<HostAgentProcessesResponse> {
    const processes = await this.readSnapshot();
    const sampledAtMs = this.now();
    const sampledAt = new Date(sampledAtMs).toISOString();
    const byPid = new Map(processes.map((process) => [process.pid, process]));
    const childrenByParent = new Map<number, HostProcessSnapshot[]>();
    for (const process of processes) {
      const children = childrenByParent.get(process.parentPid) ?? [];
      children.push(process);
      childrenByParent.set(process.parentPid, children);
    }

    const ownedByPid = new Map(
      localOwned.map((process) => [process.pid, process]),
    );
    const recognized = processes.filter((process) => process.provider);
    const recognizedPids = new Set(recognized.map((process) => process.pid));
    const externalRoots = recognized.filter((candidate) => {
      for (const ownedPid of ownedByPid.keys()) {
        if (
          candidate.pid === ownedPid ||
          isAncestor(candidate.pid, ownedPid, byPid) ||
          isAncestor(ownedPid, candidate.pid, byPid)
        ) {
          return false;
        }
      }

      let parent = byPid.get(candidate.parentPid);
      const visited = new Set<number>();
      while (parent && !visited.has(parent.pid)) {
        if (recognizedPids.has(parent.pid)) return false;
        visited.add(parent.pid);
        parent = byPid.get(parent.parentPid);
      }
      return true;
    });

    const roots: Array<{
      snapshot: HostProcessSnapshot;
      provider: ProviderName;
      supervision: "ya" | "external";
      supervisorProcessId?: string;
    }> = [];
    for (const owned of localOwned) {
      const snapshot = byPid.get(owned.pid);
      if (!snapshot) continue;
      roots.push({
        snapshot,
        provider: owned.provider,
        supervision: "ya",
        supervisorProcessId: owned.id,
      });
    }
    for (const snapshot of externalRoots) {
      if (!snapshot.provider) continue;
      roots.push({
        snapshot,
        provider: snapshot.provider,
        supervision: "external",
      });
    }

    if (this.platform === "linux") {
      const relevantPids = new Set<number>();
      for (const root of roots) {
        relevantPids.add(root.snapshot.pid);
        for (const descendant of collectTree(
          root.snapshot.pid,
          childrenByParent,
        )) {
          relevantPids.add(descendant.pid);
        }
      }
      const preciseCpuTimes = await this.readCpuTimes([...relevantPids]);
      for (const [pid, cpuTimeMs] of preciseCpuTimes) {
        const snapshot = byPid.get(pid);
        if (snapshot) snapshot.cpuTimeMs = cpuTimeMs;
      }
    }

    const currentIdentities = new Set<string>();
    const observations: HostAgentProcessObservation[] = roots.map((root) => {
      const identity = `${root.snapshot.pid}:${root.snapshot.startedAtMs}`;
      const previous = this.previousCpuByIdentity.get(identity);
      const cpuWindowMs = previous
        ? sampledAtMs - previous.sampledAtMs
        : undefined;
      const cpuDeltaMs = previous
        ? root.snapshot.cpuTimeMs - previous.cpuTimeMs
        : undefined;
      const rootPercent =
        cpuWindowMs !== undefined &&
        cpuWindowMs > 0 &&
        cpuDeltaMs !== undefined &&
        cpuDeltaMs >= 0
          ? Math.round((cpuDeltaMs / cpuWindowMs) * 1_000) / 10
          : undefined;

      const descendants = collectTree(root.snapshot.pid, childrenByParent);
      const treeCpuDeltaMs =
        previous && cpuWindowMs !== undefined && cpuWindowMs > 0
          ? [root.snapshot, ...descendants].reduce((total, process) => {
              const processIdentity = `${process.pid}:${process.startedAtMs}`;
              const processPrevious =
                this.previousCpuByIdentity.get(processIdentity);
              if (
                !processPrevious ||
                processPrevious.sampledAtMs !== previous.sampledAtMs
              ) {
                return total;
              }
              const delta = process.cpuTimeMs - processPrevious.cpuTimeMs;
              return delta >= 0 ? total + delta : total;
            }, 0)
          : undefined;
      const treePercent =
        treeCpuDeltaMs !== undefined &&
        cpuWindowMs !== undefined &&
        cpuWindowMs > 0
          ? Math.round((treeCpuDeltaMs / cpuWindowMs) * 1_000) / 10
          : undefined;
      return {
        observationId: identity,
        pid: root.snapshot.pid,
        provider: root.provider,
        supervision: root.supervision,
        ...(root.supervisorProcessId
          ? { supervisorProcessId: root.supervisorProcessId }
          : {}),
        startedAt: new Date(root.snapshot.startedAtMs).toISOString(),
        sampledAt,
        ...(rootPercent === undefined ||
        treePercent === undefined ||
        cpuWindowMs === undefined
          ? {}
          : {
              cpu: {
                rootPercent,
                treePercent,
                windowMs: cpuWindowMs,
              },
            }),
        memory: {
          rootRssBytes: root.snapshot.rssBytes,
          treeRssBytes:
            root.snapshot.rssBytes +
            descendants.reduce(
              (total, descendant) => total + descendant.rssBytes,
              0,
            ),
          descendantCount: descendants.length,
        },
      };
    });

    if (generation === this.generation) {
      for (const process of processes) {
        const identity = `${process.pid}:${process.startedAtMs}`;
        currentIdentities.add(identity);
        this.previousCpuByIdentity.set(identity, {
          cpuTimeMs: process.cpuTimeMs,
          sampledAtMs,
        });
      }
      for (const identity of this.previousCpuByIdentity.keys()) {
        if (!currentIdentities.has(identity)) {
          this.previousCpuByIdentity.delete(identity);
        }
      }
    }

    await this.correlateExternalSessions(observations, generation, sampledAtMs);

    observations.sort((left, right) => {
      if (left.supervision !== right.supervision) {
        return left.supervision === "ya" ? -1 : 1;
      }
      if (left.provider !== right.provider) {
        return left.provider.localeCompare(right.provider);
      }
      return left.pid - right.pid;
    });

    const response: HostAgentProcessesResponse = {
      enabled: true,
      supported: true,
      sampledAt,
      observations,
    };
    if (generation === this.generation) {
      this.cachedResponse = {
        key: cacheKey,
        sampledAtMs,
        response,
      };
    }
    return response;
  }

  /**
   * Join external roots to their provider session through the provider's pid
   * record, which is exact; cwd or timing alone never makes a join. The
   * result, including YA's title lookup, is reused per process identity for
   * a minute so metric refreshes do not repeat session enrichment.
   */
  private async correlateExternalSessions(
    observations: HostAgentProcessObservation[],
    generation: number,
    sampledAtMs: number,
  ): Promise<void> {
    if (generation !== this.generation || this.closed) return;
    const signal = this.controller.signal;
    const current = new Set<string>();
    const uncached: HostAgentProcessObservation[] = [];
    for (const observation of observations) {
      if (observation.supervision !== "external") continue;
      current.add(observation.observationId);
      const cached = this.sessionByIdentity.get(observation.observationId);
      if (!cached || sampledAtMs - cached.at >= SESSION_CORRELATION_TTL_MS)
        uncached.push(observation);
    }
    // One native/catalogue batch, shared through the incumbent per-process TTL
    // slots. A metric refresh never walks the catalogue once per PID.
    const batch = this.correlateBatch(uncached, signal);
    for (const observation of uncached) {
      this.sessionByIdentity.set(observation.observationId, {
        at: sampledAtMs,
        result: batch.then((results) => results.get(observation) ?? {}),
      });
    }
    await Promise.all(
      observations.map(async (observation) => {
        if (observation.supervision !== "external") return;
        const result = await this.sessionByIdentity.get(
          observation.observationId,
        )?.result;
        if (!signal.aborted) Object.assign(observation, result);
      }),
    );
    if (signal.aborted) return;
    for (const identity of this.sessionByIdentity.keys()) {
      if (!current.has(identity)) this.sessionByIdentity.delete(identity);
    }
  }

  private async correlateBatch(
    observations: readonly HostAgentProcessObservation[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<HostAgentProcessObservation, SessionCorrelation>> {
    const results = new Map<HostAgentProcessObservation, SessionCorrelation>();
    if (observations.length === 0 || signal.aborted) return results;
    const records = await Promise.all(
      observations.map(async (observation) => ({
        observation,
        native: await this.readNativeSession(
          observation.provider,
          observation.pid,
          Date.parse(observation.startedAt),
        ).catch(() => undefined),
      })),
    );
    if (signal.aborted) return results;
    const nativeRecords = records.flatMap(({ native }) =>
      native ? [native] : [],
    );
    const described = await this.describeNativeSessions?.(
      nativeRecords,
      signal,
    ).catch(() => undefined);
    if (signal.aborted) return results;
    for (const { observation, native } of records) {
      if (!native) continue;
      const publicSession = described?.get(native);
      results.set(observation, {
        // This released wire field explicitly means provider-native id.
        sessionId: native.nativeSessionId,
        ...(publicSession?.sessionTitle
          ? { sessionTitle: publicSession.sessionTitle }
          : {}),
        // Old clients combine projectId + native sessionId to navigate. Do not
        // publish that pair when the public resource has a different id.
        ...(publicSession?.sessionId.toString() === native.nativeSessionId
          ? { projectId: publicSession.projectId }
          : {}),
      });
    }
    return results;
  }
}
