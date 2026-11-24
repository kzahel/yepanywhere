import { createHash, randomUUID } from "node:crypto";
import { type FSWatcher, promises as fs, watch } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { ImagePreparationProfile } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { defaultGitExclude } from "../projects/managedProjectDir.js";
import { publishComposeLink } from "./rendezComposeLink.js";
import {
  MAX_ROUTES,
  type RendezTarget,
  atomicJson,
  settleLatest,
} from "./rendez-protocol.mjs";

/**
 * YA's native observer for one project's `.rendez` directory, implementing
 * the shared protocol in graehl/agents topics/rendezvous.md so that its
 * records interoperate with the `rendez` helper. User contract: topics/rendez.md.
 */

const MAX_FILES = 10_000;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
// Decoding allocates the full frame; refuse larger sources before decoding.
const MAX_SOURCE_PIXELS = 64 * 1024 * 1024;
// Node reports writes but not closes, so an upload is complete once it has
// stopped changing for this long.
const QUIET_MS = 1000;
const ROUTE_RESCAN_MS = 250;
const INBOX_WATCH_STARTUP_RECHECK_MS = 2000;
const URL_NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
const DEFAULT_PROFILE: ImagePreparationProfile = {
  maxLongEdge: 2000,
  maxBytes: 4 * 1024 * 1024,
  quality: 85,
};
const PREPARED_FORMATS = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/gif": "png",
} as const;
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
};

export { DEFAULT_PROFILE as RENDEZ_DEFAULT_PROFILE };

export interface RendezRecord {
  version: 1;
  id: string;
  route: string;
  target: RendezRecipient;
  state:
    | "pending"
    | "attempting"
    | "accepted"
    | "failed"
    | "uncertain"
    | "held";
  createdAt: number;
  kind?: "overload";
  text?: string;
  path?: string;
  originalName?: string;
  originalPath?: string;
  originalSize?: number;
  /** Nanoseconds as a decimal string; JSON numbers cannot hold them exactly. */
  originalMtimeNs?: string;
  sha256?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  prepared?: true;
  profile?: ImagePreparationProfile;
  transport?: string;
  receipt?: unknown;
  diagnostics?: string;
  burstId?: string;
}

export interface RendezSendResult {
  accepted: boolean;
  receipt?: unknown;
  diagnostics?: string;
}

/** Where one target's uploads go, chosen when its record is sent. */
export interface RendezDeliveryRoute {
  transport: "ya" | "provider-host" | "draft";
  profile: ImagePreparationProfile;
  send(
    id: string,
    text: string,
    record?: RendezRecord,
  ): Promise<RendezSendResult>;
}

export interface RendezDraftTarget {
  draft: { claimId: string };
}
export type RendezRecipient = RendezTarget | RendezDraftTarget;

export interface RendezSessions {
  route(project: string, target: RendezRecipient): Promise<RendezDeliveryRoute>;
  turnStatus(submissionId: string): Promise<{ accepted?: unknown } | null>;
}

/** Process-wide ceiling on directory watches across every observer. */
export interface RendezWatchBudget {
  used: number;
  readonly limit: number;
}

/** Another YA or `rendez watch --turns` already observes the project. */
export class RendezConflictError extends Error {}

export interface RendezObserverOptions {
  windowMs: number;
  maxPerWindow: number;
  sessions: RendezSessions;
  budget: RendezWatchBudget;
  onFailure: (error: unknown) => void;
}

interface AdmissionRoute {
  last: number;
  arrivals: number[];
  burst: string;
  overloaded: boolean;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** RFC 4122 name-based id, matching Python's `uuid5(NAMESPACE_URL, name)`. */
function uuid5(name: string): string {
  const hash = createHash("sha1").update(URL_NAMESPACE).update(name).digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, "utf8")) as T;
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await fs.mkdir(path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  if ((await fs.lstat(path)).isSymbolicLink()) {
    throw new Error(`Rendez directory must not be a symlink: ${path}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Create `.rendez` on first use; enabling rendez authorizes it. */
async function initializeRoot(project: string): Promise<string> {
  const real = await fs.realpath(project);
  const root = join(real, ".rendez");
  let created = false;
  try {
    await fs.mkdir(root, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  if ((await fs.lstat(root)).isSymbolicLink()) {
    throw new Error("Rendez root must not be a symlink");
  }
  if (created) await defaultGitExclude(real, ".rendez");
  await ensureDirectory(join(root, "routes"));
  await ensureDirectory(join(root, "delivered"));
  return root;
}

/** Linux process start time, which tells a reused pid from its original. */
async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

async function processAlive(pid: number, startTime?: string): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) !== "EPERM") throw error;
  }
  if (startTime === undefined) return true;
  const current = await processStartTime(pid);
  return current === undefined || current === startTime;
}

/**
 * Refuse to observe a project another observer already serves. This is a
 * startup conflict check, not a lock: a marker whose process is gone from
 * this host, or whose pid now belongs to a later process, is replaced, so a
 * YA restart never conflicts with its predecessor.
 */
async function acquireObserverMarker(root: string): Promise<void> {
  const marker = join(root, ".observer.json");
  const mine = {
    owner: "yepanywhere",
    host: hostname(),
    pid: process.pid,
    startTime: await processStartTime(process.pid),
    startedAt: Date.now() / 1000,
  };
  const temporary = join(root, `.observer-${randomUUID()}`);
  await fs.writeFile(temporary, JSON.stringify(mine));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.link(temporary, marker);
        return;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      let other: Partial<typeof mine> = {};
      try {
        other = await readJson(marker);
      } catch (error) {
        if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) {
          throw error;
        }
      }
      if (
        other.host === mine.host &&
        !(await processAlive(other.pid ?? 0, other.startTime))
      ) {
        await fs.rm(marker, { force: true });
        continue;
      }
      throw new RendezConflictError(
        `Project ${dirname(root)} is already observed by ${other.owner ?? "another observer"} (pid ${other.pid} on ${other.host}); stop it, or delete ${marker} if it is gone`,
      );
    }
    throw new Error(`Cannot create the rendez observer marker ${marker}`);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function releaseObserverMarker(root: string): Promise<void> {
  const marker = join(root, ".observer.json");
  try {
    if ((await readJson<{ pid?: number }>(marker)).pid === process.pid) {
      await fs.rm(marker, { force: true });
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
}

/** Take the one-time right to send an event; a claim is never released. */
async function claim(event: string): Promise<boolean> {
  try {
    await fs.writeFile(
      join(event, "claim"),
      JSON.stringify({
        host: hostname(),
        pid: process.pid,
        at: Date.now() / 1000,
      }),
      { flag: "wx" },
    );
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

async function listRoutes(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(join(root, "routes"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    try {
      const subscription = await fs.lstat(
        join(root, "routes", entry.name, "subscription.json"),
      );
      if (!subscription.isFile()) continue;
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    result.push(entry.name);
    if (result.length > MAX_ROUTES) {
      throw new Error(`Rendez exceeds the ${MAX_ROUTES}-route observer limit`);
    }
  }
  return result;
}

/** Persistent per-route burst state, shared with the `rendez` helper. */
class BurstAdmission {
  private constructor(
    private readonly root: string,
    private readonly windowMs: number,
    private readonly maximum: number,
    private readonly state: Record<string, AdmissionRoute>,
  ) {}

  static async load(
    root: string,
    windowMs: number,
    maximum: number,
  ): Promise<BurstAdmission> {
    let state: Record<string, AdmissionRoute> = {};
    try {
      state = await readJson(join(root, ".admission.json"));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return new BurstAdmission(root, windowMs, maximum, state);
  }

  /** Hold the record when over budget; return a new burst's one notice. */
  async admit(
    record: RendezRecord,
    observedMs: number,
    capacity: boolean,
  ): Promise<RendezRecord | undefined> {
    let previous = this.state[record.route];
    if (!previous || observedMs - previous.last >= 4 * this.windowMs) {
      previous = {
        last: observedMs,
        arrivals: [],
        burst: randomUUID(),
        overloaded: false,
      };
    }
    previous.last = observedMs;
    previous.arrivals = previous.arrivals.filter(
      (time) => observedMs - time < this.windowMs,
    );
    let notice: RendezRecord | undefined;
    if (
      !capacity ||
      previous.overloaded ||
      previous.arrivals.length >= this.maximum
    ) {
      record.state = "held";
      record.burstId = previous.burst;
      // Held files need no second full-size archive; the original's path
      // and hash stay in the record.
      if (record.path) {
        await fs.rm(record.path, { force: true });
        await atomicJson(join(dirname(record.path), "record.json"), record);
      }
      if (!previous.overloaded) {
        const directory = join(this.root, "delivered", record.route);
        notice = {
          version: 1,
          id: previous.burst,
          route: record.route,
          target: record.target,
          state: "pending",
          kind: "overload",
          createdAt: Date.now() / 1000,
          text: `Many files were uploaded, potentially unintentionally. Excess uploads are held and will not be sent automatically. Inspect record.json files under ${directory} with state 'held' and burstId '${previous.burst}' to find their originalPath values. Do not unhold them without an explicit request.`,
        };
        await fs.mkdir(join(directory, notice.id));
        await atomicJson(join(directory, notice.id, "record.json"), notice);
      }
      previous.overloaded = true;
    } else {
      previous.arrivals.push(observedMs);
    }
    this.state[record.route] = previous;
    // Unsynchronized: only an unsupported second observer could miscount.
    await atomicJson(join(this.root, ".admission.json"), this.state);
    return notice;
  }
}

/**
 * Size and mtime of the last captured original, by route and inbox-relative
 * name. An original that still matches is not copied and hashed again, the
 * same test rsync uses to skip unchanged files.
 */
type Seen = Map<string, string>;

function seenKey(route: string, name: string): string {
  return `${route}\0${name}`;
}

function fingerprint(size: bigint | number, mtimeNs: bigint | string): string {
  return `${size}:${mtimeNs}`;
}

/** Copy one completed incoming file into a new immutable delivery record. */
async function snapshot(
  root: string,
  route: string,
  name: string,
  seen: Seen,
): Promise<RendezRecord | undefined> {
  if (name.split("/").some((part) => part.startsWith("."))) return undefined;
  const source = join(root, "routes", route, "inbox", name);
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stats = await fs.lstat(source, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!stats.isFile()) return undefined;
  if (
    seen.get(seenKey(route, name)) === fingerprint(stats.size, stats.mtimeNs)
  ) {
    return undefined;
  }
  if (stats.size > MAX_UPLOAD_BYTES) {
    getLogger().warn(
      { source, size: stats.size },
      "Rendez upload exceeds the 64 MiB limit and was not delivered",
    );
    return undefined;
  }
  const { target } = await readJson<{ target: RendezRecipient }>(
    join(root, "routes", route, "subscription.json"),
  );
  const directory = join(root, "delivered", route);
  await ensureDirectory(directory);
  const scratch = join(directory, `.capture-${randomUUID()}`);
  await fs.mkdir(scratch);
  const suffix = extname(name);
  const copied = join(
    scratch,
    `file${/^\.[\p{L}\p{N}]+$/u.test(suffix) ? suffix : ""}`,
  );
  let original: { size: bigint; mtimeNs: bigint } | undefined;
  try {
    const hash = createHash("sha256");
    const input = await fs.open(source, "r");
    try {
      const output = await fs.open(copied, "wx");
      try {
        const before = await input.stat({ bigint: true });
        original = before;
        const buffer = Buffer.alloc(1024 * 1024);
        let total = 0;
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > MAX_UPLOAD_BYTES) {
            getLogger().warn(
              { source },
              "Rendez upload grew beyond the 64 MiB limit and was not delivered",
            );
            return undefined;
          }
          hash.update(buffer.subarray(0, bytesRead));
          await output.write(buffer, 0, bytesRead);
        }
        const after = await input.stat({ bigint: true });
        await output.sync();
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        ) {
          return undefined;
        }
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
    const sha256 = hash.digest("hex");
    const id = uuid5(`${root}/${route}/${name}/${sha256}`);
    const destination = join(directory, id);
    const captured = fingerprint(original.size, original.mtimeNs);
    if (await exists(destination)) {
      seen.set(seenKey(route, name), captured);
      return undefined;
    }
    const record: RendezRecord = {
      version: 1,
      id,
      route,
      target,
      originalName: name,
      originalPath: source,
      originalSize: Number(original.size),
      originalMtimeNs: original.mtimeNs.toString(),
      sha256,
      path: join(destination, basename(copied)),
      state: "pending",
      createdAt: Date.now() / 1000,
      mimeType: MIME_TYPES[suffix.toLowerCase()] ?? "application/octet-stream",
    };
    await atomicJson(join(scratch, "record.json"), record);
    // Renaming onto an existing, never-empty event directory fails, so
    // exactly one observer captures each upload without a lock.
    let created: RendezRecord | undefined = record;
    try {
      await fs.rename(scratch, destination);
    } catch (error) {
      if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") {
        throw error;
      }
      created = undefined;
    }
    seen.set(seenKey(route, name), captured);
    return created;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** Resize and recompress an image snapshot to the target's profile. */
async function prepareAttachment(
  path: string,
  mimeType: string,
  profile: ImagePreparationProfile,
): Promise<Partial<RendezRecord>> {
  const size = (await fs.stat(path)).size;
  const format = PREPARED_FORMATS[mimeType as keyof typeof PREPARED_FORMATS];
  if (!format) return { size, mimeType };
  const { default: sharp } = await import("sharp");
  const input = { limitInputPixels: MAX_SOURCE_PIXELS };
  const { width = 0, height = 0 } = await sharp(path, input).metadata();
  let edge = profile.maxLongEdge;
  if (Math.max(width, height) <= edge && size <= profile.maxBytes) {
    return { width, height, size, mimeType };
  }
  const output = join(
    dirname(path),
    format === "png" ? ".prepared.png" : `.prepared${extname(path)}`,
  );
  let info: { width: number; height: number; size: number } | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const image = sharp(path, input).rotate().resize({
      width: edge,
      height: edge,
      fit: "inside",
      withoutEnlargement: true,
    });
    // PNG has no quality setting here; sharp would quantize to a palette.
    info = await (format === "png"
      ? image.png()
      : format === "jpeg"
        ? image.jpeg({ quality: profile.quality })
        : image.webp({ quality: profile.quality })
    ).toFile(output);
    if (info.size <= profile.maxBytes) break;
    info = undefined;
    edge = Math.max(32, Math.floor(edge * 0.8));
  }
  if (!info) {
    await fs.rm(output, { force: true });
    throw new Error(
      "Image preparation could not satisfy the adapter byte limit",
    );
  }
  let finalPath = path;
  if (mimeType === "image/gif") {
    finalPath = join(dirname(path), `${basename(path, extname(path))}.png`);
    await fs.rename(output, finalPath);
    await fs.rm(path);
  } else {
    await fs.rename(output, path);
  }
  return {
    width: info.width,
    height: info.height,
    size: (await fs.stat(finalPath)).size,
    mimeType: mimeType === "image/gif" ? "image/png" : mimeType,
    path: finalPath,
    profile,
  };
}

/** The user-turn text; YA renders its uploaded-files section as attachments. */
function body(record: RendezRecord): string {
  if (record.kind === "overload") return record.text ?? "";
  const dimensions =
    record.width !== undefined ? `, ${record.width}x${record.height}` : "";
  const name = (record.originalName ?? "")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("\n", " ");
  return `Please inspect the uploaded file.\n\nUser uploaded files:\n- [${name}](<${record.path}>) (${record.size} B, ${record.mimeType}${dimensions})`;
}

/** Watch one project's routes and deliver each completed upload once. */
export class RendezObserver {
  private root = "";
  private admission?: BurstAdmission;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly seen: Seen = new Map();
  private readonly settling = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; observed: number }
  >();
  private routeTimer?: ReturnType<typeof setTimeout>;
  private intake: Promise<void> = Promise.resolve();
  private readonly queue: Array<{
    record: RendezRecord;
    reserved: boolean;
  }> = [];
  private outstanding = 0;
  private draining?: Promise<void>;
  private markerOwned = false;
  private closed = false;
  private failed = false;

  constructor(
    readonly project: string,
    private readonly options: RendezObserverOptions,
  ) {}

  async start(): Promise<void> {
    this.root = await initializeRoot(this.project);
    await acquireObserverMarker(this.root);
    this.markerOwned = true;
    await settleLatest(this.root);
    await publishComposeLink(this.root, false);
    this.admission = await BurstAdmission.load(
      this.root,
      this.options.windowMs,
      this.options.maxPerWindow,
    );
    this.watchDirectory(join(this.root, "routes"), "", () =>
      this.scheduleRouteRescan(),
    );
    const routes = await listRoutes(this.root);
    await this.loadRecords(routes);
    const observed = Date.now();
    for (const route of routes)
      await this.observeDirectory(route, "", observed);
    await this.intake;
    // Subscriptions can also arrive before the routes watch is active.
    if (process.platform === "darwin") this.scheduleRouteRescan(QUIET_MS);
  }

  private fail(error: unknown): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.options.onFailure(error);
  }

  private watchDirectory(
    path: string,
    key: string,
    onName: (name: string | undefined) => void,
  ): void {
    const { budget } = this.options;
    if (budget.used >= budget.limit) {
      throw new Error(`Rendez watch ceiling of ${budget.limit} reached`);
    }
    const watcher = watch(path, { persistent: false }, (_event, name) =>
      onName(name?.toString()),
    );
    budget.used++;
    watcher.on("error", (error) => this.fail(error));
    this.watchers.set(key, watcher);
  }

  private unwatch(key: string): void {
    const watcher = this.watchers.get(key);
    if (!watcher) return;
    watcher.close();
    this.watchers.delete(key);
    this.options.budget.used--;
  }

  /** Watches are keyed by route and inbox-relative directory. */
  private directoryKey(route: string, relative: string): string {
    return `${route}/${relative}`;
  }

  /** Release the watches of a removed directory and everything below it. */
  private unwatchTree(route: string, relative: string): void {
    const key = this.directoryKey(route, relative);
    for (const watched of this.watchers.keys()) {
      if (watched === key || watched.startsWith(relative ? `${key}/` : key)) {
        this.unwatch(watched);
      }
    }
  }

  /**
   * Watch a directory and every non-hidden one below it, queueing capture of
   * files already present. Symlinks are never followed and a directory
   * reached twice (a bind-mount loop) is skipped, so this ends without a
   * depth limit.
   */
  private async observeDirectory(
    route: string,
    relative: string,
    observed: number,
    settleFiles = false,
  ): Promise<void> {
    const inbox = join(this.root, "routes", route, "inbox");
    const visited = new Set<string>();
    const pending = [relative];
    let entries = 0;
    let attached = false;
    for (
      let current = pending.pop();
      current !== undefined;
      current = pending.pop()
    ) {
      const path = join(inbox, current);
      let stats: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stats = await fs.stat(path, { bigint: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (this.closed) return;
      const identity = `${stats.dev}:${stats.ino}`;
      if (visited.has(identity)) continue;
      visited.add(identity);
      const key = this.directoryKey(route, current);
      const directory = current;
      // Attach before listing to narrow the native-watch startup window.
      if (!this.watchers.has(key)) {
        this.watchDirectory(path, key, (name) => {
          if (name?.startsWith(".")) return;
          this.settle(route, name ? join(directory, name) : directory);
        });
        attached = true;
      }
      for (const entry of await fs.readdir(path, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        if (++entries > MAX_FILES) {
          getLogger().warn(
            { projectPath: this.project, route, directory: relative },
            `Rendez directory exceeds ${MAX_FILES} entries; the rest are skipped`,
          );
          return;
        }
        const child = current ? `${current}/${entry.name}` : entry.name;
        if (entry.isDirectory()) pending.push(child);
        else if (entry.isFile()) {
          if (!settleFiles) {
            this.capture(route, child, observed);
            continue;
          }
          const key = this.directoryKey(route, child);
          if (this.settling.has(key)) continue;
          const file = await fs
            .lstat(join(path, entry.name), { bigint: true })
            .catch((error) => {
              if (errorCode(error) === "ENOENT") return undefined;
              throw error;
            });
          if (
            file?.isFile() &&
            this.seen.get(seenKey(route, child)) !==
              fingerprint(file.size, file.mtimeNs) &&
            !this.settling.has(key)
          )
            this.settle(route, child);
        }
      }
    }
    // FSEvents can miss writes while the watch starts. Give a newly watched
    // subtree a separate startup window before rechecking it once.
    if (
      attached &&
      process.platform === "darwin" &&
      !this.settling.has(this.directoryKey(route, relative))
    ) {
      this.settle(route, relative, INBOX_WATCH_STARTUP_RECHECK_MS);
    }
  }

  private scheduleRouteRescan(delay = ROUTE_RESCAN_MS): void {
    if (this.routeTimer || this.closed) return;
    this.routeTimer = setTimeout(() => {
      this.routeTimer = undefined;
      this.rescanRoutes().catch((error) => this.fail(error));
    }, delay);
  }

  /** Follow subscriptions created or removed while observing. */
  async rescanRoutes(): Promise<void> {
    if (this.closed) return;
    const routes = new Set(await listRoutes(this.root));
    for (const key of this.watchers.keys()) {
      if (key && !routes.has(key.slice(0, key.indexOf("/")))) this.unwatch(key);
    }
    const observed = Date.now();
    for (const route of routes) {
      if (this.watchers.has(this.directoryKey(route, ""))) continue;
      await this.observeDirectory(route, "", observed, true);
    }
    await this.intake;
  }

  private settle(route: string, relative: string, delay = QUIET_MS): void {
    if (this.closed) return;
    const key = this.directoryKey(route, relative);
    const previous = this.settling.get(key);
    if (previous) clearTimeout(previous.timer);
    else if (this.settling.size >= MAX_FILES) {
      this.fail(new Error("Rendez has too many uploads in progress"));
      return;
    }
    const observed = previous?.observed ?? Date.now();
    const timer = setTimeout(() => {
      this.settling.delete(key);
      this.capture(route, relative, observed);
    }, delay);
    timer.unref();
    this.settling.set(key, { timer, observed });
  }

  /** Capture a settled file, or start watching a settled new directory. */
  private capture(route: string, relative: string, observed: number): void {
    this.intake = this.intake
      .then(async () => {
        const path = join(this.root, "routes", route, "inbox", relative);
        let stats: Awaited<ReturnType<typeof fs.lstat>>;
        try {
          stats = await fs.lstat(path);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
          this.unwatchTree(route, relative);
          return;
        }
        if (stats.isDirectory()) {
          // Newly discovered uploads still need a quiet interval.
          await this.observeDirectory(route, relative, observed, true);
          return;
        }
        const record = await snapshot(this.root, route, relative, this.seen);
        if (record) await this.admit(record, observed);
      })
      .catch((error) => this.fail(error));
  }

  /**
   * After a restart, send records that were captured but never sent, check
   * provider receipts for interrupted sends, and index captured originals.
   * Records already found uncertain stay so until someone inspects the
   * transcript.
   */
  private async loadRecords(routes: string[]): Promise<void> {
    let pending = 0;
    const captured = new Map<string, number>();
    for (const route of routes) {
      const directory = join(this.root, "delivered", route);
      if (!(await exists(directory))) continue;
      for (const event of await fs.readdir(directory)) {
        if (event.startsWith(".")) continue;
        let record: RendezRecord;
        try {
          record = await readJson(join(directory, event, "record.json"));
        } catch (error) {
          if (errorCode(error) === "ENOENT") continue;
          throw error;
        }
        if (
          record.originalMtimeNs !== undefined &&
          record.originalSize !== undefined
        ) {
          const key = seenKey(route, record.originalName ?? "");
          if (record.createdAt >= (captured.get(key) ?? 0)) {
            captured.set(key, record.createdAt);
            this.seen.set(
              key,
              fingerprint(record.originalSize, record.originalMtimeNs),
            );
          }
        }
        if (record.state === "pending") {
          if (++pending > MAX_FILES) {
            throw new Error("Rendez pending records exceed the scan limit");
          }
          await this.admit(record, Date.now());
        } else if (
          record.state === "attempting" ||
          (record.state === "uncertain" && record.transport === "provider-host")
        ) {
          await this.reconcile(record);
        }
      }
    }
  }

  private async admit(record: RendezRecord, observed: number): Promise<void> {
    if (this.closed || !this.admission) return;
    const capacity = this.outstanding < this.options.maxPerWindow;
    if (record.kind !== "overload") {
      const notice = await this.admission.admit(record, observed, capacity);
      if (notice) this.queue.push({ record: notice, reserved: false });
      if (record.state === "held") {
        this.drain();
        return;
      }
    }
    if (record.kind !== "overload") this.outstanding++;
    this.queue.push({ record, reserved: record.kind !== "overload" });
    this.drain();
  }

  private drain(): void {
    if (this.draining || this.closed) return;
    this.draining = (async () => {
      while (!this.closed) {
        const item = this.queue.shift();
        if (!item) return;
        try {
          await this.deliver(item.record);
        } finally {
          if (item.reserved) this.outstanding--;
        }
      }
    })()
      .catch((error) => this.fail(error))
      .finally(() => {
        this.draining = undefined;
        if (this.queue.length) this.drain();
      });
  }

  private recordPath(record: RendezRecord): string {
    return join(this.root, "delivered", record.route, record.id, "record.json");
  }

  private async finish(
    record: RendezRecord,
    update: Partial<RendezRecord>,
  ): Promise<void> {
    Object.assign(record, update);
    await atomicJson(this.recordPath(record), record);
    if (record.state === "failed" || record.state === "uncertain") {
      getLogger().warn(
        {
          projectPath: this.project,
          id: record.id,
          state: record.state,
          diagnostics: record.diagnostics,
        },
        "Rendez upload was not confirmed",
      );
    }
  }

  private async reconcile(record: RendezRecord): Promise<void> {
    if (record.transport !== "provider-host") {
      await this.finish(record, {
        state: "uncertain",
        diagnostics:
          "Acceptance is uncertain; inspect the target transcript before another upload",
      });
      return;
    }
    try {
      const status = await this.options.sessions.turnStatus(record.id);
      await this.finish(record, {
        state: status?.accepted ? "accepted" : "uncertain",
        receipt: status,
      });
    } catch (error) {
      await this.finish(record, {
        state: "uncertain",
        diagnostics: errorMessage(error),
      });
    }
  }

  private async deliver(queued: RendezRecord): Promise<void> {
    const record = await readJson<RendezRecord>(this.recordPath(queued));
    if (record.state !== "pending") return;
    if (!(await claim(dirname(this.recordPath(record))))) {
      // A claimant that stopped before recording an outcome may or may not
      // have sent the upload; never send it a second time.
      await this.finish(record, {
        state: "uncertain",
        diagnostics:
          "Another observer claimed this upload; inspect the target transcript before another upload",
      });
      return;
    }
    let route: RendezDeliveryRoute;
    try {
      route = await this.options.sessions.route(this.project, record.target);
    } catch (error) {
      await this.finish(record, {
        state: "failed",
        diagnostics: `No delivery route: ${errorMessage(error)}`,
      });
      return;
    }
    if (!record.prepared && record.kind !== "overload" && record.path) {
      try {
        Object.assign(
          record,
          await prepareAttachment(
            record.path,
            record.mimeType ?? "application/octet-stream",
            route.profile,
          ),
          { prepared: true },
        );
      } catch (error) {
        await this.finish(record, {
          state: "failed",
          diagnostics: `Image preparation failed: ${errorMessage(error)}`,
        });
        return;
      }
    }
    await this.finish(record, {
      state: "attempting",
      transport: route.transport,
    });
    try {
      const result = await route.send(record.id, body(record), record);
      await this.finish(record, {
        state: result.accepted ? "accepted" : "failed",
        receipt: result.receipt,
        diagnostics: result.diagnostics,
      });
    } catch (error) {
      await this.finish(record, {
        state: "uncertain",
        diagnostics: errorMessage(error),
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const key of this.watchers.keys()) this.unwatch(key);
    if (this.routeTimer) clearTimeout(this.routeTimer);
    for (const { timer } of this.settling.values()) clearTimeout(timer);
    this.settling.clear();
    await this.intake;
    await this.draining;
    if (this.markerOwned) await releaseObserverMarker(this.root);
  }
}
