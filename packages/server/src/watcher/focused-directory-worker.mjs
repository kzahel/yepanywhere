// macOS can spend seconds inside FSWatcher.close(). The worker owns the native
// handle for its entire lifetime; only watch IDs and small events cross threads.
import { watch } from "node:fs";
import { parentPort } from "node:worker_threads";

const watches = new Map();
parentPort.on("message", ({ id, path, cancelled }) => {
  if (path === undefined) {
    const handle = watches.get(id);
    watches.delete(id);
    handle?.close();
    parentPort.postMessage({ id, type: "released" });
    return;
  }
  // A view may have gone away while an earlier native close was blocked.
  if (Atomics.load(cancelled, 0)) return;
  try {
    const handle = watch(path, { persistent: false }, (event, filename) => {
      parentPort.postMessage({ id, type: "change", event, filename });
    });
    watches.set(id, handle);
    handle.on("error", (error) => {
      parentPort.postMessage({
        id,
        type: "error",
        message: error.message,
        code: error.code,
      });
    });
    handle.on("close", () => {
      if (watches.get(id) === handle) {
        parentPort.postMessage({
          id,
          type: "error",
          message: "Directory watcher closed unexpectedly",
        });
      }
    });
    parentPort.postMessage({ id, type: "ready" });
  } catch (error) {
    parentPort.postMessage({
      id,
      type: "error",
      message: error.message,
      code: error.code,
    });
  }
});
