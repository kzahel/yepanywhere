import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function hashPath(hash, filename, ancestors = new Set()) {
  let info;
  try {
    info = await stat(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    hash.update(JSON.stringify([filename, "missing"]));
    return;
  }
  if (info.isDirectory()) {
    const resolved = await realpath(filename);
    if (ancestors.has(resolved))
      throw new Error(
        `Client build input contains a directory cycle: ${filename}`,
      );
    const parents = new Set([...ancestors, resolved]);
    hash.update(JSON.stringify([filename, "directory"]));
    for (const name of (await readdir(filename)).sort()) {
      await hashPath(hash, join(filename, name), parents);
    }
  } else {
    const bytes = await readFile(filename);
    hash.update(JSON.stringify([filename, bytes.length]));
    hash.update(bytes);
  }
}

/** Content identity of the local Vite build's source, configuration and install. */
async function builtClientInputFingerprint(rootDir, env) {
  const hash = createHash("sha256");
  let version = "dev";
  try {
    const result = await execFileAsync(
      "git",
      ["describe", "--tags", "--always", "--match", "v[0-9]*.[0-9]*.[0-9]*"],
      { cwd: join(rootDir, "packages/client"), env },
    );
    version = result.stdout.trim().replace(/^v(?=\d)/, "");
  } catch {
    // vite.config.ts uses the same version when Git is unavailable.
  }
  hash.update(
    JSON.stringify([version, process.version, process.platform, process.arch]),
  );
  hash.update(
    JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))),
  );
  for (const directory of ["packages/client", "packages/shared"]) {
    // Root-level files include env files, HTML entries, Vite plugins and configs.
    for (const entry of (
      await readdir(join(rootDir, directory), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = join(rootDir, directory, entry.name);
      if (
        entry.isFile() ||
        (entry.isSymbolicLink() && (await stat(filename)).isFile())
      ) {
        await hashPath(hash, filename);
      }
    }
  }
  for (const input of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    ".npmrc",
    ".pnpmfile.cjs",
    "packages/client/src",
    "packages/client/public",
    "packages/client/preboot",
    "packages/shared/src",
    "patches",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm/lock.yaml",
  ]) {
    await hashPath(hash, join(rootDir, input));
  }
  return hash.digest("hex");
}

async function outputFingerprint(directory) {
  const hash = createHash("sha256");
  await hashPath(hash, directory);
  return hash.digest("hex");
}

/** Prepare a complete client build without changing the running server's files. */
export async function prepareBuiltClient(
  rootDir,
  build,
  previous,
  env = process.env,
) {
  const inputFingerprint = await builtClientInputFingerprint(rootDir, env);
  const previousIntact =
    previous &&
    previous.outputFingerprint ===
      (await outputFingerprint(previous.directory));
  if (previousIntact && previous.inputFingerprint === inputFingerprint) {
    return previous;
  }
  const cache = join(rootDir, "node_modules", ".cache", "ya-client");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "build-"));
  try {
    await build(directory);
    await readFile(join(directory, "index.html"));
    const assets = await readdir(join(directory, "assets"));
    if (
      (await builtClientInputFingerprint(rootDir, env)) !== inputFingerprint
    ) {
      throw new Error("Client build inputs changed during build; retry reload");
    }
    // Keep one previous generation's lazy chunks available after a reload.
    // Only its original assets carry forward, so retention stays bounded.
    for (const name of previousIntact ? previous.assets : []) {
      if (!assets.includes(name)) {
        await copyFile(
          join(previous.directory, "assets", name),
          join(directory, "assets", name),
          constants.COPYFILE_EXCL,
        );
      }
    }
    return {
      directory,
      assets,
      inputFingerprint,
      outputFingerprint: await outputFingerprint(directory),
    };
  } catch (error) {
    await rm(directory, { recursive: true });
    throw error;
  }
}
