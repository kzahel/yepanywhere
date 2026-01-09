import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const GEMINI_TMP_DIR =
  process.env.GEMINI_SESSIONS_DIR ?? join(homedir(), ".gemini", "tmp");
export const GEMINI_DIR = GEMINI_TMP_DIR.replace(/\/tmp$/, "");
export const PROJECT_MAP_FILE = join(GEMINI_TMP_DIR, "project-map.json");

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
  private map: Map<string, string> = new Map();
  private loaded = false;

  constructor(private mapFile: string = PROJECT_MAP_FILE) {}

  /**
   * Load the map from disk.
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      const content = await readFile(this.mapFile, "utf-8");
      const data = JSON.parse(content) as ProjectMapData;
      this.map = new Map(Object.entries(data));
    } catch {
      // File doesn't exist or is invalid, start with empty map
      this.map = new Map();
    }
    this.loaded = true;
  }

  /**
   * Save the map to disk.
   */
  async save(): Promise<void> {
    const data: ProjectMapData = Object.fromEntries(this.map.entries());
    try {
      await mkdir(dirname(this.mapFile), { recursive: true });
      await writeFile(this.mapFile, JSON.stringify(data, null, 2), "utf-8");
    } catch (error) {
      console.error("Failed to save Gemini project map:", error);
    }
  }

  /**
   * Get CWD for a project hash.
   */
  async get(hash: string): Promise<string | undefined> {
    await this.load();
    return this.map.get(hash);
  }

  /**
   * Set CWD for a project hash and save.
   */
  async set(hash: string, cwd: string): Promise<void> {
    await this.load();
    if (this.map.get(hash) !== cwd) {
      this.map.set(hash, cwd);
      await this.save();
    }
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
    await this.load();
    if (this.map.has(hash)) {
      this.map.delete(hash);
      await this.save();
    }
  }

  /**
   * Get all entries.
   */
  async getAll(): Promise<Map<string, string>> {
    await this.load();
    return new Map(this.map);
  }

  /**
   * Clean invalid entries using a validator function.
   */
  async clean(validator: (cwd: string) => Promise<boolean>): Promise<void> {
    await this.load();
    const initialSize = this.map.size;
    for (const [hash, cwd] of this.map.entries()) {
      if (!(await validator(cwd))) {
        this.map.delete(hash);
      }
    }
    if (this.map.size !== initialSize) {
      await this.save();
    }
  }

  /**
   * Register a project path (computes hash and saves).
   */
  async register(cwd: string): Promise<string> {
    const hash = hashProjectPath(cwd);
    await this.set(hash, cwd);
    return hash;
  }
}

export const geminiProjectMap = new GeminiProjectMap();
