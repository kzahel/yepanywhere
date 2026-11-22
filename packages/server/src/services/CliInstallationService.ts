import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  CliInstallationCandidate,
  CliInstallationFamily,
  CliInstallationInventory,
  CliInstallationSelections,
  CliLaunchDescriptor,
} from "@yep-anywhere/shared/provider-cli-installations";
import {
  providerInstallationCoordinator,
  type ProviderInstallationCoordinator,
} from "./ProviderInstallationCoordinator.js";

export interface CliCandidate {
  path: string;
  launch: CliLaunchDescriptor;
  source: string;
  version?: string;
  error?: string;
  /** Files/directories needed by this launch, including adjacent tool hosts. */
  watchPaths: string[];
}

export interface CliInstallationAdapter {
  family: CliInstallationFamily;
  installationFamily: string;
  /** Bump when the recipe or the meaning of a successful check changes. */
  probeRevision: string;
  /**
   * The candidate an Auto launch actually runs, for a family whose launch
   * does not go through resolve(). Without it, Auto shows the first usable one.
   */
  autoSelect?(candidates: readonly CliCandidate[]): CliCandidate | undefined;
  discover(explicitPath?: string): Promise<CliCandidate[]>;
  contextKey(): string;
  rescan?(): void;
  /** Must join process cleanup before resolving, including abort paths. */
  verify?(candidate: CliCandidate, signal: AbortSignal): Promise<void>;
}

interface Verification {
  key: string;
  path: string;
  at: number;
  ok: boolean;
  error?: string;
}

/** Fingerprint metadata rather than hashing large executable contents per launch. */
export async function cliInstallationFingerprint(
  candidate: CliCandidate,
): Promise<string> {
  const facts: unknown[] = [candidate.launch];
  for (const path of [
    ...new Set([
      candidate.path,
      candidate.launch.command,
      ...candidate.watchPaths,
    ]),
  ]) {
    try {
      const target = await realpath(path);
      const link = await lstat(path);
      const info = await stat(target);
      facts.push([
        path,
        target,
        link.mtimeMs,
        info.ino,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
      ]);
      if (info.isDirectory()) {
        // A fixed bound, including missing/new helpers. Never walk user histories.
        const names = (await readdir(target)).sort();
        if (names.length > 256)
          throw new Error(
            `Installation directory has too many entries: ${path}`,
          );
        for (const name of names) {
          const entry = await stat(join(target, name)).catch(() => null);
          facts.push([
            name,
            entry?.ino,
            entry?.size,
            entry?.mtimeMs,
            entry?.ctimeMs,
          ]);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        facts.push([path, "missing"]);
      else throw error;
    }
  }
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

export class CliInstallationService {
  // Bound by registered families and at most 64 installation fingerprints.
  private readonly inflight = new Map<string, Promise<Verification>>();
  private readonly records = new Map<string, Verification>();
  private readonly inventories = new Map<string, Promise<CliCandidate[]>>();
  private writeTail: Promise<void> = Promise.resolve();
  private loaded?: Promise<void>;
  private readonly cachePath: string;

  constructor(
    readonly dataDir: string,
    private readonly adapters: CliInstallationAdapter[],
    private readonly selections: () => CliInstallationSelections,
    private readonly managedPaths: () => CliInstallationSelections = () => ({}),
    private readonly coordinator: Pick<
      ProviderInstallationCoordinator,
      "withReadLease" | "getSourceVersion"
    > = providerInstallationCoordinator,
    private readonly timeoutMs = 20_000,
  ) {
    this.cachePath = join(dataDir, "cli-verification", "results.json");
  }

  private adapter(family: CliInstallationFamily) {
    const adapter = this.adapters.find((item) => item.family === family);
    if (!adapter)
      throw new Error(`Unsupported CLI installation family: ${family}`);
    return adapter;
  }

  selectedPath(family: CliInstallationFamily): string | undefined {
    return this.managedPaths()[family] ?? this.selections()[family];
  }

  async rescan(family: CliInstallationFamily) {
    this.adapter(family).rescan?.();
    return this.inventory(family);
  }

  private async load() {
    this.loaded ??= (async () => {
      try {
        const saved: unknown = JSON.parse(
          await readFile(this.cachePath, "utf8"),
        );
        if (!Array.isArray(saved)) return;
        for (const value of saved.slice(-64)) {
          if (
            value &&
            typeof value.key === "string" &&
            typeof value.path === "string" &&
            typeof value.at === "number" &&
            typeof value.ok === "boolean"
          )
            this.records.set(value.key, value);
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          !(error instanceof SyntaxError)
        )
          throw error;
      }
    })();
    await this.loaded;
  }

  private async key(adapter: CliInstallationAdapter, candidate: CliCandidate) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          adapter.family,
          adapter.probeRevision,
          adapter.contextKey(),
          this.coordinator.getSourceVersion(adapter.installationFamily),
          await cliInstallationFingerprint(candidate),
        ]),
      )
      .digest("hex");
  }

  private async candidates(adapter: CliInstallationAdapter, explicit?: string) {
    const key = `${adapter.family}\0${explicit ?? ""}`;
    let read = this.inventories.get(key);
    if (!read) {
      read = adapter
        .discover(explicit)
        .finally(() => this.inventories.delete(key));
      this.inventories.set(key, read);
    }
    return read;
  }

  async inventory(
    family: CliInstallationFamily,
    explicitPath?: string,
    includeAll = true,
  ): Promise<
    CliInstallationInventory & {
      candidates: Array<CliInstallationCandidate & CliCandidate>;
    }
  > {
    const adapter = this.adapter(family);
    return this.coordinator.withReadLease(
      adapter.installationFamily,
      async () => {
        await this.load();
        const managed = explicitPath ?? this.managedPaths()[family];
        const selection = managed ?? this.selections()[family] ?? null;
        const candidates: Array<CliInstallationCandidate & CliCandidate> = [];
        const discovered = await this.candidates(
          adapter,
          selection ?? undefined,
        );
        const all =
          selection && includeAll
            ? [...discovered, ...(await this.candidates(adapter))]
            : discovered;
        const unique = [
          ...new Map(
            all.map((candidate) => [candidate.path, candidate]),
          ).values(),
        ].slice(0, 64);
        for (const candidate of unique) {
          const record = this.records.get(await this.key(adapter, candidate));
          const retained =
            record && (record.ok || Date.now() - record.at < 30_000)
              ? record
              : undefined;
          candidates.push({
            ...candidate,
            selected: false,
            verification: retained
              ? retained.ok
                ? "verified"
                : "failed"
              : adapter.verify
                ? "unverified"
                : "unsupported",
            verifiedAt: retained?.at,
            verificationError: retained?.error,
          });
        }
        const automatic = adapter.autoSelect?.(candidates);
        const selected = selection
          ? candidates.find((candidate) => candidate.path === selection)
          : adapter.autoSelect
            ? candidates.find((candidate) => candidate === automatic)
            : (candidates.find(
                (c) => !c.error && c.verification === "verified",
              ) ??
              candidates.find((c) => !c.error && c.verification !== "failed") ??
              candidates[0]);
        if (selected) selected.selected = true;
        return { family, selection, managed: Boolean(managed), candidates };
      },
    );
  }

  /** Version/inventory reads never execute tools. New runtimes call this gate. */
  async resolve(
    family: CliInstallationFamily,
    explicitPath?: string,
    force = false,
  ): Promise<CliLaunchDescriptor> {
    const adapter = this.adapter(family);
    return this.coordinator.withReadLease(
      adapter.installationFamily,
      async () => {
        const inventory = await this.inventory(family, explicitPath, false);
        const failures: string[] = [];
        const deadline = Date.now() + 60_000;
        for (const candidate of inventory.candidates) {
          if (Date.now() >= deadline) {
            failures.push(
              "Installation selection timed out; retry or select a specific path",
            );
            break;
          }
          if (!(await stat(candidate.path).catch(() => null))) {
            failures.push(
              `${candidate.path}: Selected executable no longer exists`,
            );
            continue;
          }
          if (candidate.error) {
            failures.push(`${candidate.path}: ${candidate.error}`);
            continue;
          }
          if (!adapter.verify) return candidate.launch;
          const key = await this.key(adapter, candidate);
          const record = this.records.get(key);
          if (
            !force &&
            record &&
            (record.ok || Date.now() - record.at < 30_000)
          ) {
            if (record.ok) return candidate.launch;
            failures.push(`${candidate.path}: ${record.error}`);
            continue;
          }
          let pending = this.inflight.get(key);
          if (!pending) {
            pending = this.probe(adapter, candidate, key).finally(() =>
              this.inflight.delete(key),
            );
            this.inflight.set(key, pending);
          }
          const result = await pending;
          if (result.ok) return candidate.launch;
          failures.push(`${candidate.path}: ${result.error}`);
        }
        throw new Error(
          `No usable ${family} installation. ${failures.join("; ") || "Choose an installation or rescan."}`,
        );
      },
    );
  }

  private async probe(
    adapter: CliInstallationAdapter,
    candidate: CliCandidate,
    key: string,
  ): Promise<Verification> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Execution probe timed out")),
      this.timeoutMs,
    );
    let failure: string | undefined;
    try {
      await adapter.verify?.(candidate, controller.signal);
      controller.signal.throwIfAborted();
      if (key !== (await this.key(adapter, candidate)))
        throw new Error("Installation changed during verification; retry");
    } catch (error) {
      const cause = controller.signal.aborted
        ? controller.signal.reason
        : error;
      failure = (cause instanceof Error ? cause.message : String(cause)).slice(
        0,
        4096,
      );
    } finally {
      clearTimeout(timeout);
    }
    const record: Verification = {
      key,
      path: candidate.path,
      at: Date.now(),
      ok: failure === undefined,
      error: failure,
    };
    this.records.set(key, record);
    while (this.records.size > 64)
      this.records.delete(this.records.keys().next().value!);
    this.writeTail = this.writeTail
      .catch(() => {})
      .then(async () => {
        await mkdir(join(this.dataDir, "cli-verification"), {
          recursive: true,
          mode: 0o700,
        });
        const temp = `${this.cachePath}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify([...this.records.values()]), {
          mode: 0o600,
        });
        await rename(temp, this.cachePath);
      });
    await this.writeTail;
    return record;
  }
}
