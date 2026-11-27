// Preload only inside the isolated replay's focused-directory worker.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { parentPort } from "node:worker_threads";

const watch = fs.watch;
fs.watch = (...args) => {
  const handle = watch(...args);
  const close = handle.close;
  handle.close = function () {
    const start = performance.now();
    try {
      return close.call(this);
    } finally {
      parentPort.postMessage({
        type: "probe-native-close",
        ms: performance.now() - start,
      });
    }
  };
  return handle;
};
syncBuiltinESMExports();
