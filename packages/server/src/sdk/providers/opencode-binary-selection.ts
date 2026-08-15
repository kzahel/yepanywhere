import { existsSync } from "node:fs";
import { win32 as windowsPath } from "node:path";

/**
 * Pick a usable OpenCode binary out of `which` / `where` output.
 *
 * Windows `where` prints one line per PATHEXT match, so the raw stdout routinely
 * holds several paths and trimming it whole yields a string that is not a path at
 * all. Split first, then prefer a directly executable file: `getAvailableModels()`
 * runs the binary through `execFile()`, which on Windows cannot start npm's
 * extensionless shell shim (ENOENT) or a `.cmd` shim (EINVAL) — only a real
 * `.exe`. `opencode serve` is spawned with `shell: true` and does tolerate the
 * shims, so a shim is still returned as a last resort rather than reporting that
 * OpenCode is missing entirely.
 */
export function selectOpenCodeBinary(
  stdout: string,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  const hits = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => fileExists(line));

  if (platform !== "win32") {
    return hits[0] ?? null;
  }

  const directExe = hits.find((hit) => hit.toLowerCase().endsWith(".exe"));
  if (directExe) {
    return directExe;
  }

  // `npm i -g opencode-ai` drops `opencode` and `opencode.cmd` shims beside the
  // global node_modules; the executable itself is opencode-ai/bin/opencode.exe.
  // Resolve with the win32 path rules explicitly so the lookup behaves the same
  // when these strings are exercised from a posix test host.
  for (const hit of hits) {
    const packaged = windowsPath.join(
      hit,
      "..",
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (fileExists(packaged)) {
      return packaged;
    }
  }

  return hits[0] ?? null;
}
