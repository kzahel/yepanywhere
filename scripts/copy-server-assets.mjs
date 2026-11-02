#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(rootDir, "packages/server/src/services/voice");
const targetDir = join(rootDir, "packages/server/dist/services/voice");
const serverSourceDir = join(rootDir, "packages/server/src");
const serverTargetDir = join(rootDir, "packages/server/dist");

mkdirSync(targetDir, { recursive: true });

let copied = 0;
for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
  // Workers plus the helper module they import by name from this directory.
  if (!entry.isFile() || !entry.name.endsWith(".py")) {
    continue;
  }
  const source = join(sourceDir, entry.name);
  const target = join(targetDir, entry.name);
  copyFileSync(source, target);
  copied += 1;
}

if (copied === 0) {
  throw new Error(
    `No server worker assets copied from ${relative(rootDir, sourceDir)}`,
  );
}

for (const expected of [
  "whisper_worker.py",
  "parakeet_worker.py",
  "nemo_worker.py",
  "granite_worker.py",
  "qwen_worker.py",
  "stt_worker_common.py",
]) {
  if (!existsSync(join(targetDir, expected))) {
    throw new Error(`Expected ${expected} in server dist assets`);
  }
}

copyFileSync(
  join(serverSourceDir, "session-sandbox-network-launcher.mjs"),
  join(serverTargetDir, "session-sandbox-network-launcher.mjs"),
);

copyFileSync(
  join(serverSourceDir, "sdk/providers/pi-yep-anywhere-extension.mjs"),
  join(serverTargetDir, "sdk/providers/pi-yep-anywhere-extension.mjs"),
);

for (const name of [
  "creation-runtime-record.mjs",
  "creation-runtime-record.d.mts",
  "bound-runtime-identity.mjs",
  "bound-runtime-identity.d.mts",
]) {
  copyFileSync(
    join(serverSourceDir, "sdk/providers", name),
    join(serverTargetDir, "sdk/providers", name),
  );
}

copyFileSync(
  join(serverSourceDir, "highlighting/highlight-worker.mjs"),
  join(serverTargetDir, "highlighting/highlight-worker.mjs"),
);

for (const name of ["rendez-activity.mjs", "rendez-protocol.mjs"]) {
  copyFileSync(
    join(serverSourceDir, "services", name),
    join(serverTargetDir, "services", name),
  );
}

copyFileSync(
  join(serverSourceDir, "services/image-preparation.mjs"),
  join(serverTargetDir, "services/image-preparation.mjs"),
);

copyFileSync(
  join(serverSourceDir, "augments/unicode-math-params.bin"),
  join(serverTargetDir, "augments/unicode-math-params.bin"),
);
