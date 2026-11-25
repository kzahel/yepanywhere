import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type BootInstructionsLaunch,
  DEFAULT_BOOT_HOME_NAME,
} from "../../sessions/session-boot-instructions.js";

/**
 * A Codex boot home: a stable `CODEX_HOME` per API client with no user-level
 * `AGENTS.md`, carrying the operator's login and configuration. Contract:
 * topics/session-boot-instructions.md#codex-boot-home.
 */
const MARKER = ".ya-boot-home";

/** Where a launch's Codex boot home lives. */
export function codexBootHomePath(boot: BootInstructionsLaunch): string {
  if (!boot.homeRoot)
    throw new Error(
      "Boot home root unavailable: this server has no data directory for boot homes",
    );
  return join(boot.homeRoot, "codex", boot.apiClient ?? DEFAULT_BOOT_HOME_NAME);
}

function markerText(apiClient: string | undefined): string {
  return `${JSON.stringify({
    schema: 1,
    provider: "codex",
    apiClient: apiClient ?? null,
    createdAt: new Date().toISOString(),
  })}\n`;
}

async function assertOwnedBootHome(
  home: string,
  apiClient: string | undefined,
): Promise<void> {
  const refuse = (why: string) =>
    new Error(
      `Boot home not owned by this client: ${home} ${why}; YA will not reuse or replace it`,
    );
  const stat = await lstat(home);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw refuse("is not a directory");
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(join(home, MARKER), "utf8"));
  } catch {
    throw refuse(`has no readable ${MARKER}`);
  }
  const record = marker as Record<string, unknown> | null;
  if (
    !record ||
    record.schema !== 1 ||
    record.provider !== "codex" ||
    record.apiClient !== (apiClient ?? null)
  )
    throw refuse(`has a ${MARKER} for another client`);
}

async function createBootHome(
  home: string,
  apiClient: string | undefined,
): Promise<void> {
  const staging = `${home}.staging-${randomUUID()}`;
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeFile(join(staging, MARKER), markerText(apiClient), {
      mode: 0o600,
    });
    await rename(staging, home);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // Another launch created the home first; the caller verifies its marker.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
  }
}

/**
 * Point `link` at `target`, replacing a stale link or a file Codex left
 * there. A real directory may hold rollouts, so it is refused, never removed.
 */
async function linkCarriedEntry(link: string, target: string): Promise<void> {
  if (!existsSync(target)) return;
  try {
    const stat = await lstat(link);
    if (stat.isSymbolicLink() && (await readlink(link)) === target) return;
    if (stat.isDirectory())
      throw new Error(
        `Boot home entry is a directory, not a link: ${link}; move it aside to continue`,
      );
    await unlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(target, link);
}

/** Top-level `config.toml` keys that name or carry instructions. */
const DROPPED_TOP_LEVEL_KEYS = new Set([
  "developer_instructions",
  "instructions",
  "model_instructions_file",
  "experimental_instructions_file",
]);

/**
 * The operator's `config.toml` without keys that would reintroduce
 * instructions or run hooks. Best effort and line-based: top-level
 * instruction keys (including multi-line string values) and every `hooks`
 * table are dropped; everything else is kept verbatim.
 */
export function filterCodexConfigToml(text: string): string {
  const kept: string[] = [];
  let topLevel = true;
  let inHooksTable = false;
  let skippingUntil: string | null = null;
  for (const line of text.split("\n")) {
    if (skippingUntil) {
      if (line.includes(skippingUntil)) skippingUntil = null;
      continue;
    }
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      topLevel = false;
      const name = header[1]!.replace(/["']/g, "");
      inHooksTable = name === "hooks" || name.startsWith("hooks.");
    }
    if (inHooksTable) continue;
    const key = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (
      topLevel &&
      key &&
      (DROPPED_TOP_LEVEL_KEYS.has(key[1]!) || key[1]!.startsWith("hooks."))
    ) {
      const value = key[2]!;
      for (const quote of ['"""', "'''"]) {
        if (value.startsWith(quote) && !value.slice(3).includes(quote))
          skippingUntil = quote;
      }
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

async function writeCarriedConfig(
  operatorHome: string,
  home: string,
): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(operatorHome, "config.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const staging = join(home, `.config.toml.${randomUUID()}`);
  await writeFile(staging, filterCodexConfigToml(text), { mode: 0o600 });
  await rename(staging, join(home, "config.toml"));
}

/**
 * Create or verify the launch's boot home, then refresh its carried login,
 * rules, rollout tree and filtered configuration, returning the directory to
 * use as `CODEX_HOME`. Never writes `AGENTS.md`, skills or hooks. Rollouts go
 * to the operator's own `sessions/`, so their native storage scope, readers
 * and resume checks are those of any other Codex session.
 */
export async function prepareCodexBootHome(
  boot: BootInstructionsLaunch,
  operatorHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
): Promise<string> {
  if (process.platform === "win32")
    throw new Error(
      "Boot instructions unavailable for Codex on Windows: boot homes need symbolic links",
    );
  const home = codexBootHomePath(boot);
  await mkdir(join(boot.homeRoot!, "codex"), { recursive: true, mode: 0o700 });
  if (!existsSync(home)) await createBootHome(home, boot.apiClient);
  await assertOwnedBootHome(home, boot.apiClient);
  await mkdir(join(operatorHome, "sessions"), { recursive: true });
  for (const entry of ["auth.json", "rules", "sessions"])
    await linkCarriedEntry(join(home, entry), join(operatorHome, entry));
  await writeCarriedConfig(operatorHome, home);
  return home;
}

/**
 * Thread `skills.config` entries disabling every user skill Codex discovers
 * outside `CODEX_HOME`, listed afresh at each launch so new skills are covered.
 */
export function codexUserSkillDisables(
  userSkillsDir = join(homedir(), ".agents", "skills"),
): { path: string; enabled: false }[] {
  let names: string[];
  try {
    names = readdirSync(userSkillsDir);
  } catch {
    return [];
  }
  return names
    .map((name) => join(userSkillsDir, name, "SKILL.md"))
    .filter((path) => existsSync(path))
    .sort()
    .map((path) => ({ path, enabled: false as const }));
}
