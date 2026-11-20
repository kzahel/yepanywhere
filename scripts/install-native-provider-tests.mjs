import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(
  new URL("../node_modules/.cache/ya-native-provider-tests/", import.meta.url),
);
const manifest = JSON.parse(
  await readFile(
    new URL(
      "../packages/server/test/native-provider/executables/artifacts.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const providers = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(manifest);
const platform = `${process.platform}-${process.arch}`;

for (const provider of providers) {
  const entry = manifest[provider];
  const artifact = entry?.platforms[platform];
  if (!artifact)
    throw Error(
      `No verified ${provider} test artifact for ${platform}; select a supported provider/platform explicitly`,
    );
  const destination = join(root, platform, provider, entry.version);
  const algorithm = artifact.sha512 ? "sha512" : "sha256";
  const checksum = artifact[algorithm];
  const stampName = `artifact.${algorithm}`;
  const stamp = join(destination, stampName);
  if ((await readFile(stamp, "utf8").catch(() => "")) === checksum) {
    console.log(`${provider} ${entry.version}: cached ${platform}`);
    continue;
  }
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), ".install-"));
  try {
    const response = await fetch(artifact.url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw Error(`Download ${provider}: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash(algorithm).update(archive).digest("hex");
    if (digest !== checksum)
      throw Error(
        `Integrity mismatch for ${provider} ${entry.version} ${platform}`,
      );
    const executable = join(staging, entry.executable);
    if (artifact.url.endsWith(".tar.gz")) {
      const archivePath = join(staging, "runtime.tar.gz.download");
      await writeFile(archivePath, archive);
      await exec("tar", ["-xzf", archivePath, "-C", staging, "antigravity"]);
      await rename(join(staging, "antigravity"), executable);
      await rm(archivePath);
    } else {
      await writeFile(executable, gunzipSync(archive));
    }
    await chmod(executable, 0o755);
    await writeFile(join(staging, stampName), digest);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    console.log(
      `${provider} ${entry.version}: verified ${platform}, ${archive.length} download bytes`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
