import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { getDataDir } from "../config.js";

export const GEMINI_TMP_DIR =
  process.env.GEMINI_SESSIONS_DIR ?? join(homedir(), ".gemini", "tmp");
export const GEMINI_DIR = GEMINI_TMP_DIR.replace(
  new RegExp(`\\${sep}tmp$`),
  "",
);
const LEGACY_PROJECT_MAP_FILE = join(GEMINI_TMP_DIR, "project-map.json");
// YA-owned lookup state must not generate atomic-write events inside the
// provider's recursively watched store (Node 20 can race a removed temp file).
// The data directory comes from `getDataDir()`, which owns the profile rules;
// resolving the default path here would give two profiles one shared map.
export const PROJECT_MAP_FILE = join(getDataDir(), "gemini-project-map.json");

/**
 * Compute SHA-256 hash of a path (how Gemini creates projectHash).
 */
export function hashProjectPath(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

export interface ProjectMapData {
  // hash -> cwd
  [hash: string]: string;
}

export class GeminiProjectMap {
  /**
   * Never mutated in place: a mutation builds a candidate and swaps it in, so
   * readers may hold this map without copying it. It mirrors every known
   * project path, which reaches tens of thousands of entries on hosts whose
   * tests create temporary projects.
   */
  private map: Map<string, string> = new Map();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private mapFile: string = PROJECT_MAP_FILE,
    private legacyMapFile: string | undefined = mapFile === PROJECT_MAP_FILE
      ? LEGACY_PROJECT_MAP_FILE
      : undefined,
  ) {}

  /**
   * Load the map from disk.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;

    const loadPromise = this.loadFromDisk();
    this.loadPromise = loadPromise;
    try {
      await loadPromise;
    } finally {
      if (this.loadPromise === loadPromise) {
        this.loadPromise = null;
      }
    }
  }

  private async loadFromDisk(): Promise<void> {
    let migrate = false;
    try {
      const content = await readFile(this.mapFile, "utf-8").catch(
        async (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" || !this.legacyMapFile) throw error;
          migrate = true;
          return readFile(this.legacyMapFile, "utf-8");
        },
      );
      const data = JSON.parse(content) as ProjectMapData;
      this.map = new Map(Object.entries(data));
    } catch {
      // File doesn't exist or is invalid, start with empty map
      this.map = new Map();
      migrate = false;
    }
    // Leave the legacy file untouched for older installs. Once the new map
    // exists it is authoritative, including removals made after migration.
    if (migrate) await this.persist(this.map);
    this.loaded = true;
  }

  private async persist(candidate: Map<string, string>): Promise<void> {
    const data: ProjectMapData = Object.fromEntries(candidate.entries());
    const tempPath = `${this.mapFile}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    await mkdir(dirname(this.mapFile), { recursive: true });
    try {
      await writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
      await rename(tempPath, this.mapFile);
    } catch (error) {
      await unlink(tempPath).catch(() => {
        // Best-effort cleanup for failed atomic writes.
      });
      console.error("Failed to save Gemini project map:", error);
      throw error;
    }
  }

  private enqueueMutation(
    mutate: (candidate: Map<string, string>) => boolean | Promise<boolean>,
  ): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      await this.load();
      const candidate = new Map(this.map);
      if (!(await mutate(candidate))) return;
      await this.persist(candidate);
      this.map = candidate;
    });
    this.mutationTail = operation.catch(() => {
      // Keep later mutations runnable while the originating caller observes
      // the persistence failure.
    });
    return operation;
  }

  /**
   * Save the current map through the same serialized atomic writer used by
   * mutations.
   */
  async save(): Promise<void> {
    await this.enqueueMutation(() => true);
  }

  /**
   * Get CWD for a project hash.
   */
  async get(hash: string): Promise<string | undefined> {
    await this.load();
    await this.mutationTail;
    return this.map.get(hash);
  }

  /**
   * Set CWD for a project hash and save.
   */
  async set(hash: string, cwd: string): Promise<void> {
    await this.setAll([[hash, cwd]]);
  }

  /**
   * Set many entries as one mutation. Entries already present cost a lookup,
   * not a copy of the whole map.
   */
  async setAll(entries: Iterable<readonly [string, string]>): Promise<void> {
    await this.load();
    await this.mutationTail;
    const changed = [...entries].filter(
      ([hash, cwd]) => this.map.get(hash) !== cwd,
    );
    if (changed.length === 0) return;
    await this.enqueueMutation((candidate) => {
      let mutated = false;
      for (const [hash, cwd] of changed) {
        if (candidate.get(hash) === cwd) continue;
        candidate.set(hash, cwd);
        mutated = true;
      }
      return mutated;
    });
  }

  /**
   * Alias for set, used in tests/logic sometimes
   */
  async add(hash: string, cwd: string): Promise<void> {
    return this.set(hash, cwd);
  }

  /**
   * Remove an entry.
   */
  async remove(hash: string): Promise<void> {
    await this.enqueueMutation((candidate) => candidate.delete(hash));
  }

  /**
   * Get all entries.
   */
  async getAll(): Promise<ReadonlyMap<string, string>> {
    await this.load();
    await this.mutationTail;
    return this.map;
  }

  /**
   * Clean invalid entries using a validator function.
   */
  async clean(validator: (cwd: string) => Promise<boolean>): Promise<void> {
    await this.enqueueMutation(async (candidate) => {
      const initialSize = candidate.size;
      for (const [hash, cwd] of candidate.entries()) {
        if (!(await validator(cwd))) {
          candidate.delete(hash);
        }
      }
      return candidate.size !== initialSize;
    });
  }

  /**
   * Register a project path (computes hash and saves).
   */
  async register(cwd: string): Promise<string> {
    const hash = hashProjectPath(cwd);
    await this.set(hash, cwd);
    return hash;
  }

  async registerAll(cwds: Iterable<string>): Promise<void> {
    await this.setAll(
      Array.from(cwds, (cwd) => [hashProjectPath(cwd), cwd] as const),
    );
  }
}

export const geminiProjectMap = new GeminiProjectMap();
