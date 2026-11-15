import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Only fnm's configured default; do not search unused Node installations. */
export function fnmCodexPaths(
  platform = process.platform,
  home = homedir(),
  env = process.env,
): string[] {
  const roots = env.FNM_DIR
    ? [env.FNM_DIR]
    : platform === "win32"
      ? [
          join(env.APPDATA ?? join(home, "AppData", "Roaming"), "fnm"),
          join(home, ".fnm"),
        ]
      : [
          join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "fnm"),
          join(home, ".fnm"),
          ...(platform === "darwin"
            ? [join(home, "Library", "Application Support", "fnm")]
            : []),
        ];
  const root = roots.find(existsSync);
  if (root) {
    try {
      const alias = realpathSync(join(root, "aliases", "default"));
      const prefixes = [alias, join(alias, "installation")];
      return prefixes
        .flatMap((prefix) =>
          platform === "win32"
            ? [join(prefix, "codex.exe"), join(prefix, "codex.cmd")]
            : [join(prefix, "bin", "codex")],
        )
        .filter(existsSync);
    } catch {
      /* fnm is optional and may have no configured default. */
    }
  }
  return [];
}
