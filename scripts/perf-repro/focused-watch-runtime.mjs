// Run with Node after building the server. An optional argument selects the
// child runtime (e.g. bun). No YA instance, socket or provider home is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const [, , runtime, dir, mode] = process.argv;
if (runtime === "--child") {
  const { watchSharedDirectory } = await import(
    "../../packages/server/dist/watcher/SharedDirectoryWatcher.js"
  );
  const watch = watchSharedDirectory(dir, { focused: true }, (_event, name) => {
    if (name === null) {
      console.log("ready");
      if (mode === "unref") watch.unref();
    } else if (name === "transcript.jsonl") {
      console.log("changed");
      watch.close();
    }
  });
} else {
  assert.equal(
    process.platform,
    "darwin",
    "Qualifies the macOS worker backend",
  );
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-focused-runtime-")),
  );
  try {
    for (const mode of ["unref", "ref"]) {
      const child = spawn(
        runtime ?? process.execPath,
        [fileURLToPath(import.meta.url), "--child", root, mode],
        {
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      const exit = once(child, "exit");
      const lines = createInterface({ input: child.stdout });
      const seen = [];
      let writer;
      const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
      try {
        for await (const line of lines) {
          seen.push(line);
          if (mode === "ref" && line === "ready") {
            // A referenced child must survive the quiet interval. Continue a
            // real external append stream through native event coalescing.
            writer = setInterval(
              () =>
                appendFileSync(join(root, "transcript.jsonl"), "new answer\n"),
              200,
            );
          }
        }
        assert.deepEqual(await exit, [0, null], mode + " child exit");
        assert.deepEqual(
          seen,
          mode === "ref" ? ["ready", "changed"] : ["ready"],
        );
        console.log(mode + " passed");
      } finally {
        clearInterval(writer);
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exit;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
