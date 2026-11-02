import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Resolve symlinks before native storage exists, without creating directories. */
export async function nativeStorageScope(path: string): Promise<string> {
  let root = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(await realpath(root), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(root);
      if (parent === root) throw error;
      missing.push(basename(root));
      root = parent;
    }
  }
}
