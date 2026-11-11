import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Hash paths and bytes, including declarations/maps that can reveal stale builds. */
export function fingerprintTree(root) {
  root = realpathSync(root);
  const hash = createHash("sha256");
  let files = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const bytes = readFileSync(file);
        hash.update(JSON.stringify([path.relative(root, file), bytes.length]));
        hash.update(bytes);
        files++;
      } else throw new Error(`Unsupported runtime artifact: ${file}`);
    }
  };
  visit(root);
  if (!files) throw new Error(`Empty runtime build: ${root}`);
  return { root, files, sha256: hash.digest("hex") };
}

/** Resolve from the actual server entry, rather than assuming workspace aliases are frozen. */
export function runtimeIdentity(serverDist, clientDist) {
  const entry = pathToFileURL(path.join(serverDist, "index.js")).href;
  const sharedEntry = fileURLToPath(
    execFileSync(
      process.execPath,
      [
        "--experimental-import-meta-resolve",
        "--input-type=module",
        "-e",
        'process.stdout.write(import.meta.resolve("@yep-anywhere/shared", process.argv[1]))',
        entry,
      ],
      { encoding: "utf8" },
    ).trim(),
  );
  const sharedRoot = path.dirname(path.dirname(sharedEntry));
  return {
    fingerprintVersion: 1,
    server: fingerprintTree(serverDist),
    client: fingerprintTree(clientDist),
    sharedEntry,
    shared: {
      ...fingerprintTree(path.join(sharedRoot, "dist")),
      packageJsonSha256: createHash("sha256")
        .update(readFileSync(path.join(sharedRoot, "package.json")))
        .digest("hex"),
    },
  };
}
